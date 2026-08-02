// ─────────────────────────────────────────────────────────────────────────────
//  THE DESKTOP AGENT — an optional third source of truth about "am I working?"
// ─────────────────────────────────────────────────────────────────────────────
//  The extension can only see inside the browser. Everything else — a thesis in a
//  local LaTeX editor, a paper in a desktop PDF reader, a compile in a terminal —
//  reaches it only as a `chrome.idle` reading: input happened SOMEWHERE. That is
//  what `osHeld` means, and why the violet countdown exists.
//
//  The agent (see desktop/) closes that gap and does exactly one thing: it reports
//  which program is in the foreground, over plain HTTP on the loopback interface.
//  It has no account, no session, no state and no UI. Every decision — which
//  programs count, what to do about them — is made HERE, because the extension is
//  the central node and the agent is a sensor.
//
//  ── WHY POLLING, NOT NATIVE MESSAGING ──────────────────────────────────────
//  chrome.runtime.connectNative would be the canonical route, but a native
//  messaging host manifest has to name the exact extension ID it may talk to —
//  and this extension's ID is not pinned (it changes when the unpacked folder
//  moves). Polling a loopback port needs no manifest, no ID, and no installer
//  touching the browser's own configuration. The extension already polls
//  chrome.idle twice a second; this rides along with it.
//
//  ── WHY A WEB PAGE CANNOT READ IT ──────────────────────────────────────────
//  The agent sends NO CORS headers. A page's fetch is therefore blocked from
//  reading the response by the browser itself, while this extension — which holds
//  an explicit host permission for the port — is exempt. The agent additionally
//  refuses requests carrying a web Origin. So "which programs do you use" is not
//  readable by any site you visit.
//
//  Everything here fails soft: with no agent installed, `currentProgram()` returns
//  null forever and the extension behaves exactly as it always has.
// ─────────────────────────────────────────────────────────────────────────────

export interface ForegroundProgram {
  /** Platform-native identity, lower-cased: executable name (Windows), bundle id
   *  (macOS), process name (Linux). */
  id: string;
  /** Human-readable name, for the popup. Never a window title. */
  name: string;
}

/** Where the agent listens. Must match AGENT_PORT in desktop/src/server.ts and the
 *  host permission in manifest.json — three copies of one number, so changing it
 *  means changing all three. */
export const AGENT_URL = 'http://127.0.0.1:47317/';

/** A reading older than this is not trusted. The agent answers in microseconds on
 *  loopback, so anything staler means it stopped responding. */
const FRESH_MS = 3000;

/** How long to wait before trying again once the agent looks absent. Without this
 *  a machine with no agent would attempt a connection twice a second forever. */
const OFFLINE_RETRY_MS = 15_000;

/** …but 15 s is far too long when somebody is LOOKING at an "agent is off" message
 *  and has just started the agent to clear it. A UI asking for status is a human
 *  waiting for an answer, so those requests probe at this interval instead. Still a
 *  floor, so a 1 s popup poll cannot turn into a connection attempt per poll. */
const EAGER_RETRY_MS = 1500;

/** Minimum gap between requests while the agent IS responding. The idle poll runs
 *  at 2 Hz; there is no value in asking faster than the agent samples. */
const ONLINE_INTERVAL_MS = 500;

/** How long the last non-browser program stays offerable — see recentProgram(). */
const RECENT_MS = 5 * 60_000;

let program: ForegroundProgram | null = null;
let programAt = 0;
let lastTryAt = 0;
let online = false;
let note: string | null = null;
let inFlight: Promise<void> | null = null;
let recent: ForegroundProgram | null = null;
let recentAt = 0;

/** True when the agent answered recently. */
export function isAgentOnline(): boolean {
  return online && Date.now() - programAt <= OFFLINE_RETRY_MS;
}

/** What the agent last said is in front, or null if that is stale / unavailable. */
export function currentProgram(): ForegroundProgram | null {
  return Date.now() - programAt <= FRESH_MS ? program : null;
}

/** The most recent foreground program that was NOT a browser.
 *
 *  Every surface that OFFERS a program to the whitelist has to use this rather than
 *  currentProgram(), for a reason that is structural rather than cosmetic: the popup
 *  and the companion window are both parts of the browser, so at the instant you are
 *  looking at either of them the live reading is "a browser is in front" — the one
 *  answer that must never reach the whitelist (see BROWSER_IDS below). Offering the
 *  program you were in a moment ago is what the user actually means by "this app",
 *  and it survives the click that necessarily focuses the browser to make it. */
export function recentProgram(): ForegroundProgram | null {
  return Date.now() - recentAt <= RECENT_MS ? recent : null;
}

/** Whatever the agent said it cannot do (Wayland without the GNOME bridge). */
export function agentNote(): string | null {
  return note;
}

// ── Names ────────────────────────────────────────────────────────────────────
// The whitelist is keyed by the platform IDENTIFIER, because that is the only thing
// that can be matched exactly and the same way on every machine. But an identifier
// is not what anyone calls their software: Linux caps /proc/<pid>/comm at 15
// characters, Windows gives `winword`, macOS gives `com.apple.preview`. The agent
// reports the proper name alongside every reading, so we remember it and let every
// list show "Visual Studio Code" with `code` as the fine print.
const NAMES_KEY = 'focusProgramNames';

let names: Record<string, string> = {};
/** The ids whose names may be written to disk — the whitelist, nothing else. */
let persistable = new Set<string>();

