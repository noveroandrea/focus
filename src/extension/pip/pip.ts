// Focus companion — helper window.
//
// A small always-visible window that mirrors the sprite, for when Chrome is
// covered by another app. It's a plain extension window (chrome-extension://
// origin) drawing to a <canvas>.
//
// Almost nothing is drawn here: the character, the score, the countdown and the two
// whitelist bars all live in ../ui/companion.ts, because the sprite's in-page
// "panel" mode shows exactly the same thing and the two must not drift. What is
// left in this file is what only a WINDOW has — the layout, the state and settings
// subscriptions, the pin line, the title-bar icon (a window has one; a panel drawn
// into a page does not) and the Working / Not-working toggle, which is here because
// this window is what you can see while the browser holding the popup is covered up.
//
// Keeping it on top is never this code's job — no browser can raise its own window on
// Wayland — so something outside the browser does it, and WHICH something differs by
// platform. GNOME: the companion bridge, from inside the compositor. Windows: the
// desktop agent, via SetWindowPos(HWND_TOPMOST). Both find this window by its title,
// which makes pip.html's <title> load-bearing (COMPANION_TITLE in the bridge,
// PIN_TITLE in the agent). macOS and other Linux desktops stay manual — on macOS no
// process may raise another's window at all. See the README "Floating companion".
//
// It deliberately does NOT use picture-in-picture any more. On Wayland a browser
// cannot raise its own window above others (the compositor decides), so a PiP
// overlay dropped behind the next window anyway; the only browser-side workaround
// was to run the whole browser on the X11 backend (--ozone-platform=x11), and THAT
// breaks chrome.idle under Xwayland (its idle counter never advances), freezing the
// idle timeline this window exists to display. A normal window left on native
// Wayland keeps idle working and is pinned on top by the WM instead.

import { clampIdleTime, type AgentStatus } from '../../types';
import { GROW_DURATION_MS, IDLE_WARNING_MS, WORKING_FRESH_MS } from '../timings';
import {
  CHARS, CRYING, createCompanionCanvas, createWhitelistBars, OFF_GRACE_MS,
  type CompanionState,
} from '../ui/companion';

// ── DOM ────────────────────────────────────────────────────────────────────────
const root = document.getElementById('root')!;

// The canvas keeps its 2:1 aspect inside the stage whatever size the window is
// dragged to. The window is meant to be shrunk down to a corner of the screen, so
// the stage takes all remaining space and nothing else competes for height.
const stage = document.createElement('div');
Object.assign(stage.style, {
  position: 'relative',
  flex: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
  minHeight: '0', minWidth: '0', padding: '6px',
});

const companion = createCompanionCanvas({ idleWarningMs: IDLE_WARNING_MS, growDurationMs: GROW_DURATION_MS });
stage.appendChild(companion.canvas);

// One more companion, on the next screen that hasn't got one. On a two-monitor desk
// the browser is on one screen and the work is on the other, so a single companion
// is on the wrong one about half the time; the background places each new window
// bottom-right of the first display with none, which is one click per extra monitor
// and no dragging. Deliberately a ghost button in the corner of the drawing rather
// than a row of its own: the whole design of this window is that nothing competes
// with the character for space.
const moreBtn = document.createElement('button');
Object.assign(moreBtn.style, {
  position: 'absolute', top: '10px', right: '10px',
  cursor: 'pointer', border: 'none', borderRadius: '7px',
  background: 'rgba(148,163,184,0.16)', color: '#94a3b8',
  padding: '2px 6px', fontSize: '12px', lineHeight: '1.2',
  fontFamily: 'inherit', opacity: '0.65', transition: 'opacity 0.15s ease',
});
moreBtn.textContent = '⧉';
moreBtn.title = 'Open another companion — placed on the next screen that has none';
moreBtn.addEventListener('mouseenter', () => { moreBtn.style.opacity = '1'; });
moreBtn.addEventListener('mouseleave', () => { moreBtn.style.opacity = '0.65'; });
moreBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_COMPANION', extra: true }, () => {
    try { void chrome.runtime.lastError; } catch { /* ignore */ }
  });
});
stage.appendChild(moreBtn);

// The two facts every remaining piece of this file needs. Both arrive by broadcast
// (STATE_UPDATE / storage.onChanged) rather than being asked for, so nothing here
// polls for them.
let currentState: CompanionState | null = null;
let paused = false;   // Settings.forceActive — "Not working"

