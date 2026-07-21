// ─────────────────────────────────────────────────────────────────────────────
//  HEARTBEAT GENERATION — single source of truth
// ─────────────────────────────────────────────────────────────────────────────
//  A "heartbeat" is one observation that the user is working, worth ≈one second.
//  Heartbeats are the ONLY thing that keeps a session alive: the status, the
//  sprite's step, the shrink, the character change and the focus score all hang
//  off them. Everything that can produce one — and the clock that decides when
//  they've stopped — lives in this file, so the whole activity model can be read
//  in one place instead of being scattered through background.ts.
//
//  There are three sources, in descending order of trustworthiness:
//
//    1. PAGE INPUT     heartbeat.ts sends HEARTBEAT on mouse/key/scroll on an
//                      authorized page. Exact: the page timestamps its own input.
//    2. FRONT VIEWER   a PDF/plugin tab runs no content script, so nothing inside
//                      the browser can observe its input. Having one in front is
//                      the only positive evidence of work available — with
//                      chrome.idle allowed to VETO it (see below).
//    3. OS-WIDE INPUT  chrome.idle says input happened somewhere while the front
//                      page reported no focus (you're working in another app).
//                      Only trusted once the API has proven it works here.
//
//  Plus one non-source: forceActive ("Not working" pinned on) ticks the count so
//  the sprite keeps moving, but earns no points.
//
//  chrome.idle is *polled* rather than event-driven because idle transitions can
//  arrive late or not at all on some platforms (notably Linux/Wayland).
// ─────────────────────────────────────────────────────────────────────────────

import {
  SessionState, Settings, CHARACTER_COUNT, clampIconChangeHeartbeats, clampIdleTime, round2,
} from '../types';
import {
  IDLE_POLL_MS, OS_IDLE_FLOOR_S, OS_IDLE_COUNTDOWN_S, HEARTBEAT_THROTTLE_MS, FOCUS_PING_STALE_MS,
} from './timings';

/** What this module needs from background.ts, which still owns the state itself. */
export interface HeartbeatHost {
  getState(): SessionState;
  getSettings(): Settings;
  /** Persist + broadcast a state change (a real transition). */
  updateState(patch: Partial<SessionState>): void;
  /** Mutate the live state in memory only — no storage write, no fan-out. Used by
   *  the 2 Hz poll for the "still active" refresh, which would otherwise write and
   *  broadcast twice a second for no visible change. */
  touchState(patch: Partial<SessionState>): void;
  /** True when the URL matches the user's whitelist. */
  isAllowedUrl(url: string): boolean;
}

let host: HeartbeatHost;

// ── Which tabs run a content script ───────────────────────────────────────────
// Our content script runs on every normal HTML page and pings (FOCUS_PING /
// HEARTBEAT). PDFs and other plugin-rendered documents open in Chrome's built-in
// viewer, where content scripts never run — so a loaded tab that has NEVER
// reported in (despite a real http/file URL) is how we recognise a "viewer" tab
// without depending on its URL.
//
// This is membership, not recency: once a page has shown a content script it is an
// HTML page for good. A quiet/blurred tab (e.g. after you switch windows, when
// FOCUS_PING pauses) must NOT suddenly look like a viewer — otherwise the OS-idle
// fallback would pin it active and it would never go idle. Cleared on navigation
// so a tab that later loads a PDF is re-evaluated.
//
// Chrome wraps a PDF in a real HTML document, so our script technically runs there
// and this test used to misfire — the tab claimed to be a content page while being
// structurally unable to observe input. heartbeat.ts now stays silent on plugin
// documents precisely so this stays true: reporting in means "I can see input".
const contentTabs = new Set<number>();

export function markContentAlive(tabId?: number) {
  if (typeof tabId === 'number') contentTabs.add(tabId);
}

export function hasContentScript(tabId?: number): boolean {
  return typeof tabId === 'number' && contentTabs.has(tabId);
}

// When the focused page last said it had focus. heartbeat.ts pings once a second
// and ONLY while document.hasFocus(), so this is the browser's focus state as
// reported by the page itself — the one thing that can tell us "the user is in
// another application" now that chrome.windows' `focused` is out (it reported the
// browser focused on every single poll, which is why nothing ever counted down).
let lastFocusPingAt = 0;

/** The FOCUS_PING message from heartbeat.ts.
 *
 *  A plugin wrapper (`viewer`) pings too, because document.hasFocus() genuinely
 *  knows whether you're looking at the PDF or have switched to another app. It
 *  must NOT join contentTabs though: it can report focus but can see no input, and
 *  treating it as an observable page makes the poll wait for HEARTBEATs that never
 *  arrive. Focus and input-observability are separate facts — conflating them is
 *  what made PDFs count nothing. */