// Names for programs you have NOT whitelisted stay in memory and die with the
// worker. A persisted list of every application that has ever been in front of you
// is a record of your day, and this extension has no use for one: the only names it
// needs to display are the ones already on a list you wrote yourself.
function persistNames(): void {
  const keep: Record<string, string> = {};
  for (const id of persistable) if (names[id]) keep[id] = names[id];
  try { chrome.storage.local.set({ [NAMES_KEY]: keep }); } catch { /* no storage here */ }
}

function learnName(p: ForegroundProgram): void {
  const id = normaliseProgram(p.id);
  if (!id || !p.name || names[id] === p.name) return;
  names[id] = p.name;
  if (persistable.has(id)) persistNames();
}

/** Tell the module which ids are on the whitelist. Called by `background.ts` on
 *  every settings change — it owns `Settings`, this module must not read it. */
export function setNamedPrograms(ids: string[]): void {
  persistable = new Set(ids.map(normaliseProgram));
  persistNames();
}

/** Learned id → name, for the UI. Includes names not yet whitelisted, so the panel
 *  can label the program it is offering you before you have accepted it. */
export function programNames(): Record<string, string> {
  return names;
}

// Reload what was saved. Merged UNDER anything already learned this session, since
// a live reading from the agent is never worse than a remembered one.
try {
  chrome.storage?.local?.get([NAMES_KEY], (r) => {
    const saved = (r?.[NAMES_KEY] ?? {}) as Record<string, string>;
    names = { ...saved, ...names };
  });
} catch { /* not in an extension context (the dev demo) */ }

/** Ask the agent, at most as often as the intervals above allow.
 *
 *  `eager` is for requests a human is waiting on (the popup and companion polling
 *  AGENT_STATUS): it shortens only the OFFLINE retry, which is the one that makes
 *  "I just started the agent" take up to fifteen seconds to show.
 *
 *  Returns the in-flight probe so a caller that wants THIS answer rather than the
 *  cached one can await it; the poll ignores the promise and reads the cache. */
export function refreshProgram(eager = false): Promise<void> {
  const now = Date.now();
  if (inFlight) return inFlight;
  const wait = online ? ONLINE_INTERVAL_MS : (eager ? EAGER_RETRY_MS : OFFLINE_RETRY_MS);
  if (now - lastTryAt < wait) return Promise.resolve();
  lastTryAt = now;

  // A hung agent must not wedge the poll — abandon the request well inside the
  // freshness window so a stalled reply can never be mistaken for a live one.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1500);

  inFlight = fetch(AGENT_URL, { signal: abort.signal, cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { program?: ForegroundProgram | null; note?: string | null } | null) => {
      if (!data) { online = false; return; }
      online = true;
      note = typeof data.note === 'string' ? data.note : null;
      const p = data.program;
      program = p && typeof p.id === 'string' && p.id ? { id: p.id, name: p.name || p.id } : null;
      programAt = Date.now();
      if (program && !isBrowserProgram(program.id)) {
        recent = program;
        recentAt = programAt;
        learnName(program);
      }
    })
    .catch(() => {
      // Not installed, not running, or refused. All the same thing to us.
      online = false;
      program = null;
    })
    .finally(() => {
      clearTimeout(timer);
      inFlight = null;
    });
  return inFlight;
}

/** Lower-case, trim, drop a Windows `.exe`, so `Code.exe` and `code` are one key.
 *  Applied to both sides of every comparison. */
export function normaliseProgram(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.exe$/, '');
}

// ── Browsers ─────────────────────────────────────────────────────────────────
// A browser in the foreground is NOT evidence either way, and must never be put on
// the program whitelist. The extension already knows whether that window is on
// Overleaf or on Instagram; the agent knows only "Chrome is in front", which on its
// own is meaningless. Treating a browser as work would count every distraction site
// as work; treating it as not-work would discount everything this extension exists
// to measure. So when a browser is in front the ACTIVE TAB decides, exactly as it
// did before the agent existed.
const BROWSER_IDS = new Set([
  // Linux / Windows process and executable names
  'chrome', 'google-chrome', 'google-chrome-s', 'chromium', 'chromium-browse',
  'brave', 'brave-browser', 'firefox', 'firefox-bin', 'firefox-esr', 'librewolf',
  'msedge', 'microsoft-edge', 'opera', 'opera_gx', 'vivaldi', 'vivaldi-bin',
  'iexplore', 'arc', 'thorium', 'zen',
  // macOS bundle identifiers
  'com.google.chrome', 'com.google.chrome.canary', 'com.brave.browser',
  'com.apple.safari', 'com.apple.safaritechnologypreview', 'org.mozilla.firefox',
  'org.mozilla.firefoxdeveloperedition', 'com.microsoft.edgemac', 'com.microsoft.edge',
  'com.operasoftware.opera', 'com.vivaldi.vivaldi', 'company.thebrowser.browser',
]);

export function isBrowserProgram(id: string): boolean {
  return BROWSER_IDS.has(normaliseProgram(id));
}

/** Exact match on the normalised identifier — never a substring. The list is meant
 *  to be tight and high-precision: a rule for `code` must not silently claim
 *  `vscodium` or `qrcode-studio`. */
export function isAllowedProgram(id: string, allowed: string[]): boolean {
  const key = normaliseProgram(id);
  return allowed.some((p) => normaliseProgram(p) === key);
}
