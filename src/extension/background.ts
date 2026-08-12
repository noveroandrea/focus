import { SessionState, MessageType, Settings, ServerStatus, AgentStatus, PageStatus, TelegramResult, DEFAULT_SETTINGS, CHARACTER_COUNT, clampCryBeepDuration, clampIdleTime, round2 } from '../types';
import {
  STATUS_LOOP_MS, VIEWER_CLASSIFY_DELAY_MS, WORKING_FRESH_MS,
  IDLE_PENALTY, IDLE_WARNING_MS, TELEGRAM_COOLDOWN_MS,
  idlePenaltyDelayMs, autoPauseDelayMs,
} from './timings';
// Every heartbeat source — page input, focused PDF/viewer tabs, OS-wide activity —
// lives in ./heartbeats. This file owns the state; that one decides when it beats.
import {
  initHeartbeats, onPageHeartbeat, onFocusPing, hasContentScript,
  forceActiveTick, expireStaleHeartbeat, resetOsAnchor,
} from './heartbeats';
// Optional Supabase sync. Every call is a no-op until config.ts is filled in AND
// the user has signed in, so the extension is fully functional without a server.
import {
  initSync, queueDelta, queueDomains, flush, getCachedSummary,
  joinTeam, leaveTeam, enrollTeam, leaveCompetition, fetchMemberProfile, flagDomain,
  joinCompetition, leaveCompetitionSolo,
  fetchTeamBoard, fetchCompetitionBoard, fetchMyDays, fetchTeamDays, fetchFriendsDays,
  fetchFriendsBoard, searchUsers, sendFriendRequest, respondFriendRequest, removeFriend,
} from './server/sync';
import { signIn, signOut, getSession } from './server/auth';
import { isServerConfigured } from './server/config';
// The optional desktop agent — reports which PROGRAM is in front. Purely a sensor:
// every decision about what that means lives in ./heartbeats.
import {
  currentProgram, recentProgram, isAgentOnline, isAllowedProgram, isBrowserProgram,
  normaliseProgram, programNames, setNamedPrograms, agentNote, refreshProgram,
} from './agent';

/** Assemble the account snapshot the popup renders. */
async function replyServerStatus(sendResponse: (r: ServerStatus) => void) {
  const session = await getSession();
  sendResponse({
    configured: isServerConfigured(),
    signedIn: session !== null,
    email: session?.email ?? '',
    summary: await getCachedSummary(),
  });
}

let state: SessionState = {
  isHeartbeatActive: false,
  lastHeartbeat: 0,
  activeWindowId: null,
  enabled: true,
  currentIconId: Math.floor(Math.random() * CHARACTER_COUNT),
  heartbeatCount: 0,
  iconChangeAt: 0,
  focusScore: 0,
  distractedScore: 0,
  scoreDate: '',
  penaltyAt: 0,
  osHeld: false,
};

let settings: Settings = { ...DEFAULT_SETTINGS };

// ── Toolbar icon ──────────────────────────────────────────────────────────────
// No static icon file ships with the extension; we draw it in the service worker
// with OffscreenCanvas so its colour can reflect the working state: green while
// "Working" on an authorized page, yellow while "Working" on a page that is NOT
// whitelisted, grey while "Not working" (forceActive on). It reproduces the old
// auto-generated look — a rounded square with a white "F".
function makeIcon(size: number, color: string): ImageData {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, size * 0.18);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(size * 0.72)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('F', size / 2, size * 0.56);
  return ctx.getImageData(0, 0, size, size);
}

function paintActionIcon(color: string) {
  try {
    chrome.action.setIcon({
      imageData: {
        16: makeIcon(16, color),
        32: makeIcon(32, color),
        48: makeIcon(48, color),
        128: makeIcon(128, color),
      },
    });
  } catch { /* OffscreenCanvas/action unavailable — ignore */ }
}

// Recolour the toolbar icon. "Not working" (forceActive) is grey regardless of
// page. While "Working" the colour depends on the currently active tab: green on
// a whitelisted page, yellow on any other page. Because that depends on which tab
// is in front, we look up the active tab of the last-focused window each time.
function updateActionIcon() {
  try {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      // Piggy-backed here because this already runs on every event that can change
      // which page is in front (tab activated, tab navigated, window focused), so
      // the page the companion offers cannot drift from the one the icon describes.
      rememberPage(tabs[0]);
      if (settings.forceActive) { paintActionIcon('#94a3b8'); return; } // grey
      const url = tabs[0]?.url ?? '';
      const whitelisted = !!url && isAllowedUrl(url);
      paintActionIcon(whitelisted ? '#22c55e' : '#eab308'); // green | yellow
    });
  } catch {
    paintActionIcon('#22c55e');
  }
}

// ── The last ordinary web page ────────────────────────────────────────────────
// Which page the companion window offers to whitelist. It cannot work that out for
// itself: the companion IS a window, so "which tab is active?" answers "the
// companion" exactly while you are looking at it — the same structural problem that
// makes AgentStatus.recent necessary for programs. So the background remembers the
// last http(s) page instead, and anything that is not one (the companion, the
// dashboard, chrome:// pages) simply leaves the memory alone.
let lastPageUrl = '';
let lastPageTabId: number | null = null;

function rememberPage(tab?: chrome.tabs.Tab): boolean {
  const url = tab?.url ?? '';
  if (typeof tab?.id !== 'number' || !/^https?:/i.test(url)) return false;
  lastPageUrl = url;
  lastPageTabId = tab.id;
  return true;
}

