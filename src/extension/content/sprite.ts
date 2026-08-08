// Vanilla TypeScript. Two imports, both of which inline away at build time (see
// vite.config.ts) so the compiled content-script bundle stays self-contained:
//   ../timings   — pure numeric constants, shared with background.ts so the idle
//                  timeline cannot drift.
//   ../ui/companion — the companion panel, shared with the floating window so the
//                  two are the same thing rather than two things that look alike.
import {
  IDLE_WARNING_MS, STEP_DELAY_MS, INTERACTION_STEP_MS, GROW_DURATION_MS, ICON_POP_MS,
  WORKING_FRESH_MS,
} from '../timings';
import {
  CHARS, CRYING, TREMBLE_STEP_MS, createCompanionCanvas, createWhitelistBars, trembleAmplitude,
  type CompanionCanvas, type WhitelistBars,
} from '../ui/companion';

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
  osHeld: boolean;
}

const SIZE = 60;
const FIREWORK_COLORS = ['#fde047', '#f97316', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#a855f7'];

// Active sizing: the sprite starts at START_SCALE right after a change and
// shrinks toward MIN_SCALE as active heartbeats accumulate, reaching the
// minimum exactly when the heartbeat count hits the configured threshold.
const START_SCALE = 2;
const MIN_SCALE = 0.5;

// The circle and its position are two elements, and that split is what lets the
// bounce and the tremble exist at all. `transform` can hold only one value: the slow
// `transform 0.9s linear` easing that makes the shrink pleasant would also smear a
// 300 ms hop and a per-frame shiver into nothing. So the WRAPPER owns where the
// sprite is (left/top, plus a per-frame translate with no transition) and the CIRCLE
// owns how big it is — neither has to know about the other's timing.
const SPRITE_TRANSITION = 'background-color 0.35s ease, transform 0.9s linear';
const WRAP_TRANSITION = 'left 0.09s ease, top 0.09s ease';

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
// Which of the three shapes the sprite is wearing. Mirrors Settings; see SPRITE_MODES.
let spriteMode: 'roam' | 'fixed' | 'panel' = 'roam';
// Mirrors Settings.idleGrow. Trembling has no equivalent — it is always on.
let idleGrow = true;
// Mirrors Settings.spriteEnabled. When off nothing is drawn into the page at all —
// for people who work with the companion window instead. Everything else carries on:
// heartbeats, scoring and the whitelist are the background's, not this file's, so the
// only thing that stops is the drawing. Defaults to true so a page never flashes an
// empty frame before settings load.
let spriteEnabled = true;
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
  // Sprite only moves when active — and only in `roam` mode, which is the whole
  // difference between it and `fixed`: same circle, same one-per-heartbeat rhythm,
  // but the beat is spent bouncing in place instead of covering ground.
  if (stopped || spriteMode !== 'roam' || pendingSteps <= 0 || isDragging || !(appState?.isHeartbeatActive)) {
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
  wrapEl.style.left = px + 'px';
  wrapEl.style.top  = py + 'px';
  pendingSteps--;
  if (pendingSteps > 0) stepTimer = setTimeout(doStep, STEP_DELAY_MS);
}

function queueSteps(n: number) {
  if (spriteMode !== 'roam') return;
  pendingSteps += n;
  if (!stepTimer && pendingSteps > 0) doStep();
}

// Queue a step in response to real page interaction, throttled so a burst of
// mousemove/scroll events becomes a steady walk rather than a spam of steps.
// Only walks while active and not being dragged.
let lastInteractionStep = 0;
function interactionStep() {
  if (stopped || spriteMode !== 'roam' || isDragging || !appState?.isHeartbeatActive) return;
  const now = Date.now();
  if (now - lastInteractionStep < INTERACTION_STEP_MS) return;
  lastInteractionStep = now;
  queueSteps(1);
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
let wrapEl: HTMLDivElement;     // where the sprite IS (position + per-frame motion)
let spriteEl: HTMLDivElement;   // the circle itself (colour + scale)
let iconEl: HTMLSpanElement;
let scoreEl: HTMLSpanElement;
let focusEl: HTMLSpanElement;
let distractedEl: HTMLSpanElement;

// ── Bounce and tremble ────────────────────────────────────────────────────────
// Two per-frame offsets applied to the WRAPPER, both zero most of the time:
//
//   bounceY  — the `fixed` mode's heartbeat. A parked sprite still has to show that
//              a beat landed, and a hop is the same rhythm the walk had.
//   tremble  — the idle escalation, always on and with no setting. Ramped by
//              trembleAmplitude() from the companion panel, so the circle and the
//              panel shake on one curve rather than two that were meant to match.
//
// The loop only runs while there is something to draw, and stops itself the moment
// both settle to zero — a content script on every page in every tab does not get to
// hold a permanent rAF.
let bounceY = 0;
let motionRaf = 0;
let motionLastAt = 0;
let shakeAt = 0, shakeX = 0, shakeY = 0;

/** How far the sprite should be jumping right now, in CSS pixels, or 0. */
function currentTremble(): number {
  if (spriteMode === 'panel') return 0;   // the panel's own canvas shakes itself
  if (!warningStartAt || appState?.isHeartbeatActive) return 0;
  // Anchored on the START of the warning, not on the escalation that follows it, so
  // the shake is already visible while there is still time to come back.
  return trembleAmplitude(Date.now() - warningStartAt);
}

function motionTick() {
  motionRaf = 0;
  if (stopped || !wrapEl) return;
  const now = Date.now();
  const dt = Math.min(0.1, (now - motionLastAt) / 1000);
  motionLastAt = now;

  bounceY *= Math.pow(0.86, dt * 60);
  if (Math.abs(bounceY) < 0.3) bounceY = 0;

  // A new direction on a FIXED clock, held until the next one. What the lapse buys is
  // DISTANCE, never rate: a rising rate blurs into a buzz, while a rising distance
  // stays a series of steps you can count — which is what makes it catch your eye
  // rather than merely be noisy.
  const amp = currentTremble();
  if (!amp) shakeAt = 0;
  else if (now - shakeAt >= TREMBLE_STEP_MS) {
    shakeAt = now;
    // Random direction, full step: a shake is a jump to somewhere else, not a drift,
    // so the magnitude is not randomised on top of the direction.
    const a = Math.random() * Math.PI * 2;
    shakeX = Math.cos(a); shakeY = Math.sin(a);
  }
  // Clamped to the room the viewport actually has on each side. At full amplitude the
  // jump is wider than the margin a sprite dragged into a corner has left, and a
  // companion that shakes ITSELF off the edge of the screen is one you stop seeing at
  // exactly the moment it is trying hardest to be seen.
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  const jx = clamp(shakeX * amp, -px, Math.max(0, window.innerWidth - SIZE - px));
  const jy = clamp(shakeY * amp, -py, Math.max(0, window.innerHeight - SIZE - py));

  if (!bounceY && !amp) {
    wrapEl.style.transform = '';
    return;                       // nothing left to animate — let the loop die
  }
  wrapEl.style.transform = `translate(${jx.toFixed(2)}px, ${(bounceY + jy).toFixed(2)}px)`;
  motionRaf = requestAnimationFrame(motionTick);
}

function startMotion() {
  if (motionRaf || stopped) return;
  motionLastAt = Date.now();
  motionRaf = requestAnimationFrame(motionTick);
}

/** One heartbeat, spent in place. The `fixed` mode's answer to a step. */
function bounce() {
  if (spriteMode !== 'fixed' || isDragging) return;
  bounceY = -14;
  startMotion();
}

// ── Phase countdown (debug readout under the score) ────────────────────────────
// A small "I 12s" / "W 4s" line below the points that ticks down the current
// phase's remaining time, so the idle timeline can be watched live:
//   • I — time until the session is treated as idle (≈ the idleTime setting).
//   • W — the face-only warning window before the beep/grow (IDLE_WARNING_MS).
//
// "I" counts down from state.lastHeartbeat — the SAME clock background.ts uses to
// decide when to flip to Idle — NOT from page-local input. That's deliberate: a
// heartbeat comes from either page activity here OR the chrome.idle poll (any
// window, PDF viewers, other apps), so working in another window keeps the
// countdown topped up exactly as it keeps the session active. Deriving it from
// page-local input instead made the readout lie in both directions — it ran down
// to "I 0s" with nothing happening while the user was busy elsewhere, and it
// disagreed with the helper window's copy of the same number.
let phaseEl: HTMLSpanElement;
let phaseTimer: ReturnType<typeof setInterval> | null = null;
let warningStartAt = 0;            // when the current idle warning began
let idleTimeS = 20;                // mirror of the idleTime setting (seconds)

// NOTE: the floating companion is NOT hosted here. A content script can only draw
// inside its page, so it vanishes the moment another app covers Chrome — the whole
// point of the companion. It lives in a separate extension window instead
// (src/extension/pip/pip.ts), opened by the popup's Working button. This file only
// keeps the in-page sprite.

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
// Shared by the in-page readout and the companion window's canvas, which computes
// it identically from the same broadcast field so the two can never disagree.
function currentPhase(): { text: string; color: string } | null {
  const st = appState;
  if (!st || st.enabled === false || forcedNotWorking) return null;
  const now = Date.now();
  if (st.isHeartbeatActive) {
    // One countdown and one escalation, whatever the activity source: stopping work
    // in another app must go idle exactly like stopping on the page does. Only the
    // COLOUR distinguishes them — violet while another app is keeping the session
    // alive, blue while this page is.
    const remain = Math.max(0, idleTimeS - (now - st.lastHeartbeat) / 1000);
    return { text: `I ${Math.ceil(remain)}s`, color: st.osHeld ? '#c4b5fd' : '#93c5fd' };
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

/** The escalation, once the warning window has run out: swell to fill the page. The
 *  shake is not part of this and does not wait for it — it began back at the start of
 *  the warning and has been ramping ever since. In `panel` mode the canvas does both
 *  itself, so there is nothing here to do. */
function startGrowAnimation() {
  if (spriteMode === 'panel') return;
  startMotion();                  // the shake never stops while the lapse runs
  if (!idleGrow) return;          // …and growing is the half that can be refused

  stopScaleAnimation();
  spriteEl.style.transition = 'background-color 0.35s ease';
  wrapEl.style.transition = 'left 1.5s ease, top 1.5s ease';
  const centerX = window.innerWidth  / 2 - SIZE / 2;
  const centerY = window.innerHeight / 2 - SIZE / 2;
  wrapEl.style.left = centerX + 'px';
  wrapEl.style.top  = centerY + 'px';
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
  spriteEl.style.transition = SPRITE_TRANSITION;
  wrapEl.style.transition = WRAP_TRANSITION;
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
  // Panel mode draws its own −10 on the canvas; a second one filling the page on
  // top of it would be the same event announced twice.
  if (spriteMode === 'panel') return;
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
  if (spriteMode === 'panel') return;   // the canvas fires its own burst and "+N"
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
  warningStartAt = Date.now(); // anchor the "W" countdown AND the tremble ramp
  setIconText(CRYING[0]);
  // The shake starts here, not at the escalation, so it is already visible while
  // there is still time to come back — which is the entire point of a warning.
  startMotion();
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
  // Arriving here with no anchor means the page loaded into a lapse already in
  // progress and there was no warning window to date it. Any anchor is a guess
  // then; "now" at least ramps from nothing rather than jumping to full shake.
  if (!warningStartAt) warningStartAt = Date.now();
  startMotion();
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

  // In panel mode the canvas draws its own everything — character, score, countdown,
  // fireworks, the fly-ups and the shiver — off exactly this state.
  panelCanvas?.setState(s);
  panelBars?.noteState(s);   // a working↔idle switch must not wait for the poll

  const char = CHARS[s.currentIconId % CHARS.length] ?? CHARS[0];

  setScore(s.focusScore ?? 0, s.distractedScore ?? 0);

  const transitioned = wasHeartbeatActive !== s.isHeartbeatActive;
  wasHeartbeatActive = s.isHeartbeatActive;

  // One beat per heartbeat, from any source. The background counts one heartbeat
  // per active second (page activity or the chrome.idle poll) and broadcasts the
  // new count, so a change here means a heartbeat just happened — spend it as a
  // step (roaming) or a hop in place (fixed). Both no-op in panel mode; its canvas
  // has already taken the same beat as its own bob.
  if (s.heartbeatCount !== lastHeartbeatCount) {
    const hadCount = lastHeartbeatCount >= 0;
    lastHeartbeatCount = s.heartbeatCount;
    if (hadCount && s.isHeartbeatActive) { queueSteps(1); bounce(); }
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
  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    position: 'absolute',
    width: SIZE + 'px', height: SIZE + 'px',
    left: px + 'px', top: py + 'px',
    transition: WRAP_TRANSITION,
    zIndex: '2147483647',
    // The circle scales far past this box; nothing may be clipped to it.
    overflow: 'visible',
  });
  wrapEl = wrap;

  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'absolute', inset: '0',
    borderRadius: '50%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#94a3b8',
    cursor: 'grab',
    pointerEvents: 'auto',
    boxShadow: '0 8px 20px rgba(0,0,0,0.28)',
    border: '4px solid white',
    userSelect: 'none',
    transition: SPRITE_TRANSITION,
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
    // The wrapper's box, not the circle's: the circle is scaled (up to 2× while
    // active, and far more while growing), so its rect is not where the sprite
    // "is" and the grab would jump by the difference.
    const rect = wrapEl.getBoundingClientRect();
    dragOX = e.clientX - rect.left;
    dragOY = e.clientY - rect.top;
    el.setPointerCapture(e.pointerId);
    el.addEventListener('pointermove', onSpriteMove as EventListener);
    el.addEventListener('pointerup', onSpriteUp as EventListener, { once: true });
  });

  wrap.appendChild(el);
  return wrap;
}

function onSpriteMove(e: PointerEvent) {
  isDragging = true;
  px = Math.max(0, Math.min(e.clientX - dragOX, window.innerWidth  - SIZE));
  py = Math.max(0, Math.min(e.clientY - dragOY, window.innerHeight - SIZE));
  // No easing while a finger is on it — the 0.09 s walk transition would make the
  // sprite trail the pointer.
  wrapEl.style.transition = 'none';
  wrapEl.style.left = px + 'px';
  wrapEl.style.top  = py + 'px';
}

function onSpriteUp(_e: PointerEvent) {
  spriteEl.removeEventListener('pointermove', onSpriteMove as EventListener);
  spriteEl.style.cursor = 'grab';
  wrapEl.style.transition = WRAP_TRANSITION;
  // Where you park it is only meaningful in `fixed` mode — a roaming sprite walks
  // off within a second, so remembering the drop point would be noise.
  if (isDragging && spriteMode === 'fixed') savePosition('fixed', px, py);
  setTimeout(() => { isDragging = false; }, 30);
}

// ── Remembered position ───────────────────────────────────────────────────────
// Stored as a FRACTION of the viewport rather than pixels, so the same page opened
// on a laptop and on an external monitor puts the companion in the same visual
// place instead of off the edge of the smaller one. Kept in its own storage key,
// not in Settings: a drag is not a preference, and routing one through the settings
// object would fire the whole settings-changed cascade on every drop.
const POS_KEY = 'focusSpritePos';
let savedPos: { fixed?: { x: number; y: number }; panel?: { x: number; y: number } } = {};

function savePosition(mode: 'fixed' | 'panel', x: number, y: number) {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  savedPos = { ...savedPos, [mode]: { x: x / w, y: y / h } };
  try { chrome.storage.local.set({ [POS_KEY]: savedPos }); } catch { /* ignore */ }
}

/** The remembered spot in this viewport's pixels, clamped inside it, or null. */
function loadPosition(mode: 'fixed' | 'panel', w: number, h: number): { x: number; y: number } | null {
  const p = savedPos[mode];
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return {
    x: Math.max(0, Math.min(p.x * window.innerWidth, window.innerWidth - w)),
    y: Math.max(0, Math.min(p.y * window.innerHeight, window.innerHeight - h)),
  };
}

// ── Panel mode ────────────────────────────────────────────────────────────────
// The floating companion window, drawn inside the page instead. Same canvas, same
// two whitelist bars, same everything — literally the same module (../ui/companion),
// so this is not a lookalike that will drift, it is the companion with a different
// container. It exists because the window it copies has one hard requirement the
// page does not: something outside the browser has to keep it on top, and on macOS
// and most Wayland desktops nothing will. Inside the page, the browser is the
// compositor and the problem disappears — at the cost of only being visible while
// you are looking at the browser, which is exactly the trade the user is choosing.
const PANEL_W = 300;

let panelEl: HTMLDivElement | null = null;
let panelCanvas: CompanionCanvas | null = null;
let panelBars: WhitelistBars | null = null;
let panelX = 0, panelY = 0;

function buildPanel() {
  if (panelEl) return;
  const rootEl = document.getElementById('focus-flow-root');
  if (!rootEl) return;

  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'absolute', width: PANEL_W + 'px',
    display: 'flex', flexDirection: 'column',
    // The same surface as pip.html's <body>, so switching between the two modes
    // does not look like switching between two products.
    background: 'radial-gradient(circle at 30% 30%, #1e293b, #0f172a)',
    color: '#e2e8f0', borderRadius: '14px', overflow: 'hidden',
    border: '1px solid rgba(148,163,184,0.22)',
    boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
    fontFamily: 'system-ui, sans-serif',
    pointerEvents: 'auto', cursor: 'grab', userSelect: 'none',
    zIndex: '2147483647',
  });

  const stage = document.createElement('div');
  Object.assign(stage.style, {
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px',
  });
  panelCanvas = createCompanionCanvas({ idleWarningMs: IDLE_WARNING_MS, growDurationMs: GROW_DURATION_MS });
  // A fixed height here rather than `flex:1`: this box is sized by its contents,
  // so the canvas has to declare how tall it wants to be. 2:1, like the drawing.
  Object.assign(panelCanvas.canvas.style, { width: '100%', height: ((PANEL_W - 12) / 2) + 'px' });
  stage.appendChild(panelCanvas.canvas);

  panelBars = createWhitelistBars({ workingFreshMs: WORKING_FRESH_MS });
  box.append(stage, ...panelBars.rows);

  const pos = loadPosition('panel', PANEL_W, (PANEL_W - 12) / 2 + 60);
  panelX = pos ? pos.x : Math.max(0, window.innerWidth - PANEL_W - 24);
  panelY = pos ? pos.y : Math.max(0, window.innerHeight - 220);
  box.style.left = panelX + 'px';
  box.style.top = panelY + 'px';

  // Dragged by anywhere that is not a control. A title bar would cost a row of a
  // 300px box, and every pixel of this thing is already earning its place.
  box.addEventListener('pointerdown', (e: PointerEvent) => {
    if ((e.target as HTMLElement)?.closest('button')) return;
    e.stopPropagation();
    const rect = box.getBoundingClientRect();
    const ox = e.clientX - rect.left, oy = e.clientY - rect.top;
    box.style.cursor = 'grabbing';
    const move = (ev: PointerEvent) => {
      panelX = Math.max(0, Math.min(ev.clientX - ox, window.innerWidth - rect.width));
      panelY = Math.max(0, Math.min(ev.clientY - oy, window.innerHeight - rect.height));
      box.style.left = panelX + 'px';
      box.style.top = panelY + 'px';
    };
    const up = () => {
      box.removeEventListener('pointermove', move as EventListener);
      box.style.cursor = 'grab';
      savePosition('panel', panelX, panelY);
    };
    box.setPointerCapture(e.pointerId);
    box.addEventListener('pointermove', move as EventListener);
    box.addEventListener('pointerup', up as EventListener, { once: true });
  });

  rootEl.appendChild(box);
  panelEl = box;

  // Hand it whatever we already know, so it is not blank until the next broadcast.
  panelCanvas.setSettings({ forceActive: forcedNotWorking, idleTimeS, idleGrow });
  if (appState) panelCanvas.setState(appState);
}

