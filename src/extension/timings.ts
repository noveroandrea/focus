// ─────────────────────────────────────────────────────────────────────────────
//  ALL EXTENSION TIMERS — single source of truth
// ─────────────────────────────────────────────────────────────────────────────
//  Every timing constant that governs *when* something happens lives here so the
//  whole schedule can be read (and tuned) in one place, instead of being spread
//  across background.ts and sprite.ts where two copies can silently drift.
//
//  Pure constants + pure functions only — NO chrome APIs, NO DOM — so both the
//  service worker (background.ts) and the injected content script (sprite.ts) can
//  import it and stay in sync. In the sprite bundle these inline to plain numbers,
//  so the content script stays self-contained.
//
//  Durations are in milliseconds unless the name ends in _S (seconds) or the
//  value comes from a user setting (idleTime, cryBeepDuration — both in seconds).
// ─────────────────────────────────────────────────────────────────────────────

// ── Background polling ─────────────────────────────────────────────────────────
/** OS idle poll (background.ts): chrome.idle.queryState is read this often. This
 *  is the *sampling latency* on top of the idle threshold — the sprite can go
 *  Idle up to this late after the OS has actually been idle for `idleTime` s. */
export const IDLE_POLL_MS = 500;

/** Status loop (background.ts): keeps counting alive in forceActive mode and is
 *  the BACKUP idle expiry if the idle poll never reports Idle. */
export const STATUS_LOOP_MS = 1000;

/** Threshold we hand to chrome.idle.queryState — Chrome's MINIMUM (15 s), not the
 *  user's idleTime. queryState(N) is binary: "input within the last N s" or not,
 *  with no sub-threshold detail. Polling at the user's idleTime therefore yields
 *  no countdown at all — it reads "active" (so lastHeartbeat is refreshed to now,
 *  pinning any countdown at its maximum) right up until the instant it flips.
 *
 *  Polling at the floor instead gives us an ANCHOR: the first "idle" reading means
 *  input stopped ≥15 s ago, so we can date the last input to now−15 s and count the
 *  remaining `idleTime − 15` s down ourselves. The idle flip still lands at
 *  idleTime after the last input; we just gain a real, ticking countdown for the
 *  tail of the wait instead of a cliff. The first 15 s remain genuinely unknowable
 *  — the OS simply doesn't expose them. */
export const OS_IDLE_FLOOR_S = 15;

/** registerHeartbeat() advances the count at most once per this window, so the
 *  count tracks ≈one heartbeat per real second no matter how many sources fire. */
export const HEARTBEAT_THROTTLE_MS = 1000;

/** How long a content script is given to report in before the background treats
 *  the focused tab as a viewer (PDF/plugin) and classifies it itself. */
export const VIEWER_CLASSIFY_DELAY_MS = 2500;


// ── Idle escalation timeline ───────────────────────────────────────────────────
//  Shared by background.ts (scoring / auto-pause) and sprite.ts (face / beep /
//  grow). An idle lapse, measured from the moment the sprite goes Idle, runs:
//
//    phase        window            what the user sees / what happens
//    ───────────  ────────────────  ──────────────────────────────────────────
//    warning      0 … WARNING       crying FACE only — a silent heads-up
//    grace        WARNING … +GRACE  beep + grow start, but no points are docked
//    penalty      > WARNING+GRACE   −IDLE_PENALTY lands on distractedScore (once)
//    auto-pause   > WARNING+beepDur status auto-switches to "Not working" (once)
//
//  Keep IDLE_WARNING_MS identical on both sides — that's the whole reason it lives
//  here now instead of being declared twice.
/** Face-only warning: the crying face shows this long BEFORE any beep/grow. */
export const IDLE_WARNING_MS = 5000;

/** Grace after the warning: idle behaviour is running but scores are untouched. */
export const IDLE_GRACE_MS = 5000;

/** Points removed from distractedScore, once, when a lapse outlasts warning+grace. */
export const IDLE_PENALTY = 10;

// ── Sprite animation ───────────────────────────────────────────────────────────
/** Delay between the sprite's walking steps (one step is queued per heartbeat). */
export const STEP_DELAY_MS = 130;

/** Throttle on interaction-driven steps, so a burst of mousemove/scroll becomes a
 *  steady walk rather than a spam of steps. */
export const INTERACTION_STEP_MS = 200;

/** How long the idle "grow" takes to fill the window once it starts (after the
 *  warning). Purely visual — does not gate scoring. */
export const GROW_DURATION_MS = 20_000;

/** The icon-change celebration (fireworks + spin pop) before the new character
 *  settles back to full size. */
export const ICON_POP_MS = 700;

// ── Derived timeline helpers ───────────────────────────────────────────────────
/** Wall-clock time from "went Idle" to the −10 penalty landing. */
export function idlePenaltyDelayMs(): number {
  return IDLE_WARNING_MS + IDLE_GRACE_MS;
}

/** Wall-clock time from "went Idle" to the auto "Not working" switch, given the
 *  configured beep duration (seconds). The nag = warning face + the full beep. */
export function autoPauseDelayMs(cryBeepDurationS: number): number {
  return IDLE_WARNING_MS + cryBeepDurationS * 1000;
}

/** Worst-case wall-clock time from the user's LAST activity to the moment the
 *  idle behaviour (beep + grow) begins, on an already-authorized page:
 *
 *     idleTime (s)               OS must report no input for this long
 *   + IDLE_POLL_MS               up to one extra poll to notice it
 *   + IDLE_WARNING_MS            the silent crying-face warning
 *   ───────────────────────────
 *   = total before beep/grow
 *
 *  NOTE: `idleTime` is chrome.idle's threshold. On some platforms (notably
 *  Linux/Wayland) the OS idle time itself can be reported LATE, which shows up as
 *  "it took longer than idleTime + 5 s" — that extra delay is outside this code.
 */
export function timeToIdleBehaviourMs(idleTimeS: number): number {
  return idleTimeS * 1000 + IDLE_POLL_MS + IDLE_WARNING_MS;
}