/** Hostname without `www.` — the form the whitelist stores and the popup shows. */
function pageDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ── Writing settings from the background ──────────────────────────────────────
// THE single background-side writer of `settings`, and it exists because the
// storage.onChanged listener below cannot see these writes for what they are.
//
// That listener is how a settings change normally reaches the rest of this file:
// it diffs the incoming value against `settings` and, on a whitelist change, mirrors
// the list to the server and recolours the toolbar icon. It works for the popup,
// which writes storage directly — the background's copy really is the old one at
// that moment. It CANNOT work for a write made here: by the time storage fires we
// have already assigned the new value to `settings`, so `prev` and the new value are
// the same list, `whitelistChanged` is false, and queueDomains() never runs.
//
// That was not merely a missing sync. With the edit never queued, the next post
// came back carrying the server's older list, and applyState() overwrites
// Settings.allowedDomains with whatever the server sent — so a page whitelisted from
// the companion window counted for a few seconds and then silently stopped, with the
// entry gone from the popup's editor. The follow-ups therefore have to be done here,
// explicitly, by whoever made the change.
function saveSettings(next: Settings) {
  const prev = settings;
  settings = next;
  chrome.storage.local.set({ focusFlowSettings: settings });

  const whitelistChanged =
    prev.allowedDomains.join('\n') !== settings.allowedDomains.join('\n');
  if (whitelistChanged) {
    updateActionIcon();          // the front page may have just flipped green↔yellow
    void queueDomains(settings.allowedDomains);
  }
  // Only whitelisted programs may keep their display name on disk.
  if ((prev.allowedPrograms ?? []).join('\n') !== (settings.allowedPrograms ?? []).join('\n')) {
    setNamedPrograms(settings.allowedPrograms ?? []);
  }
}

// ── Which whitelist is earning the points right now ───────────────────────────
// Being ON a whitelist and being the thing currently counted are two different facts,
// and the companion shows both: with one window per screen you can watch the editor
// go quiet as the browser page lights up, which is the only way to see that the
// program whitelist and the page whitelist are doing what you think.
//
// Exactly one side can be driving. This function answers for the PROGRAM side, and
// the page side is its complement, because a live session that no allowed program is
// holding up must be one the browser is holding up. Deriving the page's answer rather
// than testing `!osHeld` for it is deliberate: `osHeld` is also set while reading a
// PDF, where the browser genuinely IS the work but no page heartbeat can ever arrive,
// and reading it directly would call that idle.
// Both answers are gated on this rather than on `isHeartbeatActive` alone, because the
// two are not the same question. `isHeartbeatActive` covers the whole idle timeout,
// INCLUDING the final stretch where chrome.idle has already reported "idle", the
// anchor is set and the "I" countdown is visibly falling — a stretch in which no
// heartbeat is registered and no point is earned. Saying WORKING there would be
// describing a session that has already stopped counting, while the number on the
// screen next to it counts down. See WORKING_FRESH_MS.
function heartbeatsLanding(): boolean {
  return state.isHeartbeatActive && Date.now() - state.lastHeartbeat < WORKING_FRESH_MS;
}

function programIsDriving(): boolean {
  const live = currentProgram();
  return heartbeatsLanding() && state.osHeld && !!live
    && !isBrowserProgram(live.id) && isAllowedProgram(live.id, settings.allowedPrograms);
}

// ── Companion windows ─────────────────────────────────────────────────────────
// One per screen, bottom-right, because the companion is only useful where you can
// see it: on a two-monitor desk the browser is on one screen and the work is on the
// other, and a single companion is on the wrong one roughly half the time. So the
// button on the companion opens ANOTHER one, and each goes to the first screen that
// has none — which on a normal desk means one click per extra monitor and no
// dragging. They are all the same window content reading the same broadcast state,
// so there is nothing to keep in sync between them.
//
// Placement lives here rather than in the popup for two reasons: the popup closes
// the moment the window opens, taking any callback with it, and chrome.system.display
// is a background-only concern.
// 30% off each side of the original 300×260 — a quarter of the area. This window is
// meant to be *beside* the work rather than looked at, so the smallest size that can
// still be read at a glance is the right one; the drawing is resolution-independent
// (a 480×240 picture scaled into whatever box it gets) and the two whitelist bars
// ellipsize, so nothing breaks on the way down. The one part that does not shrink is
// the window frame the platform draws, which is why the height loses proportionally
// more of its content than the width. A platform that refuses a window this small
// clamps it up to its own minimum, which costs nothing but the shrinking.
const COMPANION_W = 210;
const COMPANION_H = 182;   // canvas + the two whitelist bars + the pin line
const COMPANION_MARGIN = 16;
const COMPANION_IDS_KEY = 'pipWindowIds';

/** Every companion window that still exists, with its bounds. Dead ids are dropped
 *  on the way past — cheaper and more reliable than tracking windows.onRemoved, which
 *  a suspended service worker is not around to hear. */
async function liveCompanions(): Promise<chrome.windows.Window[]> {
  const stored = await new Promise<unknown>((resolve) => {
    chrome.storage.local.get([COMPANION_IDS_KEY, 'pipWindowId'], (r) => {
      // `pipWindowId` is the single-window key earlier versions wrote; adopting it
      // means an upgrade does not orphan the companion the user already has open.
      const many = Array.isArray(r[COMPANION_IDS_KEY]) ? r[COMPANION_IDS_KEY] : [];
      resolve(typeof r.pipWindowId === 'number' ? [...many, r.pipWindowId] : many);
    });
  });
  const ids = [...new Set((stored as unknown[]).filter((v): v is number => typeof v === 'number'))];
  const found = await Promise.all(ids.map((id) => new Promise<chrome.windows.Window | null>((resolve) => {
    chrome.windows.get(id, (w) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(w ?? null);
    });
  })));
  const live = found.filter((w): w is chrome.windows.Window => !!w && typeof w.id === 'number');
  chrome.storage.local.set({ [COMPANION_IDS_KEY]: live.map((w) => w.id as number) });
  chrome.storage.local.remove('pipWindowId');
  return live;
}

function getDisplays(): Promise<chrome.system.display.DisplayUnitInfo[]> {
  return new Promise((resolve) => {
    try {
      chrome.system.display.getInfo((d) => resolve(chrome.runtime.lastError ? [] : (d ?? [])));
    } catch {
      resolve([]);   // permission or API unavailable — fall back to no placement
    }
  });
}

/** Which display a window is on: the one containing its centre. A window straddling
 *  two screens belongs to whichever shows more of it, which is what a centre test
 *  gives you for free. -1 when nothing matches (an unplugged monitor). */
function displayOf(win: chrome.windows.Window, displays: chrome.system.display.DisplayUnitInfo[]): number {
  const cx = (win.left ?? 0) + (win.width ?? 0) / 2;
  const cy = (win.top ?? 0) + (win.height ?? 0) / 2;
  return displays.findIndex((d) => {
    const a = d.workArea;
    return cx >= a.left && cx < a.left + a.width && cy >= a.top && cy < a.top + a.height;
  });
}

