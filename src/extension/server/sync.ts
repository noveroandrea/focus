// ─────────────────────────────────────────────────────────────────────────────
//  Score sync — the extension's side of the server contract
// ─────────────────────────────────────────────────────────────────────────────
//  One endpoint does the work: rpc/apply_score_delta. It takes a DELTA (+focus /
//  −distracted) and returns the whole summary, so "push my points" and "tell me
//  where I stand" are the same round trip. A (0, 0) delta is therefore a pure read,
//  and one endpoint covers all three moments the client checks in:
//
//    • a score change            (queueDelta, debounced)
//    • the browser opening       (background init + onStartup)
//    • the Working button        (the forceActive toggle in background.ts)
//
//  THE CLIENT KNOWS NOTHING ABOUT ROLLOVER. Days are ended by the server's cron job
//  on its own schedule; nothing here tracks, triggers or even asks about it. The
//  live score is the server's value, rendered as received. So just after a rollover
//  the client may still show the previous day's figure until its next post returns
//  the reset one — which is fine, and much cheaper than teaching both sides the same
//  calendar and keeping them agreeing.
//
//  WHY DELTAS AND NOT ABSOLUTE SCORES. A device sends only what it earned since its
//  own last successful post, and gets back the running total across ALL devices:
//
//    server total 10.  laptop posts +1  ->  server 11,  laptop sees 11
//                      phone  posts +1  ->  server 12,  phone  sees 12
//                      laptop posts +0  ->  server 12,  laptop sees 12
//
//  so every device converges on the same total without knowing what the others did.
//  Sending absolutes would lose points instead: the laptop would claim "total 11"
//  and the phone "total 11", and the server would settle on 11 rather than 12.
//
//  Pending deltas are held in chrome.storage.local rather than memory, because an
//  MV3 worker is suspended between events and would otherwise forget them. They are
//  cleared only once the server has confirmed them, so being offline delays a post
//  but never drops it.
//
//  The one case that can double-count is a request that reached the database but
//  whose response was lost in transit: we retry, and the delta lands twice. That is
//  deliberate — the alternative is dropping work the user really did, and one
//  spurious point matters less than a missing one. Nothing here is billing.
// ─────────────────────────────────────────────────────────────────────────────

import { DayScore, HISTORY_KEY, Settings, DEFAULT_SETTINGS, weekdayName, round2 } from '../../types';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, PENDING_KEY, SUMMARY_KEY,
  PENDING_DOMAINS_KEY, SERVER_DOMAINS_KEY, isServerConfigured,
} from './config';
import { getAccessToken, isSignedIn } from './auth';

/** Mirrors the `summary` view in the functions migration in supabase/migrations/. */
export interface ServerSummary {
  user_id: string;
  live_focus: number;
  live_distracted: number;
  live_day: string;
  d1_focus: number; d1_distracted: number;
  d2_focus: number; d2_distracted: number;
  d3_focus: number; d3_distracted: number;
  avg7_focus: number; avg7_distracted: number;
  avg30_focus: number; avg30_distracted: number;
  timezone: string;
  updated_at: string;
}

/** One completed day as the server sends it. */
export interface ServerDay {
  day: string;                // YYYY-MM-DD
  focus_score: number;
  distracted_score: number;
}

/** The full payload from apply_score_delta / get_state. The server is the source of
 *  truth for all three parts; the local copies are caches it overwrites. */
export interface ServerState {
  summary: ServerSummary | null;
  domains: string[];
  days: ServerDay[];
}

interface Pending {
  focus: number;
  distracted: number;
}

/** What sync needs from background.ts, which owns SessionState. Same shape of
 *  arrangement as initHeartbeats() — this module never imports the state. */
export interface SyncHost {
  /** Replace the local live score with the server's authoritative figure, and the
   *  local day label with the server's focus-day. Must NOT route back through the
   *  delta hook, or reconciliation would post the difference it just received and
   *  run away. */
  onServerScores(focus: number, distracted: number, liveDay: string): void;
}

let syncHost: SyncHost | null = null;

/** Wire up reconciliation. Call once from the service worker's top level. */
export function initSync(h: SyncHost) {
  syncHost = h;
}

/** Every score change posts, so the reply can reconcile the displayed live score
 *  promptly. Not zero, though: a focus point and an idle penalty can land in the same
 *  instant, and a character change at the minimum interval (5 heartbeats) fires every
 *  few seconds. One second collapses those genuine bursts into a single request while
 *  keeping convergence effectively immediate.
 *
 *  Raise this if a study with many participants starts straining request limits — the
 *  optimistic local update means the user sees their points immediately either way,
 *  and only the reconciliation is delayed. */
const FLUSH_DEBOUNCE_MS = 1000;

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<ServerState | null> | null = null;

