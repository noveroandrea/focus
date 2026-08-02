// ─────────────────────────────────────────────────────────────────────────────
//  HEARTBEAT GENERATION — single source of truth
// ─────────────────────────────────────────────────────────────────────────────
//  A "heartbeat" is one observation that the user is working, worth ≈one second.
//  Heartbeats are the ONLY thing that keeps a session alive: the status, the
//  sprite's step, the shrink, the character change and the focus score all hang
//  off them. Everything that can produce one — and the clock that decides when
//  they've stopped — lives in this file.
//
//  There are exactly two sources:
//
//    1. PAGE INPUT   heartbeat.ts sends HEARTBEAT on mouse/key/scroll on an
//                    authorized page. Exact: the page timestamps its own input.
//    2. OS INPUT     chrome.idle reports input anywhere in the system while a
//                    tracked tab is in front. Covers PDFs and other plugin
//                    viewers (where no content script runs), and work done in
//                    another application entirely.
//
//  Plus one non-source: forceActive ("Not working" pinned on) ticks the count so
//  the sprite keeps moving, but earns no points.
//
//  chrome.idle is *polled* rather than event-driven because idle transitions can
//  arrive late on some platforms.
//
//  NOTE ON PLATFORM: this depends on chrome.idle actually working. Running
//  Chromium with --ozone-platform=x11 on a Wayland session breaks it — the X11
//  backend reads XScreenSaver's idle counter, which never advances under
//  Xwayland because the compositor handles input, so queryState answers "active"
//  forever and nothing can ever go idle. That is a browser launch problem, not
//  something this code should try to compensate for; an earlier version of this
//  file carried a pile of machinery to work around it and it only ever produced
//  a frozen countdown by a more complicated route.
// ─────────────────────────────────────────────────────────────────────────────

import {
  SessionState, Settings, CHARACTER_COUNT, clampIconChangeHeartbeats, clampIdleTime, round2,
} from '../types';
import {
  IDLE_POLL_MS, OS_IDLE_FLOOR_S, OS_IDLE_COUNTDOWN_S, HEARTBEAT_THROTTLE_MS, PAGE_INPUT_FRESH_MS,
} from './timings';
import { refreshProgram, currentProgram, isBrowserProgram, isAllowedProgram } from './agent';

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
// Only used to recognise a PDF/plugin "viewer" tab for the AI classify flow in
// background.ts — heartbeats no longer care, since chrome.idle covers a viewer
// exactly as well as it covers anything else.
//
// Our content script runs on every normal HTML page and pings (FOCUS_PING /
// HEARTBEAT), so a loaded tab that has NEVER reported in is a viewer. Cleared on
// navigation so a tab that later loads a PDF is re-evaluated. Chrome wraps a PDF
// in a real HTML document, where our script does run — heartbeat.ts stays silent
// there precisely so this test keeps meaning what it says.
const contentTabs = new Set<number>();

export function markContentAlive(tabId?: number) {
  if (typeof tabId === 'number') contentTabs.add(tabId);
}

export function hasContentScript(tabId?: number): boolean {
  return typeof tabId === 'number' && contentTabs.has(tabId);
}

/** The FOCUS_PING message from heartbeat.ts: proof this tab is an HTML page. */
export function onFocusPing(tabId?: number) {
  markContentAlive(tabId);
}

// ── What counts as a page we track ────────────────────────────────────────────
/** Chrome renders PDFs in its built-in viewer, so heartbeat.ts never runs on one
 *  and the whitelist check here is the only gate. heartbeat.ts authorizes any
 *  `.pdf` URL outright, so without this a PDF on a non-whitelisted domain — or a
 *  local `file://…/paper.pdf`, which has no domain to whitelist at all — would be
 *  tracked by neither side. Mirror the content script's rule. */
function isPdfUrl(url: string): boolean {
  return /\.pdf($|[?#])/i.test(url);
}

/** A URL we generate background heartbeats for: whitelisted, or a PDF. */
function isTrackedUrl(url: string): boolean {
  return host.isAllowedUrl(url) || isPdfUrl(url);
}

/** The tab the user is looking at, if it's one we track. The callback simply
 *  doesn't run otherwise, so every caller fails closed (no heartbeat). */
function withTrackedActiveTab(fn: () => void) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const url = tabs[0]?.url;
    if (!url || !/^(https?|file):/i.test(url) || !isTrackedUrl(url)) return;
    fn();
  });
}

// ── Heartbeat accumulation ────────────────────────────────────────────────────
// One heartbeat is counted per *active* second. The sprite shrinks as the count
// rises and takes one step on each change; once the count reaches
// `iconChangeHeartbeats` the sprite has hit its minimum size, so the character
// advances, the count resets to 0 (new icon back at full size) and `iconChangeAt`
// is bumped to trigger the celebratory fireworks.
//
// This is EVENT-DRIVEN, called at every heartbeat source. We do NOT rely on a
// setInterval to count, because an MV3 service worker is suspended between events
// and its timers don't fire reliably while asleep; an incoming heartbeat, by
// contrast, always wakes the worker and lands here. The 1 s throttle keeps
// accumulation at ≈one per real second no matter how fast, or from how many
// sources, heartbeats arrive.
let lastCountAt = 0;