/** Put one window bottom-right of `display`, or wherever the browser likes if we have
 *  no display information. Resolves with the new id so the caller can place the next
 *  one knowing this one exists. */
function createCompanion(area?: chrome.system.display.Bounds, step = 0): Promise<number | null> {
  const left = area && area.left + area.width - COMPANION_W - COMPANION_MARGIN - step;
  const top = area && area.top + area.height - COMPANION_H - COMPANION_MARGIN - step;
  return new Promise((resolve) => {
    chrome.windows.create(
      // Deliberately small — this sits in a screen corner while you work elsewhere.
      // The canvas scales with the window, so it survives being shrunk further.
      { url: chrome.runtime.getURL('pip.html'), type: 'popup', width: COMPANION_W, height: COMPANION_H, left, top },
      (w) => resolve(w?.id ?? null),
    );
  });
}

/**
 * Open companion windows.
 *
 *   extra = false — the Working button. Opens **one per screen**, and focuses what is
 *                   already there. There is no setting for the number and there
 *                   should not be: the right answer is a fact about the desk, not a
 *                   preference, and `chrome.system.display` already knows it. A
 *                   number the user has to keep in step with the monitors they
 *                   plugged in is a number they will forget to change.
 *   extra = true  — the companion's own ⧉ button, which is a request for one MORE,
 *                   for the rare desk where a screen wants two.
 */
async function openCompanion(extra: boolean) {
  const live = await liveCompanions();
  const displays = await getDisplays();
  const ids = live.map((w) => w.id as number);

  // Which screens already have one. A window is on the display containing its centre.
  const used = new Set(live.map((w) => displayOf(w, displays)).filter((i) => i >= 0));

  // One per screen. With no display information at all (an API that failed, or a
  // platform that has none) fall back to one — the count has to come from somewhere
  // and "the screen you are looking at" is the only safe guess.
  const want = extra ? live.length + 1 : Math.max(1, displays.length);

  if (live.length >= want) {
    // Nothing to add — the button still has to do something visible, so raise them.
    for (const id of ids) chrome.windows.update(id, { focused: true, drawAttention: true });
    return;
  }

  for (let n = live.length; n < want; n++) {
    let area: chrome.system.display.Bounds | undefined;
    let step = 0;
    if (displays.length) {
      const idx = displays.findIndex((_, i) => !used.has(i));
      if (idx >= 0) {
        used.add(idx);
        area = displays[idx].workArea;
      } else {
        // Every screen already has one → stack on the primary, stepped down and right
        // so the new window is not perfectly hidden behind the old.
        area = displays[Math.max(0, displays.findIndex((d) => d.isPrimary))].workArea;
        step = n * 26;
      }
    }
    const id = await createCompanion(area, step);
    if (id != null) ids.push(id);
  }
  chrome.storage.local.set({ [COMPANION_IDS_KEY]: ids });
}

// ── The phone nudge ───────────────────────────────────────────────────────────
// The one thing on screen cannot help with the one failure it exists for: you have
// stopped looking at the screen. The beep needs the volume up and the room quiet, the
// trembling character needs your eyes on it, and neither reaches a pocket. A phone
// does, and it does it by vibrating — which is the whole point of firing at the START
// of the 5-second warning rather than at the penalty: there is still time to come back
// before anything is lost.
//
// Telegram, and not Web Push or an app of our own, because it is the only route that
// costs nothing to build, needs nothing installed on the desktop, nothing hosted, no
// keys to rotate and — decisively — no iOS build. It is one HTTPS POST from here.
// Whether it actually buzzes is the phone's business (Telegram's per-chat notification
// settings), which is exactly why the popup has a Test button: that is the only honest
// way to find out.
//
// It is off by default, and the message names NO page and NO program. This is the only
// thing the extension sends anywhere other than its own backend, and the timing of
// these messages is itself a record of when the user drifts — so the payload is kept
// to the one fact the user asked to be told.
const TELEGRAM_API = 'https://api.telegram.org';
/** Last nudge, in storage rather than a module variable — see TELEGRAM_COOLDOWN_MS. */
const TELEGRAM_LAST_KEY = 'focusTelegramAt';
let telegramLastAt = 0;

function telegramConfigured(): boolean {
  return settings.telegramEnabled === true
    && !!settings.telegramToken?.trim()
    && !!settings.telegramChatId?.trim();
}

/** POST one Telegram method, and turn every way it can fail into one shape. Telegram
 *  answers 200 with `ok: false` for most real errors (bad token, unknown chat), so the
 *  HTTP status alone proves nothing and the body has to be read either way. */
async function telegramCall(method: string, body: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const token = settings.telegramToken?.trim();
  if (!token) return { ok: false, error: 'No bot token' };
  try {
    const r = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null) as { ok?: boolean; result?: unknown; description?: string } | null;
    if (!data) return { ok: false, error: `HTTP ${r.status}` };
    if (!data.ok) return { ok: false, error: data.description || `HTTP ${r.status}` };
    return { ok: true, result: data.result };
  } catch {
    // No network, or Telegram unreachable. A missed nudge is a missed nudge; nothing
    // else in the session depends on it, so it is never retried or queued.
    return { ok: false, error: 'Could not reach Telegram' };
  }
}

/** Fire the nudge, if everything about the moment says it should be fired. Called from
 *  writeState on the active→idle edge, which is the same instant the sprite starts its
 *  warning — one edge, one definition, no second timer to drift from it. */
function buzzPhone(): void {
  if (!settings.enabled || settings.forceActive || !telegramConfigured()) return;
  const now = Date.now();
  // Only a real lapse. The idle flag is cleared by things that are not one — the
  // popup's "remove this domain" drops it outright, mid-click — and a phone that
  // buzzes for a button the user just pressed is a phone they learn to ignore before
  // the first genuine nudge arrives. Both real paths into idle (the OS anchor in
  // applyOsIdleReading and the backup expireStaleHeartbeat) can only fire once the
  // whole idleTime has passed with no input, so that is the test, and it needs no
  // second flag to be kept in step with them.
  if (now - state.lastHeartbeat < clampIdleTime(settings.idleTime) * 1000 - 500) return;
  if (now - telegramLastAt < TELEGRAM_COOLDOWN_MS) return;
  telegramLastAt = now;
  chrome.storage.local.set({ [TELEGRAM_LAST_KEY]: now });
  void telegramCall('sendMessage', {
    chat_id: settings.telegramChatId.trim(),
    text: `⏳ Focus — you have gone idle. ${Math.round(IDLE_WARNING_MS / 1000)}s to come back before it counts against you.`,
    // Explicit, because the default is what a silent notification would use and this
    // message exists ONLY to make a noise in a pocket.
    disable_notification: false,
  });
}