// ── Working / Not working ─────────────────────────────────────────────────────
// The same toggle as the popup's, because this window is the surface you are looking
// at while working outside the browser and the popup is three clicks away behind a
// browser you have covered up: pausing had to mean raising Chrome, finding the
// toolbar, opening the popup — with the companion sitting right there saying you are
// still being counted.
//
// It writes `Settings.forceActive` to storage exactly as the popup does, and does
// nothing else. Everything a toggle implies — snapping the session active, resetting
// the OS anchor, clearing the lapse bookkeeping, repainting the toolbar icon, the
// server check-in — belongs to the storage.onChanged listener in background.ts, and
// goes through it identically however the flag was flipped. Deliberately NOT the
// popup's whole behaviour, though: resuming there also opens a companion per screen,
// which from inside a companion would be a button that spawns duplicates of itself.
//
// A ghost button in the corner of the drawing, like ⧉, for the reason this window has
// no rows of controls: at the size it is meant to be used at, anything with a
// background of its own is taken out of the character.
const workBtn = document.createElement('button');
Object.assign(workBtn.style, {
  position: 'absolute', top: '10px', left: '10px',
  cursor: 'pointer', border: 'none', borderRadius: '999px',
  padding: '2px 8px', fontSize: '11px', lineHeight: '1.3', fontWeight: '700',
  fontFamily: 'inherit', opacity: '0.75', transition: 'opacity 0.15s ease',
  display: 'flex', alignItems: 'center', gap: '4px',
});
workBtn.addEventListener('mouseenter', () => { workBtn.style.opacity = '1'; });
workBtn.addEventListener('mouseleave', () => { workBtn.style.opacity = '0.75'; });
workBtn.addEventListener('click', () => {
  // Read before writing rather than spreading a copy this window has been holding
  // since it opened: a companion stays open for hours while the popup edits the
  // whitelist, the beep and the classifier underneath it, and a stale spread would
  // quietly undo all of it on the way past.
  chrome.storage.local.get(['focusFlowSettings'], (r) => {
    if (chrome.runtime.lastError) return;
    const cur = (r.focusFlowSettings ?? {}) as Record<string, unknown>;
    chrome.storage.local.set({
      focusFlowSettings: { ...cur, forceActive: !(cur.forceActive === true) },
    });
  });
});
stage.appendChild(workBtn);

function renderWorkBtn(): void {
  workBtn.textContent = paused ? '⏸ Not working' : '⚡ Working';
  workBtn.style.background = paused ? 'rgba(148,163,184,0.16)' : 'rgba(34,197,94,0.18)';
  workBtn.style.color = paused ? '#94a3b8' : '#4ade80';
  workBtn.title = paused
    ? 'Not working — nothing is being counted. Click to resume.'
    : 'Working — click to pause. Nothing is counted while paused, on any screen.';
}
renderWorkBtn();

// ── The title-bar icon ────────────────────────────────────────────────────────
// A companion window lives in a screen corner and spends most of its life partly
// covered, or minimised, or one entry in a window list — and what is left of it then
// is an icon and a title, nothing more. So the icon is made to answer the question
// the window exists to answer: it is the character disc in miniature, drawn from the
// same three inputs the canvas uses, so the taskbar and the window agree. Full colour
// while the session is counting; grey and crying when it has gone idle; greyscale
// over the top while "Not working", exactly as the drawing greys itself.
const favicon = document.createElement('link');
favicon.rel = 'icon';
document.head.appendChild(favicon);

const iconCanvas = document.createElement('canvas');
iconCanvas.width = 64;
iconCanvas.height = 64;
let faviconKey = '';

function paintFavicon(): void {
  const idle = !currentState?.isHeartbeatActive;
  const char = CHARS[(currentState?.currentIconId ?? 0) % CHARS.length] ?? CHARS[0];
  // Repainting is a canvas encode plus a <link> swap, and STATE_UPDATE arrives about
  // once a second while working — so the picture is redrawn only when one of the
  // three things it is made of actually changes.
  const key = `${idle}|${char.name}|${paused}`;
  if (key === faviconKey) return;
  faviconKey = key;

  const c = iconCanvas.getContext('2d');
  if (!c) return;
  c.clearRect(0, 0, 64, 64);
  c.filter = paused ? 'grayscale(1)' : 'none';
  c.beginPath();
  c.arc(32, 32, 30, 0, Math.PI * 2);
  c.fillStyle = idle ? '#94a3b8' : char.color;
  c.fill();
  // One fixed crying frame, not the canvas's 450 ms cycle: a favicon that animates is
  // a new data URL twice a second for a picture 16 px across.
  c.font = '38px "Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(idle ? CRYING[0] : char.icon, 32, 34);
  favicon.href = iconCanvas.toDataURL('image/png');
}
paintFavicon();

