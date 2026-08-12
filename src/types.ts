/** Number of characters in the sprite roster (kept in sync with sprite.ts CHARS). */
export const CHARACTER_COUNT = 15;

export interface SessionState {
  isHeartbeatActive: boolean;
  lastHeartbeat: number;
  activeWindowId: number | null;
  enabled: boolean;
  /** Index into the character roster currently shown by the active sprite */
  currentIconId: number;
  /** Active heartbeats accumulated toward the next icon change (drives the shrink) */
  heartbeatCount: number;
  /** Timestamp of the most recent icon change — bumped to trigger the fireworks animation */
  iconChangeAt: number;
  /** Points earned by focusing: +30/iconChangeHeartbeats per character change. Only ever rises. */
  focusScore: number;
  /** Points lost to distraction: −10 per idle lapse. Only ever falls, so it goes negative. */
  distractedScore: number;
  /** Local calendar day (YYYY-MM-DD) the two scores above belong to. When the day
   *  changes, the old day is banked into DayScore[] history and the scores reset. */
  scoreDate: string;
  /** Timestamp nonce bumped each time an idle penalty is applied — triggers the "−10" sprite animation */
  penaltyAt: number;
  /** True while the session is being kept alive by OS-wide activity (you're working
   *  in another application) rather than by input on the page itself. Activity
   *  anywhere counts as working, so the idle countdown legitimately stops falling —
   *  but a number frozen at its maximum is indistinguishable from a broken timer, so
   *  the readouts use this to say WHY it isn't moving. */
  osHeld: boolean;
}

/** Round a score to 2 decimals. No max(0): focusScore only ever rises from 0 and
 *  distractedScore is meant to run negative, so clamping either would be wrong. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One archived day of scores, kept in chrome.storage.local under HISTORY_KEY.
 *  Written once, when the day rolls over — never edited afterwards. */
export interface DayScore {
  /** Local calendar day, YYYY-MM-DD */
  date: string;
  /** Day of the week for that date, e.g. "Monday" — stored so the CSV is readable as-is */
  weekday: string;
  focusScore: number;
  distractedScore: number;
}

export const HISTORY_KEY = 'focusScoreHistory';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The LOCAL calendar day as YYYY-MM-DD. Deliberately not toISOString(), which is
 *  UTC and would roll the day over at the wrong moment for most timezones. */
