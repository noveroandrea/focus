// ─────────────────────────────────────────────────────────────────────────────
//  Score sync — the extension's side of the server contract
// ─────────────────────────────────────────────────────────────────────────────
//  One endpoint does the work: rpc/apply_score_delta. It takes a DELTA (+focus /
//  −distracted) and returns the whole summary, so "push my points" and "tell me
//  where I stand" are the same round trip. A (0, 0) delta is therefore a pure read,
//  and one endpoint covers every moment the client checks in:
//
//    • a score change            (queueDelta, debounced)
//    • the browser opening       (background init + onStartup)
//    • the Working button        (the forceActive toggle in background.ts)
//    • a minute since the last   (the chrome.alarms floor below)
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
  SUPABASE_URL, SUPABASE_ANON_KEY, PENDING_KEY, SUMMARY_KEY, TEAMS_KEY, FLAG_KEY,
  DOMAIN_FLAGS_KEY, PENDING_DOMAINS_KEY, SERVER_DOMAINS_KEY, isServerConfigured,
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

/** One participant on a leaderboard, as build_teams() sends them.
 *
 *  `display_name` is the local part of their email — see the PII note in the teams
 *  migration. `is_self` marks the caller's own row so the popup can highlight it
 *  without matching ids. `team` is present only inside a competition, where one list
 *  spans several teams. */
export interface MemberScore {
  user_id: string;
  display_name: string;
  is_self: boolean;
  team?: string;
  /** Position in the full field, not in the returned slice — boards are topped, so
   *  row 1 of the array can legitimately be rank 1 while the last is rank 4,312. */
  rank?: number;
  live_focus: number; live_distracted: number;
  avg7_focus: number; avg7_distracted: number;
  avg30_focus: number; avg30_distracted: number;
}

/** A team's board: everyone in it, including you. */
export interface TeamBoard {
  team: string;
  metric: Metric;
  /** Size of the whole team, which may be far larger than `members`. */
  member_count: number;
  /** The caller's rank in it, present even when they are below the cut. */
  my_rank: number | null;
  members: MemberScore[];
}

/** Which score a board is ranked by. Boards are topped, so the metric has to travel
 *  with the request: the top 20 by live score is a different set of people from the
 *  top 20 by 30-day average. */
export type Metric = 'live' | 'avg7' | 'avg30';

/** One team's summed scores, for the team-vs-team board inside a competition. */
export interface CompetitionTeam {
  team: string;
  is_mine: boolean;
  rank?: number;
  member_count: number;
  live_focus: number; live_distracted: number;
  avg7_focus: number; avg7_distracted: number;
  avg30_focus: number; avg30_distracted: number;
}

/** A competition: the team-level board, plus every participant across every team in
 *  it. Per-team member lists are NOT a separate field — each member row carries its
 *  `team`, and the popup groups by it. */
export interface CompetitionBoard {
  competition: string;
  /** Fixed when the competition was created. 'individual' has no team board;
   *  'team' has no individual entrants. */
  kind: 'individual' | 'team';
  metric: Metric;
  member_count: number;
  team_count: number;
  my_rank: number | null;
  teams: CompetitionTeam[];
  members: MemberScore[];
}

/** The routine payload from apply_score_delta / get_state, sent on every check-in.
 *
 *  Deliberately does NOT carry leaderboards. They used to ride along here, which
 *  meant every user downloaded every visible member's scores once a minute whether
 *  or not a board was on screen — egress that grew with competition size × users.
 *  Only the NAMES travel now, enough to draw the section pills; the boards are
 *  fetched when a section is opened. See fetchTeamBoard / fetchCompetitionBoard. */