// ── Pending deltas ────────────────────────────────────────────────────────────
function readPending(): Promise<Pending> {
  return new Promise((resolve) => {
    chrome.storage.local.get([PENDING_KEY], (r) => {
      const p = r[PENDING_KEY] as Pending | undefined;
      resolve({
        focus: Number(p?.focus) || 0,
        distracted: Number(p?.distracted) || 0,
      });
    });
  });
}

function writePending(p: Pending): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [PENDING_KEY]: p }, () => resolve());
  });
}

// ── The IANA timezone, so the server's 01:00 rollover is the user's 01:00 ──────
function currentTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
async function authedFetch(path: string, init: RequestInit): Promise<Response | null> {
  const token = await getAccessToken();
  if (!token) return null; // not signed in / session dead → stay offline
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
}

// ── Applying the server's state locally ───────────────────────────────────────
// Everything the server sends is written straight into the SAME storage keys the
// offline extension uses: Settings.allowedDomains and HISTORY_KEY. That is what
// makes the server authoritative without rewriting the rest of the extension —
// heartbeat.ts, isAllowedUrl() and the popup's charts keep reading exactly what they
// always read, they just no longer own it.
//
// It cannot be "no local copy at all": heartbeat.ts has to decide whether to activate
// on every page load, synchronously and offline, long before any request could
// return. So local storage stays — demoted from record to cache.
let lastState: ServerState | null = null;

function readServerDomains(): Promise<string[] | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([SERVER_DOMAINS_KEY], (r) => {
      const d = r[SERVER_DOMAINS_KEY];
      resolve(Array.isArray(d) ? (d as string[]) : null);
    });
  });
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Overwrite the local caches with what the server just said. */
async function applyState(next: ServerState | null): Promise<void> {
  if (!next) return;
  lastState = next;
  chrome.storage.local.set({ [SUMMARY_KEY]: next.summary });

  // Whitelist → Settings.allowedDomains, plus the snapshot that lets the change
  // listener recognise this write as an echo rather than a user edit.
  const domains = Array.isArray(next.domains) ? next.domains : [];
  await new Promise<void>((resolve) => {
    chrome.storage.local.get(['focusFlowSettings', SERVER_DOMAINS_KEY], (r) => {
      const settings = { ...DEFAULT_SETTINGS, ...(r.focusFlowSettings as Settings) };
      const write: Record<string, unknown> = { [SERVER_DOMAINS_KEY]: domains };
      // Only touch the settings object when the list actually differs, so an
      // unchanged reply doesn't wake every listener in the extension twice a minute.
      if (!sameList(settings.allowedDomains ?? [], domains)) {
        write.focusFlowSettings = { ...settings, allowedDomains: domains };
      }
      chrome.storage.local.set(write, () => resolve());
    });
  });

  // Completed days → HISTORY_KEY, in the DayScore shape the popup already renders.
  // weekday is re-derived rather than sent over the wire: it is a pure function of
  // the date, and deriving it locally means the two can never contradict each other.
  const days = Array.isArray(next.days) ? next.days : [];
  const history: DayScore[] = days
    .map((d) => ({
      date: d.day,
      weekday: weekdayName(d.day),
      focusScore: Number(d.focus_score) || 0,
      distractedScore: Number(d.distracted_score) || 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date)); // oldest-first, as stored locally
  chrome.storage.local.set({ [HISTORY_KEY]: history });
}

/** The last full state the server sent, from memory or storage. */
export async function getCachedSummary(): Promise<ServerSummary | null> {
  if (lastState?.summary) return lastState.summary;
  return new Promise((resolve) => {
    chrome.storage.local.get([SUMMARY_KEY], (r) => {
      resolve((r[SUMMARY_KEY] as ServerSummary) ?? null);
    });
  });
}

// ── Pending whitelist edit ────────────────────────────────────────────────────
/** Queue a whitelist edit to go out with the next post.
 *
 *  Deliberately NOT its own request: sending it inside apply_score_delta means the
 *  reply already reflects the edit, so a score delta in flight at the same moment
 *  cannot come back carrying the pre-edit list and undo the user's change. */
export async function queueDomains(domains: string[]): Promise<void> {
  if (!isServerConfigured()) return;
  const clean = domains.map((d) => d.trim()).filter((d) => d.length > 0);
  // An echo of the server's own list is not an edit.
  const known = await readServerDomains();
  if (known && sameList(known, clean)) return;
  await new Promise<void>((resolve) => {
    chrome.storage.local.set({ [PENDING_DOMAINS_KEY]: clean }, () => resolve());
  });
  void flush();
}

function readPendingDomains(): Promise<string[] | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([PENDING_DOMAINS_KEY], (r) => {
      const d = r[PENDING_DOMAINS_KEY];
      resolve(Array.isArray(d) ? (d as string[]) : null);
    });
  });
}