// ── Init from storage ─────────────────────────────────────────────────────────
chrome.storage.local.get(['focusFlowState', 'focusFlowSettings', TELEGRAM_LAST_KEY], (result) => {
  // Left behind by a version that tried to detect a broken chrome.idle at runtime.
  chrome.storage.local.remove('idleApiProven');
  // A revived worker has forgotten when it last nudged, and the gap it has forgotten
  // is exactly the one where the user was away long enough to be dropped.
  if (typeof result[TELEGRAM_LAST_KEY] === 'number') telegramLastAt = result[TELEGRAM_LAST_KEY];
  if (result.focusFlowState) {
    state = { ...state, ...(result.focusFlowState as SessionState) };
  }
  if (result.focusFlowSettings) {
    settings = { ...DEFAULT_SETTINGS, ...(result.focusFlowSettings as Settings) };
  } else {
    // First run — persist defaults so heartbeat.ts can read the domain list immediately
    chrome.storage.local.set({ focusFlowSettings: DEFAULT_SETTINGS });
  }
  state.enabled = settings.enabled;
  setNamedPrograms(settings.allowedPrograms ?? []);
  if (settings.forceActive) state.isHeartbeatActive = true;
  updateActionIcon();
  chrome.windows.getLastFocused((win) => {
    if (win.id) updateState({ activeWindowId: win.id });
  });
  // The other check-in the spec asks for: the browser has just opened (this block
  // runs on every service-worker start). Flushes anything pending from the last
  // session and pulls the current live score + averages back. With nothing pending
  // this is the (0, 0) post, i.e. a pure read.
  void flush();
});

// onStartup fires only on a real browser launch, whereas the block above also runs
// whenever the service worker is merely revived from suspension. Both are wanted —
// a launch must always check in, even if the worker had been alive moments before —
// and flush() is idempotent, so the overlap costs at most one extra empty request.
chrome.runtime.onStartup.addListener(() => { void flush(); });

// A fresh install or update has no pending deltas, but this creates the user's
// server row and seeds the whitelist so the study has their configuration from the
// start rather than only after their first accidental edit.
chrome.runtime.onInstalled.addListener(() => {
  void flush();
  void queueDomains(settings.allowedDomains);
});

// Pick up settings changes written directly by the popup.
//
// Only the popup: a change made HERE has already been assigned to `settings` by the
// time this fires, so every diff below reads as "nothing changed". That is what
// saveSettings() is for — it does these same follow-ups itself. Do not move them
// back in here on the assumption that one listener covers both writers.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.focusFlowSettings) {
    const prev = settings;
    settings = { ...DEFAULT_SETTINGS, ...(changes.focusFlowSettings.newValue as Settings) };
    // Broadcast enabled change immediately so sprites show/hide
    if (prev.enabled !== settings.enabled) {
      updateState({ enabled: settings.enabled });
    }
    // Either way round, the toggle snaps the session ACTIVE and restarts the idle
    // clock. Switching to "Not working" pins the sprite active by definition; but
    // switching back to "Working" has to as well, because it is a statement of
    // intent — the user has just said they are working, so they get a full idleTime
    // before anything can call them idle. Setting `isHeartbeatActive` to
    // `settings.forceActive` (i.e. false on the way back) instead declared them idle
    // at the exact moment they said the opposite, which cost a −10 and, once the
    // lapse outran the nag, auto-paused them straight back to "Not working" — the
    // "the first click does nothing but dock me 10 points" bug.
    if (prev.forceActive !== settings.forceActive) {
      resetOsAnchor(); // stale anchor would immediately re-idle on the way back
      updateState({ isHeartbeatActive: true, lastHeartbeat: Date.now() });
      // Clear the lapse bookkeeping now rather than waiting for the next tick, so
      // nothing left over from the previous lapse can land on this fresh one.
      idleWasActive = true;
      idleSince = 0;
      idlePenaltyApplied = false;
      autoPauseApplied = false;
      // The Working / Not-working button was clicked — one of the three moments the
      // client checks in. Hooked here rather than in the popup so it fires however
      // the toggle was flipped (the button, or the auto-pause after a long idle).
      void flush();
    }
    // Recolour the toolbar icon whenever the working state OR the whitelist changed
    // (whitelisting the current page flips its icon green↔yellow).
    const whitelistChanged =
      prev.allowedDomains.join('\n') !== settings.allowedDomains.join('\n');
    if (prev.forceActive !== settings.forceActive || whitelistChanged) {
      updateActionIcon();
    }
    // Mirror the whitelist to the server. queueDomains ignores a list identical to
    // the one the server last sent, which is what stops this from looping: every
    // server reply writes allowedDomains, which fires this very listener.
    if (whitelistChanged) {
      void queueDomains(settings.allowedDomains);
    }
    // Only whitelisted programs get their display name written to disk.
    setNamedPrograms(settings.allowedPrograms ?? []);
  }
});

// ── State helpers ─────────────────────────────────────────────────────────────
// updateState is the ONLY writer of SessionState, which makes it the one place
// worth hooking the server sync into: any future code path that awards or docks
// points is picked up automatically instead of needing its own call. queueDelta
// ignores anything that isn't a rise in focus / fall in distracted, so the daily
// rollover zeroing both counters is correctly not forwarded as a huge negative
// delta — the server runs its own rollover.
function writeState(newState: Partial<SessionState>) {
  const wasActive = state.isHeartbeatActive;
  state = { ...state, ...newState };
  chrome.storage.local.set({ focusFlowState: state });
  broadcastState();
  // The active→idle edge IS the start of the warning — the same transition every
  // surface starts its countdown on. Hooked here rather than beside the countdown in
  // trackIdlePenalty for the same reason the server sync hooks into updateState: this
  // is the single funnel every writer goes through, so a future path into idle cannot
  // forget to nudge. (touchState does not come through here, which is correct: it is
  // the "still active" refresh, and it never changes this flag.)
  if (wasActive && !state.isHeartbeatActive) buzzPhone();
}

