// ─────────────────────────────────────────────────────────────────────────────
//  THE COMPANION PANEL — one implementation, two homes
// ─────────────────────────────────────────────────────────────────────────────
//  The character, the score, the phase countdown and the two whitelist bars are
//  drawn in two completely different places: the floating companion WINDOW
//  (src/extension/pip/pip.ts, a chrome-extension:// document) and the in-page
//  PANEL the sprite can be switched to (src/extension/content/sprite.ts, injected
//  into somebody else's page). They are the same thing to look at and must behave
//  identically, so they are the same code — this file — with each host supplying
//  only its own container and lifecycle.
//
//  ── WHY THIS MODULE IMPORTS NOTHING AT RUNTIME ─────────────────────────────
//  sprite.ts is a CONTENT SCRIPT, injected as a classic script, so it cannot carry
//  `import` statements — vite.config.ts inlines its dependencies back into the
//  bundle at build time. That inliner refuses a dependency which itself has
//  imports, because inlining a chain safely is a different (and much easier to get
//  wrong) problem. So everything this module would otherwise import is passed in
//  instead: `idleWarningMs` is IDLE_WARNING_MS from ../timings, handed over by both
//  callers, and every other import here is a `type` and erased at compile time.
//  Adding a real import to this file breaks the extension build loudly, not
//  silently — but it does break it.
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentStatus, PageStatus } from '../../types';

/** The 15-character roster. The single copy — sprite.ts's in-page circle reads it
 *  from here too, so a character added in one place cannot go missing in another. */
