import { SessionState, MessageType, Settings, ServerStatus, DEFAULT_SETTINGS, CHARACTER_COUNT, clampCryBeepDuration, round2 } from '../types';
import {
  STATUS_LOOP_MS, VIEWER_CLASSIFY_DELAY_MS,
  IDLE_PENALTY, idlePenaltyDelayMs, autoPauseDelayMs,
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
} from './server/sync';
import { signIn, signOut, getSession } from './server/auth';
import { isServerConfigured } from './server/config';

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
  if (settings.forceActive) { paintActionIcon('#94a3b8'); return; } // grey
  try {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const url = tabs[0]?.url ?? '';
      const whitelisted = !!url && isAllowedUrl(url);
      paintActionIcon(whitelisted ? '#22c55e' : '#eab308'); // green | yellow
    });
  } catch {
    paintActionIcon('#22c55e');
  }
}

// ── Init from storage ─────────────────────────────────────────────────────────
chrome.storage.local.get(['focusFlowState', 'focusFlowSettings'], (result) => {
  // Left behind by a version that tried to detect a broken chrome.idle at runtime.
  chrome.storage.local.remove('idleApiProven');
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

// Pick up settings changes written directly by the popup
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.focusFlowSettings) {
    const prev = settings;
    settings = { ...DEFAULT_SETTINGS, ...(changes.focusFlowSettings.newValue as Settings) };
    // Broadcast enabled change immediately so sprites show/hide
    if (prev.enabled !== settings.enabled) {
      updateState({ enabled: settings.enabled });
    }
    // Force-active toggled: snap the sprite into (or out of) the active state
    if (prev.forceActive !== settings.forceActive) {
      resetOsAnchor(); // stale anchor would immediately re-idle on the way back
      updateState({ isHeartbeatActive: settings.forceActive, lastHeartbeat: Date.now() });
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
  state = { ...state, ...newState };
  chrome.storage.local.set({ focusFlowState: state });
  broadcastState();
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
  if (idleWasActive) {          // just went idle → start timing this lapse
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
      settings = { ...settings, allowedDomains: [...settings.allowedDomains, host] };
      chrome.storage.local.set({ focusFlowSettings: settings });
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
        settings = { ...settings, allowedDomains: [...settings.allowedDomains, domain] };
        chrome.storage.local.set({ focusFlowSettings: settings });
      }
      sendResponse({});
      break;
    }

    case 'REMOVE_DOMAIN': {
      const domain = message.domain.trim();
      settings = { ...settings, allowedDomains: settings.allowedDomains.filter(d => d !== domain) };
      chrome.storage.local.set({ focusFlowSettings: settings });
      updateState({ isHeartbeatActive: false });
      sendResponse({});
      break;
    }

    case 'CLASSIFY_PAGE': {
      classifyPage(message.url, message.title).then(sendResponse);
      break;
    }

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
    case 'SERVER_MEMBER_PROFILE':
      fetchMemberProfile(message.userId).then(sendResponse);
      break;

    case 'SERVER_FLAG_DOMAIN':
      flagDomain(message.domain).then(sendResponse);
      break;
  }
  return true;
});