function updateState(newState: Partial<SessionState>) {
  const prevFocus = state.focusScore;
  const prevDistracted = state.distractedScore;
  writeState(newState);
  if (state.focusScore !== prevFocus || state.distractedScore !== prevDistracted) {
    void queueDelta(state.focusScore - prevFocus, state.distractedScore - prevDistracted);
  }
}

// Reconciliation from the server. Goes through writeState, NOT updateState, and that
// is the whole point: updateState would diff the scores it just received against the
// old ones and post the difference straight back, which compounds on every reply.
//
// Local scores are updated optimistically when a point is earned, so the sprite's +1
// and the −10 fly-up are instant; this then replaces the displayed figure with the
// server's, which is the value shared across all of the user's devices. Neither the
// fly-up nor the fireworks are affected, because both are driven by their own
// timestamp nonces (penaltyAt / iconChangeAt), not by the score numbers changing.
function applyServerScores(focus: number, distracted: number, liveDay: string) {
  if (state.focusScore === focus &&
      state.distractedScore === distracted &&
      state.scoreDate === liveDay) return;
  writeState({ focusScore: focus, distractedScore: distracted, scoreDate: liveDay });
}

// In-memory only: no storage write, no fan-out to tabs. Used for the "still
// active" refreshes the 2 Hz poll makes, which change nothing anyone can see.
function touchState(newState: Partial<SessionState>) {
  state = { ...state, ...newState };
}

function broadcastState() {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: 'STATE_UPDATE', state }).catch(() => {});
      }
    });
  });
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state }).catch(() => {});
}

// ── Score ──────────────────────────────────────────────────────────────────────
// Two independent counters, persisted in SessionState, each moving one way only:
//   • focusScore      rises by 30/x on every character change (see registerHeartbeat).
//   • distractedScore falls by 10 once an idle lapse has outlasted the warning face
//                     AND the grace period after it — so it runs negative.
// Neither is clamped against the other; they're kept apart on purpose so a bad
// stretch never erases earned focus. Rounded to 2 decimals so small (large-x)
// focus increments still accumulate cleanly.
//
// An idle lapse runs in three phases:
//   0 … 5 s   warning  — the sprite shows the crying face only (IDLE_WARNING_MS
//                        in sprite.ts; keep the two in sync).
//   5 … 10 s  grace    — the real idle behaviour (beep, grow) has started, but the
//                        counters are untouched: there's still time to come back.
//   > 10 s             — the −10 lands on distractedScore, once per lapse.
// Finally, once the beep has run its full cryBeepDuration the lapse is treated as
// "you've stopped working" and the status auto-switches to Not working.
// (Timeline constants — IDLE_WARNING_MS, IDLE_GRACE_MS, IDLE_PENALTY — and the
//  derived delays live in ./timings.ts, shared with the sprite.)
let idleWasActive = state.isHeartbeatActive; // tracks the active→idle edge
let idleSince = 0;              // when the current idle lapse began
let idlePenaltyApplied = false; // one penalty per idle lapse
let autoPauseApplied = false;   // one auto "Not working" switch per idle lapse

// ── Day boundaries live on the server ─────────────────────────────────────────
// There is deliberately no local rollover here. The server ends the day (its cron
// job, at 01:00 in the user's own timezone) and its reply carries both the reset
// live score and the 30 most recent completed days, which applyState() writes into
// the local history cache. A second, midnight-based rollover in the client would
// only disagree with it: the two boundaries are an hour apart, so it used to zero
// the score at 00:00 and then have it jump back on the next post.
//
// state.scoreDate is now set from the server's live_day, so "today" in the popup
// means the server's focus-day rather than a locally computed date.

// Called once per second from the status loop. Detects the transition into idle
// and, once that lapse has outlasted the warning + grace phases, deducts the
// penalty a single time until activity resumes.
function trackIdlePenalty() {
  const now = Date.now();
  if (state.isHeartbeatActive) {
    idleWasActive = true;
    idlePenaltyApplied = false;
    autoPauseApplied = false;
    return;
  }
  // Anchor the lapse. Two ways in: the active→idle edge, and finding ourselves
  // already idle with no anchor at all (`idleSince` still 0).
  //
  // That second case is not hypothetical, and leaving it out was a real bug: an MV3
  // worker starts fresh on every browser launch and every revival from suspension,
  // so it routinely arrives mid-lapse having never seen the edge. `idleSince` is 0
  // then, and 0 is a TIMESTAMP — it dates the lapse to 1970, so `now - idleSince` is
  // decades and every threshold below fires on the very first tick: an instant −10
  // and an instant auto-pause, seconds after opening the browser.
  //
  // Anchoring at `now` rather than at state.lastHeartbeat is deliberate too. The
  // penalty is for a lapse this worker actually watched; time the extension spent
  // suspended — or the browser spent closed — is not evidence that the user sat
  // there doing nothing, and charging for it would dock people for going to bed.
  if (idleWasActive || !idleSince) {
    idleWasActive = false;
    idleSince = now;
    idlePenaltyApplied = false;
    autoPauseApplied = false;
  }
  if (!idlePenaltyApplied && now - idleSince > idlePenaltyDelayMs()) {
    idlePenaltyApplied = true;
    // penaltyAt is a nonce the sprite watches to play the "−10" fly-up once.
    updateState({ distractedScore: round2(state.distractedScore - IDLE_PENALTY), penaltyAt: now });
  }
  // The beep has nagged for its full duration and you're still gone → you're not
  // working, so stop nagging and say so. We only WRITE the setting: the
  // storage.onChanged listener above owns applying it, so the sprite snap and the
  // toolbar recolour go through exactly the same path as the popup's own toggle.
  // (Writing `settings` here first would make that listener see no change and skip
  // both.) Deliberately keyed off cryBeepDuration whether or not the sound is
  // actually enabled — it's the "how long do I nag you" knob either way.
  const nagEndsAt = autoPauseDelayMs(clampCryBeepDuration(settings.cryBeepDuration));
  if (!autoPauseApplied && now - idleSince > nagEndsAt) {
    autoPauseApplied = true;
    chrome.storage.local.set({ focusFlowSettings: { ...settings, forceActive: true } });
  }
}

