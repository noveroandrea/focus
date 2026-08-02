// Focus companion — helper window.
//
// A small always-visible window that mirrors the sprite, for when Chrome is
// covered by another app. It's a plain extension window (chrome-extension://
// origin) drawing to a <canvas>.
//
// Keeping it on top is never this code's job — no browser can raise its own window on
// Wayland — so something outside the browser does it, and WHICH something differs by
// platform. GNOME: the companion bridge, from inside the compositor. Windows: the
// desktop agent, via SetWindowPos(HWND_TOPMOST). Both find this window by its title,
// which makes pip.html's <title> load-bearing (COMPANION_TITLE in the bridge,
// PIN_TITLE in the agent). macOS and other Linux desktops stay manual — on macOS no
// process may raise another's window at all. See the README "Floating companion".
//
// It deliberately does NOT use picture-in-picture any more. On Wayland a browser
// cannot raise its own window above others (the compositor decides), so a PiP
// overlay dropped behind the next window anyway; the only browser-side workaround
// was to run the whole browser on the X11 backend (--ozone-platform=x11), and THAT
// breaks chrome.idle under Xwayland (its idle counter never advances), freezing the
// idle timeline this window exists to display. A normal window left on native
// Wayland keeps idle working and is pinned on top by the WM instead. See the README
// "Floating companion" section for the per-OS way to keep it on top.
//
// It mirrors the live SessionState (broadcast by background.ts) and settings
// (chrome.storage.local). The <canvas> drawing is a standalone copy of the sprite's
// renderer — the two documents can't share a runtime, so the character roster and
// draw code are duplicated here on purpose.

import { clampIdleTime, type AgentStatus, type PageStatus } from '../../types';
import { IDLE_WARNING_MS } from '../timings';

interface State {
  isHeartbeatActive: boolean;
  currentIconId: number;
  heartbeatCount: number;
  focusScore: number;
  distractedScore: number;
  lastHeartbeat: number;
  enabled: boolean;
  osHeld: boolean;
}

const CHARS = [
  { name: 'Mario',   icon: '🍄', color: '#ef4444' },
  { name: 'Luigi',   icon: '🥬', color: '#22c55e' },
  { name: 'Peach',   icon: '👑', color: '#ec4899' },
  { name: 'Toad',    icon: '🍄', color: '#f87171' },
  { name: 'Yoshi',   icon: '🥚', color: '#4ade80' },
  { name: 'Bowser',  icon: '🐢', color: '#f97316' },
  { name: 'Link',    icon: '🛡️', color: '#16a34a' },
  { name: 'Zelda',   icon: '💎', color: '#eab308' },
  { name: 'Kirby',   icon: '🎈', color: '#f472b6' },
  { name: 'Pikachu', icon: '⚡', color: '#facc15' },
  { name: 'DK',      icon: '🍌', color: '#92400e' },
  { name: 'Samus',   icon: '🚀', color: '#ea580c' },
  { name: 'Fox',     icon: '🦊', color: '#d97706' },
  { name: 'Ness',    icon: '🧢', color: '#2563eb' },
  { name: 'Falcon',  icon: '🏎️', color: '#1d4ed8' },
];
const CRYING = ['😭', '😢', '💧'];

const PIP_W = 480, PIP_H = 240;

let state: State | null = null;
let forceActive = false;
let idleTimeS = 20;
let idleSince = 0;      // when the companion last went idle (for the W countdown)
let wasActive = true;   // tracks the active→idle edge
let bob = 0;            // canvas-px vertical bob offset, decays to 0
let lastHb = -1;

// ── DOM ────────────────────────────────────────────────────────────────────────
const root = document.getElementById('root')!;