export function onFocusPing(tabId?: number, viewer = false) {
  if (!viewer) markContentAlive(tabId);
  lastFocusPingAt = Date.now();
}

/** True while the front page is actively reporting focus. */
function pageHasFocus(): boolean {
  return Date.now() - lastFocusPingAt < FOCUS_PING_STALE_MS;
}

// ── What counts as a page we track ────────────────────────────────────────────
/** Chrome renders PDFs in its built-in viewer, so heartbeat.ts never runs on one
 *  and the background poll is the ONLY possible heartbeat source for it. That
 *  makes the whitelist check here stricter than the one the content script
 *  applies: heartbeat.ts authorizes any `.pdf` URL outright, so a PDF on a
 *  non-whitelisted domain — or a local `file://…/paper.pdf`, which has no domain
 *  to whitelist at all — would produce no heartbeats from either side and the
 *  sprite would sit idle while you read. Mirror the content script's rule. */
function isPdfUrl(url: string): boolean {
  return /\.pdf($|[?#])/i.test(url);
}

/** A URL we generate background heartbeats for: whitelisted, or a PDF. */
function isTrackedUrl(url: string): boolean {
  return host.isAllowedUrl(url) || isPdfUrl(url);
}

/** The tab the user is looking at, if it's one we track. Callback gets undefined
 *  otherwise, so every caller fails closed (no heartbeat) by default. */
function withTrackedActiveTab(fn: (tab: chrome.tabs.Tab) => void) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const tab = tabs[0];
    const url = tab?.url;
    if (!url || !/^(https?|file):/i.test(url) || !isTrackedUrl(url)) return;
    fn(tab);
  });
}

// ── Heartbeat accumulation ────────────────────────────────────────────────────
// One heartbeat is counted per *active* second. The sprite shrinks as the count
// rises and takes one step on each change; once the count reaches
// `iconChangeHeartbeats` the sprite has hit its minimum size, so the character
// advances, the count resets to 0 (new icon back at full size) and `iconChangeAt`
// is bumped to trigger the celebratory fireworks.
//
// This is EVENT-DRIVEN, called at every heartbeat source above. We do NOT rely on
// a setInterval to count, because an MV3 service worker is suspended between
// events and its timers don't fire reliably while asleep; an incoming heartbeat,
// by contrast, always wakes the worker and lands here. The 1 s throttle
// (`lastCountAt`) keeps accumulation at ≈one per real second no matter how fast
// (or from how many sources) heartbeats arrive.
let lastCountAt = 0;
let lastCountWeight = 0; // the heaviest weight already applied in the current 1s window

// Advance the count by `amount`, handling the character change + score reward when
// it reaches the threshold.
function applyCount(amount: number) {
  const state = host.getState();
  const settings = host.getSettings();
  const threshold = clampIconChangeHeartbeats(settings.iconChangeHeartbeats);
  const next = state.heartbeatCount + amount;
  if (next >= threshold) {
    // Reward a completed character: +30/x points (x = threshold), so a shorter
    // interval is worth more per change and a full 30-heartbeat run is worth 1.
    // Only real "Working" activity scores — forceActive ("Not working") pins the
    // sprite active without genuine work, so it earns nothing (and the idle
    // penalty is likewise skipped while forced).
    const gained = settings.forceActive ? 0 : 30 / threshold;
    host.updateState({
      currentIconId: (state.currentIconId + 1) % CHARACTER_COUNT,
      heartbeatCount: 0,
      iconChangeAt: Date.now(),
      focusScore: round2(state.focusScore + gained),
    });
  } else {
    host.updateState({ heartbeatCount: next });
  }
}

/** Register one heartbeat.
 *
 *  `weight` is how much it advances the count. Direct page input (mouse /
 *  keyboard / scroll → the HEARTBEAT message) counts DOUBLE (weight 2) — real
 *  interaction is worth more than the OS-idle poll's passive "still active" signal
 *  (weight 1). The count still advances at most once per real second, but within
 *  that second we keep the HEAVIEST weight seen: if the 0.5 s idle poll got here
 *  first with weight 1 and a page heartbeat (weight 2) then arrives, we top up the
 *  +1 difference so direct input reliably counts double. */
export function registerHeartbeat(weight = 1) {
  if (!host.getState().isHeartbeatActive && !host.getSettings().forceActive) return;
  const now = Date.now();
  if (now - lastCountAt < HEARTBEAT_THROTTLE_MS) {
    if (weight > lastCountWeight) {   // heavier source this second → top up the gap
      const extra = weight - lastCountWeight;
      lastCountWeight = weight;
      applyCount(extra);
    }
    return;
  }
  lastCountAt = now;
  lastCountWeight = weight;
  applyCount(weight);
}

/** Register activity that no content script could report (a focused viewer tab, or
 *  OS-wide input while the browser is in the background). Broadcasts only on a
 *  real transition; while already Active it just refreshes the timestamp. */