export interface ServerState {
  summary: ServerSummary | null;
  domains: string[];
  /** The same domains with their global flag tally. Display only — `domains` above
   *  is the copy that drives whether the extension activates on a page. */
  domain_flags: { domain: string; flag_count: number }[];
  my_teams: string[];
  /** Competitions the user entered as themselves. */
  my_competitions: string[];
  /** Competitions one of the user's teams entered. Separate from the above so the
   *  popup can show the same competition twice — once per entry, which is what
   *  having two entries looks like. */
  my_team_competitions: { competition: string; team: string }[];
  /** Incoming friend requests waiting on the user — drives the badge on the pill. */
  friend_requests: number;
  /** This week's red-flag budget. One per user, granted each Monday 01:00 local. */
  flag: { available: boolean } | null;
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

// ── The floor: never more than a minute without a post ────────────────────────
// The triggers above are all things the USER does, so a session with no score
// changes — reading a PDF, another device doing the earning, simply idle — could
// sit indefinitely on a stale live score, stale averages and a day the server has
// already rolled over. This is the backstop: one post a minute, no matter what.
//
// Reset by every post rather than free-running, so it is a "time since last
// contact" floor and not an extra request on top of a busy session. Re-arming with
// the same alarm name replaces the pending one, which IS the reset.
//
// chrome.alarms, NOT setTimeout, for the reason that shapes this whole codebase: an
// MV3 service worker is suspended between events and its timers die with it.
// An alarm survives suspension and wakes the worker to deliver it, which is the only
// way a periodic task runs at all here. Also why one minute is the shortest useful
// period — Chrome clamps alarms below that.
const PERIODIC_ALARM = 'focus-sync-post';
const PERIODIC_POST_MINUTES = 1;

function armPeriodicPost() {
  chrome.alarms.create(PERIODIC_ALARM, { delayInMinutes: PERIODIC_POST_MINUTES });
}

function clearPeriodicPost() {
  chrome.alarms.clear(PERIODIC_ALARM);
}

// Registered at module scope, which for the service worker means synchronously at
// top level — a listener added later would not exist yet when Chrome wakes the
// worker to deliver the alarm, and the event would be dropped.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PERIODIC_ALARM) void flush();
});

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

  // Which sections to offer — names only. Written unconditionally, including when
  // empty: leaving your last team has to remove the pill, not leave a stale one.
  chrome.storage.local.set({
    [TEAMS_KEY]: {
      teams: Array.isArray(next.my_teams) ? next.my_teams : [],
      competitions: Array.isArray(next.my_competitions) ? next.my_competitions : [],
      teamCompetitions: Array.isArray(next.my_team_competitions) ? next.my_team_competitions : [],
      friendRequests: Number(next.friend_requests) || 0,
    },
  });

  // Flag tallies for the user's own domains, flattened to a lookup map so the popup
  // does not scan an array per row. Written unconditionally: a domain removed from
  // the whitelist must lose its entry, not keep a stale count.
  const tallies: Record<string, number> = {};
  for (const d of Array.isArray(next.domain_flags) ? next.domain_flags : []) {
    if (d && typeof d.domain === 'string') tallies[d.domain] = Number(d.flag_count) || 0;
  }
  chrome.storage.local.set({ [DOMAIN_FLAGS_KEY]: tallies });

  // The weekly flag. Defaults to available when the server said nothing, matching
  // build_state's own coalesce — a user who has never spent one holds one.
  chrome.storage.local.set({ [FLAG_KEY]: { available: next.flag?.available !== false } });
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
  if (!(await isSignedIn())) {
    // Stop the cycle instead of waking the worker every minute to do nothing. It
    // restarts on its own: signing in posts, and posting arms the alarm again.
    clearPeriodicPost();
    return null;
  }

  // Before the in-flight check, not after: a caller that joins an existing request
  // has still made contact, and the point is time since the last one.
  armPeriodicPost();
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

// ── Teams and competitions ────────────────────────────────────────────────────
// Each of these RPCs returns the same full state every other call returns, so a
// membership change repaints the whole popup — new board included — from its own
// reply. No follow-up fetch, no window where the UI and the server disagree.
//
// Errors are surfaced rather than swallowed, unlike flush(): the user typed a name
// and pressed a button, so "that team already exists" has to reach them. Postgres
// raises those as a JSON body with a `message`, which is what gets returned here.
export interface TeamActionResult {
  ok: boolean;
  error?: string;
}

async function teamRpc(fn: string, body: Record<string, unknown>): Promise<TeamActionResult> {
  if (!isServerConfigured()) return { ok: false, error: 'No server configured in this build.' };
  if (!(await isSignedIn())) return { ok: false, error: 'Sign in first.' };
  try {
    const res = await authedFetch(`/rest/v1/rpc/${fn}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res) return { ok: false, error: 'Sign in first.' };
    if (!res.ok) {
      // PostgREST wraps a RAISE as {"message": "...", "code": "..."}; the raised text
      // is already written for a human, so it is shown as-is.
      let msg = `Request failed (${res.status})`;
      try {
        const j = await res.json() as { message?: string };
        if (j?.message) msg = j.message;
      } catch { /* non-JSON body — keep the status line */ }
      return { ok: false, error: msg };
    }
    const state = (await res.json()) as ServerState | null;
    await applyState(state);
    await reconcileScores(state);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Offline — ${String(err).slice(0, 80)}` };
  }
}