// ── The pin line ──────────────────────────────────────────────────────────────
// Keeping this window on top is THREE different answers, not one feature, and the
// line below says whichever one applies to the machine it is running on:
//
//   Windows  — the desktop agent does it (SetWindowPos), so this is a progress
//              message that gets out of the way, unless the agent is not running,
//              in which case starting it IS the fix and the line says so.
//   Linux    — the GNOME bridge does it, from inside the compositor. Same progress
//              message; if the agent reports it cannot see the foreground at all
//              (Wayland with no bridge) then the bridge is definitely absent, and
//              the line names the installer instead.
//   macOS    — nobody can. No public API lets a process raise another application's
//              window, so the only honest thing to print is what the user has to do
//              by hand. That one does not fade: it is an instruction, not a status.
//
// Anything that is a status disappears. At the sizes this window is meant to be used
// at, a permanent three-line paragraph squeezes the companion into nothing — which is
// why the old single "see the README" line faded, and why only the two lines that ask
// something of the user stay.
type Platform = 'windows' | 'macos' | 'linux' | 'other';

function detectPlatform(): Platform {
  const raw = String(
    (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform
    || navigator.userAgent,
  ).toLowerCase();
  if (raw.includes('win')) return 'windows';
  if (raw.includes('mac') || raw.includes('darwin')) return 'macos';
  if (raw.includes('linux') || raw.includes('x11') || raw.includes('cros')) return 'linux';
  return 'other';
}

const PLATFORM = detectPlatform();

/** How long the automatic pinners get before the progress line stops claiming to be
 *  working on it. The GNOME bridge pins on `window-created`/`notify::title`, so it is
 *  effectively instant; the Windows agent samples every fourth tick, ~2 s. Six covers
 *  both with room for a slow start, and nothing depends on the number being right —
 *  it only decides when a message stops being interesting. */
const PIN_WAIT_MS = 6000;

const footer = document.createElement('div');
Object.assign(footer.style, {
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
  padding: '7px 10px', textAlign: 'center', flexShrink: '0', cursor: 'pointer',
  borderTop: '1px solid rgba(148,163,184,0.18)',
  fontSize: '10px', color: '#94a3b8', lineHeight: '1.35',
  transition: 'opacity 0.6s ease',
});
const spinner = document.createElement('span');
Object.assign(spinner.style, {
  flexShrink: '0', width: '9px', height: '9px', borderRadius: '50%',
  border: '2px solid rgba(148,163,184,0.35)', borderTopColor: '#93c5fd',
  animation: 'ff-spin 0.8s linear infinite',
});
const footerText = document.createElement('span');
footer.append(spinner, footerText);

const spinStyle = document.createElement('style');
spinStyle.textContent = '@keyframes ff-spin { to { transform: rotate(360deg); } }';
document.head.appendChild(spinStyle);

/** Which line is showing. Only ever moves toward a more definite answer, so a late
 *  AGENT_STATUS cannot drag a resolved instruction back to "pinning…". */
type PinState = 'pinning' | 'settled' | 'manual';
let pinState: PinState = 'pinning';
let fadeTimer: ReturnType<typeof setTimeout> | null = null;

function setPin(text: string, title: string, o: { spin?: boolean; warn?: boolean; fade?: boolean }) {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  footer.style.display = 'flex';
  footer.style.opacity = '1';
  footer.style.color = o.warn ? '#fbbf24' : '#94a3b8';
  spinner.style.display = o.spin ? 'block' : 'none';
  footerText.textContent = text;
  footer.title = title;
  if (o.fade) {
    fadeTimer = setTimeout(() => {
      footer.style.opacity = '0';
      fadeTimer = setTimeout(() => { footer.style.display = 'none'; }, 700);
    }, 4000);
  }
}

// The two lines that ask something of you stay put, which in a window this small is
// a real cost once you have done the thing (or decided not to). One click retires it
// for this window — it comes back with the next companion you open.
footer.addEventListener('click', () => {
  if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
  footer.style.display = 'none';
  pinState = 'manual';   // dismissed — nothing may put another line here
});

/** The permanent instruction, for the platforms where pinning is the user's job. */
function pinManually(): void {
  pinState = 'manual';
  if (PLATFORM === 'macos') {
    setPin(
      'Pin me on top: macOS needs a helper — Rectangle → Always on Top',
      'No macOS API lets one program raise another program\'s window, so no app (including the Focus agent) can do this for you. '
      + 'Install Rectangle (free), enable "Always on Top" in its preferences and give it a shortcut, then focus this window and press it. '
      + 'Amethyst works too. See the README, "Floating companion".',
      { warn: true },
    );
  } else {
    setPin(
      'Pin me on top with your window manager — see the README',
      'Keep this window above other apps: KDE — right-click the title bar → More Actions → Keep Above Others. '
      + 'GNOME — gsettings set org.gnome.desktop.wm.keybindings toggle-above "[\'<Primary>backslash\']", then press Ctrl+\\ here.',
      { warn: true },
    );
  }
}

if (PLATFORM === 'windows' || PLATFORM === 'linux') {
  setPin('Pinning on top…', 'Something outside the browser has to do this — on Windows the Focus agent, on GNOME the companion bridge. Neither needs any setup here.', { spin: true });
  setTimeout(() => {
    if (pinState !== 'pinning') return;   // the agent already said something better
    pinState = 'settled';
    setPin(
      'Not on top? See the README — “Floating companion”',
      PLATFORM === 'windows'
        ? 'The Focus agent pins this window while it is running. Without it, use PowerToys “Always On Top” (Win+Ctrl+T).'
        : 'The GNOME companion bridge pins this window (desktop/gnome-extension/install.sh). On KDE, right-click the title bar → More Actions → Keep Above Others.',
      { fade: true },
    );
  }, PIN_WAIT_MS);
} else {
  pinManually();
}

let pinOffSince = 0;

/** Fold what the agent just said into the pin line — the only source of evidence this
 *  window has about whether anything is going to pin it. Both signals are definite
 *  ones, which is why they may overrule a "pinning…" already on screen: on Windows a
 *  stopped agent means nothing is pinning; on Linux an agent that cannot see the
 *  foreground is an agent with no GNOME bridge beside it, and the bridge is what does
 *  the pinning there. Silence proves nothing and changes nothing. */
function pinFromAgent(agent: AgentStatus | null): void {
  if (pinState === 'manual' || !agent) return;
  if (agent.running) pinOffSince = 0;
  else if (!pinOffSince) pinOffSince = Date.now();
  // The same grace the program bar takes, and for the same reason: a revived service
  // worker answers the first AGENT_STATUS from an empty cache, so "not running" is a
  // normal FIRST answer from a machine whose agent is fine.
  if (PLATFORM === 'windows' && !agent.running && Date.now() - pinOffSince >= OFF_GRACE_MS) {
    pinState = 'settled';
    setPin(
      'Start the Focus agent — it pins this window on top',
      'On Windows the agent raises this window for you (SetWindowPos). Double-click the Focus agent icon; no setup, no elevation.',
      { warn: true },
    );
    return;
  }
  if (PLATFORM === 'linux' && agent.running && agent.note) {
    pinState = 'settled';
    setPin(
      'Install the GNOME bridge to pin this on top',
      'desktop/gnome-extension/install.sh, then log out and back in. The agent reported it cannot see the foreground, '
      + 'which means the bridge is not there — and on Wayland the bridge is the only thing that can raise this window.',
      { warn: true },
    );
  }
}

// ── Layout ────────────────────────────────────────────────────────────────────
// Page bar first: this window is on top of the browser at least as often as it is
// beside another app, and the page is the thing you are looking at when it is.
const bars = createWhitelistBars({ workingFreshMs: WORKING_FRESH_MS }, pinFromAgent);
root.append(stage, ...bars.rows, footer);

// ── State / settings ─────────────────────────────────────────────────────────
function noteState(s: CompanionState): void {
  currentState = s;
  companion.setState(s);
  bars.noteState(s);   // a working↔idle switch must not wait for the poll
  paintFavicon();
}

chrome.runtime.onMessage.addListener((msg: { type?: string; state?: CompanionState }) => {
  if (msg?.type === 'STATE_UPDATE' && msg.state) noteState(msg.state);
});
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res?: CompanionState) => {
  try {
    if (chrome.runtime.lastError) return;
    if (res) noteState(res);
  } catch { /* ignore */ }
});

function readSettings(raw: unknown) {
  const s = raw as { forceActive?: boolean; idleTime?: number; idleGrow?: boolean } | undefined;
  paused = s?.forceActive === true;
  companion.setSettings({
    forceActive: paused,
    idleTimeS: clampIdleTime(Number(s?.idleTime)),
    idleGrow: s?.idleGrow !== false,
  });
  renderWorkBtn();
  paintFavicon();
}
chrome.storage.local.get(['focusFlowSettings'], (r) => readSettings(r.focusFlowSettings));
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.focusFlowSettings) readSettings(c.focusFlowSettings.newValue);
});

// Both bars are polled only while this window is visible, so an unhidden window has
// to ask straight away rather than wait out the rest of its interval.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') bars.refresh();
});

window.addEventListener('pagehide', () => { companion.stop(); bars.stop(); });