// The canvas is a fixed 480×240 drawing that SCALES to whatever size the window
// is dragged to: object-fit keeps its 2:1 aspect inside the stage, so every
// element stays in proportion instead of the layout rearranging itself. The window
// is meant to be shrunk down to a corner of the screen, so the stage takes all
// remaining space and nothing else competes for height.
const stage = document.createElement('div');
Object.assign(stage.style, {
  flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
  minHeight: '0', minWidth: '0', padding: '6px',
});
const canvas = document.createElement('canvas');
canvas.width = PIP_W; canvas.height = PIP_H;
Object.assign(canvas.style, {
  width: '100%', height: '100%', objectFit: 'contain',
  borderRadius: '12px',
});
stage.appendChild(canvas);

// One-time instruction. It's advice for the first few seconds, not a permanent
// part of the UI — at the small sizes this window is meant to be used at, leaving
// it on screen wraps to three lines and squeezes the companion into nothing. So it
// fades out and is removed from the layout, handing its space back to the canvas.
const footer = document.createElement('div');
Object.assign(footer.style, {
  padding: '7px 10px', textAlign: 'center', flexShrink: '0',
  borderTop: '1px solid rgba(148,163,184,0.18)',
  fontSize: '10px', color: '#94a3b8', lineHeight: '1.35',
  transition: 'opacity 0.6s ease',
});
footer.textContent = 'Pin me on top — see the README “Floating companion” section';
footer.title = 'Keep this window above other apps with your OS: Windows PowerToys “Always On Top”, macOS Rectangle, GNOME toggle-above keybinding, KDE “Keep Above Others”.';
setTimeout(() => {
  footer.style.opacity = '0';
  setTimeout(() => { footer.style.display = 'none'; }, 700);
}, 8000);

// ── The two whitelist bars ────────────────────────────────────────────────────
// Under the character and the score, two strips answer the only question this
// window cannot already show you: "is what I am doing right now being counted?"
//
//   page bar     — the site in the front tab, and one click to whitelist it
//   program bar  — the program you were last in, and one click to whitelist that
//
// Both exist here rather than only in the popup because this window is ALWAYS
// VISIBLE. The popup is three clicks and covers the page it is describing; the
// companion is already on screen, on top, while you are reading the very page you
// want to count. That is worth two rows of a 300px window.
//
// NEITHER bar can ask "what is in front right now?", for the same structural reason
// in both cases: this window IS a window of the browser, so at the moment you look
// at it the live answers are "the companion tab" and "a browser". The background
// therefore hands out the last ordinary web PAGE (PageStatus) and the last
// non-browser PROGRAM (AgentStatus.recent) — which is also what a person means by
// "this page" and "this app", and both survive the click, which necessarily focuses
// the browser to happen at all.

/** One strip: a label, a green tick when it is already counted, and a button when it
 *  is not. Built once for both rows so they cannot drift apart visually. */
