import { SessionState, MessageType, Settings, DEFAULT_SETTINGS, CHARACTER_COUNT, clampIconChangeHeartbeats, clampIdleTime } from '../types';

let state: SessionState = {
  isHeartbeatActive: false,
  lastHeartbeat: 0,
  activeWindowId: null,
  enabled: true,
  currentIconId: Math.floor(Math.random() * CHARACTER_COUNT),
  heartbeatCount: 0,
  iconChangeAt: 0,
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
// "Working" (forceActive off), grey while "Not working" (forceActive on). It
// reproduces the old auto-generated look — a rounded square with a white "F".
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

function updateActionIcon() {
  try {
    const color = settings.forceActive ? '#94a3b8' : '#22c55e'; // grey | green
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

// ── Init from storage ─────────────────────────────────────────────────────────
chrome.storage.local.get(['focusFlowState', 'focusFlowSettings'], (result) => {
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
      updateState({ isHeartbeatActive: settings.forceActive, lastHeartbeat: Date.now() });
      updateActionIcon(); // recolour the toolbar icon for the new working state
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

function registerHeartbeat() {
  if (!state.isHeartbeatActive && !settings.forceActive) return;
  const now = Date.now();
  if (now - lastCountAt < 1000) return; // ≈one count per second, whatever the source rate
  lastCountAt = now;

  const threshold = clampIconChangeHeartbeats(settings.iconChangeHeartbeats);
  const next = state.heartbeatCount + 1;
  if (next >= threshold) {
    updateState({
      currentIconId: (state.currentIconId + 1) % CHARACTER_COUNT,
      heartbeatCount: 0,
      iconChangeAt: now,
    });
  } else {
    updateState({ heartbeatCount: next });
  }
}

// ── Window focus (activeWindowId only) ───────────────────────────────────────
// onFocusChanged is used purely to keep activeWindowId current.
// It is NOT used for preserve logic — unreliable for OS-level focus on Linux.
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    updateState({ activeWindowId: windowId });
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
}, 1000);

// (2) OS idle poll — twice per second. queryState(idleTime) already means "no input
// for idleTime s", so it maps straight onto the status — we do NOT stack another
// idleTime recency on top (that would double the time-to-idle):
//   • system idle      → go Idle now (this is what fires the crying/beep).
//   • system active    → on an authorized focused tab, stay/become Active.
// queryState is a cheap native read; to keep the fast poll cheap we only broadcast
// on a real transition — while already Active we just refresh lastHeartbeat in
// memory (no storage write, no fan-out to tabs).
setInterval(() => {
  if (!settings.enabled || settings.forceActive) return;
  const idleSec = clampIdleTime(settings.idleTime);
  chrome.idle.queryState(idleSec, (idleState) => {
    if (idleState !== 'active') {
      if (state.isHeartbeatActive) updateState({ isHeartbeatActive: false }); // → Idle
      return;
    }
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const url = tabs[0]?.url;
      if (!url || !/^(https?|file):/i.test(url) || !isAllowedUrl(url)) return;
      if (state.isHeartbeatActive) {
        state.lastHeartbeat = Date.now();     // already Active → in-memory refresh only
      } else {
        updateState({ isHeartbeatActive: true, lastHeartbeat: Date.now() }); // transition
      }
      registerHeartbeat(); // idle-sourced heartbeat → advance count + step (≤1/s)
    });
  });
}, 500);

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
  }, 2500);
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && tab.active) scheduleViewerClassify(tabId);
});
chrome.tabs.onActivated.addListener(({ tabId }) => scheduleViewerClassify(tabId));

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message: MessageType, sender, sendResponse) => {
  switch (message.type) {
    case 'HEARTBEAT':
      markContentAlive(sender.tab?.id);
      if (settings.enabled && !settings.forceActive) {
        if (state.isHeartbeatActive) {
          state.lastHeartbeat = Date.now();   // already Active → in-memory refresh only
        } else {
          updateState({ isHeartbeatActive: true, lastHeartbeat: Date.now() }); // transition
        }
        registerHeartbeat(); // page-sourced heartbeat (mouse/keyboard) → advance count + step
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
