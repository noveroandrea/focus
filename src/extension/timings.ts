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

/** How many seconds the "I" countdown shows when chrome.idle is what's driving it.
 *  A FIXED warning, deliberately not derived from idleTime: by the time the OS says
 *  "idle" you have already been away ≥15 s, so re-running the user's full idleTime
 *  from there would make a long idleTime feel broken (nothing visibly happens for
 *  ages). Once the OS says you've stopped, you get exactly this long to come back. */
export const OS_IDLE_COUNTDOWN_S = 5;

/** How long a page HEARTBEAT stays fresh. Purely cosmetic: when the idle poll sees
 *  input but no page heartbeat has arrived within this window, the activity is
 *  happening somewhere we can't see (another app, or inside a PDF viewer), and the
 *  "I" countdown turns violet to say so. Must exceed heartbeat.ts's own 1 s send
 *  throttle, or a steadily-used page would flicker. */
export const PAGE_INPUT_FRESH_MS = 2000;

/** How stale `SessionState.lastHeartbeat` may be while still counting as "working
 *  right now" — which is a different question from `isHeartbeatActive`.
 *
 *  `isHeartbeatActive` stays true through the whole idle timeout, including the final
 *  stretch where chrome.idle has already said "idle", the anchor has been set and the
 *  "I" countdown is visibly falling. No heartbeat is registered in that stretch and no
 *  points are earned, so a companion bar reporting WORKING there would be describing a
 *  session that has already stopped counting.
 *
 *  Any value between ~3 s and ~10 s behaves identically, because `lastHeartbeat` is
 *  either being refreshed constantly (every IDLE_POLL_MS while genuinely active, and
 *  at most 1 s apart from page input) or has jumped to the OS anchor, ≥10 s stale at
 *  the shortest permitted idleTime. Four sits clear of both edges. */
export const WORKING_FRESH_MS = 4000;

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
//    penalty 1    > WARNING+GRACE   −5  lands on distractedScore
//    penalty 2    > +PENALTY_GAP    −10 lands on top of it
//    penalty 3    = WARNING+beepDur −15, together with the auto-pause below
//    auto-pause   > WARNING+beepDur status auto-switches to "Not working" (once)
//
//  Keep IDLE_WARNING_MS identical on both sides — that's the whole reason it lives
//  here now instead of being declared twice.
/** Face-only warning: the crying face shows this long BEFORE any beep/grow. */
export const IDLE_WARNING_MS = 5000;

/** Grace after the warning: idle behaviour is running but scores are untouched. */
export const IDLE_GRACE_MS = 5000;

/** The three amounts a lapse can cost, in the order they land.
 *
 *  **A rising staircase, not one flat charge.** A single penalty says the same thing
 *  whether you looked away for eleven seconds or eleven minutes, so it teaches nothing
 *  about the difference; three say "this is getting worse" while there is still
 *  something to come back to. The first is deliberately the SMALLEST — the moment it
 *  fires you have been gone for ten seconds, which is a glance out of the window and
 *  not a betrayal, and a −15 for that is the sort of thing that gets a feature switched
 *  off. */
export const IDLE_PENALTY_1 = 5;
export const IDLE_PENALTY_2 = 10;
export const IDLE_PENALTY_3 = 15;

/** Gap between the first penalty and the second. Long enough that the countdown to it
 *  is a real chance to come back rather than a formality, and short enough to arrive
 *  while the beep is still going. */
export const IDLE_PENALTY_GAP_MS = 30_000;

/** One idle lapse's whole penalty schedule, in order, measured from the moment the
 *  session went idle.
 *
 *  **The single description of what a lapse costs and when.** Scoring reads it, the
 *  countdown on every surface reads it, and the phone nudge's text reads it — so they
 *  cannot describe different futures. Adding a stage here changes all four.
 *
 *  The last stage is pinned to the auto-pause rather than given a time of its own: that
 *  is the moment Focus decides you have stopped working, so it is the last moment a
 *  penalty means anything, and tying the two together keeps `cryBeepDuration` the single
 *  answer to "how long does a lapse go on for".
 *
 *  Which is also why the earlier stages are FILTERED and not merely listed. That slider
 *  goes down to 10 s, where the lapse is over at 15 s and the −10 at 40 s would be a
 *  countdown to something that can never happen. Anything not strictly before the end
 *  is dropped, so the schedule is always increasing and always reachable. */