function makeBar(mark: string) {
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'none', alignItems: 'center', gap: '6px', flexShrink: '0',
    padding: '5px 8px', borderTop: '1px solid rgba(148,163,184,0.18)',
    fontSize: '11px', lineHeight: '1.2', minWidth: '0',
  });

  const label = document.createElement('span');
  Object.assign(label.style, {
    flex: '1', minWidth: '0', overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#cbd5e1',
  });

  const tick = document.createElement('span');
  Object.assign(tick.style, {
    flexShrink: '0', fontSize: '9px', fontWeight: '700',
    letterSpacing: '0.06em', textTransform: 'uppercase', color: '#4ade80',
  });
  tick.textContent = mark;

  const button = document.createElement('button');
  Object.assign(button.style, {
    flexShrink: '0', cursor: 'pointer', border: 'none', borderRadius: '7px',
    background: '#3b82f6', color: '#fff', padding: '3px 7px',
    fontSize: '9px', fontWeight: '700', letterSpacing: '0.06em',
    textTransform: 'uppercase', fontFamily: 'inherit',
  });
  button.textContent = '+ Whitelist';

  // The undo, shown in place of the button once something is on the list. Quiet by
  // design — a ✕ next to the tick rather than a second coloured button: taking
  // something OFF the whitelist is the rarer action and the one you would rather not
  // hit by accident, and this row is 300px wide with a domain already competing for
  // it. The tick says what the state is; this changes it.
  const remove = document.createElement('button');
  Object.assign(remove.style, {
    flexShrink: '0', cursor: 'pointer', border: 'none', borderRadius: '6px',
    background: 'transparent', color: '#64748b', padding: '2px 5px',
    fontSize: '12px', lineHeight: '1', fontFamily: 'inherit',
  });
  remove.textContent = '✕';
  remove.addEventListener('mouseenter', () => { remove.style.color = '#f87171'; });
  remove.addEventListener('mouseleave', () => { remove.style.color = '#64748b'; });

  row.append(label, tick, button, remove);

  /** Show `text`, with either the "+ Whitelist" button or the tick-and-✕ pair —
   *  never both, since they are the two directions of one toggle. */
  const show = (text: string, title: string, counted: boolean, undoTitle = '') => {
    row.style.display = 'flex';
    row.style.background = 'transparent';
    label.style.color = '#cbd5e1';
    label.style.whiteSpace = 'nowrap';
    label.textContent = text;
    label.title = title;
    tick.style.display = counted ? 'inline' : 'none';
    remove.style.display = counted ? 'inline-block' : 'none';
    remove.title = undoTitle;
    button.style.display = counted ? 'none' : 'inline-block';
  };
  const warn = (text: string, title: string) => {
    row.style.display = 'flex';
    row.style.background = 'rgba(248,113,113,0.12)';
    label.style.color = '#fca5a5';
    label.style.whiteSpace = 'normal';   // let it wrap; it must stay readable
    label.textContent = text;
    label.title = title;
    tick.style.display = 'none';
    remove.style.display = 'none';
    button.style.display = 'none';
  };
  const hide = () => { row.style.display = 'none'; };

  return { row, button, remove, show, warn, hide };
}

const pageBar = makeBar('✓ counts');
const programBar = makeBar('✓ work');

// Page first: this window is on top of the browser at least as often as it is beside
// another app, and the page is the thing you are looking at when it is.
root.append(stage, pageBar.row, programBar.row, footer);

// ── Page bar ─────────────────────────────────────────────────────────────────
// `shownPage` is whatever the row is describing, whitelisted or not — the two
// buttons are never visible at the same time, so one subject serves both.
let shownPage: string | null = null;

function renderPageBar(page: PageStatus | null) {
  // Hidden outright when there is no ordinary web page to talk about — only the
  // companion open, or a chrome:// tab in front.
  if (!page?.domain) { shownPage = null; pageBar.hide(); return; }
  shownPage = page.domain;
  // Name what removal will actually drop. A page usually counts because of its own
  // domain, but it can be a broader entry doing the work — and dropping `unipd.it`
  // to stop counting one Overleaf page also stops counting everything else under it.
  // The button still does what the popup's toggle does; it just says so first.
  const wider = page.matched.filter((d) => d !== page.domain);
  pageBar.show(
    page.domain,
    page.allowed ? `${page.domain} counts as work` : `Count ${page.domain} as work`,
    page.allowed,
    wider.length
      ? `Remove ${page.matched.join(', ')} from the whitelist — anything else matching stops counting too`
      : `Stop counting ${page.domain} as work`,
  );
}

// Neither of these names the page: the background decides which page is meant, for
// the same reason it has to — this window cannot see which tab is in front.
pageBar.button.addEventListener('click', () => {
  if (!shownPage) return;
  chrome.runtime.sendMessage({ type: 'WHITELIST_PAGE' }, () => {
    try { if (chrome.runtime.lastError) return; } catch { /* ignore */ }
    askPage();
  });
});

pageBar.remove.addEventListener('click', () => {
  if (!shownPage) return;
  chrome.runtime.sendMessage({ type: 'UNWHITELIST_PAGE' }, () => {
    try { if (chrome.runtime.lastError) return; } catch { /* ignore */ }
    askPage();
  });
});

