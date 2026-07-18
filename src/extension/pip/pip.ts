// Focus companion — helper window.
//
// Renders the companion onto a <canvas> and pops it out as an always-on-top VIDEO
// picture-in-picture. This deliberately lives in an EXTENSION page
// (chrome-extension:// origin) rather than a content script: some sites (e.g.
// Overleaf) send a `Permissions-Policy` header that disables picture-in-picture
// for their whole document, and a content script is bound by the page's policy —
// but this extension document sets its own policy, so PiP is always allowed here.
//
// It mirrors the live SessionState (broadcast by background.ts) and settings
// (chrome.storage.local). The <canvas> drawing is a standalone copy of the sprite's
// PiP renderer — the two documents can't share a runtime, so the character roster
// and draw code are duplicated here on purpose.

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

const stage = document.createElement('div');
Object.assign(stage.style, {
  flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '0',
});
const canvas = document.createElement('canvas');
canvas.width = PIP_W; canvas.height = PIP_H;
Object.assign(canvas.style, {
  maxWidth: '100%', maxHeight: '100%', borderRadius: '14px',
  boxShadow: '0 8px 30px rgba(0,0,0,0.45)',
});
stage.appendChild(canvas);

const footer = document.createElement('div');
Object.assign(footer.style, {
  padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px',
  alignItems: 'center', borderTop: '1px solid rgba(148,163,184,0.18)',
});
const button = document.createElement('button');
button.textContent = 'Pop out ⤢';
Object.assign(button.style, {
  width: '100%', padding: '10px 14px', border: 'none', borderRadius: '10px',
  background: '#22c55e', color: '#fff', fontSize: '14px', fontWeight: '800',
  cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
});
const hint = document.createElement('div');
Object.assign(hint.style, { fontSize: '11px', color: '#94a3b8', textAlign: 'center', lineHeight: '1.4' });
hint.textContent = 'Opens a floating window that stays on top of every app.';
footer.append(button, hint);

root.append(stage, footer);

// ── Video PiP ────────────────────────────────────────────────────────────────
// Whether the overlay actually floats ABOVE other apps is decided by the desktop
// compositor, not by us — the API only requests PiP. On Linux/Wayland (e.g. GNOME)
// Chromium can't mark its window always-on-top, so the overlay drops behind the
// focused window; running the browser on X11 (`--ozone-platform=x11`) fixes it.
// macOS/Windows are always-on-top natively. See the README "Floating companion".
const stream = canvas.captureStream(15);
const video = document.createElement('video');
video.muted = true;
(video as HTMLVideoElement & { playsInline: boolean }).playsInline = true;
Object.assign(video.style, { position: 'fixed', left: '-9999px', width: '1px', height: '1px', opacity: '0' });
video.srcObject = stream;
document.body.appendChild(video);
video.play().catch(() => { /* muted canvas stream — should not be blocked */ });

video.addEventListener('enterpictureinpicture', () => {
  button.textContent = 'Bring companion back';
  button.style.background = '#3b82f6';
  hint.textContent = 'Floating and on top. Keep this window open (behind others is fine) — closing it closes the overlay.';
});
video.addEventListener('leavepictureinpicture', () => {
  button.textContent = 'Pop out ⤢';
  button.style.background = '#22c55e';
  hint.textContent = 'Opens a floating window that stays on top of every app.';
});

button.addEventListener('click', () => {
  if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); return; }
  video.requestPictureInPicture().catch((err: unknown) => {
    const name = (err as { name?: string })?.name || 'Error';
    hint.textContent = `Couldn't open the floating window (${name}).`;
    console.warn('Focus: picture-in-picture failed', err);
  });
});

// ── State / settings ─────────────────────────────────────────────────────────
function applyState(s: State) {
  if (!s) return;
  if (wasActive && !s.isHeartbeatActive) idleSince = Date.now(); // just went idle
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
function currentPhase(): { text: string; color: string } | null {
  const s = state;
  if (!s || s.enabled === false || forceActive) return null;
  const now = Date.now();
  if (s.isHeartbeatActive) {
    // Best-effort from the broadcast lastHeartbeat (the helper can't see page input).
    const remain = Math.max(0, idleTimeS - (now - s.lastHeartbeat) / 1000);
    return { text: `I ${Math.ceil(remain)}s`, color: '#93c5fd' };
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