// ── Window focus (activeWindowId only) ───────────────────────────────────────
// onFocusChanged is used purely to keep activeWindowId current.
// It is NOT used for preserve logic — unreliable for OS-level focus on Linux.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    updateState({ activeWindowId: windowId });
    updateActionIcon(); // the front page changed — recolour green/yellow
  }
});

// ── Activity monitor ──────────────────────────────────────────────────────────
// One simple model: heartbeats drive the status, and every source of them lives
// in ./heartbeats — page input, focused viewer tabs, and OS-wide activity. Status
// depends ONLY on heartbeat recency: if nothing has refreshed the heartbeat within
// `idleTime` s, the sprite goes Idle.
//
// Counting is event-driven (see registerHeartbeat), so this once-per-second loop
// only handles the forceActive tick, the backup Idle expiry and the idle-lapse
// scoring. Day boundaries are the server's business — see above.
setInterval(() => {
  if (!settings.enabled) return;

  if (settings.forceActive) {
    forceActiveTick(); // forced mode still accumulates + steps
    return;
  }

  expireStaleHeartbeat();
  trackIdlePenalty(); // dock points for an idle lapse longer than 5 s
}, STATUS_LOOP_MS);

// Start every heartbeat source. This file stays the owner of SessionState; the
// heartbeats module reads it through these accessors and only ever writes back
// through updateState/touchState, so there's still exactly one writer.
initHeartbeats({
  getState: () => state,
  getSettings: () => settings,
  updateState,
  touchState,
  isAllowedUrl,
});

// Let the server reconcile the displayed live score after each post.
initSync({ onServerScores: applyServerScores });

// Mirrors heartbeat.ts: a URL is authorized when it matches a whitelisted domain.
function isAllowedUrl(url: string): boolean {
  return settings.allowedDomains.some(d => d.trim() !== '' && url.includes(d.trim()));
}

/** The whitelist entries a URL matches — the same test as isAllowedUrl, kept beside
 *  it so the two can never disagree about what "allowed" means. Which entries
 *  matched is what removing a page has to act on, and what the companion's undo
 *  button names, because it is rarely just the hostname. */
function matchingDomains(url: string): string[] {
  return settings.allowedDomains.filter(d => d.trim() !== '' && url.includes(d.trim()));
}

// ── AI classification ─────────────────────────────────────────────────────────
// Shared classifier used by both the content-script CLASSIFY_PAGE message (HTML
// pages) and the background-side viewer flow below (PDF pages, where no content
// script runs). Resolves with the model's verdict, or { offline } if Ollama is
// unreachable so callers can degrade gracefully.
type Classification = { isStudy: boolean; raw: string; error?: string; offline?: boolean };

function classifyPage(url: string, title: string): Promise<Classification> {
  const model = settings.classifyModel?.trim() || 'qwen-yesno';
  // Where the AI backend lives. Local: http://localhost:11434. Remote: whatever the
  // user configured. Strip any trailing slash so we can append the API paths cleanly.
  const base = (settings.classifyUrl?.trim() || 'http://localhost:11434').replace(/\/+$/, '');
  // Auth header only when a key is set — a local model needs none.
  const key = settings.classifyApiKey?.trim();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Origin': 'http://localhost' };
  if (key) headers['Authorization'] = `Bearer ${key}`;
  // Cap CPU usage so a classification request never pins the machine.
  const options = settings.classifyNumThreads > 0
    ? { num_thread: settings.classifyNumThreads }
    : undefined;
  // Warm-up ping (best effort) — loads the model so the real call is fast.
  fetch(`${base}/api/generate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, prompt: '', keep_alive: '10m', options }),
  }).catch(() => {});
  return fetch(`${base}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      stream: false,
      options,
      messages: [{
        role: 'user',
        content: `${settings.classifyPrompt}\n\nURL: ${url}\nTitle: ${title}`,
      }],
    }),
  })
    .then(async (r): Promise<Classification> => {
      const text = await r.text();
      if (!text) return { isStudy: false, raw: '', error: `Empty response (status ${r.status}) — restart Ollama with: OLLAMA_ORIGINS="*" ollama serve` };
      let data: { message?: { content?: string }; error?: string };
      try { data = JSON.parse(text); } catch { return { isStudy: false, raw: '', error: `Bad JSON: ${text.slice(0, 80)}` }; }
      if (!r.ok || data.error) return { isStudy: false, raw: '', error: data.error ?? `HTTP ${r.status}` };
      const raw = (data?.message?.content ?? '').trim();
      return { isStudy: raw.toUpperCase().startsWith('YES'), raw };
    })
    // No Ollama reachable → page left unclassified (inactive, not auto-added).
    .catch((): Classification => ({ isStudy: false, raw: '', offline: true }));
}

// ── Viewer (PDF) classification ───────────────────────────────────────────────
// PDFs render in Chrome's built-in viewer, so heartbeat.ts never runs there and
// the usual content-script "ask AI → auto-whitelist → reload" flow can't fire.
// We reproduce it from the background: when a focused viewer tab isn't yet
// whitelisted, classify it; on YES, add its domain and reload so the (now
// authorized) viewer heartbeat fallback takes over.
const NEVER_WHITELIST = ['youtube.com', 'youtu.be'];
const handledViewerUrls = new Set<string>(); // dedupe: don't re-ask per activation

function maybeClassifyViewerTab(tab?: chrome.tabs.Tab) {
  if (!tab || typeof tab.id !== 'number') return;
  const url = tab.url;
  if (!settings.enabled || settings.forceActive || !settings.aiRequestEnabled) return;
  if (!url || !/^https?:/i.test(url)) return;      // http(s) only — needs a domain to whitelist
  if (isAllowedUrl(url)) return;                    // already authorized
  if (hasContentScript(tab.id)) return;            // a normal HTML page → heartbeat.ts handles it
  if (handledViewerUrls.has(url)) return;          // already asked this URL

  handledViewerUrls.add(url);
  const tabId = tab.id;
  classifyPage(url, tab.title ?? '').then((res) => {
    if (res.offline || res.error) { handledViewerUrls.delete(url); return; } // allow a later retry
    if (!res.isStudy) return;                       // NO is remembered (no re-ask)
    let host: string;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return; }
    if (!host || NEVER_WHITELIST.some(d => host.includes(d))) return;
    if (!settings.allowedDomains.includes(host)) {
      saveSettings({ ...settings, allowedDomains: [...settings.allowedDomains, host] });
    }
    chrome.tabs.reload(tabId);
  });
}