function markActiveNow() {
  if (host.getState().isHeartbeatActive) {
    host.touchState({ lastHeartbeat: Date.now() });
  } else {
    host.updateState({ isHeartbeatActive: true, lastHeartbeat: Date.now() });
  }
  registerHeartbeat(); // advance the count + step (≤1/s)
}

// ── Source 1: page input ──────────────────────────────────────────────────────
/** The HEARTBEAT message from heartbeat.ts. */
export function onPageHeartbeat(tabId?: number) {
  markContentAlive(tabId);
  const settings = host.getSettings();
  if (!settings.enabled || settings.forceActive) return;
  // Real page input is exact and beats the coarse OS anchor: drop it so the "I"
  // countdown restarts from a known-good timestamp rather than now−15 s.
  osIdleSince = 0;
  if (host.getState().isHeartbeatActive) {
    // already Active → in-memory refresh only
    host.touchState({ lastHeartbeat: Date.now(), osHeld: false });
  } else {
    host.updateState({ isHeartbeatActive: true, lastHeartbeat: Date.now(), osHeld: false });
  }
  registerHeartbeat(1); // page-sourced heartbeat (mouse/keyboard) → counts SINGLE
}

// ── Sources 2 & 3: the OS idle poll ───────────────────────────────────────────
// Polled twice per second, at chrome.idle's 15 s FLOOR (not the user's idleTime).
// See OS_IDLE_FLOOR_S in ./timings for why: querying at idleTime gives a binary
// flip with no countdown, because "active" refreshes lastHeartbeat to now right up
// until the instant it isn't.
//
//   • system active → no input gap yet. On a tracked focused tab, stay/become
//                     Active and date the last input to now.
//   • system idle   → input stopped ≥15 s ago. ANCHOR that estimate once
//                     (osIdleSince = now − 15 s) and hold it, so lastHeartbeat
//                     stops advancing and every countdown derived from it ticks
//                     down for real. Go Idle only once the gap reaches idleTime —
//                     the floor is our sampling resolution, NOT the threshold.
//
// lastHeartbeat therefore means "best known time of the last input", which is
// exactly what both the idle rule and the "I" countdown readouts want.
let osIdleSince = 0; // 0 = OS reported active on the last poll

/** Drop the OS anchor — call when something more precise takes over, or when the
 *  session is restarted (forceActive toggled off). A stale anchor would otherwise
 *  re-idle the session immediately on the way back. */
export function resetOsAnchor() {
  osIdleSince = 0;
}

// The whole idle timeline hangs off what chrome.idle reports, and when that never
// says "idle" every countdown silently pins at its maximum with no other symptom.
// Log each transition (not each poll — that would be 2 lines/s) so the service
// worker console shows whether the OS signal is arriving at all.
let lastLoggedIdleState = '';

// Whether chrome.idle has EVER reported a non-active state on this machine. Until
// it has, its "active" is treated as no information at all (see the poll below).
// Persisted, because the service worker is suspended constantly and re-learning
// this every restart would reintroduce the freeze each time.
let idleApiProven = false;

/** Restore the persisted proof flag at startup. */
export function setIdleApiProven(proven: boolean) {
  idleApiProven = proven;
}

function logIdleState(idleState: string) {
  if (idleState === lastLoggedIdleState) return;
  lastLoggedIdleState = idleState;
  const state = host.getState();
  const age = Math.round((Date.now() - state.lastHeartbeat) / 1000);
  console.log(`Focus: chrome.idle(${OS_IDLE_FLOOR_S}s) → "${idleState}" | lastHeartbeat ${age}s ago | active=${state.isHeartbeatActive}`);
}

// Apply a NON-ACTIVE chrome.idle reading: date the last input to the 15 s floor,
// let the countdown tick down from there, and flip to Idle once the gap reaches
// idleTime. Shared by both branches of the poll — a "the OS saw no input" reading
// means the same thing wherever the user happens to be.
function applyOsIdleReading(idleSec: number) {
  const now = Date.now();
  if (!idleApiProven) {
    idleApiProven = true; // it does work on this machine after all
    chrome.storage.local.set({ idleApiProven: true });
    console.log('Focus: chrome.idle reported a non-active state — activity in other apps will now hold the idle clock');
  }
  // Anchor on the FIRST idle reading only — re-anchoring every poll would keep
  // pushing the estimate forward and we'd never count down.
  //
  // The anchor is placed so exactly OS_IDLE_COUNTDOWN_S remain, whatever idleTime
  // is. It is NOT the true "last input was 15 s ago" estimate: the OS only tells us
  // input stopped at least 15 s back, and replaying the user's full idleTime from
  // there would stall a long idleTime for a minute or more with nothing visibly
  // happening. Once the OS says you've stopped, you get a fixed short warning.
  if (!osIdleSince) {
    osIdleSince = now - (idleSec - OS_IDLE_COUNTDOWN_S) * 1000;
    console.log(`Focus: OS reports no input — "I" counts down ${OS_IDLE_COUNTDOWN_S}s`);
  }
  // Publish the anchor so the countdown readouts can see it tick.
  const state = host.getState();
  if (state.lastHeartbeat > osIdleSince) host.updateState({ lastHeartbeat: osIdleSince });
  if (state.isHeartbeatActive && now - osIdleSince >= idleSec * 1000) {
    host.updateState({ isHeartbeatActive: false, osHeld: false }); // → crying/beep
  }
}