function registerHeartbeat() {
  if (!host.getState().isHeartbeatActive && !host.getSettings().forceActive) return;
  const now = Date.now();
  if (now - lastCountAt < HEARTBEAT_THROTTLE_MS) return;
  lastCountAt = now;

  const state = host.getState();
  const settings = host.getSettings();
  const threshold = clampIconChangeHeartbeats(settings.iconChangeHeartbeats);
  const next = state.heartbeatCount + 1;
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

/** Register activity as of now. Broadcasts only on a real transition; while
 *  already Active it just refreshes the timestamp in memory. */
function markActiveNow() {
  if (host.getState().isHeartbeatActive) {
    host.touchState({ lastHeartbeat: Date.now() });
  } else {
    host.updateState({ isHeartbeatActive: true, lastHeartbeat: Date.now() });
  }
  registerHeartbeat();
}

// ── Source 1: page input ──────────────────────────────────────────────────────
let lastPageInputAt = 0;

/** The HEARTBEAT message from heartbeat.ts (mouse / keyboard / scroll). */
export function onPageHeartbeat(tabId?: number) {
  markContentAlive(tabId);
  const settings = host.getSettings();
  if (!settings.enabled || settings.forceActive) return;
  lastPageInputAt = Date.now();
  // Real page input is exact and beats the coarse OS anchor: drop it so the "I"
  // countdown restarts from a known-good timestamp.
  osIdleSince = 0;
  if (host.getState().isHeartbeatActive) {
    host.touchState({ lastHeartbeat: Date.now(), osHeld: false });
  } else {
    host.updateState({ isHeartbeatActive: true, lastHeartbeat: Date.now(), osHeld: false });
  }
  registerHeartbeat();
}

// ── Source 2: the OS idle poll ────────────────────────────────────────────────
// Polled twice per second, at chrome.idle's 15 s FLOOR (not the user's idleTime).
// See OS_IDLE_FLOOR_S in ./timings for why: querying at idleTime gives a binary
// flip with no countdown, because "active" refreshes lastHeartbeat to now right up
// until the instant it isn't.
//
//   • active → input somewhere in the last 15 s. With a tracked tab in front, that
//              counts as work: refresh lastHeartbeat and count a heartbeat.
//   • idle   → input stopped ≥15 s ago. ANCHOR that once and hold it, so
//              lastHeartbeat stops advancing and the countdown ticks down for
//              real, then flip to Idle when it runs out.
//
// lastHeartbeat therefore means "best known time of the last input", which is what
// both the idle rule and the "I" countdown readouts want.
let osIdleSince = 0; // 0 = OS reported active on the last poll

/** Drop the OS anchor. A stale one would re-idle the session immediately on the
 *  way back from forceActive. */
export function resetOsAnchor() {
  osIdleSince = 0;
}

function applyOsIdleReading(idleSec: number) {
  const now = Date.now();
  // Anchor on the FIRST idle reading only — re-anchoring every poll would keep
  // pushing the estimate forward and we'd never count down.
  //
  // The anchor is placed so exactly OS_IDLE_COUNTDOWN_S remain, whatever idleTime
  // is. It is NOT the true "last input was 15 s ago" estimate: the OS only tells us
  // input stopped at least 15 s back, and replaying the user's full idleTime from
  // there would stall a long idleTime for a minute with nothing visibly happening.
  if (!osIdleSince) osIdleSince = now - (idleSec - OS_IDLE_COUNTDOWN_S) * 1000;

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

  // Ask the optional desktop agent which program is in front. Throttled and fire-
  // and-forget inside; with no agent installed this never resolves to anything and
  // every branch below falls through to the original, browser-only behaviour.
  refreshProgram();
  const program = currentProgram();

  // ── The agent is running and a NON-BROWSER program is in front ──────────────
  // This is the case chrome.idle alone could never resolve. "Input happened
  // somewhere" now has a name attached, so the answer is no longer a guess:
  //
  //   whitelisted program  → this IS work. Count it, even though no tab is
  //                          involved and no page heartbeat can ever arrive.
  //   anything else        → this is NOT work. Generate nothing and let the
  //                          session expire, even though the OS says the user is
  //                          busy — being busy in a game is precisely the state
  //                          the extension is meant to notice.
  //
  // A browser is deliberately not handled here; see below.
  if (program && !isBrowserProgram(program.id)) {
    if (!isAllowedProgram(program.id, settings.allowedPrograms)) {
      // Drop the anchor so that returning to work restarts the countdown from a
      // clean state rather than from a stale reading taken minutes ago.
      osIdleSince = 0;
      return;
    }
    chrome.idle.queryState(OS_IDLE_FLOOR_S, (idleState) => {
      if (idleState !== 'active') { applyOsIdleReading(idleSec); return; }
      osIdleSince = 0;
      // Work is happening in another application — exactly what osHeld was always
      // meant to say. Now it is a statement rather than an inference.
      host.touchState({ osHeld: true });
      markActiveNow();
    });
    return;
  }

  // ── No agent, or a BROWSER is in front: the active tab decides ─────────────
  // Unchanged from before the agent existed, and it must stay that way. The agent
  // can only see "Chrome is in front", which says nothing about whether that
  // window is on Overleaf or on Instagram — the extension already knows, and this
  // is the path where it applies what it knows.
  withTrackedActiveTab(() => {
    chrome.idle.queryState(OS_IDLE_FLOOR_S, (idleState) => {
      if (idleState !== 'active') { applyOsIdleReading(idleSec); return; }
      osIdleSince = 0;
      // The OS saw input but this page didn't, so it happened somewhere else —
      // another application, or inside a PDF viewer we can't see into. The
      // countdown is legitimately held up; osHeld turns it violet to say why.
      host.touchState({ osHeld: Date.now() - lastPageInputAt > PAGE_INPUT_FRESH_MS });
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