/** Join a team, or create it first. `create` refuses a name that already exists and
 *  join refuses one that doesn't — that separation is the point of the two buttons.
 *
 *  The password is the team's shared secret: creating sets it, joining must match
 *  it. Sent in the request body over TLS and compared against a bcrypt hash the
 *  server never lets any client read. */
export function joinTeam(team: string, create: boolean, password: string): Promise<TeamActionResult> {
  return teamRpc('join_team', { p_team: team, p_create: create, p_password: password });
}

/** Leave a team. The team itself survives even if it empties. */
export function leaveTeam(team: string): Promise<TeamActionResult> {
  return teamRpc('leave_team', { p_team: team });
}

/** Enter one of your teams into a competition, creating the competition if asked.
 *
 *  Passworded like a team, and for a sharper reason: sharing a competition is what
 *  makes rival teams visible to each other, so without a secret anyone could enrol a
 *  throwaway team by name and read the whole field. */
export function enrollTeam(
  team: string, competition: string, create: boolean, password: string,
): Promise<TeamActionResult> {
  return teamRpc('enroll_team', {
    p_team: team, p_competition: competition, p_create: create, p_password: password,
  });
}

/** Enter a competition as yourself, creating it if asked. Independent of any team
 *  entry: you can hold both, and leaving one leaves the other alone. */
export function joinCompetition(
  competition: string, create: boolean, password: string,
): Promise<TeamActionResult> {
  return teamRpc('join_competition', {
    p_competition: competition, p_create: create, p_password: password,
  });
}

/** Withdraw yourself from a competition, leaving any team entry untouched. */
export function leaveCompetitionSolo(competition: string): Promise<TeamActionResult> {
  return teamRpc('leave_competition_solo', { p_competition: competition });
}

/** Withdraw one of your teams from a competition. Mirrors enrolling, including who
 *  is allowed to do it: any member of the team. */
export function leaveCompetition(team: string, competition: string): Promise<TeamActionResult> {
  return teamRpc('leave_competition', { p_team: team, p_competition: competition });
}

// ── Member profiles and domain flags ──────────────────────────────────────────
// Unlike everything above, these do NOT return the full state and do NOT touch the
// storage caches: a profile is a detail view of somebody else, fetched when it is
// opened and discarded when it is closed. Caching it would mean holding another
// participant's browsing data on disk long after the popup that asked for it closed.

/** One whitelisted domain on a profile.
 *
 *  `flag_count` is the global tally across everyone; `my_flags` is how many of those
 *  are the caller's. Not a boolean any more — a domain can be flagged again in a
 *  later week, so "have I" was replaced by "how often". */
export interface MemberDomain {
  domain: string;
  flag_count: number;
  my_flags: number;
}

/** What flag_domain returns: the domain's new global tally, the caller's own tally
 *  on it after this flag, the per-domain ceiling, and the (always false) state of
 *  their weekly budget. */
export interface FlagResult {
  domain: string;
  flag_count: number;
  my_flags: number;
  max_per_domain: number;
  flag_available: boolean;
}

/** A participant's detail view. `days` matches ServerDay so the popup renders it
 *  through the same code path as your own history. */
export interface MemberProfile {
  user_id: string;
  display_name: string;
  is_self: boolean;
  /** Where the caller stands with this person, so the profile can offer the right
   *  button without a second call. */
  friend_status: FriendStatus;
  live_focus: number; live_distracted: number;
  avg7_focus: number; avg7_distracted: number;
  avg30_focus: number; avg30_distracted: number;
  days: ServerDay[];
  domains: MemberDomain[];
}

async function readRpc<T>(fn: string, body: Record<string, unknown>): Promise<T | null> {
  if (!isServerConfigured()) return null;
  if (!(await isSignedIn())) return null;
  try {
    const res = await authedFetch(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) });
    if (!res || !res.ok) {
      if (res) console.warn(`Focus: ${fn} failed (${res.status}):`, (await res.text()).slice(0, 200));
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`Focus: ${fn} unreachable:`, String(err).slice(0, 120));
    return null;
  }
}

// ── Friends ───────────────────────────────────────────────────────────────────
// A second route to seeing another participant, alongside teams, and the only one
// that needs both sides to agree. A PENDING request shows nothing: the server's
// can_see_user() requires status = 'accepted'.

/** Someone waiting on the user to accept. */
export interface FriendRequest {
  user_id: string;
  display_name: string;
  created_at: string;
}

/** What the caller can do about a given person. */
export type FriendStatus = 'none' | 'sent' | 'received' | 'friends' | 'self';

/** A search hit. Deliberately no email: search matches the local part and returns
 *  only that, so a searcher learns a name exists and nothing more. */
export interface UserHit {
  user_id: string;
  display_name: string;
  status: FriendStatus;
}

