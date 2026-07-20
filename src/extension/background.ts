import { SessionState, MessageType, Settings, DayScore, DEFAULT_SETTINGS, CHARACTER_COUNT, HISTORY_KEY, clampIconChangeHeartbeats, clampIdleTime, clampCryBeepDuration, localDateKey, weekdayName } from '../types';
import {
  IDLE_POLL_MS, STATUS_LOOP_MS, OS_IDLE_FLOOR_S, HEARTBEAT_THROTTLE_MS, VIEWER_CLASSIFY_DELAY_MS,
  IDLE_PENALTY, idlePenaltyDelayMs, autoPauseDelayMs,
} from './timings';

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

// Tabs whose CURRENT page has run our content script. Our content script runs on
// every normal HTML page and pings (FOCUS_PING/HEARTBEAT). PDFs and other
// plugin-rendered documents open in Chrome's built-in viewer, where content
// scripts never run — so a loaded tab that has NEVER reported in (despite a real
// http/file URL) is how we recognise a "viewer" tab without depending on its URL.
//
// This is membership, not recency: once a page has shown a content script it is
// an HTML page for good. A quiet/blurred tab (e.g. after you switch windows, when
// FOCUS_PING pauses) must NOT suddenly look like a viewer — otherwise the OS-idle
// fallback would pin it active and it would never go idle. Cleared on navigation
// so a tab that later loads a PDF is re-evaluated.
const contentTabs = new Set<number>();

function markContentAlive(tabId?: number) {
  if (typeof tabId === 'number') contentTabs.add(tabId);
}
function hasContentScript(tabId?: number): boolean {
  return typeof tabId === 'number' && contentTabs.has(tabId);
}
chrome.tabs.onRemoved.addListener((tabId) => contentTabs.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') contentTabs.delete(tabId); // new page → re-detect
});

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
chrome.storage.local.get(['focusFlowState', 'focusFlowSettings', 'idleApiProven'], (result) => {
  idleApiProven = result.idleApiProven === true;
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
  maybeRollover(); // the PC may have been off across midnight — bank the old day now
  updateActionIcon();
  chrome.windows.getLastFocused((win) => {
    if (win.id) updateState({ activeWindowId: win.id });
  });
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
      osIdleSince = 0; // stale anchor would immediately re-idle on the way back
      updateState({ isHeartbeatActive: settings.forceActive, lastHeartbeat: Date.now() });
    }
    // Recolour the toolbar icon whenever the working state OR the whitelist changed
    // (whitelisting the current page flips its icon green↔yellow).
    if (prev.forceActive !== settings.forceActive ||
        prev.allowedDomains.join('\n') !== settings.allowedDomains.join('\n')) {
      updateActionIcon();
    }
  }
});