function askPage() {
  chrome.runtime.sendMessage({ type: 'PAGE_STATUS' }, (res?: PageStatus) => {
    try { if (chrome.runtime.lastError) return; } catch { return; }
    renderPageBar(res ?? null);
  });
}

// ── Program bar ──────────────────────────────────────────────────────────────
// With the agent stopped, this strip turns into a red line saying so. Opening this
// window IS the moment work moves outside the browser, so a stopped agent means
// everything you are about to do goes uncounted, and nothing else on screen would
// tell you. It stays until fixed rather than fading like the footer hint, because it
// describes a state, not a tip. The bar is hidden only when there is genuinely
// nothing to say: agent running, but no program resolved yet (a Wayland session with
// no bridge, say), which the popup's Allowed programs panel explains properly.
let shownProgram: string | null = null;
let offSince = 0;                    // when the agent first looked absent

// A woken service worker answers the first AGENT_STATUS from an empty cache — its
// poll timer did not survive suspension — so "not running" is a normal first answer
// from a machine whose agent is perfectly fine. Two polls' worth of grace turns that
// into no flicker at all, at the cost of a genuinely stopped agent being announced
// four seconds late, which nobody is waiting on.
const OFF_GRACE_MS = 4000;

function renderProgramBar(agent: AgentStatus | null) {
  // Nothing heard back yet — say nothing rather than accuse the agent of being off.
  if (!agent) { programBar.hide(); return; }

  if (!agent.running) {
    if (!offSince) offSince = Date.now();
    if (Date.now() - offSince < OFF_GRACE_MS) return;   // leave the bar as it was
    shownProgram = null;
    programBar.warn(
      'Focus agent is off — double-click the Focus agent icon to run it',
      'Without it, work outside the browser cannot be counted',
    );
    return;
  }

  offSince = 0;
  const p = agent.recent;
  shownProgram = p?.id ?? null;
  if (!p) { programBar.hide(); return; }
  programBar.show(
    p.name,
    agent.recentAllowed ? `${p.id} counts as work` : `Count ${p.id} as work`,
    agent.recentAllowed,
    `Stop counting ${p.id} as work`,
  );
}

programBar.button.addEventListener('click', () => {
  if (!shownProgram) return;
  chrome.runtime.sendMessage({ type: 'ADD_PROGRAM', program: shownProgram }, () => {
    try { if (chrome.runtime.lastError) return; } catch { /* ignore */ }
    askAgent();
  });
});

programBar.remove.addEventListener('click', () => {
  if (!shownProgram) return;
  chrome.runtime.sendMessage({ type: 'REMOVE_PROGRAM', program: shownProgram }, () => {
    try { if (chrome.runtime.lastError) return; } catch { /* ignore */ }
    askAgent();
  });
});

function askAgent() {
  chrome.runtime.sendMessage({ type: 'AGENT_STATUS' }, (res?: AgentStatus) => {
    try { if (chrome.runtime.lastError) return; } catch { return; }
    renderProgramBar(res ?? null);
  });
}

// Polled, because both answers change as you switch tab or alt-tab and nothing
// broadcasts either. Skipped while the window is hidden: this window stays open for
// hours, and a minimised companion asking twice a minute would wake the service
// worker for two bars nobody can see.
function poll() {
  if (document.visibilityState !== 'visible') return;
  askPage();
  askAgent();
}
setInterval(poll, 2000);
poll();

// ── State / settings ─────────────────────────────────────────────────────────
function applyState(s: State) {
  if (!s) return;
  // wasActive starts true, so an already-idle first state anchors the W countdown.
  if (wasActive && !s.isHeartbeatActive) idleSince = Date.now();
  wasActive = s.isHeartbeatActive;
  state = s;
}

function readSettings(raw: unknown) {
  const s = raw as { forceActive?: boolean; idleTime?: number } | undefined;
  if (typeof s?.forceActive === 'boolean') forceActive = s.forceActive;
  if (s?.idleTime !== undefined) idleTimeS = clampIdleTime(Number(s.idleTime));
}