/** Same shape as a team board, plus whoever is waiting on you. */
export interface FriendsBoard {
  metric: Metric;
  member_count: number;
  my_rank: number | null;
  members: MemberScore[];
  requests: FriendRequest[];
}

export function fetchFriendsBoard(metric: Metric, limit = 20): Promise<FriendsBoard | null> {
  return readRpc<FriendsBoard>('get_friends_board', { p_metric: metric, p_limit: limit });
}

/** Type-ahead over other participants. Returns [] under 3 characters — the server
 *  enforces that floor so an empty query cannot enumerate the study. */
export function searchUsers(query: string): Promise<UserHit[] | null> {
  return readRpc<UserHit[]>('search_users', { p_query: query, p_limit: 10 });
}

export function sendFriendRequest(userId: string): Promise<{ status: FriendStatus } | null> {
  return readRpc('send_friend_request', { p_user: userId });
}

export function respondFriendRequest(requester: string, accept: boolean): Promise<{ status: FriendStatus } | null> {
  return readRpc('respond_friend_request', { p_requester: requester, p_accept: accept });
}

export function removeFriend(userId: string): Promise<{ status: FriendStatus } | null> {
  return readRpc('remove_friend', { p_user: userId });
}

/** The caller's own 30 completed days, fetched when the history is on screen rather
 *  than pushed with every post. It changes once a day, at the 01:00 rollover. */
export function fetchMyDays(): Promise<ServerDay[] | null> {
  return readRpc<ServerDay[]>('get_my_days', {});
}

/** The 7-day and 30-day means a chart needs, and nothing else. ServerSummary
 *  satisfies it structurally, so the same chart draws a person and a group. */
export interface AvgSummary {
  avg7_focus: number; avg7_distracted: number;
  avg30_focus: number; avg30_distracted: number;
}

/** A day series averaged over a group — a team, or you and your friends.
 *
 *  Same two charts the Personal section draws, over a set of people instead of one.
 *  `summary.live_*` is the group's mean live score, which becomes today's bar; the
 *  server documents which of the two averaging conventions each field uses. */
export interface GroupHistory {
  member_count: number;
  summary: AvgSummary & { live_focus: number; live_distracted: number };
  days: ServerDay[];
}

/** Averaged history for one of the caller's teams. Fetched ONCE when the section
 *  opens, not on the boards' 60-second refresh: a completed day changes once a day.
 *  Same reasoning as fetchMyDays. */
export function fetchTeamDays(team: string): Promise<GroupHistory | null> {
  return readRpc<GroupHistory>('get_team_days', { p_team: team });
}

/** The same, over the caller and everyone who has accepted them. */
export function fetchFriendsDays(): Promise<GroupHistory | null> {
  return readRpc<GroupHistory>('get_friends_days', {});
}

/** One team's board, fetched when its section is opened rather than pushed with
 *  every post. Refused unless the caller is a member. */
export function fetchTeamBoard(team: string, metric: Metric, limit = 20): Promise<TeamBoard | null> {
  return readRpc<TeamBoard>('get_team_board', { p_team: team, p_metric: metric, p_limit: limit });
}

/** One competition's board — team totals plus every participant across it. Refused
 *  unless one of the caller's own teams is entered in it. */
export function fetchCompetitionBoard(
  competition: string, metric: Metric, limit = 20,
): Promise<CompetitionBoard | null> {
  return readRpc<CompetitionBoard>('get_competition_board',
    { p_competition: competition, p_metric: metric, p_limit: limit });
}

/** Open a participant's profile. The server refuses anyone the caller cannot
 *  already see on a leaderboard, so a null here can mean "not allowed" as well as
 *  "offline" — both come out as the same empty view. */
export function fetchMemberProfile(userId: string): Promise<MemberProfile | null> {
  return readRpc<MemberProfile>('get_member_profile', { p_user: userId });
}

/** Spend this week's red flag on a domain. One-way: there is no un-flagging, and the
 *  budget does not return until Monday 01:00 local. Refused once the caller has
 *  already put MAX_FLAGS_PER_DOMAIN on that one domain.
 *
 *  The count is global per domain, not per participant — the same tally appears on
 *  every profile listing that domain. The result is written straight into FLAG_KEY so
 *  the badge greys out the moment it lands, without waiting for the next post. */
export async function flagDomain(domain: string): Promise<FlagResult | null> {
  const res = await readRpc<FlagResult>('flag_domain', { p_domain: domain });
  if (res) chrome.storage.local.set({ [FLAG_KEY]: { available: res.flag_available } });
  return res;
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