// ── State helpers ─────────────────────────────────────────────────────────────
function updateState(newState: Partial<SessionState>) {
  state = { ...state, ...newState };
  chrome.storage.local.set({ focusFlowState: state });
  broadcastState();
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

// ── Heartbeat accumulation (drives icon change AND the sprite's step) ─────────
// One heartbeat is counted per *active* second. The sprite shrinks as the count
// rises and takes one step on each change; once the count reaches
// `iconChangeHeartbeats` the sprite has hit its minimum size, so the character
// advances, the count resets to 0 (new icon back at full size) and `iconChangeAt`
// is bumped to trigger the celebratory fireworks.
//
// This is EVENT-DRIVEN, called at every heartbeat *source* — the page's HEARTBEAT
// message (mouse/keyboard) AND the chrome.idle poll (PDFs/other windows). We do
// NOT rely on the 1s setInterval to count, because an MV3 service worker is
// suspended between events and its timers don't fire reliably while asleep; an
// incoming heartbeat, by contrast, always wakes the worker and lands here. The
// 1s throttle (`lastCountAt`) keeps accumulation at ≈one per real second no
// matter how fast (or from how many sources) heartbeats arrive.
let lastCountAt = 0;
let lastCountWeight = 0; // the heaviest weight already applied in the current 1s window

// Advance the count by `amount`, handling the character change + score reward
// when it reaches the threshold.
function applyCount(amount: number) {
  const threshold = clampIconChangeHeartbeats(settings.iconChangeHeartbeats);
  const next = state.heartbeatCount + amount;
  if (next >= threshold) {
    // Reward a completed character: +30/x points (x = threshold), so a shorter
    // interval is worth more per change and a full 30-heartbeat run is worth 1.
    // Only real "Working" activity scores — forceActive ("Not working") pins the
    // sprite active without genuine work, so it earns nothing (and the idle
    // penalty is likewise skipped while forced).
    const gained = settings.forceActive ? 0 : 30 / threshold;
    updateState({
      currentIconId: (state.currentIconId + 1) % CHARACTER_COUNT,
      heartbeatCount: 0,
      iconChangeAt: Date.now(),
      focusScore: round2(state.focusScore + gained),
    });
  } else {
    updateState({ heartbeatCount: next });
  }
}

// `weight` is how much this heartbeat advances the count. Direct page input
// (mouse/keyboard/scroll → the HEARTBEAT message) counts DOUBLE (weight 2) —
// real interaction is worth more than the OS-idle poll's passive "still active"
// signal (weight 1). The count still advances at most once per real second, but
// within that second we keep the HEAVIEST weight seen: if the 0.5s idle poll got
// here first with weight 1 and a page heartbeat (weight 2) then arrives, we top
// up the +1 difference so direct input reliably counts double.
function registerHeartbeat(weight = 1) {
  if (!state.isHeartbeatActive && !settings.forceActive) return;
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

// No max(0) here: focusScore only ever rises from 0 and distractedScore is meant
// to run negative, so clamping either would be wrong.
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Daily rollover ─────────────────────────────────────────────────────────────
// The two counters belong to one local calendar day (state.scoreDate) and survive
// reboots via chrome.storage.local. When the day changes we bank the finished day
// into the DayScore[] history and reset the live counters to 0.
//
// This is date-driven, NOT a midnight timer: an MV3 service worker is asleep most
// of the time and can't be trusted to fire at 00:00, and the PC may be off
// entirely. Instead we compare dates on every wake — at startup and on each tick
// of the status loop — so the rollover lands at midnight if the machine is awake,
// or at the first moment it's switched on afterwards. Either way no day is lost.
function maybeRollover() {
  const today = localDateKey();
  if (state.scoreDate === today) return;

  // Empty scoreDate = first run since this feature shipped; there's no complete
  // previous day to bank, so just claim today.
  if (state.scoreDate) archiveDay(state.scoreDate, state.focusScore, state.distractedScore);
  updateState({ scoreDate: today, focusScore: 0, distractedScore: 0 });
}

function archiveDay(date: string, focusScore: number, distractedScore: number) {
  chrome.storage.local.get([HISTORY_KEY], (r) => {
    const history: DayScore[] = Array.isArray(r[HISTORY_KEY]) ? r[HISTORY_KEY] : [];
    const entry: DayScore = { date, weekday: weekdayName(date), focusScore, distractedScore };
    // Overwrite rather than append if the date is somehow already there, so a
    // double rollover can never duplicate a day.
    const i = history.findIndex((e) => e.date === date);
    if (i >= 0) history[i] = entry;
    else history.push(entry);
    history.sort((a, b) => a.date.localeCompare(b.date));
    chrome.storage.local.set({ [HISTORY_KEY]: history });
    console.log('Focus: banked', date, entry);
  });
}

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
// One simple model: heartbeats drive the status, and the OS idle state is just
// another source of heartbeats.
//
//   • Every 2s we poll chrome.idle.queryState. If the user is active anywhere
//     (mouse/keyboard in any window) and the focused tab is authorized, we
//     "generate a heartbeat" (refresh lastHeartbeat, mark Active). This covers
//     PDFs/viewers (no content script) and other windows uniformly. If the OS
//     reports idle, no heartbeat is generated.
//   • Content scripts also send HEARTBEAT messages on real page activity.
//   • Status depends ONLY on heartbeat recency: if nothing has refreshed the
//     heartbeat within `idleTime` s, the sprite goes Idle.
//
// chrome.idle is *polled* rather than event-based because idle transitions can be
// missed/late on some platforms (notably Linux/Wayland). queryState(N) reports
// "active" whenever there was any input in the last N seconds.

// (1) Status loop — once per second. Counting is now event-driven (see
// registerHeartbeat, called from the heartbeat sources), so this loop only:
//   • keeps the count moving in forceActive mode (no external heartbeats there),
//   • acts as a backup Idle expiry if nothing refreshed the heartbeat within
//     `idleTime` (the idle poll is the primary path to Idle).
setInterval(() => {
  // Before any early return: the day must roll over even while disabled or forced.
  maybeRollover();
  if (!settings.enabled) return;

  if (settings.forceActive) {
    if (!state.isHeartbeatActive) updateState({ isHeartbeatActive: true });
    registerHeartbeat(); // forced mode still accumulates + steps
    return;
  }

  const now = Date.now();
  const idleSec = clampIdleTime(settings.idleTime);
  if (state.isHeartbeatActive && now - state.lastHeartbeat > idleSec * 1000) {
    updateState({ isHeartbeatActive: false });
  }
  trackIdlePenalty(); // dock points for an idle lapse longer than 5 s
}, STATUS_LOOP_MS);

// (2) OS idle poll — twice per second, at chrome.idle's 15 s FLOOR (not the user's
// idleTime). See OS_IDLE_FLOOR_S in ./timings for why: querying at idleTime gives
// a binary flip with no countdown, because "active" refreshes lastHeartbeat to now
// right up until the instant it isn't.
//
//   • system active → no input gap yet. On an authorized focused tab, stay/become
//                     Active and date the last input to now.
//   • system idle   → input stopped ≥15 s ago. ANCHOR that estimate once
//                     (osIdleSince = now − 15 s) and hold it, so lastHeartbeat
//                     stops advancing and every countdown derived from it ticks
//                     down for real. Go Idle only once the gap reaches idleTime —
//                     the floor is our sampling resolution, NOT the threshold.
//
// lastHeartbeat therefore means "best known time of the last input", which is
// exactly what both the idle rule and the "I" countdown readouts want. To keep the
// fast poll cheap we only broadcast on a real transition — while already Active we
// just refresh lastHeartbeat in memory (no storage write, no fan-out to tabs).
let osIdleSince = 0; // 0 = OS reported active on the last poll

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

// Register activity that no content script could report (a focused viewer tab, or
// OS-wide input while the browser is in the background). Broadcasts only on a real
// transition; while already Active it just refreshes the timestamp in memory.
function markActiveNow() {
  if (state.isHeartbeatActive) {
    state.lastHeartbeat = Date.now();
  } else {
    updateState({ isHeartbeatActive: true, lastHeartbeat: Date.now() });
  }
  registerHeartbeat(); // advance the count + step (≤1/s)
}

setInterval(() => {
  if (!settings.enabled || settings.forceActive) return;
  const idleSec = clampIdleTime(settings.idleTime);

  chrome.windows.getLastFocused({}, (win) => {
    if (chrome.runtime.lastError) return;
    const browserFocused = !!win?.focused;

    // ── The browser has OS focus ────────────────────────────────────────────
    // Everything can be answered from inside the browser; chrome.idle isn't
    // consulted at all, so its reliability doesn't matter here.
    if (browserFocused) {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const url = tabs[0]?.url;
        if (!url || !/^(https?|file):/i.test(url) || !isAllowedUrl(url)) return;
        // A content-script page timestamps every mouse/key/scroll itself — strictly
        // better than any OS-wide signal. Defer to its HEARTBEATs and let the clock
        // run down when they stop.
        if (hasContentScript(tabs[0]?.id)) return;
        // A viewer tab (PDF/plugin) runs no content script, so nothing can observe
        // its input. Treat "focused on an authorized viewer" as work — this is what
        // keeps reading a PDF from going idle.
        osIdleSince = 0;
        state.osHeld = false;
        markActiveNow();
      });
      return;
    }

    // ── The browser does NOT have focus ─────────────────────────────────────
    // The user is in another application, and chrome.idle is the only thing that
    // could say whether they're working there. Trust it ONLY once it has proven
    // itself by reporting a non-active state at least once.
    //
    // On some platforms it never does — Chromium under Wayland can report "active"
    // forever, whatever the user does. An unproven API must not be allowed to hold
    // the clock up, because that freezes the countdown and the sprite never goes
    // idle no matter how long you stay away. Until it proves otherwise we simply
    // let the clock run down, which is the behaviour with no OS signal at all.
    chrome.idle.queryState(OS_IDLE_FLOOR_S, (idleState) => {
      const now = Date.now();

      if (idleState !== lastLoggedIdleState) {
        lastLoggedIdleState = idleState;
        const age = Math.round((now - state.lastHeartbeat) / 1000);
        console.log(`Focus: chrome.idle(${OS_IDLE_FLOOR_S}s) → "${idleState}" | lastHeartbeat ${age}s ago | active=${state.isHeartbeatActive}`);
      }

      if (idleState !== 'active') {
        if (!idleApiProven) {
          idleApiProven = true; // it does work on this machine after all
          chrome.storage.local.set({ idleApiProven: true });
          console.log('Focus: chrome.idle reported a non-active state — activity in other apps will now hold the idle clock');
        }
        // Anchor on the FIRST idle reading only — re-anchoring every poll would
        // keep pushing the estimate forward and we'd never count down.
        if (!osIdleSince) {
          osIdleSince = now - OS_IDLE_FLOOR_S * 1000;
          console.log(`Focus: anchored last input at ${OS_IDLE_FLOOR_S}s ago — "I" counts down the remaining ${idleSec - OS_IDLE_FLOOR_S}s`);
        }
        // Publish the anchor so the countdown readouts can see it tick.
        if (state.lastHeartbeat > osIdleSince) updateState({ lastHeartbeat: osIdleSince });
        if (state.isHeartbeatActive && now - osIdleSince >= idleSec * 1000) {
          // Nothing is holding it up any more — the whole machine is idle.
          updateState({ isHeartbeatActive: false, osHeld: false }); // → crying/beep
        }
        return;
      }

      // "active" from an API that has never shown us anything else carries no
      // information — ignore it and let the countdown fall.
      if (!idleApiProven) return;

      osIdleSince = 0; // real input somewhere in the last 15 s
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        const url = tabs[0]?.url;
        if (!url || !/^(https?|file):/i.test(url) || !isAllowedUrl(url)) return;
        state.osHeld = true; // another app is what's keeping this alive (violet "I")
        markActiveNow();
      });
    });
  });
}, IDLE_POLL_MS);

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
      markContentAlive(sender.tab?.id);
      if (settings.enabled && !settings.forceActive) {
        // Real page input is exact and beats the coarse OS anchor: drop it so the
        // "I" countdown restarts from a known-good timestamp rather than now−15 s.
        osIdleSince = 0;
        state.osHeld = false; // input is on the page again, not in another app
        if (state.isHeartbeatActive) {
          state.lastHeartbeat = Date.now();   // already Active → in-memory refresh only
        } else {
          updateState({ isHeartbeatActive: true, lastHeartbeat: Date.now() }); // transition
        }
        registerHeartbeat(1); // page-sourced heartbeat (mouse/keyboard) → counts SINGLE
      }
      break;

    case 'FOCUS_PING':
      markContentAlive(sender.tab?.id);    // this tab runs a content script (HTML page)
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
  }
  return true;
});