chrome.runtime.onMessage.addListener((msg: { type?: string; state?: State }) => {
  if (msg?.type === 'STATE_UPDATE' && msg.state) applyState(msg.state);
});
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res?: State) => {
  try { if (chrome.runtime.lastError) return; if (res) applyState(res); } catch { /* ignore */ }
});
chrome.storage.local.get(['focusFlowSettings'], (r) => readSettings(r.focusFlowSettings));
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.focusFlowSettings) readSettings(c.focusFlowSettings.newValue);
});

// ── Phase (I / W countdown) ────────────────────────────────────────────────────
// Deliberately the same formula sprite.ts uses, over the same broadcast field
// (state.lastHeartbeat = background's best estimate of the last input). That's the
// only way the two readouts can agree: this window can't see page input directly,
// so anything computed locally here would drift from the in-page sprite.
function currentPhase(): { text: string; color: string } | null {
  const s = state;
  if (!s || s.enabled === false || forceActive) return null;
  const now = Date.now();
  if (s.isHeartbeatActive) {
    // Violet = another app is keeping it alive, blue = this page is. Same countdown.
    const remain = Math.max(0, idleTimeS - (now - s.lastHeartbeat) / 1000);
    return { text: `I ${Math.ceil(remain)}s`, color: s.osHeld ? '#c4b5fd' : '#93c5fd' };
  }
  if (idleSince && now - idleSince < IDLE_WARNING_MS) {
    const remain = Math.max(0, (idleSince + IDLE_WARNING_MS - now) / 1000);
    return { text: `W ${Math.ceil(remain)}s`, color: '#fbbf24' };
  }
  return null;
}

// ── Draw loop ──────────────────────────────────────────────────────────────────
const ctx = canvas.getContext('2d');

function draw() {
  if (!ctx) return;
  const s = state;
  const idle = !s?.isHeartbeatActive;
  const char = CHARS[(s?.currentIconId ?? 0) % CHARS.length] ?? CHARS[0];

  if (s && s.heartbeatCount !== lastHb) {
    const had = lastHb >= 0;
    lastHb = s.heartbeatCount;
    if (had && !idle) bob = -16;
  }
  const discX = 132, discY = 120 + bob, r = 78;
  bob *= 0.82; if (Math.abs(bob) < 0.4) bob = 0;

  ctx.filter = 'none';
  const g = ctx.createRadialGradient(PIP_W * 0.3, PIP_H * 0.42, 20, PIP_W * 0.3, PIP_H * 0.42, PIP_W * 0.8);
  g.addColorStop(0, '#1e293b'); g.addColorStop(1, '#0f172a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, PIP_W, PIP_H);

  if (forceActive) ctx.filter = 'grayscale(1)';

  ctx.beginPath();
  ctx.arc(discX, discY, r, 0, Math.PI * 2);
  ctx.fillStyle = idle ? '#94a3b8' : char.color;
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
  ctx.fill();
  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

  const face = idle ? CRYING[Math.floor(Date.now() / 450) % CRYING.length] : char.icon;
  ctx.font = '84px "Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(face, discX, discY + 4);

  const sx = 250;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = 'bold 46px system-ui, sans-serif';
  const focusStr = String(Math.round(s?.focusScore ?? 0));
  const distStr = String(Math.round(s?.distractedScore ?? 0));
  ctx.fillStyle = '#4ade80'; ctx.fillText(focusStr, sx, 112);
  const fw = ctx.measureText(focusStr).width;
  ctx.fillStyle = '#64748b'; ctx.fillText('/', sx + fw + 12, 112);
  const slw = ctx.measureText('/').width;
  ctx.fillStyle = '#f87171'; ctx.fillText(distStr, sx + fw + 12 + slw + 12, 112);

  const ph = currentPhase();
  if (ph) {
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.fillStyle = ph.color;
    ctx.fillText(ph.text, sx, 168);
  }
  ctx.filter = 'none';
}

setInterval(draw, 66); // ~15 fps
draw();