export function localDateKey(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Weekday name for a YYYY-MM-DD key. The T00:00:00 suffix forces local-time
 *  parsing — a bare date string is parsed as UTC and can land on the day before. */
export function weekdayName(dateKey: string): string {
  const d = new Date(`${dateKey}T00:00:00`);
  return WEEKDAYS[d.getDay()] ?? '';
}

export interface Settings {
  /** Master on/off switch; when false the extension does nothing */
  enabled: boolean;
  /** When true, force the sprite into the active state on every page regardless of real activity */
  forceActive: boolean;
  /** Seconds of no activity before the sprite goes idle (and the beep begins).
   *  Also drives chrome.idle's system-wide detection used on PDF/viewer tabs. */
  idleTime: number;
  /** Active heartbeats (≈seconds of focused work) before the sprite character changes */
  iconChangeHeartbeats: number;
  /** Peak volume (0–100 %) of the high-tone beep that plays while the sprite is idle/crying */
  cryBeepVolume: number;
  /** How long (seconds) the idle beep lasts before it stops on its own */
  cryBeepDuration: number;
  /** Which idle-beep pattern to play (see CRY_BEEP_STYLES) */
  cryBeepStyle: CryBeepStyle;
  /** Master switch for the idle beep sound; when false no sound plays regardless of volume */
  soundEnabled: boolean;
  /** When true, unknown pages are sent to the AI classifier; when false they just stay inactive */
  aiRequestEnabled: boolean;
  /** When true, resuming work opens the floating companion window; when false it never opens */
  companionEnabled: boolean;
  /** When false, no sprite is injected into pages at all. For people who work with
   *  the companion window instead: a character walking over the page is the single
   *  most intrusive thing this extension does, and on a second monitor it is also
   *  redundant. Nothing else changes — heartbeats, scoring and the whitelist are all
   *  owned by the background and carry on exactly as before. */
  spriteEnabled: boolean;
  /** What the sprite injected into the page looks like and how it behaves (see SPRITE_MODES) */
  spriteMode: SpriteMode;
  /** Whether the crying character also SWELLS to fill its frame once the warning is
   *  over. Trembling is not a choice and has no setting: it is the escalation, it
   *  starts inside the warning window and it grows the whole time you are away.
   *  Growing is the part that takes over the screen, so it is the part worth being
   *  able to turn off. Applies to all three sprite modes and to the companion window
   *  — the panel and the window are fixed-size boxes, but the drawing inside them is
   *  not. */
  idleGrow: boolean;
  /** Full list of allowed domain strings — pre-populated with defaults, fully editable */
  allowedDomains: string[];
  /** Foreground PROGRAMS that count as work, reported by the optional desktop agent.
   *
   *  A separate list from allowedDomains, and not a variant of it: a domain is a
   *  place inside the browser matched by substring against a URL, while a program is
   *  an OS-level identity matched exactly against the agent's identifier (executable
   *  name on Windows, bundle id on macOS, process name on Linux).
   *
   *  Empty by default. There is no useful cross-platform default list, and the popup
   *  offers the program you are actually using with one click to add it. */
  allowedPrograms: string[];
  /** Base address of the AI backend (Ollama-compatible HTTP API).
   *  Local: just host:port, e.g. http://localhost:11434. Remote: the full base URL. */
  classifyUrl: string;
  /** API key for a remote backend, sent as `Authorization: Bearer …`.
   *  Leave empty for a local model (no auth needed). */
  classifyApiKey: string;
  /** Model name used for page auto-classification (must reply YES / NO). Required —
   *  the address says WHERE the server is, the model name says WHICH model to run. */
  classifyModel: string;
  /** Max CPU threads Ollama may use per classification request (caps load; 0 = let Ollama decide) */
  classifyNumThreads: number;
  /** Prompt sent to the model for page classification (URL/title/snippet are appended automatically) */
  classifyPrompt: string;
  /** Buzz the user's phone at the start of the 5-second warning, via a Telegram bot.
   *
   *  Off by default and inert until both fields below are filled in. Telegram rather
   *  than a push service or an app of our own because it is the only option that
   *  needs nothing installed on the desktop, nothing hosted, no keys to rotate and no
   *  iOS build: one HTTPS POST from the service worker, and the phone the user
   *  already has notifications from does the rest.
   *
   *  Note this is the ONE thing the extension sends anywhere other than its own
   *  backend, so it is opt-in and the message names no page and no program — only
   *  that a lapse started. The timing alone is behavioural data, and it lands on
   *  Telegram's servers. */
  telegramEnabled: boolean;
  /** Bot token from @BotFather (`123456:ABC-…`). A credential, held in
   *  chrome.storage.local exactly like `classifyApiKey`. */
  telegramToken: string;
  /** Which chat to send to — the numeric id of the user's own conversation with
   *  their bot. Filled in by the popup's "Find" button rather than by hand: nobody
   *  knows their own chat id, and it is one `getUpdates` call away once they have
   *  said anything to the bot. */
  telegramChatId: string;
}

/** Clamp the icon-change interval to the supported heartbeat range. */
export const ICON_CHANGE_MIN = 5;
export const ICON_CHANGE_MAX = 300;
export function clampIconChangeHeartbeats(h: number): number {
  if (!Number.isFinite(h)) return 30;
  return Math.min(ICON_CHANGE_MAX, Math.max(ICON_CHANGE_MIN, Math.round(h)));
}

/** Clamp the idle beep peak volume to 0–100 %. */
export const CRY_BEEP_MIN = 0;
export const CRY_BEEP_MAX = 100;
export function clampCryBeepVolume(v: number): number {
  if (!Number.isFinite(v)) return 100;
  return Math.min(CRY_BEEP_MAX, Math.max(CRY_BEEP_MIN, Math.round(v)));
}

/** Idle-beep patterns. */
export type CryBeepStyle = 'ramp' | 'pulse' | 'siren';
export const CRY_BEEP_STYLES: { id: CryBeepStyle; label: string; hint: string }[] = [
  { id: 'ramp',  label: 'Rising volume',    hint: 'one tone that fades in from silence up to the set volume' },
  { id: 'pulse', label: 'Steady beeps',     hint: 'short beeps at full volume, one every 5 seconds' },
  { id: 'siren', label: 'Siren',            hint: 'a two-tone alarm at full volume the whole time' },
];
export function clampCryBeepStyle(s: unknown): CryBeepStyle {
  return s === 'pulse' || s === 'siren' ? s : 'ramp';
}

/** Clamp the idle beep duration to 10 s – 5 min. */
export const CRY_BEEP_DURATION_MIN = 10;
export const CRY_BEEP_DURATION_MAX = 300;
export function clampCryBeepDuration(s: number): number {
  if (!Number.isFinite(s)) return 60;
  return Math.min(CRY_BEEP_DURATION_MAX, Math.max(CRY_BEEP_DURATION_MIN, Math.round(s)));
}

// ── The in-page sprite ────────────────────────────────────────────────────────
// Three shapes for the same information, because the thing that makes a companion
// work is different for different people: some need it moving to notice it at all,
// some find a moving object on the page unusable, and some want the whole companion
// panel — whitelist buttons included — without a second window to keep on top.
export type SpriteMode = 'roam' | 'fixed' | 'panel';
export const SPRITE_MODES: { id: SpriteMode; label: string; hint: string }[] = [
  { id: 'roam',  label: 'Roaming',  hint: 'the small circle walks across the page, one step per heartbeat' },
  { id: 'fixed', label: 'Fixed',    hint: 'the same small circle, parked where you drag it — it bounces on each heartbeat instead of walking' },
  { id: 'panel', label: 'Panel',    hint: 'the whole companion, in the page: character, score, countdown and both whitelist buttons, dragged where you like' },
];
export function clampSpriteMode(s: unknown): SpriteMode {
  return s === 'fixed' || s === 'panel' ? s : 'roam';
}

// What the character does when you go idle.
//
// TREMBLING is not optional and has no setting. It begins inside the five-second
// warning window — while there is still time to come back, which is the only moment a
// warning is worth anything — and grows for as long as you stay away. Making it a
// choice would have meant offering to switch off the one thing that is *meant* to
// catch your eye.
//
// GROWING is the part that takes over the screen, so that is the part worth being
// able to refuse. One setting for every surface: the roaming and fixed circles grow
// into the page, and the panel and the companion window grow inside their own frame —
// a fixed-size box does not stop the drawing in it from swelling. In both frames the
// score and the countdown are painted over the top, so a character big enough to fill
// the view never hides the numbers.

/** Where the user parked the sprite, per mode, as a FRACTION of the viewport rather
 *  than pixels: the same page opened on a laptop and an external monitor has to put
 *  the companion in the same visual place, and a pixel offset saved on the big screen
 *  lands off the edge of the small one. Written by the content script on drop, read
 *  by every tab. Kept out of `Settings` deliberately — a drag is not a preference,
 *  and routing one through the settings object would fire the whole settings-changed
 *  cascade (whitelist diff, server mirror, icon repaint) on every drop. */
export const SPRITE_POS_KEY = 'focusSpritePos';
export interface SpritePositions {
  fixed?: { x: number; y: number };
  panel?: { x: number; y: number };
}

/** Clamp the idle time. Minimum is 15 s — the floor Chrome's idle API allows. */
export const IDLE_TIME_MIN = 15;
export const IDLE_TIME_MAX = 300;
export function clampIdleTime(s: number): number {
  if (!Number.isFinite(s)) return 20;
  return Math.min(IDLE_TIME_MAX, Math.max(IDLE_TIME_MIN, Math.round(s)));
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  forceActive: false,
  idleTime: 20,
  iconChangeHeartbeats: 30,
  cryBeepVolume: 100,
  cryBeepDuration: 60,
  cryBeepStyle: 'ramp',
  soundEnabled: true,
  aiRequestEnabled: true,
  companionEnabled: true,
  spriteEnabled: true,
  spriteMode: 'roam',
  idleGrow: true,
  allowedDomains: [
    'overleaf.com', 'arxiv.org', 'nature.com', 'ieee.org', 'claude.ai',
    'mail.google.com', 'outlook.live.com', 'outlook.office.com',
    'scholar.google.com', 'wikipedia.org', 'unipd.it',
  ],
  allowedPrograms: [],
  classifyUrl: 'http://localhost:11434',
  classifyApiKey: '',
  classifyModel: 'qwen-yesno',
  classifyNumThreads: 2,
  telegramEnabled: false,
  telegramToken: '',
  telegramChatId: '',
  classifyPrompt: 'Is this page where the user actively reads, studies, or writes technical or academic content? Answer YES for: search results, study material, math/engineering related material, research papers, documentation, articles, reference tools, writing editors. Answer NO if the page is primarily for passive consumption or social interaction — regardless of how professional it looks. For YouTube, base your answer only on the video title.',
};

export type MessageType =
  | { type: 'HEARTBEAT'; tabId: number }
  | { type: 'FOCUS_PING' }
  | { type: 'GET_STATE' }
  | { type: 'STATE_UPDATE'; state: SessionState }
  | { type: 'ADD_DOMAIN'; domain: string }
  | { type: 'REMOVE_DOMAIN'; domain: string }
  | { type: 'CLASSIFY_PAGE'; url: string; title: string; snippet: string }
  // The optional desktop agent: is it running, and what program is in front?
  // Asked by the popup so the program whitelist can offer what you're using now.
  | { type: 'AGENT_STATUS' }
  // Whitelist a program from a surface that has no settings UI — the companion
  // window's one-click button. The background owns `settings`, so it does the write.
  | { type: 'ADD_PROGRAM'; program: string }
  | { type: 'REMOVE_PROGRAM'; program: string }
  // The same one-click path for the page you are on, asked and answered by the
  // background because the companion window cannot see which tab is in front —
  // which is also why undoing it takes no argument.
  | { type: 'PAGE_STATUS' }
  | { type: 'WHITELIST_PAGE' }
  | { type: 'UNWHITELIST_PAGE' }
  // Open (or focus) a companion window. Owned by the background because both the
  // popup's Working button and the companion's own "another one" button ask for it,
  // and because placing it needs chrome.system.display, which a content script and a
  // popup that closes mid-call have no business holding open.
  //   extra = false — the Working button: focus the companion you already have.
  //   extra = true  — the companion's button: put ANOTHER one on the next screen.
  | { type: 'OPEN_COMPANION'; extra?: boolean }
  // Server sync. Sign-in runs in the background, never in the popup: opening the
  // Google consent window closes the popup, which would abort the flow mid-way.
  | { type: 'SERVER_SIGN_IN' }
  | { type: 'SERVER_SIGN_OUT' }
  | { type: 'SERVER_STATUS' }
  // Teams. Routed through the background like everything else that touches the
  // server, so one module owns the session and the storage caches.
  | { type: 'SERVER_JOIN_TEAM'; team: string; create: boolean; password: string }
  | { type: 'SERVER_LEAVE_TEAM'; team: string }
  | { type: 'SERVER_ENROLL_TEAM'; team: string; competition: string; create: boolean; password: string }
  | { type: 'SERVER_LEAVE_COMPETITION'; team: string; competition: string }
  | { type: 'SERVER_JOIN_COMPETITION'; competition: string; create: boolean; password: string }
  | { type: 'SERVER_LEAVE_COMPETITION_SOLO'; competition: string }
  // Profile detail. Fetched on demand and never cached — it is somebody else's data.
  | { type: 'SERVER_MY_DAYS' }
  // Averaged day series for a group. Separate from the board messages because it is
  // fetched once per section open, while a board refreshes every minute.
  | { type: 'SERVER_TEAM_DAYS'; team: string }
  | { type: 'SERVER_FRIENDS_DAYS' }
  | { type: 'SERVER_FRIENDS_BOARD'; metric: 'live' | 'avg7' | 'avg30' }
  | { type: 'SERVER_SEARCH_USERS'; query: string }
  | { type: 'SERVER_FRIEND_REQUEST'; userId: string }
  | { type: 'SERVER_FRIEND_RESPOND'; requester: string; accept: boolean }
  | { type: 'SERVER_FRIEND_REMOVE'; userId: string }
  | { type: 'SERVER_TEAM_BOARD'; team: string; metric: 'live' | 'avg7' | 'avg30' }
  | { type: 'SERVER_COMPETITION_BOARD'; competition: string; metric: 'live' | 'avg7' | 'avg30' }
  | { type: 'SERVER_MEMBER_PROFILE'; userId: string }
  | { type: 'SERVER_FLAG_DOMAIN'; domain: string }
  // The phone nudge. Both are popup-only setup steps, and both live in the background
  // for the same reason the classifier proxy does: the bot token is a credential the
  // background already holds, and a popup that closes mid-request loses the answer.
  //   TELEGRAM_LINK — read the chat id off the bot's own inbox (getUpdates), so the
  //                   user never has to find a number nobody knows how to find.
  //   TELEGRAM_TEST — send the buzz now, which is the only way to know the phone is
  //                   actually set to vibrate for it.
  | { type: 'TELEGRAM_LINK' }
  | { type: 'TELEGRAM_TEST' };

/** Reply to the two Telegram setup messages. `error` is Telegram's own `description`
 *  where there is one — it is written to be shown ("Unauthorized", "chat not found"). */
export interface TelegramResult {
  ok: boolean;
  /** TELEGRAM_LINK only: the chat id found, for the popup to save. */
  chatId?: string;
  error?: string;
}

/** Reply to the three team messages. `error` carries the database's own message
 *  ("Team X already exists — join it instead"), which is written to be shown. */
export interface ServerActionResult {
  ok: boolean;
  error?: string;
}

/** Reply to AGENT_STATUS. `program` is null when the agent is not running, or is
 *  running but has not resolved a foreground window yet. */
export interface AgentStatus {
  running: boolean;
  program: { id: string; name: string } | null;
  /** Whether that program is on `Settings.allowedPrograms`. */
  allowed: boolean;
  /** The most recent foreground program that was NOT a browser, which is what any
   *  UI offering "whitelist this app" must show: the popup and the companion window
   *  are both parts of the browser, so while you are looking at either of them
   *  `program` above reads as the browser — the one answer that may never go on the
   *  list. Null until a non-browser program has been in front. */
  recent: { id: string; name: string } | null;
  /** Whether `recent` is on `Settings.allowedPrograms`. */
  recentAllowed: boolean;
  /** Whether `recent` is what is keeping the session alive *right now* — i.e. you are
   *  working in it, as opposed to it merely being whitelisted and idle.
   *
   *  Being on the whitelist and being the thing currently earning points are two
   *  different facts, and with a companion on each screen you can see both at once:
   *  move from the editor to a whitelisted page in the browser and the program should
   *  go quiet while the page lights up. `SessionState.osHeld` is exactly that
   *  distinction — true when an application outside the browser is holding the
   *  session open, false when a page heartbeat is. */
  recentWorking: boolean;
  /** Learned identifier → human name (`code` → `Visual Studio Code`), so a list keyed
   *  by the exact platform identifier can still be read by a human. An identifier is
   *  a matching key, not a label: Linux truncates it to 15 characters and macOS gives
   *  a bundle id. Missing until the agent has seen that program in the foreground. */
  names: Record<string, string>;
  /** Set when the agent reported it cannot see the foreground (Wayland without the
   *  GNOME bridge). Shown in the popup so the failure names its own fix. */
  note: string | null;
}

/** Reply to PAGE_STATUS: the last ordinary web page seen in front, for a surface
 *  that cannot ask "which tab is active?" and get a useful answer — the companion
 *  window is itself a window, so while you look at it the live answer is the
 *  companion. `domain` is empty when there is no such page to offer. */
export interface PageStatus {
  domain: string;
  /** Whether that page currently matches `Settings.allowedDomains`. */
  allowed: boolean;
  /** Whether that page is what is keeping the session alive *right now*, rather than
   *  simply being whitelisted. The mirror of `AgentStatus.recentWorking`, off the same
   *  `osHeld` flag: exactly one of the two can be true at a time. */
  working: boolean;
  /** The whitelist entries making it count — usually just `domain`, but the match is
   *  a substring test, so a broader entry (`unipd.it`) can be the one doing the work,
   *  and removing the page removes *that*. Sent so the undo button can say what it
   *  will actually drop instead of implying it only affects this hostname. */
  matched: string[];
}

/** Reply to SERVER_STATUS / SERVER_SIGN_IN — what the popup needs to render the
 *  account section. `summary` is the last payload the server returned. */
export interface ServerStatus {
  configured: boolean;
  signedIn: boolean;
  email: string;
  summary: unknown | null;
}