function pollOsIdle() {
  const settings = host.getSettings();
  if (!settings.enabled || settings.forceActive) return;
  const idleSec = clampIdleTime(settings.idleTime);

  // No chrome.windows focus check any more. `win.focused` came back true on every
  // poll on at least one platform, so "the browser has focus" was a constant and
  // the whole branch it guarded was dead weight. Everything is now decided from the
  // front tab plus the page's own focus report.
  withTrackedActiveTab((tab) => {
    const observable = hasContentScript(tab.id); // can this page see its own input?

    // The ONE place a source deliberately stands down. A focused content-script
    // page timestamps every mouse/key/scroll itself, so its HEARTBEATs are strictly
    // better than any OS-wide signal — and if merely being in front also counted,
    // staring at a whitelisted page without touching it would generate heartbeats
    // forever and the countdown could never fall.
    //
    // Safe only because a tab that CANNOT observe its own input never gets here
    // (see the contentTabs note above). That asymmetry is what broke PDFs, where
    // both sources stood down and nothing counted at all.
    if (observable && pageHasFocus()) return;

    // Everything else falls through to chrome.idle, in one of two situations:
    //
    //   • a whitelisted VIEWER tab you are LOOKING AT — nothing in the browser can
    //     watch its input, so the OS is the only witness there is.
    //   • nothing is reporting focus at all — you are in another application, and
    //     only the OS knows whether you're working there.
    //
    // They differ in how far chrome.idle is trusted, which is the whole reason the
    // distinction survives at all (see below). Note this keys off the page's own
    // focus report, so a PDF left in a background window is correctly treated as
    // "another app" rather than as work — it used to count either way.
    const inAnotherApp = !pageHasFocus();

    chrome.idle.queryState(OS_IDLE_FLOOR_S, (idleState) => {
      logIdleState(idleState);

      // A non-active reading is a positive assertion that the OS saw no input, so
      // acting on it can only ever end a session EARLIER — and an API stuck on
      // "active" simply never triggers it. That makes it safe to honour
      // unconditionally, whichever situation we're in.
      if (idleState !== 'active') { applyOsIdleReading(idleSec); return; }

      // "active" is the dangerous direction: it HOLDS the clock up, so a broken API
      // freezes the countdown forever. Trust it to keep a session alive only once
      // it has proven itself by reporting a non-active state at least once —
      // Chromium under Wayland reports "active" no matter what the user does.
      //
      // The viewer case is exempt: there is no other evidence available for a PDF,
      // and refusing it would put us straight back to a PDF counting nothing at
      // all. The cost is that on a machine where chrome.idle is broken, a PDF left
      // in front never goes idle.
      if (inAnotherApp && !idleApiProven) return;

      osIdleSince = 0;
      host.touchState({ osHeld: inAnotherApp }); // another app holding it → violet "I"
      markActiveNow();
    });
  });
}

// ── The forceActive tick, and the end of a session ────────────────────────────
/** Called once a second while forceActive ("Not working") is on: there are no
 *  external heartbeats in that mode, so the sprite would freeze without this. */
export function forceActiveTick() {
  if (!host.getState().isHeartbeatActive) host.updateState({ isHeartbeatActive: true });
  registerHeartbeat();
}

/** Backup Idle expiry, called once a second. The poll above is the primary path to
 *  Idle; this catches the case where nothing refreshed the heartbeat at all. */
export function expireStaleHeartbeat() {
  const state = host.getState();
  const idleSec = clampIdleTime(host.getSettings().idleTime);
  if (state.isHeartbeatActive && Date.now() - state.lastHeartbeat > idleSec * 1000) {
    host.updateState({ isHeartbeatActive: false, osHeld: false });
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────────
/** Install the tab bookkeeping and start the OS idle poll. Call once, from the
 *  service worker's top level. */
export function initHeartbeats(h: HeartbeatHost) {
  host = h;
  chrome.tabs.onRemoved.addListener((tabId) => contentTabs.delete(tabId));
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'loading') contentTabs.delete(tabId); // new page → re-detect
  });
  setInterval(pollOsIdle, IDLE_POLL_MS);
}