function destroyPanel() {
  panelCanvas?.stop();
  panelBars?.stop();
  panelEl?.remove();
  panelCanvas = null;
  panelBars = null;
  panelEl = null;
}

/** Show whichever of the two shapes the current mode calls for. Cheap enough to call
 *  on every settings change — the panel is only built when it is actually wanted. */
function applyMode() {
  if (!wrapEl) return;
  // Switched off entirely: put away both shapes and stop everything they were
  // running. Note the beep is deliberately NOT part of this — it belongs to the idle
  // escalation, not to the drawing, and someone who turned the sprite off to stop it
  // walking over their page has not asked to stop being told they went idle.
  if (!spriteEnabled) {
    destroyPanel();
    wrapEl.style.display = 'none';
    return;
  }
  if (spriteMode === 'panel') {
    wrapEl.style.display = 'none';
    buildPanel();
    // Already built — re-place it. Called on resize and on another tab's drag, both
    // of which can leave a box anchored in pixels hanging off the edge.
    if (panelEl) {
      const pos = loadPosition('panel', panelEl.offsetWidth || PANEL_W, panelEl.offsetHeight || 200);
      if (pos) {
        panelX = pos.x; panelY = pos.y;
        panelEl.style.left = panelX + 'px';
        panelEl.style.top = panelY + 'px';
      }
    }
    return;
  }
  destroyPanel();
  wrapEl.style.display = 'block';
  // Leaving `panel` for `fixed` has to put the circle somewhere deliberate; leaving
  // it for `roam` does not, since it walks off wherever it starts.
  if (spriteMode === 'fixed') {
    const pos = loadPosition('fixed', SIZE, SIZE);
    if (pos) { px = pos.x; py = pos.y; }
    wrapEl.style.left = px + 'px';
    wrapEl.style.top = py + 'px';
  }
  if (appState?.isHeartbeatActive && !changeTimer) applyActiveSize();
}

