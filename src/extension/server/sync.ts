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

import { SUPABASE_URL, SUPABASE_ANON_KEY, PENDING_KEY, SUMMARY_KEY, isServerConfigured } from './config';
import { getAccessToken, isSignedIn } from './auth';

/** Mirrors the `summary` view in supabase/migrations/0002_functions.sql. */
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

interface Pending {
  focus: number;
  distracted: number;
}

/** Coalesce a burst of score changes into one request instead of one per point. */
const FLUSH_DEBOUNCE_MS = 4000;

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<ServerSummary | null> | null = null;
let lastSummary: ServerSummary | null = null;

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

function cacheSummary(s: ServerSummary | null) {
  if (!s) return;
  lastSummary = s;
  chrome.storage.local.set({ [SUMMARY_KEY]: s });
}

/** The last summary the server sent, from memory or storage. Lets the popup show
 *  server figures immediately instead of blank-then-populate. */
export async function getCachedSummary(): Promise<ServerSummary | null> {
  if (lastSummary) return lastSummary;
  return new Promise((resolve) => {
    chrome.storage.local.get([SUMMARY_KEY], (r) => {
      lastSummary = (r[SUMMARY_KEY] as ServerSummary) ?? null;
      resolve(lastSummary);
    });
  });
}

// ── The single write+read call ────────────────────────────────────────────────
/** Post whatever is pending (possibly nothing) and store the returned summary.
 *
 *  Safe to call at any time: it is a no-op when the server is unconfigured or the
 *  user is signed out, and it serialises itself so concurrent callers share one
 *  request rather than racing two deltas. */
export async function flush(): Promise<ServerSummary | null> {
  if (!isServerConfigured()) return null;
  if (!(await isSignedIn())) return null;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const pending = await readPending();
    try {
      const res = await authedFetch('/rest/v1/rpc/apply_score_delta', {
        method: 'POST',
        body: JSON.stringify({
          p_focus_delta: pending.focus,
          p_distracted_delta: pending.distracted,
          p_timezone: currentTimezone(),
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

      const summary = (await res.json()) as ServerSummary | null;
      cacheSummary(summary);
      return summary;
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

/** Read-only fetch of the summary — no delta, no write.
 *
 *  The right call when something merely wants to display the numbers (the popup
 *  opening) without counting as a check-in. flush() is what the three client
 *  triggers use, since it both pushes and reads. */
export async function fetchSummary(): Promise<ServerSummary | null> {
  if (!isServerConfigured()) return null;
  if (!(await isSignedIn())) return null;
  try {
    const res = await authedFetch('/rest/v1/summary?select=*&limit=1', { method: 'GET' });
    if (!res || !res.ok) return null;
    const rows = (await res.json()) as ServerSummary[];
    const summary = rows?.[0] ?? null;
    cacheSummary(summary);
    return summary;
  } catch {
    return null;
  }
}

/** Mirror the whitelist to the server. Full replace — the extension owns the list.
 *  Called when the domain list changes, not on a timer. */
export async function syncDomains(domains: string[]): Promise<boolean> {
  if (!isServerConfigured()) return false;
  if (!(await isSignedIn())) return false;
  try {
    const res = await authedFetch('/rest/v1/rpc/sync_domains', {
      method: 'POST',
      body: JSON.stringify({
        p_domains: domains.map((d) => d.trim()).filter((d) => d.length > 0),
      }),
    });
    if (!res || !res.ok) {
      if (res) console.warn(`Focus: domain sync failed (${res.status})`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
