// Vanilla TypeScript. The only import is ../timings (pure numeric constants,
// shared with background.ts so the idle timeline can't drift); it inlines away, so
// the compiled content-script bundle stays self-contained.
import {
  IDLE_WARNING_MS, STEP_DELAY_MS, INTERACTION_STEP_MS, GROW_DURATION_MS, ICON_POP_MS,
} from '../timings';

interface SessionState {
  isHeartbeatActive: boolean;
  lastHeartbeat: number;
  activeWindowId: number | null;
  enabled: boolean;
  currentIconId: number;
  heartbeatCount: number;
  iconChangeAt: number;
  focusScore: number;
  distractedScore: number;
  penaltyAt: number;
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
const SIZE = 60;
const FIREWORK_COLORS = ['#fde047', '#f97316', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#a855f7'];

// Active sizing: the sprite starts at START_SCALE right after a change and
// shrinks toward MIN_SCALE as active heartbeats accumulate, reaching the
// minimum exactly when the heartbeat count hits the configured threshold.
const START_SCALE = 2;
const MIN_SCALE = 0.5;
const ACTIVE_TRANSITION = 'background-color 0.35s ease, left 0.09s ease, top 0.09s ease, transform 0.9s linear';

// ── Lifecycle ─────────────────────────────────────────────────────────────────
((window as any).__ffSpriteCleanup as (() => void) | undefined)?.();
let stopped = false;

// ── State ─────────────────────────────────────────────────────────────────────
let appState: SessionState | null = null;
let iconChangeHeartbeats = 30; // mirrors settings; threshold for the shrink/change
let cryBeepVolume = 100;       // mirrors settings; peak volume (0–100 %) of the idle beep
let cryBeepDuration = 60;      // mirrors settings; seconds the idle beep lasts before stopping
let cryBeepStyle: 'ramp' | 'pulse' | 'siren' = 'ramp'; // mirrors settings; beep pattern
let soundEnabled = true;       // mirrors settings; master switch for the idle beep
// Whether THIS page is whitelisted. The sprite runs on every page but only a
// whitelisted one counts as work, so off-whitelist we show the crying face right
// away as a hint. This is a face swap only — every real idle behaviour (beep,
// grow, colour, steps) still waits out the normal idle time, since the state that
// drives them is global and owned by the background. Defaults to true so a
// whitelisted page never flashes a crying face before settings load.
let pageAllowed = true;
// Mirrors settings.forceActive — the "Not working" status. It pins the sprite
// active with no real work behind it (and earns no score), so we desaturate the
// whole thing to make that legible at a glance.
let forcedNotWorking = false;
let px = Math.random() * 300 + 100;
let py = Math.random() * 200 + 100;
let vx = 2.5, vy = 1.8;
let isDragging = false;
let dragOX = 0, dragOY = 0;
let cryFrame = 0;
let cryTimer: ReturnType<typeof setInterval> | null = null;
let changeTimer: ReturnType<typeof setTimeout> | null = null;
let wasHeartbeatActive: boolean | null = null;
let lastIconChangeAt = 0;
let lastPenaltyAt = 0;
// The first state we receive carries the persisted nonces; we sync to them
// WITHOUT animating so a page load never replays an old change/penalty. Every
// change after that is a real event and does animate. (A plain `=== 0` guard
// fails for penaltyAt, which legitimately starts at 0 → the first real penalty
// would be mistaken for the load value and skipped.)
let noncesInited = false;
let scaleAnimTimer: ReturnType<typeof setInterval> | null = null;

// ── Step-based movement ───────────────────────────────────────────────────────
const STEP_PX = 18;
let pendingSteps = 0;
let stepTimer: ReturnType<typeof setTimeout> | null = null;
// Last heartbeat count seen from the background. Movement is driven off this so
// the sprite takes exactly one step per heartbeat, whatever generated it (page
// activity OR the background's chrome.idle poll). -1 = nothing seen yet.
let lastHeartbeatCount = -1;

function doStep() {
  stepTimer = null;
  // Sprite only moves when active
  if (stopped || pendingSteps <= 0 || isDragging || !(appState?.isHeartbeatActive)) {
    pendingSteps = 0;
    return;
  }
  const maxX = window.innerWidth  - SIZE;
  const maxY = window.innerHeight - SIZE;
  const mag = Math.sqrt(vx * vx + vy * vy) || 1;
  let nx = px + (vx / mag) * STEP_PX;
  let ny = py + (vy / mag) * STEP_PX;
  if (nx <= 0 || nx >= maxX) { vx = -vx; nx = px + (vx / mag) * STEP_PX; }
  if (ny <= 0 || ny >= maxY) { vy = -vy; ny = py + (vy / mag) * STEP_PX; }
  px = Math.max(0, Math.min(nx, maxX));
  py = Math.max(0, Math.min(ny, maxY));
  spriteEl.style.left = px + 'px';
  spriteEl.style.top  = py + 'px';
  pendingSteps--;
  if (pendingSteps > 0) stepTimer = setTimeout(doStep, STEP_DELAY_MS);
}

function queueSteps(n: number) {
  pendingSteps += n;
  if (!stepTimer && pendingSteps > 0) doStep();
}

// Queue a step in response to real page interaction, throttled so a burst of
// mousemove/scroll events becomes a steady walk rather than a spam of steps.
// Only walks while active and not being dragged.
let lastInteractionStep = 0;
function interactionStep() {
  lastPageActivity = Date.now(); // reset the "I" countdown on any real page activity
  if (stopped || isDragging || !appState?.isHeartbeatActive) return;
  const now = Date.now();
  if (now - lastInteractionStep < INTERACTION_STEP_MS) return;
  lastInteractionStep = now;
  queueSteps(1);
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
let spriteEl: HTMLDivElement;
let iconEl: HTMLSpanElement;
let scoreEl: HTMLSpanElement;
let focusEl: HTMLSpanElement;
let distractedEl: HTMLSpanElement;

// ── Phase countdown (debug readout under the score) ────────────────────────────
// A small "I 12s" / "W 4s" line below the points that ticks down the current
// phase's remaining time, so the idle timeline can be watched live:
//   • I — time until this page is treated as idle, counted from the last real page
//         interaction (≈ the idleTime setting). Resets on mouse/key/scroll here.
//   • W — the face-only warning window before the beep/grow (IDLE_WARNING_MS).
// It's derived from page-local activity, so if it sits at "I 0s" for a while before
// "W" appears, that gap is chrome.idle reporting the OS idle late (Linux/Wayland).
let phaseEl: HTMLSpanElement;
let phaseTimer: ReturnType<typeof setInterval> | null = null;
let lastPageActivity = Date.now(); // last real interaction on THIS page
let warningStartAt = 0;            // when the current idle warning began
let idleTimeS = 20;                // mirror of the idleTime setting (seconds)

// NOTE: the always-on-top floating companion (video picture-in-picture) is NOT
// hosted here. Pages can disable PiP via Permissions-Policy (e.g. Overleaf), and a
// content script is bound by the page's policy — so the PiP lives in an extension
// page instead (src/extension/pip/pip.ts), which sets its own policy. The popup's
// Working button opens that window. This file only keeps the in-page sprite.

function setIconText(text: string) {
  iconEl.textContent = text;
}

/** Mirrors isAllowedUrl in background.ts: a page is work when its URL contains a
 *  whitelisted domain. Treats missing settings as allowed (see pageAllowed). */
function isPageAllowed(domains: unknown): boolean {
  if (!Array.isArray(domains)) return true;
  return domains.some((d) => typeof d === 'string' && d.trim() !== '' && location.href.includes(d.trim()));
}

/** Grey the sprite out while the status is "Not working". A CSS filter desaturates
 *  the character emoji and its coloured disc together, so it keeps every bit of
 *  its normal behaviour (steps, shrink, face) but reads as paused, not earning. */
function renderWorkingFilter() {
  if (spriteEl) spriteEl.style.filter = forcedNotWorking ? 'grayscale(1)' : 'none';
}

/** Paint the face for the active state: the real character on a whitelisted page,
 *  the crying icon on any other. No-op while actually idle — the cry animation
 *  owns the face then. */
function renderActiveFace() {
  if (!appState?.isHeartbeatActive || cryTimer) return;
  const char = CHARS[appState.currentIconId % CHARS.length] ?? CHARS[0];
  setIconText(pageAllowed ? char.icon : CRYING[0]);
}

function setScore(focus: number, distracted: number) {
  if (focusEl) focusEl.textContent = String(Math.round(focus));
  // Already negative — String() keeps the minus sign, which is the point.
  if (distractedEl) distractedEl.textContent = String(Math.round(distracted));
}

// The current idle-timeline phase as a short label + colour, or null when there's
// nothing to count (disabled, "Not working", or the beep/grow already running).
// Shared by the in-page readout and the PiP canvas so they never disagree.
function currentPhase(): { text: string; color: string } | null {
  const st = appState;
  if (!st || st.enabled === false || forcedNotWorking) return null;
  const now = Date.now();
  if (st.isHeartbeatActive) {
    const remain = Math.max(0, idleTimeS - (now - lastPageActivity) / 1000);
    return { text: `I ${Math.ceil(remain)}s`, color: '#93c5fd' }; // blue — working
  }
  if (warningTimer) {
    const remain = Math.max(0, (warningStartAt + IDLE_WARNING_MS - now) / 1000);
    return { text: `W ${Math.ceil(remain)}s`, color: '#fbbf24' }; // amber — warning
  }
  return null;
}

// Tick the phase countdown under the score. Called ~4×/s so the number is smooth.
function updatePhaseReadout() {
  if (!phaseEl) return;
  const ph = currentPhase();
  if (!ph) { phaseEl.style.display = 'none'; return; }
  phaseEl.textContent = ph.text;
  phaseEl.style.color = ph.color;
  phaseEl.style.display = 'block';
}

// ── CSS ───────────────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('ff-styles')) return;
  const s = document.createElement('style');
  s.id = 'ff-styles';
  s.textContent = `
    @keyframes ff-pop {
      0%   { transform: scale(1)   rotate(0deg); }
      40%  { transform: scale(1.6) rotate(200deg); }
      100% { transform: scale(1)   rotate(360deg); }
    }
    #focus-flow-root * { box-sizing: border-box; font-family: system-ui, sans-serif; }
  `;
  (document.head || document.documentElement).appendChild(s);
}

// ── Scale animations ──────────────────────────────────────────────────────────
function stopScaleAnimation() {
  if (scaleAnimTimer) { clearInterval(scaleAnimTimer); scaleAnimTimer = null; }
}

/** Idle: center sprite on screen, grow from scale(1) to fill window over 20s. */
function startGrowAnimation() {
  stopScaleAnimation();
  spriteEl.style.transition = 'background-color 0.35s ease, left 1.5s ease, top 1.5s ease';
  const centerX = window.innerWidth  / 2 - SIZE / 2;
  const centerY = window.innerHeight / 2 - SIZE / 2;
  spriteEl.style.left = centerX + 'px';
  spriteEl.style.top  = centerY + 'px';
  px = centerX;
  py = centerY;
  spriteEl.style.transform = 'scale(1)';
  counterScaleScore(1);

  const maxScale = Math.ceil(Math.max(window.innerWidth, window.innerHeight) / SIZE) + 2;
  const duration = GROW_DURATION_MS;
  const startTime = Date.now();

  scaleAnimTimer = setInterval(() => {
    if (stopped) { stopScaleAnimation(); return; }
    const progress = Math.min((Date.now() - startTime) / duration, 1);
    const scale = 1 + (maxScale - 1) * (progress * progress); // easeIn
    spriteEl.style.transform = `scale(${scale})`;
    counterScaleScore(scale);
    if (progress >= 1) stopScaleAnimation();
  }, 50);
}

// ── Heartbeat-driven sizing ───────────────────────────────────────────────────
// While active, the sprite scale is a direct function of the accumulated
// heartbeat count: full size at 0, minimum size at `iconChangeHeartbeats`.
function activeScale(count: number): number {
  const p = Math.min(1, Math.max(0, count / Math.max(1, iconChangeHeartbeats)));
  return START_SCALE + (MIN_SCALE - START_SCALE) * p;
}

/** Active: set the sprite size from the current heartbeat count. */
function applyActiveSize() {
  if (!appState) return;
  stopScaleAnimation();
  spriteEl.style.transition = ACTIVE_TRANSITION;
  const sc = activeScale(appState.heartbeatCount);
  spriteEl.style.transform = `scale(${sc})`;
  counterScaleScore(sc);
}

// Keep the score badge a constant on-screen size regardless of how the sprite is
// scaled (shrinking while active, growing while idle) by inverting the scale.
function counterScaleScore(spriteScale: number) {
  const t = `translateX(-50%) scale(${1 / spriteScale})`;
  if (scoreEl) scoreEl.style.transform = t;
  if (phaseEl) phaseEl.style.transform = t;
}

// ── Fireworks (icon change celebration) ───────────────────────────────────────
function triggerFireworks() {
  const rootEl = document.getElementById('focus-flow-root');
  if (!rootEl) return;
  const cx = px + SIZE / 2;
  const cy = py + SIZE / 2;
  const N = 14;
  for (let i = 0; i < N; i++) {
    const dot = document.createElement('div');
    const angle = (Math.PI * 2 * i) / N + Math.random() * 0.35;
    const dist = 38 + Math.random() * 40;
    const dotSize = 5 + Math.random() * 4;
    const color = FIREWORK_COLORS[i % FIREWORK_COLORS.length];
    Object.assign(dot.style, {
      position: 'absolute',
      left: cx + 'px', top: cy + 'px',
      width: dotSize + 'px', height: dotSize + 'px',
      borderRadius: '50%',
      background: color,
      boxShadow: `0 0 6px ${color}`,
      pointerEvents: 'none',
      zIndex: '2147483647',
    });
    rootEl.appendChild(dot);
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const anim = dot.animate(
      [
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.3)`, opacity: 0 },
      ],
      { duration: 650 + Math.random() * 250, easing: 'cubic-bezier(0.15,0.6,0.4,1)' },
    );
    anim.onfinish = () => dot.remove();
  }
}

/** Idle-penalty feedback: a huge red "−10" that pops up over the sprite, holds
 *  at full size for ~2 s, then fades — ~3 s total. Fired once per idle lapse
 *  (driven by the background's penaltyAt). Sized to the viewport so it reads big
 *  on any screen. Rendered at the screen centre so the grown idle sprite never
 *  covers it. */
function triggerPenalty() {
  const rootEl = document.getElementById('focus-flow-root');
  if (!rootEl) return;
  const label = document.createElement('div');
  label.textContent = '−10';
  const fontSize = Math.max(120, Math.min(window.innerWidth * 0.28, 320));
  Object.assign(label.style, {
    position: 'fixed',
    left: '50%',
    top: '50%',
    color: '#ef4444',
    fontWeight: '900',
    fontSize: fontSize + 'px',
    lineHeight: '1',
    fontFamily: 'system-ui, sans-serif',
    textShadow: '0 4px 16px rgba(0,0,0,0.55)',
    pointerEvents: 'none',
    zIndex: '2147483647',
  });
  rootEl.appendChild(label);
  const anim = label.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0.3)', opacity: 0, offset: 0 },
      { transform: 'translate(-50%, -50%) scale(1)',   opacity: 1, offset: 0.12 }, // pop in (~0.35 s)
      { transform: 'translate(-50%, -50%) scale(1)',   opacity: 1, offset: 0.78 }, // hold full size (~2 s)
      { transform: 'translate(-50%, -75%) scale(1)',   opacity: 0, offset: 1 },     // rise + fade out
    ],
    { duration: 3000, easing: 'ease-out' },
  );
  anim.onfinish = () => label.remove();
}

/** Play the icon-change celebration: fireworks + a quick spin pop, then the new
 *  character restarts at full size (heartbeat count is back to 0). */
function triggerIconChange() {
  if (changeTimer) clearTimeout(changeTimer);
  stopScaleAnimation();
  triggerFireworks();
  spriteEl.style.transform = ''; // hand transform to the CSS animation
  spriteEl.style.animation = 'ff-pop 0.7s ease forwards';
  changeTimer = setTimeout(() => {
    changeTimer = null;
    spriteEl.style.animation = '';
    if (appState?.isHeartbeatActive) applyActiveSize();
    else startGrowAnimation();
  }, ICON_POP_MS);
}

// ── Idle beep (Web Audio) ───────────────────────────────────────────────────
// A high-tone sine played while the sprite is idle (crying). The pattern depends
// on `cryBeepStyle` and always stops on its own after `cryBeepDuration` s:
//   • 'ramp'  — one tone fading in from silence up to the set volume.
//   • 'pulse' — short beeps at full set volume, a fixed gap between them.
//   • 'siren' — a two-tone alarm at full set volume the whole time.
const BEEP_FREQ = 1320;      // Hz — high tone
const BEEP_SIREN_LO = 740;   // Hz — siren's low tone
const BEEP_PULSE_LEN = 0.12; // s — length of each pulse beep
const BEEP_PULSE_GAP = 5.0;  // s — fixed gap between pulses for the whole run
const BEEP_SIREN_PERIOD = 0.7;    // s — one low→high→low siren sweep
const BEEP_MAX_GAIN = 1.0;   // slider maps straight to gain: 20 % → gain 0.20, i.e.
                             // 20 % of full scale when the system volume is at 100 %.
                             // (Web Audio gain is relative to system volume — the OS
                             //  multiplies afterward and that value can't be read — so
                             //  as the system volume drops the beep drops with it; a
                             //  constant absolute loudness isn't possible in a browser.)

let audioCtx: AudioContext | null = null;
let beepOsc: OscillatorNode | null = null;
let beepGain: GainNode | null = null;

// Chrome's autoplay policy only lets an AudioContext start after a user gesture.
// The beep itself fires when the sprite goes idle (no gesture), so we create and
// resume the context up-front on the user's normal keypresses/clicks while they
// are active — by the time the idle beep is needed, the context is already live.
//
// Crucially we create the context lazily — only the FIRST time unlockAudio runs
// inside a real gesture — and the unlock listeners are registered in the *capture*
// phase (see init). Some SPAs (e.g. Telegram Web) stopPropagation on input events,
// so bubble-phase window listeners never fire and the context would be constructed
// outside a gesture, tripping "AudioContext was not allowed to start". Capture
// phase runs before the page can swallow the event, so the gesture is genuine.
function unlockAudio() {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch { /* audio unavailable — ignore */ }
}

function startBeep() {
  if (beepOsc || !soundEnabled || cryBeepVolume <= 0) return;
  // Only play through an already-unlocked context. We never create or resume it
  // here: going idle isn't a user gesture, so doing so would violate Chrome's
  // autoplay policy and log a console warning. unlockAudio() (wired to keydown/
  // mousedown) is the sole owner of context creation, so by the time the user
  // has been active and then goes idle, the context is already running.
  if (!audioCtx || audioCtx.state !== 'running') return;
  try {
    const now = audioCtx.currentTime;
    const target = (cryBeepVolume / 100) * BEEP_MAX_GAIN;
    const duration = cryBeepDuration; // seconds

    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    const gain = audioCtx.createGain();
    osc.connect(gain).connect(audioCtx.destination);

    if (cryBeepStyle === 'pulse') {
      // Short beeps at full volume with a fixed gap for the whole run.
      osc.frequency.value = BEEP_FREQ;
      gain.gain.setValueAtTime(0, now);
      let t = 0;
      while (t < duration) {
        const tb = now + t;
        gain.gain.setValueAtTime(target, tb);                       // beep on
        gain.gain.setValueAtTime(target, tb + BEEP_PULSE_LEN - 0.02);
        gain.gain.linearRampToValueAtTime(0, tb + BEEP_PULSE_LEN);  // beep off
        t += BEEP_PULSE_GAP;
      }
      osc.start(now);
      osc.stop(now + duration + 0.05);
    } else if (cryBeepStyle === 'siren') {
      // Constant full volume; frequency sweeps low↔high for an alarm feel.
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(target, now + 0.05); // tiny fade-in (anti-click)
      osc.frequency.setValueAtTime(BEEP_SIREN_LO, now);
      let t = 0;
      while (t < duration) {
        osc.frequency.linearRampToValueAtTime(BEEP_FREQ,     now + Math.min(t + BEEP_SIREN_PERIOD / 2, duration));
        osc.frequency.linearRampToValueAtTime(BEEP_SIREN_LO, now + Math.min(t + BEEP_SIREN_PERIOD,     duration));
        t += BEEP_SIREN_PERIOD;
      }
      osc.start(now);
      osc.stop(now + duration);
    } else {
      // 'ramp' — one tone fading in from silence to the set volume.
      osc.frequency.value = BEEP_FREQ;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(target, now + duration);
      osc.start(now);
      osc.stop(now + duration);                  // beep lasts exactly `duration` s
    }

    osc.onended = () => {                          // clear refs when it self-stops
      if (beepOsc === osc) { beepOsc = null; beepGain = null; }
    };
    beepOsc = osc;
    beepGain = gain;
  } catch { /* audio unavailable — ignore */ }
}

function stopBeep() {
  if (!beepOsc || !audioCtx) { beepOsc = null; beepGain = null; return; }
  try {
    const now = audioCtx.currentTime;
    if (beepGain) {
      beepGain.gain.cancelScheduledValues(now);
      beepGain.gain.setValueAtTime(beepGain.gain.value, now);
      beepGain.gain.linearRampToValueAtTime(0, now + 0.08); // brief fade-out
    }
    beepOsc.stop(now + 0.1);
  } catch { /* ignore */ }
  beepOsc = null;
  beepGain = null;
}

/** Reconcile the beep with changed settings (volume/style/duration/sound) while
 *  the sprite is still crying. Each style schedules its whole pattern up-front,
 *  so the simplest correct response is to stop and restart with the new values. */
function restartBeepIfCrying() {
  stopBeep();
  if (soundEnabled && cryTimer && cryBeepVolume > 0) startBeep();
}

// ── Idle warning ──────────────────────────────────────────────────────────────
// Going idle doesn't escalate straight to the full crying behaviour. For the
// first IDLE_WARNING_MS we only swap the face to the crying icon as a heads-up —
// no beep, no cry animation, no grow to centre. Come back within the window and
// none of that ever fires; stay away and it all starts at the end of it. The
// score's grace period only begins here, once the warning is over. IDLE_WARNING_MS
// is imported from ../timings — the SAME constant background.ts uses, so the face
// warning and the scoring timeline can never drift apart.
let warningTimer: ReturnType<typeof setTimeout> | null = null;

function startIdleWarning() {
  if (warningTimer || cryTimer) return;
  warningStartAt = Date.now(); // anchor the "W" countdown
  setIconText(CRYING[0]);
  warningTimer = setTimeout(() => {
    warningTimer = null;
    if (appState?.isHeartbeatActive) return; // activity resumed → never escalate
    startCrying();
    if (!changeTimer) startGrowAnimation();
  }, IDLE_WARNING_MS);
}

function stopIdleWarning() {
  if (!warningTimer) return;
  clearTimeout(warningTimer);
  warningTimer = null;
}

// ── Crying ────────────────────────────────────────────────────────────────────
function startCrying() {
  if (cryTimer) return;
  cryTimer = setInterval(() => {
    cryFrame = (cryFrame + 1) % CRYING.length;
    setIconText(CRYING[cryFrame]);
  }, 500);
  startBeep();
}
function stopCrying() {
  if (!cryTimer) return;
  clearInterval(cryTimer);
  cryTimer = null;
  stopBeep();
}

// ── State → DOM ───────────────────────────────────────────────────────────────
function applyState(s: SessionState) {
  appState = s;

  // Master enable switch — hide everything when disabled.
  const rootEl = document.getElementById('focus-flow-root');
  if (rootEl) rootEl.style.display = s.enabled === false ? 'none' : 'block';

  const char = CHARS[s.currentIconId % CHARS.length] ?? CHARS[0];

  setScore(s.focusScore ?? 0, s.distractedScore ?? 0);

  const transitioned = wasHeartbeatActive !== s.isHeartbeatActive;
  wasHeartbeatActive = s.isHeartbeatActive;

  // One step per heartbeat, from any source. The background counts one heartbeat
  // per active second (page activity or the chrome.idle poll) and broadcasts the
  // new count, so a change here means a heartbeat just happened — take a step.
  if (s.heartbeatCount !== lastHeartbeatCount) {
    const hadCount = lastHeartbeatCount >= 0;
    lastHeartbeatCount = s.heartbeatCount;
    if (hadCount && s.isHeartbeatActive) queueSteps(1);
  }

  spriteEl.style.backgroundColor = s.isHeartbeatActive ? char.color : '#94a3b8';

  if (s.isHeartbeatActive) {
    stopIdleWarning();
    stopCrying();
    renderActiveFace();
    // Size follows the heartbeat count (shrinks as focus accumulates).
    if (!changeTimer) applyActiveSize();
  } else if (transitioned) {
    startIdleWarning();          // face-only heads-up; escalates after the window
  } else if (!warningTimer) {
    startCrying();               // window already elapsed → keep the real idle state
  }

  // Nonces (iconChangeAt / penaltyAt): sync silently on the first state, then
  // animate on every later change — including the first real one.
  if (!noncesInited) {
    noncesInited = true;
    lastIconChangeAt = s.iconChangeAt;
    lastPenaltyAt = s.penaltyAt ?? 0;
  } else {
    if (s.iconChangeAt && s.iconChangeAt !== lastIconChangeAt) {
      lastIconChangeAt = s.iconChangeAt;
      triggerIconChange();
    }
    if (s.penaltyAt && s.penaltyAt !== lastPenaltyAt) {
      lastPenaltyAt = s.penaltyAt;
      triggerPenalty();
    }
  }
}

// ── Sprite ────────────────────────────────────────────────────────────────────
function buildSprite(): HTMLDivElement {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'absolute',
    width: SIZE + 'px', height: SIZE + 'px',
    left: px + 'px', top: py + 'px',
    borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#94a3b8',
    cursor: 'grab',
    pointerEvents: 'auto',
    boxShadow: '0 8px 20px rgba(0,0,0,0.28)',
    border: '4px solid white',
    userSelect: 'none',
    transition: ACTIVE_TRANSITION,
    zIndex: '2147483647',
    transformOrigin: 'center',
  });
  spriteEl = el;

  const icon = document.createElement('span');
  icon.style.fontSize = '24px';
  icon.style.lineHeight = '1';
  icon.style.pointerEvents = 'none';
  el.appendChild(icon);
  iconEl = icon;

  // Score badge pinned to the bottom of the circle: focus earned (green) beside
  // distraction lost (red). It counter-scales in applyActiveSize so it stays
  // legible whatever size the sprite is.
  const score = document.createElement('span');
  Object.assign(score.style, {
    position: 'absolute',
    bottom: '-9px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    gap: '5px',
    alignItems: 'center',
    padding: '1px 6px',
    borderRadius: '9px',
    background: 'rgba(15,23,42,0.9)',
    fontSize: '11px',
    fontWeight: '700',
    lineHeight: '1.3',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
  });
  const focus = document.createElement('span');
  focus.style.color = '#4ade80';
  focus.textContent = '0';
  const distracted = document.createElement('span');
  distracted.style.color = '#f87171';
  distracted.textContent = '0';
  score.append(focus, distracted);
  el.appendChild(score);
  scoreEl = score;
  focusEl = focus;
  distractedEl = distracted;

  // Phase countdown line, just under the score pill. Counter-scaled alongside it.
  const phase = document.createElement('span');
  Object.assign(phase.style, {
    position: 'absolute',
    bottom: '-25px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'none',
    padding: '0 5px',
    borderRadius: '7px',
    background: 'rgba(15,23,42,0.85)',
    fontSize: '10px',
    fontWeight: '700',
    lineHeight: '1.4',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    color: '#93c5fd',
  });
  el.appendChild(phase);
  phaseEl = phase;

  el.addEventListener('pointerdown', (e: PointerEvent) => {
    e.stopPropagation();
    isDragging = false;
    el.style.cursor = 'grabbing';
    const rect = el.getBoundingClientRect();
    dragOX = e.clientX - rect.left;
    dragOY = e.clientY - rect.top;
    el.setPointerCapture(e.pointerId);
    el.addEventListener('pointermove', onSpriteMove as EventListener);
    el.addEventListener('pointerup', onSpriteUp as EventListener, { once: true });
  });

  return el;
}

function onSpriteMove(e: PointerEvent) {
  isDragging = true;
  px = Math.max(0, Math.min(e.clientX - dragOX, window.innerWidth  - SIZE));
  py = Math.max(0, Math.min(e.clientY - dragOY, window.innerHeight - SIZE));
  spriteEl.style.left = px + 'px';
  spriteEl.style.top  = py + 'px';
}

function onSpriteUp(_e: PointerEvent) {
  spriteEl.removeEventListener('pointermove', onSpriteMove as EventListener);
  spriteEl.style.cursor = 'grab';
  setTimeout(() => { isDragging = false; }, 30);
}

// ── Settings sync ──────────────────────────────────────────────────────────────
function readSettings(raw: unknown) {
  const s = raw as { iconChangeHeartbeats?: number; cryBeepVolume?: number; cryBeepDuration?: number; cryBeepStyle?: string; soundEnabled?: boolean; allowedDomains?: unknown; forceActive?: boolean; idleTime?: number } | undefined;
  const it = Number(s?.idleTime);
  if (Number.isFinite(it)) idleTimeS = Math.min(300, Math.max(15, Math.round(it)));
  const h = Number(s?.iconChangeHeartbeats);
  if (Number.isFinite(h)) iconChangeHeartbeats = Math.min(300, Math.max(5, Math.round(h)));
  const v = Number(s?.cryBeepVolume);
  if (Number.isFinite(v)) cryBeepVolume = Math.min(100, Math.max(0, Math.round(v)));
  const d = Number(s?.cryBeepDuration);
  if (Number.isFinite(d)) cryBeepDuration = Math.min(300, Math.max(10, Math.round(d)));
  cryBeepStyle = s?.cryBeepStyle === 'pulse' || s?.cryBeepStyle === 'siren' ? s.cryBeepStyle : 'ramp';
  if (typeof s?.soundEnabled === 'boolean') soundEnabled = s.soundEnabled;
  if (s?.allowedDomains !== undefined) pageAllowed = isPageAllowed(s.allowedDomains);
  if (typeof s?.forceActive === 'boolean') forcedNotWorking = s.forceActive;
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  if (document.getElementById('focus-flow-root')) return;

  injectStyles();

  const rootEl = document.createElement('div');
  rootEl.id = 'focus-flow-root';
  Object.assign(rootEl.style, {
    position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647',
  });
  document.body.appendChild(rootEl);

  spriteEl = buildSprite();
  rootEl.appendChild(spriteEl);

  // Unlock the AudioContext on the first real gesture. Capture phase + multiple
  // gesture types so pages that stopPropagation on input still let us through.
  // Note this can only ever fire on a genuine user activation: mousemove/wheel/
  // scroll do NOT qualify, and neither does the background's OS idle poll — so a
  // page you only read (or stay active on via another window) still has no
  // context and stays silent on idle until you click or type in it once.
  const unlockOpts = { capture: true, passive: true } as AddEventListenerOptions;
  window.addEventListener('pointerdown', unlockAudio, unlockOpts);
  window.addEventListener('pointerup', unlockAudio, unlockOpts);
  window.addEventListener('mousedown', unlockAudio, unlockOpts);
  window.addEventListener('mouseup', unlockAudio, unlockOpts);
  window.addEventListener('keydown', unlockAudio, unlockOpts);
  window.addEventListener('keyup', unlockAudio, unlockOpts);
  window.addEventListener('touchstart', unlockAudio, unlockOpts);
  window.addEventListener('touchend', unlockAudio, unlockOpts);
  window.addEventListener('click', unlockAudio, unlockOpts);

  // Step the sprite on REAL page interaction, locally — the background's heartbeat
  // count is throttled to ~1/s and is usually consumed by the chrome.idle poll, so
  // page activity would otherwise never produce a distinct step (the sprite would
  // appear to move "only on idle"). This makes it visibly react to mouse/keyboard/
  // scroll here, while the count-driven step in applyState still covers heartbeats
  // from any source. Capture phase + passive so SPAs that stopPropagation still let
  // us through; throttled so fast mouse moves don't spam steps. Active-gated.
  window.addEventListener('pointermove', interactionStep, unlockOpts);
  window.addEventListener('keydown', interactionStep, unlockOpts);
  window.addEventListener('mousedown', interactionStep, unlockOpts);
  window.addEventListener('wheel', interactionStep, unlockOpts);
  window.addEventListener('scroll', interactionStep, unlockOpts);

  chrome.storage.local.get(['focusFlowSettings'], (r) => {
    readSettings(r.focusFlowSettings);
    renderActiveFace(); // the whitelist just resolved — the face may need to change
    renderWorkingFilter();
    if (appState?.isHeartbeatActive && !changeTimer) applyActiveSize();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.focusFlowSettings) {
      readSettings(changes.focusFlowSettings.newValue);
      // Reconcile the beep with the new settings (volume/style/duration/sound):
      // restart it cleanly if still crying, otherwise it stays stopped.
      restartBeepIfCrying();
      // Whitelisting this page (popup toggle or AI classify) swaps the face back
      // to the real character without waiting for the next state broadcast.
      renderActiveFace();
      // Covers both the popup's toggle and the background's automatic switch to
      // "Not working" after the beep runs out.
      renderWorkingFilter();
      if (appState?.isHeartbeatActive && !changeTimer) applyActiveSize();
    }
  });

  chrome.runtime.onMessage.addListener((msg: any) => {
    if (msg.type === 'STATE_UPDATE') applyState(msg.state as SessionState);
  });
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    try {
      if (chrome.runtime.lastError) return;
      if (res) applyState(res as SessionState);
    } catch {}
  });

  // Tick the phase countdown under the score (I … / W …).
  phaseTimer = setInterval(updatePhaseReadout, 250);

  (window as any).__ffSpriteCleanup = () => {
    stopped = true;
    stopBeep();
    if (audioCtx)       { audioCtx.close().catch(() => {}); audioCtx = null; }
    if (cryTimer)       { clearInterval(cryTimer);       cryTimer = null; }
    if (warningTimer)   { clearTimeout(warningTimer);    warningTimer = null; }
    if (stepTimer)      { clearTimeout(stepTimer);        stepTimer = null; }
    if (scaleAnimTimer) { clearInterval(scaleAnimTimer);  scaleAnimTimer = null; }
    if (changeTimer)    { clearTimeout(changeTimer);      changeTimer = null; }
    if (phaseTimer)     { clearInterval(phaseTimer);      phaseTimer = null; }
    document.getElementById('focus-flow-root')?.remove();
    document.getElementById('ff-styles')?.remove();
    (window as any).__ffSpriteCleanup = undefined;
  };

  console.log('Focus: sprite injected');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