// ── Settings sync ──────────────────────────────────────────────────────────────
function readSettings(raw: unknown) {
  const s = raw as { iconChangeHeartbeats?: number; cryBeepVolume?: number; cryBeepDuration?: number; cryBeepStyle?: string; soundEnabled?: boolean; allowedDomains?: unknown; forceActive?: boolean; idleTime?: number; spriteEnabled?: boolean; spriteMode?: string; idleGrow?: boolean } | undefined;
  spriteEnabled = s?.spriteEnabled !== false;
  spriteMode = s?.spriteMode === 'fixed' || s?.spriteMode === 'panel' ? s.spriteMode : 'roam';
  idleGrow = s?.idleGrow !== false;
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
  panelCanvas?.setSettings({ forceActive: forcedNotWorking, idleTimeS, idleGrow });
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

  // Clamp the random starting position into the viewport before the sprite is
  // built. px/py are seeded up to (400, 300), which is off-screen in any viewport
  // smaller than that — a narrow or half-height browser window — and nothing would
  // correct it until the first heartbeat moved the sprite. On a page that never
  // goes active, that is a sprite you never see.
  px = Math.min(px, Math.max(0, window.innerWidth - SIZE));
  py = Math.min(py, Math.max(0, window.innerHeight - SIZE));

  rootEl.appendChild(buildSprite());   // returns the wrapper; the circle is inside

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

  // Both keys in one read: the mode decides WHICH shape to build, the remembered
  // position decides where to put it, and building before the position arrives would
  // put a fixed sprite in the wrong place and then jump it.
  chrome.storage.local.get(['focusFlowSettings', POS_KEY], (r) => {
    const p = r[POS_KEY];
    if (p && typeof p === 'object') savedPos = p as typeof savedPos;
    readSettings(r.focusFlowSettings);
    applyMode();
    renderActiveFace(); // the whitelist just resolved — the face may need to change
    renderWorkingFilter();
    if (appState?.isHeartbeatActive && !changeTimer) applyActiveSize();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // Another tab moved the sprite. Adopt the new spot so every tab agrees where
    // "the companion" is, rather than each keeping the position it was opened with.
    if (changes[POS_KEY]) {
      const p = changes[POS_KEY].newValue;
      if (p && typeof p === 'object') {
        savedPos = p as typeof savedPos;
        if (!isDragging) applyMode();
      }
    }
    if (changes.focusFlowSettings) {
      readSettings(changes.focusFlowSettings.newValue);
      applyMode();
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

  // Both fixed shapes are placed against the viewport, so a resized window has to
  // re-place them or they end up off the edge (or, on a maximise, huddled in a
  // corner). The roaming sprite corrects itself on the next step and needs nothing.
  window.addEventListener('resize', () => {
    if (spriteMode !== 'roam' && !isDragging) applyMode();
  }, { passive: true });

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
    if (motionRaf)      { cancelAnimationFrame(motionRaf); motionRaf = 0; }
    destroyPanel();     // its canvas holds a rAF and its bars a 2 s poll
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