// Give any content script ~2.5s to report in first; if none does, the focused
// tab is a viewer and we classify it from here.
function scheduleViewerClassify(tabId: number) {
  setTimeout(() => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab.active) return;
      maybeClassifyViewerTab(tab);
    });
  }, VIEWER_CLASSIFY_DELAY_MS);
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.active) scheduleViewerClassify(tabId);
  // A navigation on the active tab may have changed its whitelist status
  if (tab.active && (info.url || info.status === 'complete')) updateActionIcon();
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  scheduleViewerClassify(tabId);
  updateActionIcon(); // switched tabs — recolour green/yellow for the new front page
});

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message: MessageType, sender, sendResponse) => {
  switch (message.type) {
    case 'HEARTBEAT':
      onPageHeartbeat(sender.tab?.id);
      break;

    case 'FOCUS_PING':
      onFocusPing(sender.tab?.id);
      break;

    case 'ADD_DOMAIN': {
      const domain = message.domain.trim();
      const NEVER_WHITELIST = ['youtube.com', 'youtu.be'];
      if (domain && !settings.allowedDomains.includes(domain) && !NEVER_WHITELIST.some(d => domain.includes(d))) {
        saveSettings({ ...settings, allowedDomains: [...settings.allowedDomains, domain] });
      }
      sendResponse({});
      break;
    }

    case 'REMOVE_DOMAIN': {
      const domain = message.domain.trim();
      saveSettings({ ...settings, allowedDomains: settings.allowedDomains.filter(d => d !== domain) });
      updateState({ isHeartbeatActive: false });
      sendResponse({});
      break;
    }

    case 'CLASSIFY_PAGE': {
      classifyPage(message.url, message.title).then(sendResponse);
      break;
    }

    // Read the chat id off the bot's own inbox. Nobody knows their own chat id and
    // there is no way to look it up in the app, so the alternative is telling people
    // to message a third-party "id bot" — which means handing a stranger's bot the
    // first message of the setup. One getUpdates on their own bot is the whole answer.
    case 'TELEGRAM_LINK': {
      void telegramCall('getUpdates', { limit: 10, timeout: 0 }).then((r) => {
        if (!r.ok) { sendResponse({ ok: false, error: r.error } satisfies TelegramResult); return; }
        const updates = Array.isArray(r.result) ? r.result : [];
        // The most recent chat that has said anything, so a user who has been talking
        // to their bot for other reasons still lands on the conversation they just used.
        let chatId = '';
        for (const u of updates) {
          const chat = (u as { message?: { chat?: { id?: number | string } } })?.message?.chat;
          if (chat?.id != null) chatId = String(chat.id);
        }
        if (!chatId) {
          sendResponse({
            ok: false,
            error: 'No message yet — open the bot in Telegram, send it anything, then press Find again',
          } satisfies TelegramResult);
          return;
        }
        sendResponse({ ok: true, chatId } satisfies TelegramResult);
      });
      break;
    }

    // The only way to learn whether the phone will actually buzz: Telegram's per-chat
    // notification settings are the phone's business, not ours, and a nudge that
    // arrives silently is indistinguishable from one that never arrived.
    case 'TELEGRAM_TEST': {
      void telegramCall('sendMessage', {
        chat_id: settings.telegramChatId?.trim(),
        text: '✅ Focus — this is what an idle nudge will feel like.',
        disable_notification: false,
      }).then((r) => sendResponse({ ok: r.ok, error: r.error } satisfies TelegramResult));
      break;
    }

    // The optional desktop agent. Answered AFTER the probe it triggers rather than
    // from the cache: whoever asks is a UI with a human in front of it, and the
    // difference shows exactly when it matters — someone reading "the agent is off",
    // starting it, and waiting for that to clear. Replying from the cache made them
    // wait for the following poll on top of the backoff. On loopback the probe costs
    // a millisecond, and refreshProgram still enforces its own interval, so this
    // cannot become a request per keystroke.
    case 'AGENT_STATUS': {
      void refreshProgram(true).then(() => {
        const program = currentProgram();
        const recent = recentProgram();
        const recentAllowed = !!recent && isAllowedProgram(recent.id, settings.allowedPrograms);
        sendResponse({
          running: isAgentOnline(),
          program,
          allowed: !!program && isAllowedProgram(program.id, settings.allowedPrograms),
          recent,
          recentAllowed,
          // Whitelisted is not the same as working — see programIsDriving(). The id
          // comparison is what makes it "this program": `recent` is the last
          // non-browser program, which is not necessarily the one in front now.
          recentWorking: recentAllowed && programIsDriving()
            && !!program && !!recent && normaliseProgram(program.id) === normaliseProgram(recent.id),
          names: programNames(),
          note: agentNote(),
        } satisfies AgentStatus);
      });
      break;
    }

    // Adding a program from the companion window, which has no settings UI of its
    // own. Routed through here rather than written straight to storage because the
    // background already holds the authoritative `settings`; a writer that knew only
    // this one field would have to read-modify-write and could clobber a concurrent
    // edit made in the popup.
    case 'ADD_PROGRAM': {
      const id = normaliseProgram(message.program);
      const programs = settings.allowedPrograms ?? [];
      // A browser is never evidence of work on its own — the page whitelist decides
      // those — so the door is shut here as well, not only in the UI that offers it.
      if (id && !isBrowserProgram(id) && !programs.includes(id)) {
        // saveSettings takes care of setNamedPrograms — its name may now be saved.
        saveSettings({ ...settings, allowedPrograms: [...programs, id] });
      }
      sendResponse({});
      break;
    }

    case 'REMOVE_PROGRAM': {
      const id = normaliseProgram(message.program);
      const programs = settings.allowedPrograms ?? [];
      if (id && programs.includes(id)) {
        // Its name is no longer one we may keep on disk — saveSettings drops it.
        saveSettings({ ...settings, allowedPrograms: programs.filter((p) => p !== id) });
      }
      sendResponse({});
      break;
    }

    // The page half of the companion window's two one-click buttons.
    case 'PAGE_STATUS': {
      const reply = () => {
        const domain = pageDomain(lastPageUrl);
        const matched = lastPageUrl ? matchingDomains(lastPageUrl) : [];
        sendResponse({
          domain,
          allowed: matched.length > 0,
          // The complement of AgentStatus.recentWorking: a live session that no
          // allowed program is holding up is one the browser is holding up, and the
          // only page it can be is the one in front — this one. Includes the PDF
          // case, where the session is genuinely the browser's work even though
          // osHeld is set and no page heartbeat can arrive.
          working: heartbeatsLanding() && matched.length > 0 && !programIsDriving(),
          matched,
        } satisfies PageStatus);
      };
      if (lastPageUrl) { reply(); break; }
      // Nothing remembered yet. A service worker that has just been revived has seen
      // no tab events, and a user who is reading rather than browsing may not
      // generate one for a long time — so look now rather than leave the bar blank.
      // Every window's active tab, since the focused one may be the companion.
      chrome.tabs.query({ active: true }, (tabs) => {
        for (const tab of tabs) if (rememberPage(tab)) break;
        reply();
      });
      break;
    }

    // Deliberately takes no argument: the caller does not know which page it means,
    // which is the whole reason this lives here. Reloads the tab afterwards, exactly
    // as the popup's own toggle does — heartbeat.ts decides whether to activate at
    // document start, so an already-open page keeps ignoring itself until it does.
    //
    // NEVER_WHITELIST is deliberately NOT consulted. It exists to stop the AI
    // classifier and the content script adding YouTube *by themselves*; this is a
    // person deliberately pressing a button, which the popup's own per-page toggle
    // already honours. Refusing here would mean the same page could be whitelisted
    // from one surface and not the other.
    case 'WHITELIST_PAGE': {
      const domain = pageDomain(lastPageUrl);
      if (domain && !settings.allowedDomains.includes(domain)) {
        saveSettings({ ...settings, allowedDomains: [...settings.allowedDomains, domain] });
        if (lastPageTabId != null) chrome.tabs.reload(lastPageTabId);
      }
      sendResponse({});
      break;
    }

    // The undo. It drops EVERY whitelist entry that matches the page, not just an
    // exact hostname match, because the rule that whitelisted it is a substring test:
    // it is `unipd.it` that makes `overleaf.dei.unipd.it` count, and removing only
    // the exact hostname would leave the page still counting and the companion still
    // showing a tick — a button that visibly does nothing. Same rule the popup's own
    // toggle applies, and it ends the session for the same reason REMOVE_DOMAIN does.
    case 'UNWHITELIST_PAGE': {
      const drop = lastPageUrl ? new Set(matchingDomains(lastPageUrl)) : new Set<string>();
      if (drop.size) {
        const keep = settings.allowedDomains.filter((d) => !drop.has(d));
        saveSettings({ ...settings, allowedDomains: keep });
        updateState({ isHeartbeatActive: false });
        if (lastPageTabId != null) chrome.tabs.reload(lastPageTabId);
      }
      sendResponse({});
      break;
    }

    case 'OPEN_COMPANION':
      void openCompanion(message.extra === true);
      sendResponse({});
      break;

    case 'GET_STATE':
      sendResponse(state);
      break;

    // ── Server sync ──────────────────────────────────────────────────────────
    // Sign-in must run here rather than in the popup: launchWebAuthFlow opens a
    // window, which closes the popup, which would tear down the flow before Google
    // redirects back.
    case 'SERVER_SIGN_IN':
      signIn().then((session) => {
        if (session) {
          // Seed the account so a new participant has a server row and their current
          // whitelist recorded, rather than waiting for their first point. From here
          // on the server owns the list and sends it back on every post.
          void queueDomains(settings.allowedDomains);
          void flush();
        }
        void replyServerStatus(sendResponse);
      });
      break;

    case 'SERVER_SIGN_OUT':
      signOut().then(() => replyServerStatus(sendResponse));
      break;

    case 'SERVER_STATUS':
      void replyServerStatus(sendResponse);
      break;

    // Each of these returns the full state, which applyState() writes into the same
    // storage keys the popup already watches — so the reply repaints the boards with
    // no second request.
    case 'SERVER_JOIN_TEAM':
      joinTeam(message.team, message.create, message.password).then(sendResponse);
      break;

    case 'SERVER_LEAVE_TEAM':
      leaveTeam(message.team).then(sendResponse);
      break;

    case 'SERVER_ENROLL_TEAM':
      enrollTeam(message.team, message.competition, message.create, message.password).then(sendResponse);
      break;

    case 'SERVER_LEAVE_COMPETITION':
      leaveCompetition(message.team, message.competition).then(sendResponse);
      break;

    // Both reply with the raw payload (or null) rather than a status: they are reads
    // of somebody else's data, so nothing is written to the local caches.
    case 'SERVER_MY_DAYS':
      fetchMyDays().then(sendResponse);
      break;

    case 'SERVER_TEAM_DAYS':
      fetchTeamDays(message.team).then(sendResponse);
      break;

    case 'SERVER_FRIENDS_DAYS':
      fetchFriendsDays().then(sendResponse);
      break;

    case 'SERVER_JOIN_COMPETITION':
      joinCompetition(message.competition, message.create, message.password).then(sendResponse);
      break;

    case 'SERVER_LEAVE_COMPETITION_SOLO':
      leaveCompetitionSolo(message.competition).then(sendResponse);
      break;

    case 'SERVER_FRIENDS_BOARD':
      fetchFriendsBoard(message.metric).then(sendResponse);
      break;

    case 'SERVER_SEARCH_USERS':
      searchUsers(message.query).then(sendResponse);
      break;

    case 'SERVER_FRIEND_REQUEST':
      sendFriendRequest(message.userId).then(sendResponse);
      break;

    case 'SERVER_FRIEND_RESPOND':
      respondFriendRequest(message.requester, message.accept).then(sendResponse);
      break;

    case 'SERVER_FRIEND_REMOVE':
      removeFriend(message.userId).then(sendResponse);
      break;

    case 'SERVER_TEAM_BOARD':
      fetchTeamBoard(message.team, message.metric).then(sendResponse);
      break;

    case 'SERVER_COMPETITION_BOARD':
      fetchCompetitionBoard(message.competition, message.metric).then(sendResponse);
      break;

    case 'SERVER_MEMBER_PROFILE':
      fetchMemberProfile(message.userId).then(sendResponse);
      break;

    case 'SERVER_FLAG_DOMAIN':
      flagDomain(message.domain).then(sendResponse);
      break;
  }
  return true;
});
