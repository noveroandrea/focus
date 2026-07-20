// Focus companion — helper window.
//
// A small always-visible window that mirrors the sprite, for when Chrome is
// covered by another app. It's a plain extension window (chrome-extension://
// origin) drawing to a <canvas> — keep it on top with your window manager's
// "Always on Top" (right-click the title bar on GNOME/KDE; macOS and Windows have
// equivalents or use a tiling/WM rule).
//
// It deliberately does NOT use picture-in-picture any more. PiP needs a playing
// <video>, and Chrome holds a screen wake lock while video plays — on Linux that
// can stop the session from ever registering as idle, so the companion silently
// broke the very idle detection it was displaying. A WM-pinned normal window gives
// the same always-on-top result with none of that (and none of Wayland's inability
// to let Chromium raise its own PiP window).
//
// It mirrors the live SessionState (broadcast by background.ts) and settings
// (chrome.storage.local). The <canvas> drawing is a standalone copy of the sprite's
// renderer — the two documents can't share a runtime, so the character roster and
// draw code are duplicated here on purpose.

import { clampIdleTime } from '../../types';
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
footer.textContent = 'Right-click the title bar → “Always on Top”';
footer.title = 'Right-click this window’s title bar and enable “Always on Top” to keep it above other applications.';
setTimeout(() => {
  footer.style.opacity = '0';
  setTimeout(() => { footer.style.display = 'none'; }, 700);
}, 8000);

root.append(stage, footer);

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
