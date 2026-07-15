// Pure vanilla TypeScript — no runtime imports. Compiles to a self-contained bundle.

interface SessionState {
  isHeartbeatActive: boolean;
  lastHeartbeat: number;
  activeWindowId: number | null;
  enabled: boolean;
  currentIconId: number;
  heartbeatCount: number;
  iconChangeAt: number;
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
let scaleAnimTimer: ReturnType<typeof setInterval> | null = null;

// ── Step-based movement ───────────────────────────────────────────────────────
const STEP_PX = 18;
const STEP_DELAY_MS = 130;
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
const INTERACTION_STEP_MS = 200;
let lastInteractionStep = 0;
function interactionStep() {
  if (stopped || isDragging || !appState?.isHeartbeatActive) return;
  const now = Date.now();
  if (now - lastInteractionStep < INTERACTION_STEP_MS) return;
  lastInteractionStep = now;
  queueSteps(1);
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
let spriteEl: HTMLDivElement;
let iconEl: HTMLSpanElement;

function setIconText(text: string) {
  iconEl.textContent = text;
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

  const maxScale = Math.ceil(Math.max(window.innerWidth, window.innerHeight) / SIZE) + 2;
  const duration = 20_000;
  const startTime = Date.now();

  scaleAnimTimer = setInterval(() => {
    if (stopped) { stopScaleAnimation(); return; }
    const progress = Math.min((Date.now() - startTime) / duration, 1);
    const scale = 1 + (maxScale - 1) * (progress * progress); // easeIn
    spriteEl.style.transform = `scale(${scale})`;
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
  spriteEl.style.transform = `scale(${activeScale(appState.heartbeatCount)})`;
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
  }, 700);
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
    stopCrying();
    setIconText(char.icon);
    // Size follows the heartbeat count (shrinks as focus accumulates).
    if (!changeTimer) applyActiveSize();
  } else {
    startCrying();
    if (transitioned && !changeTimer) startGrowAnimation();
  }

  // Fire the celebration when the background reports a fresh icon change.
  if (s.iconChangeAt && s.iconChangeAt !== lastIconChangeAt) {
    const first = lastIconChangeAt === 0;
    lastIconChangeAt = s.iconChangeAt;
    if (!first) triggerIconChange();
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
  const s = raw as { iconChangeHeartbeats?: number; cryBeepVolume?: number; cryBeepDuration?: number; cryBeepStyle?: string; soundEnabled?: boolean } | undefined;
  const h = Number(s?.iconChangeHeartbeats);
  if (Number.isFinite(h)) iconChangeHeartbeats = Math.min(300, Math.max(5, Math.round(h)));
  const v = Number(s?.cryBeepVolume);
  if (Number.isFinite(v)) cryBeepVolume = Math.min(100, Math.max(0, Math.round(v)));
  const d = Number(s?.cryBeepDuration);
  if (Number.isFinite(d)) cryBeepDuration = Math.min(300, Math.max(10, Math.round(d)));
  cryBeepStyle = s?.cryBeepStyle === 'pulse' || s?.cryBeepStyle === 'siren' ? s.cryBeepStyle : 'ramp';
  if (typeof s?.soundEnabled === 'boolean') soundEnabled = s.soundEnabled;
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
  const unlockOpts = { capture: true, passive: true } as AddEventListenerOptions;
  window.addEventListener('pointerdown', unlockAudio, unlockOpts);
  window.addEventListener('keydown', unlockAudio, unlockOpts);
  window.addEventListener('touchstart', unlockAudio, unlockOpts);
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
    if (appState?.isHeartbeatActive && !changeTimer) applyActiveSize();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.focusFlowSettings) {
      readSettings(changes.focusFlowSettings.newValue);
      // Reconcile the beep with the new settings (volume/style/duration/sound):
      // restart it cleanly if still crying, otherwise it stays stopped.
      restartBeepIfCrying();
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

  (window as any).__ffSpriteCleanup = () => {
    stopped = true;
    stopBeep();
    if (audioCtx)       { audioCtx.close().catch(() => {}); audioCtx = null; }
    if (cryTimer)       { clearInterval(cryTimer);       cryTimer = null; }
    if (stepTimer)      { clearTimeout(stepTimer);        stepTimer = null; }
    if (scaleAnimTimer) { clearInterval(scaleAnimTimer);  scaleAnimTimer = null; }
    if (changeTimer)    { clearTimeout(changeTimer);      changeTimer = null; }
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
