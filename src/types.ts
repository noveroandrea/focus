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
  /** Full list of allowed domain strings — pre-populated with defaults, fully editable */
  allowedDomains: string[];
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
  allowedDomains: [
    'overleaf.com', 'arxiv.org', 'nature.com', 'ieee.org', 'claude.ai',
    'mail.google.com', 'outlook.live.com', 'outlook.office.com',
    'scholar.google.com', 'wikipedia.org', 'unipd.it',
  ],
  classifyUrl: 'http://localhost:11434',
  classifyApiKey: '',
  classifyModel: 'qwen-yesno',
  classifyNumThreads: 2,
  classifyPrompt: 'Is this page where the user actively reads, studies, or writes technical or academic content? Answer YES for: search results, study material, math/engineering related material, research papers, documentation, articles, reference tools, writing editors. Answer NO if the page is primarily for passive consumption or social interaction — regardless of how professional it looks. For YouTube, base your answer only on the video title.',
};

export type MessageType =
  | { type: 'HEARTBEAT'; tabId: number }
  | { type: 'FOCUS_PING' }
  | { type: 'GET_STATE' }
  | { type: 'STATE_UPDATE'; state: SessionState }
  | { type: 'ADD_DOMAIN'; domain: string }
  | { type: 'REMOVE_DOMAIN'; domain: string }
  | { type: 'CLASSIFY_PAGE'; url: string; title: string; snippet: string };