export function penaltyStages(beepDurationS: number): { at: number; amount: number }[] {
  const end = autoPauseDelayMs(beepDurationS);
  const first = idlePenaltyDelayMs();
  const stages = [
    { at: first, amount: IDLE_PENALTY_1 },
    { at: first + IDLE_PENALTY_GAP_MS, amount: IDLE_PENALTY_2 },
  ].filter((s) => s.at < end);
  stages.push({ at: end, amount: IDLE_PENALTY_3 });
  return stages;
}

/** Shortest gap between two phone nudges. **Zero — every real lapse nudges.**
 *
 *  This was 5 minutes, and the reasoning was: the warning starts every time you look
 *  away for `idleTime`, dozens of times on an ordinary afternoon, so a buzz per lapse is
 *  a phone that gets silenced by lunchtime. That argument was written when a lapse sent
 *  ONE push, and it stopped being true when the lapse learned to repeat: a single lapse
 *  now sends a burst — one every NUDGE_REPEAT_MS until you come back or the auto-pause
 *  fires — so the "don't be annoying" budget is already spent inside one lapse, and all
 *  a cross-lapse cooldown could still do was swallow the *next* real one.
 *
 *  And swallowing it silently was the actual damage. The nudge is the only surface that
 *  works when you have stopped looking at the screen, so a suppressed one is not a
 *  quieter warning, it is no warning — while the points come off exactly the same. It
 *  read as "the notifications randomly stop and later come back", because that is
 *  precisely what a five-minute window looks like from outside.
 *
 *  Kept as a constant rather than deleted, because the guard in buzzPhone is one line
 *  and this is the knob to turn if the phone ever does become too chatty. At 0 that
 *  guard can never fire. What bounds the rate now is the shape of the event itself:
 *  buzzPhone runs only on the active→idle edge, and reaching another one costs real
 *  input followed by a full `idleTime` of silence.
 *
 *  `nudgeLastAt` is still persisted (see NUDGE_LAST_KEY in background.ts) so raising
 *  this is a one-character change: an MV3 worker is suspended between events, and a
 *  cooldown living in a module variable resets itself exactly when the user has been
 *  away long enough for the worker to be dropped. */
export const NUDGE_COOLDOWN_MS = 0;

/** Gap between repeats once a lapse has already nudged you once.
 *
 *  The first nudge is a tap on the shoulder and is easy to miss — the phone is in a
 *  pocket, face down, or you glanced at it and put it back. Repeating turns it into
 *  something you have to answer, which is the point of a nudge to a person who has
 *  already stopped noticing the screen.
 *
 *  It does NOT need an end of its own, and deliberately does not have one: the repeat
 *  stops when the session stops nagging — you come back (active again), or the lapse
 *  outlasts the beep and the extension switches itself to "Not working", which with the
 *  default 60 s beep is about 65 s and a dozen repeats. Tying it to the existing
 *  auto-pause rather than counting repeats means there is one answer to "how long does
 *  Focus nag me", the cryBeepDuration slider, and no second number to keep in step.
 *
 *  The phone shows ONE notification throughout, not a dozen: sw.js sends every push
 *  under the same `tag` with `renotify`, so each replaces the last and re-alerts. */
export const NUDGE_REPEAT_MS = 5000;

/** How stale a nudge's countdown is by the time the phone shows it.
 *
 *  A push is not instant: signing, the POST to Apple or Google, their relay to the
 *  device, and the phone waking its service worker add up to a few seconds — measured at
 *  about three on a real iPhone. The countdown was computed at SEND time, so it arrived
 *  describing a moment that had already passed: "15 seconds before −10" on a screen
 *  where the real number was 12.
 *
 *  So the text is written for the future rather than the present, and this is the amount
 *  it is written ahead by. Four rather than the measured three deliberately: the error
 *  should fall on the side of the phone under-promising, since a countdown that turns out
 *  to have been generous is a second of unexpected grace, while one that runs out early
 *  is the feature lying to you about the only number it exists to tell you.
 *
 *  Only the PHONE text uses this. The countdowns on screen are live and exact — there is
 *  nothing in flight to compensate for. */
export const PUSH_LATENCY_MS = 4000;

/** How long a phone-pairing QR stays valid.
 *
 *  MIRRORS pairing_ttl() in supabase/migrations/20260812100000_push_pairing.sql,
 *  which is the one that actually enforces it — this copy exists so the popup can
 *  count the QR down instead of letting it expire silently, and a disagreement here
 *  costs a wrong number on screen rather than a wrong decision.
 *
 *  Long enough to find the phone, unlock it, scan, and on iOS work through Add to
 *  Home Screen; short enough that a nonce photographed over a shoulder is worthless
 *  by the time anyone could use it. */
export const PAIRING_TTL_MS = 10 * 60_000;

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
/** Wall-clock time from "went Idle" to the FIRST penalty landing. */
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