// ── Reconciling the displayed score with the server ───────────────────────────
// The local score is updated OPTIMISTICALLY the moment a point is earned, so the
// sprite's +1 and the −10 fly-up fire immediately rather than after a round trip.
// This is the other half of that: once the server answers, its live score becomes
// the displayed one.
//
// The `+ pending` is not optional. Deltas queued while the request was in flight are
// by definition not in the figure the server just sent, so setting the display to the
// bare server value would visibly undo points the user has already been shown
// earning — and the next post would then re-add them, making the number jump twice.
// Adding what is still pending keeps the display equal to "everything the server
// knows, plus everything on its way there".
//
// Note this is also what makes a server-side rollover show up on screen: after it the
// server reports 0, so the display drops to 0 (plus anything pending) on the next
// post. No client-side notion of a day is involved.
async function reconcileScores(next: ServerState | null): Promise<void> {
  const summary = next?.summary;
  if (!summary || !syncHost) return;
  const remaining = await readPending();
  const focus = (Number(summary.live_focus) || 0) + remaining.focus;
  const distracted = (Number(summary.live_distracted) || 0) + remaining.distracted;
  syncHost.onServerScores(round2(focus), round2(distracted), String(summary.live_day ?? ''));
}

// ── The single write+read call ────────────────────────────────────────────────
/** Post whatever is pending (possibly nothing) and store the returned summary.
 *
 *  Safe to call at any time: it is a no-op when the server is unconfigured or the
 *  user is signed out, and it serialises itself so concurrent callers share one
 *  request rather than racing two deltas. */
export async function flush(): Promise<ServerState | null> {
  if (!isServerConfigured()) return null;
  if (!(await isSignedIn())) return null;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const pending = await readPending();
    const pendingDomains = await readPendingDomains();
    try {
      const res = await authedFetch('/rest/v1/rpc/apply_score_delta', {
        method: 'POST',
        body: JSON.stringify({
          p_focus_delta: pending.focus,
          p_distracted_delta: pending.distracted,
          p_timezone: currentTimezone(),
          // null, not [], when there is no edit: an empty array legitimately CLEARS
          // the whitelist, so the two must not be conflated.
          p_domains: pendingDomains,
        }),
      });
      if (!res) return null;

      if (!res.ok) {
        const body = await res.text();
        console.warn(`Focus: score sync failed (${res.status}):`, body.slice(0, 200));
        return null; // pending is left intact and retried on the next call
      }

      // Subtract rather than zero: more deltas may have been queued while this
      // request was in flight, and those must survive.
      const now = await readPending();
      await writePending({
        focus: Math.max(0, now.focus - pending.focus),
        distracted: Math.min(0, now.distracted - pending.distracted),
      });
      // The whitelist edit is confirmed only if this request carried the same one we
      // still hold; a newer edit queued mid-flight must stay pending.
      if (pendingDomains) {
        const still = await readPendingDomains();
        if (still && sameList(still, pendingDomains)) {
          await new Promise<void>((r) => chrome.storage.local.remove(PENDING_DOMAINS_KEY, () => r()));
        }
      }

      const state = (await res.json()) as ServerState | null;
      await applyState(state);
      await reconcileScores(state);
      return state;
    } catch (err) {
      // Offline, DNS failure, project paused — keep the pending delta for later.
      console.warn('Focus: score sync unreachable:', String(err).slice(0, 120));
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Record a score change for the next flush.
 *
 *  Signs are enforced here as well as in SQL: focus only ever rises and distracted
 *  only ever falls, so anything else is the extension's own local history resetting
 *  its counters, not real activity. Those must never be forwarded — the server ends
 *  its own days, and a giant negative delta would wipe out a real score. */
export async function queueDelta(focusDelta: number, distractedDelta: number): Promise<void> {
  if (!isServerConfigured()) return;
  const focus = Number.isFinite(focusDelta) ? Math.max(0, focusDelta) : 0;
  const distracted = Number.isFinite(distractedDelta) ? Math.min(0, distractedDelta) : 0;
  if (focus === 0 && distracted === 0) return;
  if (!(await isSignedIn())) return;

  const p = await readPending();
  await writePending({ focus: p.focus + focus, distracted: p.distracted + distracted });

  // Debounced: a character change plus a penalty landing in the same few seconds
  // becomes one request. The pending total is already durable, so a worker
  // suspension before the timer fires costs nothing but latency.
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, FLUSH_DEBOUNCE_MS);
}

 /** Read-only fetch of the full state — no delta, no write, no side effects.
 *
 *  The right call when something merely wants to display the numbers (the popup
 *  opening) without counting as a check-in. flush() is what the three client triggers
 *  use, since it both pushes and reads. */
export async function fetchState(): Promise<ServerState | null> {
  if (!isServerConfigured()) return null;
  if (!(await isSignedIn())) return null;
  try {
    const res = await authedFetch('/rest/v1/rpc/get_state', {
      method: 'POST',
      body: JSON.stringify({ p_timezone: currentTimezone() }),
    });
    if (!res || !res.ok) return null;
    const state = (await res.json()) as ServerState | null;
    await applyState(state);
    await reconcileScores(state);
    return state;
  } catch {
    return null;
  }
}