export const CHARS = [
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

export const CRYING = ['😭', '😢', '💧'];

const FIREWORK_COLORS = ['#fde047', '#f97316', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#a855f7'];

/** The drawing is a fixed 480×240 picture that SCALES to whatever size its host
 *  gives it, so every element keeps its proportions instead of the layout
 *  rearranging itself as the window is dragged smaller. */
export const CANVAS_W = 480;
export const CANVAS_H = 240;

const DISC_X = 132, DISC_Y = 120, DISC_R = 78;

// ── The idle escalation ──────────────────────────────────────────────────────
// Two behaviours, one of them optional. The panel used to be exempt from growing on
// the grounds that a fixed-size box cannot grow — but the box does not have to. The
// DRAWING inside it can, and does.
//
// TREMBLING is always on. It starts at nothing the instant the session goes idle and
// grows continuously through the warning window and on into the crying — one ramp
// across both phases rather than a step at the boundary, because the point is to be
// noticed *before* the beep, by something that was not there a moment ago. It never
// resets while you stay away, so the longer the lapse the further it moves.
//
// **The escalation is in the DISTANCE, never in the rate.** A new offset is picked on
// a fixed clock (TREMBLE_STEP_MS) and held until the next one, so what changes as the
// lapse runs is how far the character jumps each time, not how fast it rattles. Those
// look completely different: a rising rate reads as a buzz and blurs into a smear,
// while a rising distance stays a series of visible steps you can count — which is
// what makes it legible out of the corner of your eye rather than just noisy.

/** Displacement the moment the warning starts. NOT zero: a ramp that begins at
 *  nothing is invisible for its first several seconds, which are precisely the
 *  seconds the warning exists for. This is the smallest jump that reads as deliberate
 *  rather than as a rendering glitch. */
export const TREMBLE_MIN_PX = 10;

/** Peak displacement, in CSS pixels — roughly two and a half centimetres on a 96-DPI
 *  screen. Large on purpose: the character is competing with whatever you wandered off
 *  to, and a polite shiver loses. */
export const TREMBLE_MAX_PX = 96;

/** How often a new offset is chosen. CONSTANT, deliberately: see above. ~18 Hz is
 *  fast enough to read as a shake and slow enough that each step is a step. */
export const TREMBLE_STEP_MS = 55;

/** How long from going idle to the full displacement. */
const TREMBLE_RAMP_MS = 25_000;

// The canvas cannot shake as far as a page can, and no constant will change that: the
// drawing is 480×240 with the disc centred at (132,120) and 78 across, so there are
// exactly 54 units of room to its left and 42 above before it starts being clipped by
// the frame. These are those two numbers. Clipping a character against a hard
// rectangular edge does not read as a violent shake, it reads as a bug.
const CANVAS_SHAKE_X = DISC_X - DISC_R;
const CANVAS_SHAKE_Y = DISC_Y - DISC_R;

// GROWING, by contrast, begins only when the warning is over — the same moment
// sprite.ts starts its own — and swells on the same easeIn curve until the character
// covers the frame. "Covers" is measured to the farthest corner from the disc's
// centre, so the number below is derived rather than guessed at.
const MAX_DISC_SCALE = Math.hypot(
  Math.max(DISC_X, CANVAS_W - DISC_X),
  Math.max(DISC_Y, CANVAS_H - DISC_Y),
) / DISC_R;

/** Shake displacement in CSS pixels for a lapse that has run `idleForMs`. Exported
 *  because the in-page sprite shakes on the same escalation, just on a different
 *  object, and two ramps that were meant to match but were written twice would not. */
export function trembleAmplitude(idleForMs: number): number {
  if (idleForMs <= 0) return 0;
  const p = Math.min(1, idleForMs / TREMBLE_RAMP_MS);
  return TREMBLE_MIN_PX + (TREMBLE_MAX_PX - TREMBLE_MIN_PX) * p;
}

/** The slice of SessionState this panel draws. Structurally a subset, declared
 *  separately so neither host has to import the full type. */
export interface CompanionState {
  isHeartbeatActive: boolean;
  currentIconId: number;
  heartbeatCount: number;
  focusScore: number;
  distractedScore: number;
  lastHeartbeat: number;
  enabled: boolean;
  osHeld: boolean;
  iconChangeAt: number;
  penaltyAt: number;
}

interface Particle { x: number; y: number; vx: number; vy: number; color: string; size: number; born: number; life: number }
interface FlyUp { text: string; color: string; born: number; life: number; size: number }

export interface CompanionCanvas {
  /** The <canvas> to place. Sized in CSS by the host; the drawing scales into it. */
  canvas: HTMLCanvasElement;
  /** Feed every STATE_UPDATE through here. */
  setState(s: CompanionState): void;
  /** Feed the settings the drawing depends on. */
  setSettings(o: { forceActive: boolean; idleTimeS: number; idleGrow: boolean }): void;
  /** Stop the animation loop and release the frame callback. */
  stop(): void;
}

/**
 * Build the animated character canvas.
 *
 * Everything it animates is driven by the two timestamp NONCES the background
 * broadcasts (`iconChangeAt`, `penaltyAt`) rather than by the scores changing,
 * for the same reason sprite.ts does it that way: the server reconciles the
 * displayed score after every post, so a score that changed is not evidence that
 * anything happened *here*, while a bumped nonce is.
 */
export function createCompanionCanvas(opts: { idleWarningMs: number; growDurationMs: number }): CompanionCanvas {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  Object.assign(canvas.style, {
    width: '100%', height: '100%', objectFit: 'contain', borderRadius: '12px',
    display: 'block',
  });
  const ctx = canvas.getContext('2d');

  let state: CompanionState | null = null;
  let forceActive = false;
  let idleTimeS = 20;
  let idleGrow = true;

  let idleSince = 0;        // when this panel last saw the session go idle
  let wasActive = true;     // tracks the active→idle edge
  let bob = 0;              // vertical hop, decays to 0
  let lastHb = -1;
  let lastIconChangeAt = 0;
  let lastPenaltyAt = 0;
  let lastFocus = 0;
  // The first state carries the PERSISTED nonces, so syncing to them silently is
  // what stops a freshly opened window replaying the last character change and the
  // last penalty as if they had just happened.
  let noncesInited = false;

  const parts: Particle[] = [];
  const flyUps: FlyUp[] = [];
  let raf = 0;
  let stopped = false;

  function fireworks() {
    const now = Date.now();
    for (let i = 0; i < 18; i++) {
      const angle = (Math.PI * 2 * i) / 18 + Math.random() * 0.35;
      const speed = 60 + Math.random() * 90;   // canvas px per second
      parts.push({
        x: DISC_X, y: DISC_Y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        color: FIREWORK_COLORS[i % FIREWORK_COLORS.length],
        size: 4 + Math.random() * 4,
        born: now, life: 700 + Math.random() * 300,
      });
    }
  }

  function flyUp(text: string, color: string, size: number, life: number) {
    flyUps.push({ text, color, born: Date.now(), life, size });
  }

  function setState(s: CompanionState) {
    if (!s) return;
    // wasActive starts true, so an already-idle first state still anchors the ramp.
    if (wasActive && !s.isHeartbeatActive) idleSince = Date.now();
    if (s.isHeartbeatActive) idleSince = 0;
    wasActive = s.isHeartbeatActive;

    if (s.heartbeatCount !== lastHb) {
      const had = lastHb >= 0;
      lastHb = s.heartbeatCount;
      if (had && s.isHeartbeatActive) bob = -16;
    }

    if (!noncesInited) {
      noncesInited = true;
      lastIconChangeAt = s.iconChangeAt ?? 0;
      lastPenaltyAt = s.penaltyAt ?? 0;
    } else {
      if (s.iconChangeAt && s.iconChangeAt !== lastIconChangeAt) {
        lastIconChangeAt = s.iconChangeAt;
        fireworks();
        // What the character was actually worth. Read from the score rather than
        // recomputed from the settings, because "Not working" awards nothing and a
        // "+1" over a grey panel that earned zero would be a lie. Rounded to two
        // decimals and stripped of trailing zeros: a 60-heartbeat interval pays 0.5.
        const gain = Math.round(((s.focusScore ?? 0) - lastFocus) * 100) / 100;
        if (gain > 0) flyUp(`+${gain}`, '#4ade80', 56, 1600);
      }
      if (s.penaltyAt && s.penaltyAt !== lastPenaltyAt) {
        lastPenaltyAt = s.penaltyAt;
        flyUp('−10', '#ef4444', 88, 2600);
      }
    }
    lastFocus = s.focusScore ?? 0;
    state = s;
  }

  function setSettings(o: { forceActive: boolean; idleTimeS: number; idleGrow: boolean }) {
    forceActive = o.forceActive;
    idleTimeS = o.idleTimeS;
    idleGrow = o.idleGrow;
  }

  /** How far the character has swelled, 1 while there is nothing to escalate. Starts
   *  at the END of the warning window, on the same easeIn curve sprite.ts uses, so
   *  the circle in the page and the drawing here move together. */
  function growScale(idleForMs: number): number {
    if (!idleGrow) return 1;
    const t = idleForMs - opts.idleWarningMs;
    if (t <= 0) return 1;
    const p = Math.min(1, t / opts.growDurationMs);
    return 1 + (MAX_DISC_SCALE - 1) * p * p;
  }

  // The shake, held between steps so the rate stays fixed while the distance grows.
  let shakeAt = 0, shakeX = 0, shakeY = 0;

  /** trembleAmplitude() is in CSS pixels, but this canvas is a 480-unit drawing
   *  scaled into whatever box its host gave it. Converting through the RENDERED size
   *  is what makes the shake the same physical distance on screen whether the window
   *  is a corner thumbnail or dragged out large — which is the whole point of
   *  specifying it in centimetres rather than in units of a drawing nobody sees at
   *  1:1. `object-fit: contain` letterboxes, so the rendered width is whichever of
   *  the two axes runs out first. */
  function unitsPerCssPx(): number {
    const w = canvas.clientWidth || CANVAS_W;
    const h = canvas.clientHeight || CANVAS_H;
    const rendered = Math.min(w, h * (CANVAS_W / CANVAS_H));
    return CANVAS_W / Math.max(1, rendered);
  }

  // The countdown under the score. Deliberately the same formula sprite.ts uses over
  // the same broadcast field (state.lastHeartbeat = the background's best estimate of
  // the last input) — the only way the readouts can agree, since this panel cannot
  // see page input directly and anything computed locally would drift.
  function currentPhase(): { text: string; color: string } | null {
    const s = state;
    if (!s || s.enabled === false || forceActive) return null;
    const now = Date.now();
    if (s.isHeartbeatActive) {
      // Violet = another app is keeping it alive, blue = this page is. Same countdown.
      const remain = Math.max(0, idleTimeS - (now - s.lastHeartbeat) / 1000);
      return { text: `I ${Math.ceil(remain)}s`, color: s.osHeld ? '#c4b5fd' : '#93c5fd' };
    }
    if (idleSince && now - idleSince < opts.idleWarningMs) {
      const remain = Math.max(0, (idleSince + opts.idleWarningMs - now) / 1000);
      return { text: `W ${Math.ceil(remain)}s`, color: '#fbbf24' };
    }
    return null;
  }

  let lastFrameAt = Date.now();

  function draw() {
    if (!ctx) return;
    const now = Date.now();
    const dt = Math.min(0.1, (now - lastFrameAt) / 1000);   // clamp: a hidden tab
    lastFrameAt = now;                                       // returns with a huge gap
    const s = state;
    const idle = !s?.isHeartbeatActive;
    const char = CHARS[(s?.currentIconId ?? 0) % CHARS.length] ?? CHARS[0];

    const idleFor = idle ? now - (idleSince || now) : 0;

    // The shake. Always on while idle; what the lapse buys is DISTANCE, on a clock
    // that never speeds up — a new offset every TREMBLE_STEP_MS, held until the next.
    // Clamped per axis to the room the frame actually has (see CANVAS_SHAKE_*), which
    // is why this one tops out well short of what the in-page sprite can do: a page is
    // as big as the screen, this picture is 480×240 and the character is a third of it.
    let tx = 0, ty = 0;
    if (idle) {
      const amp = trembleAmplitude(idleFor) * unitsPerCssPx();
      if (now - shakeAt >= TREMBLE_STEP_MS) {
        shakeAt = now;
        // Random direction, full step: a shake is a jump to somewhere else, not a
        // drift, so the magnitude is not itself randomised.
        const a = Math.random() * Math.PI * 2;
        shakeX = Math.cos(a); shakeY = Math.sin(a);
      }
      tx = shakeX * Math.min(amp, CANVAS_SHAKE_X);
      ty = shakeY * Math.min(amp, CANVAS_SHAKE_Y);
    } else {
      shakeAt = 0;
    }

    const grow = idle ? growScale(idleFor) : 1;

    bob *= Math.pow(0.82, dt * 15);
    if (Math.abs(bob) < 0.4) bob = 0;
    const discX = DISC_X + tx, discY = DISC_Y + bob + ty;

    ctx.filter = 'none';
    const g = ctx.createRadialGradient(CANVAS_W * 0.3, CANVAS_H * 0.42, 20, CANVAS_W * 0.3, CANVAS_H * 0.42, CANVAS_W * 0.8);
    g.addColorStop(0, '#1e293b'); g.addColorStop(1, '#0f172a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    if (forceActive) ctx.filter = 'grayscale(1)';

    ctx.beginPath();
    ctx.arc(discX, discY, DISC_R * grow, 0, Math.PI * 2);
    ctx.fillStyle = idle ? '#94a3b8' : char.color;
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
    ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    const face = idle ? CRYING[Math.floor(now / 450) % CRYING.length] : char.icon;
    ctx.font = `${Math.round(84 * grow)}px "Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(face, discX, discY + 4 * grow);

    // Everything below is drawn AFTER the character and therefore over it. That is the
    // whole arrangement: a grown character is allowed to fill the frame, but the score
    // and the countdown are the reason this panel exists and must never be the thing
    // it covers. (The two whitelist bars are separate DOM rows under the canvas, so
    // they are out of reach of the drawing entirely.) Once the disc is big enough to
    // reach them they get a plate behind them — grey on grey is unreadable, and a
    // shadow alone is not enough against a flat fill.
    const covered = grow > 1.05;
    const plate = (x: number, y: number, w: number, h: number) => {
      if (!covered) return;
      ctx.fillStyle = 'rgba(15,23,42,0.82)';
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 12);
      ctx.fill();
    };

    const sx = 250;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.font = 'bold 46px system-ui, sans-serif';
    const focusStr = String(Math.round(s?.focusScore ?? 0));
    const distStr = String(Math.round(s?.distractedScore ?? 0));
    const fw = ctx.measureText(focusStr).width;
    const slw = ctx.measureText('/').width;
    const dx = sx + fw + 12 + slw + 12;
    plate(sx - 12, 66, dx - sx + ctx.measureText(distStr).width + 24, 60);
    ctx.fillStyle = '#4ade80'; ctx.fillText(focusStr, sx, 112);
    ctx.fillStyle = '#64748b'; ctx.fillText('/', sx + fw + 12, 112);
    ctx.fillStyle = '#f87171'; ctx.fillText(distStr, dx, 112);

    const ph = currentPhase();
    if (ph) {
      ctx.font = 'bold 34px system-ui, sans-serif';
      plate(sx - 12, 134, ctx.measureText(ph.text).width + 24, 46);
      ctx.fillStyle = ph.color;
      ctx.fillText(ph.text, sx, 168);
    }
    ctx.filter = 'none';

    // Fireworks. Integrated rather than keyframed so a dropped frame costs distance,
    // not a jump: the whole burst is over in under a second.
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      const age = (now - p.born) / p.life;
      if (age >= 1) { parts.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += 90 * dt;                       // a little gravity, so it falls away
      ctx.globalAlpha = 1 - age;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (1 - age * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // The score change, over the character. Pops in, holds, then rises and fades —
    // the same three beats as the in-page "−10", so the two read as one event seen
    // from two places rather than two different notifications.
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = flyUps.length - 1; i >= 0; i--) {
      const l = flyUps[i];
      const age = (now - l.born) / l.life;
      if (age >= 1) { flyUps.splice(i, 1); continue; }
      const pop = age < 0.12 ? age / 0.12 : 1;
      const rise = age > 0.7 ? (age - 0.7) / 0.3 : 0;
      ctx.globalAlpha = 1 - rise;
      ctx.font = `900 ${Math.round(l.size * (0.4 + 0.6 * pop))}px system-ui, sans-serif`;
      ctx.fillStyle = l.color;
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 12;
      ctx.fillText(l.text, DISC_X, DISC_Y - rise * 40);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }

  function frame() {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    draw();
  }
  // requestAnimationFrame rather than an interval, and not only for smoothness: the
  // browser stops calling it while the window is hidden or minimised, which is most
  // of this panel's life. An interval would keep compositing a canvas nobody can see.
  raf = requestAnimationFrame(frame);

  return {
    canvas,
    setState,
    setSettings,
    stop() { stopped = true; cancelAnimationFrame(raf); },
  };
}

// ── The two whitelist bars ────────────────────────────────────────────────────
// Under the character and the score, two strips answer the only question this panel
// cannot already show you: "is what I am doing right now being counted?"
//
//   page bar     — the site in the front tab, and one click to whitelist it
//   program bar  — the program you were last in, and one click to whitelist that
//
// NEITHER can ask "what is in front RIGHT NOW?", for the same structural reason in
// both cases: the companion window is itself a window of the browser, so at the
// moment you look at it the live answers are "the companion tab" and "a browser".
// The background hands out the last ordinary web PAGE (PageStatus) and the last
// non-browser PROGRAM (AgentStatus.recent) instead — which is also what a person
// means by "this page" and "this app", and both survive the click, which necessarily
// focuses the browser in order to happen at all.

/** A woken service worker answers the first AGENT_STATUS from an empty cache — its
 *  poll timer did not survive suspension — so "not running" is a normal FIRST answer
 *  from a machine whose agent is perfectly fine. Two polls' worth of grace turns that
 *  into no flicker at all, at the cost of a genuinely stopped agent being announced
 *  four seconds late, which nobody is waiting on. */
export const OFF_GRACE_MS = 4000;

export interface WhitelistBars {
  /** The two rows, page first. Append them under the canvas. */
  rows: HTMLElement[];
  /** Ask now rather than waiting for the next poll. */
  refresh(): void;
  /** Feed every STATE_UPDATE through here so a working↔idle switch shows at once
   *  rather than up to two seconds later. */
  noteState(s: CompanionState): void;
  stop(): void;
}

/** One strip: a label, a status word once it is on the whitelist, and a button when it
 *  is not. Built once for both rows so they cannot drift apart visually.
 *
 *  The status word is **WORKING** or **IDLE**, not "whitelisted", because those are
 *  two different facts and the interesting one changes minute to minute. With a
 *  companion on each screen, moving from the editor to a whitelisted page should show
 *  the program going quiet and the page lighting up — which is a thing you can watch,
 *  where "both are on a list" is not. */
function makeBar() {
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'none', alignItems: 'center', gap: '6px', flexShrink: '0',
    padding: '5px 8px', borderTop: '1px solid rgba(148,163,184,0.18)',
    fontSize: '11px', lineHeight: '1.2', minWidth: '0',
    fontFamily: 'system-ui, sans-serif',
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

  /** Show `text`, with either the "+ Whitelist" button or the status-and-✕ pair —
   *  never both, since they are the two directions of one toggle. `working` picks
   *  between the two states of the status word; it is meaningless unless `counted`. */
  const show = (text: string, title: string, counted: boolean, undoTitle = '', working = false) => {
    row.style.display = 'flex';
    row.style.background = 'transparent';
    label.style.color = counted && !working ? '#94a3b8' : '#cbd5e1';
    label.style.whiteSpace = 'nowrap';
    label.textContent = text;
    label.title = title;
    tick.style.display = counted ? 'inline' : 'none';
    tick.textContent = working ? '✓ working' : 'idle';
    tick.style.color = working ? '#4ade80' : '#64748b';
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

/**
 * Build the page and program strips, wired to the background.
 *
 * Polled, because both answers change as you switch tab or alt-tab and nothing
 * broadcasts either. Skipped while the document is hidden: a companion window stays
 * open for hours, and a minimised one asking twice a minute would wake the service
 * worker for two bars nobody can see.
 *
 * `onAgent` is handed every reply, because a caller may need the same answer for
 * something else — the companion window's pin line reads it to work out whether
 * anything is going to keep it on top.
 */
export function createWhitelistBars(
  opts: { workingFreshMs: number },
  onAgent?: (a: AgentStatus | null) => void,
): WhitelistBars {
  const pageBar = makeBar();
  const programBar = makeBar();

  // `shownPage`/`shownProgram` hold whatever each row is describing, whitelisted or
  // not — the two buttons are never visible at once, so one subject serves both.
  let shownPage: string | null = null;
  let shownProgram: string | null = null;
  let offSince = 0;                   // when the agent first looked absent
  let stopped = false;

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
      page.allowed
        ? (page.working
            ? `You are working on ${page.domain} — it is earning points right now`
            : `${page.domain} is whitelisted, but the points are being earned somewhere else`)
        : `Count ${page.domain} as work`,
      page.allowed,
      wider.length
        ? `Remove ${page.matched.join(', ')} from the whitelist — anything else matching stops counting too`
        : `Stop counting ${page.domain} as work`,
      page.working,
    );
  }

  // With the agent stopped, this strip turns into a red line saying so. Opening the
  // companion IS the moment work moves outside the browser, so a stopped agent means
  // everything you are about to do goes uncounted, and nothing else on screen would
  // tell you. It stays until fixed rather than fading like a hint, because it
  // describes a state, not a tip. The bar is hidden only when there is genuinely
  // nothing to say: agent running, but no program resolved yet (a Wayland session
  // with no bridge, say), which the popup's Allowed programs panel explains properly.
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
      agent.recentAllowed
        ? (agent.recentWorking
            ? `You are working in ${p.id} — it is earning points right now`
            : `${p.id} is whitelisted, but the points are being earned somewhere else`)
        : `Count ${p.id} as work`,
      agent.recentAllowed,
      `Stop counting ${p.id} as work`,
      agent.recentWorking,
    );
  }

  function askPage() {
    chrome.runtime.sendMessage({ type: 'PAGE_STATUS' }, (res?: PageStatus) => {
      try { if (chrome.runtime.lastError) return; } catch { return; }
      renderPageBar(res ?? null);
    });
  }

  function askAgent() {
    chrome.runtime.sendMessage({ type: 'AGENT_STATUS' }, (res?: AgentStatus) => {
      try { if (chrome.runtime.lastError) return; } catch { return; }
      renderProgramBar(res ?? null);
      onAgent?.(res ?? null);
    });
  }

  // Neither page click names the page: the background decides which page is meant,
  // for the same reason it has to — this panel cannot see which tab is in front.
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

  const refresh = () => {
    if (stopped || document.visibilityState !== 'visible') return;
    askPage();
    askAgent();
  };
  const timer = setInterval(refresh, 2000);
  refresh();

  // The two-second poll is fine for "did the front tab change", but the working↔idle
  // switch is a thing the user is doing deliberately and watching for, so waiting out
  // an interval to show it feels broken. Three fields decide it and all three arrive
  // by broadcast — so ask again the moment any of them changes, and only then.
  // Refreshing on every STATE_UPDATE would be two messages a second while working,
  // for a pair of rows that almost never change.
  //
  // `fresh` is the one that is not a flag. It goes false the instant the background
  // pins `lastHeartbeat` back to the OS anchor — which is a broadcast of its own, and
  // the exact moment the "I" countdown starts falling and the session stops earning.
  // Without it the bars would keep saying WORKING for up to another two seconds of a
  // five-second countdown.
  let lastHeld: boolean | null = null;
  let lastActive: boolean | null = null;
  let lastFresh: boolean | null = null;
  const noteState = (s: CompanionState) => {
    if (!s) return;
    const held = !!s.osHeld;
    const active = !!s.isHeartbeatActive;
    const fresh = Date.now() - s.lastHeartbeat < opts.workingFreshMs;
    if (held === lastHeld && active === lastActive && fresh === lastFresh) return;
    lastHeld = held; lastActive = active; lastFresh = fresh;
    refresh();
  };

  return {
    rows: [pageBar.row, programBar.row],
    refresh,
    noteState,
    stop() { stopped = true; clearInterval(timer); },
  };
}
