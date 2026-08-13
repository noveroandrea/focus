// ─────────────────────────────────────────────────────────────────────────────
//  WHICH PROGRAM IS IN FRONT — the agent's only question
// ─────────────────────────────────────────────────────────────────────────────
//  This file answers one thing and judges nothing. There is no whitelist here, no
//  notion of work, no idle threshold, no scoring and no session: all of that lives
//  in the extension, which is the central node. The agent is a sensor.
//
//  Each platform ships a tiny script containing its own loop, spawned ONCE, that
//  prints one line per reading. Spawning a fresh process twice a second would cost
//  more CPU than everything else this program does put together.
//
//  Line format, identical on every platform so the parser is one function:
//
//      <identifier>|<display name>
//
//  ⚠ NO WINDOW TITLE IS EVER REPORTED. Titles leak document names, message contents
//  and page titles; application identity is all a whitelist ever needed, so no
//  reading contains one and none is stored. The single exception looks but never
//  tells: on Windows the helper below compares titles against the fixed string
//  "Focus companion" to find the extension's own companion window and keep it on
//  top — a lookup key, discarded immediately, never printed, never sent.
//
//  That pin is the only thing here that is not pure observation, and it exists
//  because Windows has no built-in always-on-top and no equivalent of the GNOME
//  bridge. On Wayland the compositor does it (gnome-extension/); on macOS nothing
//  can, so it stays manual there.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

export interface Foreground {
  id: string;
  name: string;
}

/** A reading older than this is discarded. Without it, a helper that silently
 *  stopped producing lines would pin the extension to whatever it last saw — which,
 *  if that was your editor, would keep counting an application you closed an hour
 *  ago as work. */
const STALE_MS = 5000;

const RESTART_MIN_MS = 1000;
const RESTART_MAX_MS = 30_000;

/** The companion window's title — pip.html's <title>, and COMPANION_TITLE in the
 *  GNOME bridge. Three copies of one string; changing it means changing all three.
 *  Used ONLY to find that window on Windows, where nothing else can pin it. */
const PIN_TITLE = 'Focus companion';

/** …and only while it is small. Same numbers, same reasons, as the GNOME bridge. */
const PIN_MAX_W = 900;
const PIN_MAX_H = 700;

/** How opaque the companion window is left on Windows, 0–255 — the same unit and the
 *  same meaning as the GNOME bridge's `companion-opacity`, so one number describes the
 *  window on either platform.
 *
 *  Windows can do this for the same reason it can pin: one process may change another's
 *  window here, needing no elevation and no injection. `SetLayeredWindowAttributes`
 *  sits beside the `SetWindowPos` that was already there, and buys the same uniform
 *  translucency — the whole window fades, character and score included.
 *
 *  It is an ENVIRONMENT VARIABLE and not a settings file, because the agent has no
 *  settings file and should not grow one: it has no account, no window and no tray,
 *  and every configuration decision in this project belongs to the extension or, on
 *  GNOME, to the piece with a preferences dialog. Read once at start-up, so changing
 *  it means restarting the agent — but not reinstalling anything, and not reopening
 *  the companion, since the value is re-applied on every pin pass.
 *
 *  255 disables it: the window is left exactly as the browser painted it, and the
 *  layered style is never set. */
const COMPANION_OPACITY = (() => {
  const raw = Number.parseInt(process.env.FOCUS_COMPANION_OPACITY ?? '', 10);
  return Number.isFinite(raw) ? Math.min(255, Math.max(40, raw)) : 180;
})();

let child: ChildProcessByStdio<null, Readable, Readable> | null = null;
let buffer = '';
let last: Foreground | null = null;
let lastAt = 0;
let restartMs = RESTART_MIN_MS;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let limitation: string | null = null;

/** The current foreground program, or null if unknown or stale. */
export function foreground(): Foreground | null {
  return last && Date.now() - lastAt <= STALE_MS ? last : null;
}

/** What this machine cannot do, in a sentence fit to show a user. Null when fine. */
export function note(): string | null {
  return limitation;
}

// ── The per-platform helpers ──────────────────────────────────────────────────

/** Windows: GetForegroundWindow + GetWindowThreadProcessId. No permission prompt,
 *  no elevation. The label is the executable's FileDescription — the string Task
 *  Manager shows — which comes from the binary's version resource, not a window.
 *
 *  It also pins AND fades the companion window (see PIN_TITLE), which is Windows'
 *  equivalent of what the GNOME bridge does from inside the compositor: Windows has no
 *  built-in always-on-top, so without this the only route is a third-party tool like
 *  PowerToys, and a browser cannot make its own window see-through on any platform.
 *  SetWindowPos(HWND_TOPMOST) and SetLayeredWindowAttributes need no elevation and no
 *  injection — one process may change another's window here, unlike Wayland or macOS.
 *
 *  `$procId`, NOT `$pid`: `$pid` is a read-only automatic variable in PowerShell. */
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace FocusNative -Name Win -MemberDefinition @'
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
'@

# The pin. A separate type because EnumWindows takes a callback delegate, which
# -MemberDefinition cannot express.
#
# The title is compared against one fixed string and is neither printed nor kept:
# it is a lookup key here, never a reading. The size ceiling is the same guard the
# GNOME bridge applies: a page that happens to carry that title must not drag a
# whole browser window on top, and an always-on-top window big enough to cover the
# work is the failure that got an earlier overlay deleted.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FocusPin {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte alpha, uint flags);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOPMOST = 0x00000008;
  const int WS_EX_LAYERED = 0x00080000;
  const uint LWA_ALPHA = 0x00000002;
  const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010;
  public static void Pin(string title, int maxW, int maxH, int alpha) {
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(160);
      GetWindowTextW(h, sb, sb.Capacity);
      if (!sb.ToString().StartsWith(title, StringComparison.Ordinal)) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      if (r.Right - r.Left > maxW || r.Bottom - r.Top > maxH) return true;

      // Translucency: what the GNOME bridge does with the window actor, done here
      // with the layered-window style. Applied on EVERY pass rather than once, so
      // restarting the agent with a different value updates companions that are
      // already open — the size guard above is what keeps that safe.
      if (alpha < 255) {
        int ex = GetWindowLong(h, GWL_EXSTYLE);
        if ((ex & WS_EX_LAYERED) == 0) SetWindowLong(h, GWL_EXSTYLE, ex | WS_EX_LAYERED);
        SetLayeredWindowAttributes(h, 0, (byte)alpha, LWA_ALPHA);
      }

      // The pin, unlike the fade, is one-shot: a window the user un-pinned by hand
      // must not be fought over twice a second.
      if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) == 0)
        SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      return true;
    }, IntPtr.Zero);
  }
}
'@

$tick = 0
while ($true) {
  $procId = 0
  $hwnd = [FocusNative.Win]::GetForegroundWindow()
  if ($hwnd -ne [IntPtr]::Zero) {
    [void][FocusNative.Win]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    if ($procId -ne 0) {
      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($proc) {
        $label = $proc.Description
        if (-not $label) { $label = $proc.ProcessName }
        [Console]::Out.WriteLine("$($proc.ProcessName)|$label")
        [Console]::Out.Flush()
      }
    }
  }
  # Every fourth pass: enumerating every top-level window is far dearer than one
  # foreground read, and a companion window that appears is not urgent to the second.
  $tick++
  if ($tick % 4 -eq 0) { [FocusPin]::Pin('${PIN_TITLE}', ${PIN_MAX_W}, ${PIN_MAX_H}, ${COMPANION_OPACITY}) }
  Start-Sleep -Milliseconds 500
}
`;

/** macOS: `lsappinfo` needs NO permission prompt at all. Window titles are what
 *  would require Accessibility, which is exactly why none are read — the TCC
 *  dialog never appears. (`osascript` against System Events would trigger an
 *  Automation prompt for information already available here.) */
const MACOS_SCRIPT = `
while :; do
  asn=$(lsappinfo front 2>/dev/null)
  if [ -n "$asn" ]; then
    lsappinfo info -only bundleid,name "$asn" 2>/dev/null | tr '\\n' ' '
    echo
  fi
  sleep 0.5
done
`;

/** Linux/X11: the active window is a root property, its process another property
 *  on that window, its name /proc. Three reads, no permissions, no native module. */
const X11_SCRIPT = `
while :; do
  wid=$(xprop -root -notype _NET_ACTIVE_WINDOW 2>/dev/null | awk '{print $NF}')
  case "$wid" in
    0x*)
      wpid=$(xprop -id "$wid" -notype _NET_WM_PID 2>/dev/null | awk '{print $NF}')
      case "$wpid" in
        ''|*[!0-9]*) ;;
        *)
          comm=$(cat /proc/$wpid/comm 2>/dev/null)
          exe=$(basename "$(readlink /proc/$wpid/exe 2>/dev/null)" 2>/dev/null)
          label=$exe
          [ -z "$label" ] && label=$comm
          [ -n "$comm" ] && printf '%s|%s\\n' "$comm" "$label"
          ;;
      esac
      ;;
  esac
  sleep 0.5
done
`;

/** GNOME/Wayland: a Wayland client may not see other applications' windows — a
 *  security property of the protocol, not a gap. The only way through is to ask
 *  something already inside the compositor, hence the bundled Shell extension
 *  (gnome-extension/), which is needed because org.gnome.Shell.Eval has been
 *  locked down since GNOME 41. It emits the same line this parser already reads.
 *
 *  One `gdbus call` to seed, then a single long-lived `gdbus monitor`. */
const GNOME_SCRIPT = `
gdbus call --session --dest org.gnome.Shell --object-path /dev/focus/Companion --method dev.focus.Companion.GetFocused 2>/dev/null
exec gdbus monitor --session --dest org.gnome.Shell --object-path /dev/focus/Companion
`;

function has(command: string): boolean {
  try {
    return spawnSync('/bin/sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function isWayland(): boolean {
  if ((process.env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland') return true;
  return !!process.env.WAYLAND_DISPLAY && !process.env.DISPLAY;
}

function isGnome(): boolean {
  return (process.env.XDG_CURRENT_DESKTOP ?? '').toUpperCase().includes('GNOME');
}

/** True once the GNOME bridge answers, i.e. the Shell extension is installed,
 *  enabled and loaded. */
function gnomeBridgeUp(): boolean {
  try {
    return spawnSync('gdbus', [
      'call', '--session', '--dest', 'org.gnome.Shell',
      '--object-path', '/dev/focus/Companion',
      '--method', 'dev.focus.Companion.GetFocused',
    ], { stdio: 'ignore', timeout: 2000 }).status === 0;
  } catch {
    return false;
  }
}

interface Helper {
  command: string;
  args: string[];
  /** macOS folds two keys onto one line; everything else is already `id|name`. */
  mac?: boolean;
}

/** Pick the helper for this machine, or set `limitation` and return null. */
function chooseHelper(): Helper | null {
  if (process.platform === 'win32') {
    const script = join(tmpdir(), 'focus-foreground.ps1');
    try {
      // The BOM is not decoration: Windows PowerShell 5.1 reads a .ps1 without one
      // as the system ANSI codepage, so any non-ASCII byte in the file comes back
      // mangled. The script is deliberately plain ASCII too — belt and braces,
      // because a mangled character inside the C# type definition would be a
      // compile error at start-up on somebody else's machine and nowhere else.
      writeFileSync(script, `\uFEFF${WINDOWS_SCRIPT}`, 'utf8');
    } catch (err) {
      limitation = `Could not write the watcher script: ${String(err).slice(0, 100)}`;
      return null;
    }
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    };
  }

  if (process.platform === 'darwin') {
    return { command: '/bin/sh', args: ['-c', MACOS_SCRIPT], mac: true };
  }

  // Linux and the other unixes.
  if (isWayland()) {
    if (!isGnome()) {
      limitation = 'This is a Wayland session on '
        + `${process.env.XDG_CURRENT_DESKTOP ?? 'this compositor'}, where no application may see `
        + 'which other has focus. Only GNOME has a bridge here; on KDE this needs a KWin '
        + 'script, on Sway or Hyprland `swaymsg -t get_tree` / `hyprctl activewindow`. '
        + 'An X11 (Xorg) session works today with nothing installed.';
      return null;
    }
    if (!has('gdbus')) {
      limitation = 'gdbus was not found — install glib2 / libglib2.0-bin.';
      return null;
    }
    if (!gnomeBridgeUp()) {
      limitation = 'This is a Wayland session, so the foreground program can only be read '
        + 'through the bundled GNOME bridge. Run desktop/gnome-extension/install.sh, then '
        + 'LOG OUT AND BACK IN — GNOME Shell cannot load extensions on Wayland without it. '
        + 'Or log in with an X11 session, which needs nothing installed.';
      return null;
    }
    return { command: '/bin/sh', args: ['-c', GNOME_SCRIPT] };
  }

  if (!has('xprop')) {
    limitation = 'xprop was not found, so the active window cannot be read. Install it '
      + '(Debian/Ubuntu: x11-utils, Fedora: xorg-x11-utils, Arch: xorg-xprop).';
    return null;
  }
  return { command: '/bin/sh', args: ['-c', X11_SCRIPT] };
}

// lsappinfo has spelled these keys differently across macOS releases —
// `"CFBundleIdentifier"="com.apple.Safari"` on some, `bundleID="…"` on others.
// Both contain "bundleid" case-insensitively, so one tolerant pattern covers every
// version rather than pinning the parser to whichever macOS the developer had.
const MAC_BUNDLE_RE = /bundleid(?:entifier)?"?\s*=\s*"([^"]+)"/i;
const MAC_NAME_RE = /(?:lsdisplayname|displayname|"name")"?\s*=\s*"([^"]+)"/i;
// gdbus renders the payload as a quoted string inside a tuple, for both `call` and
// `monitor`, so one pattern reads either.
const GDBUS_RE = /'((?:[^'\\]|\\.)*)'/;

function parse(line: string, helper: Helper): Foreground | null {
  if (helper.mac) {
    const bundle = MAC_BUNDLE_RE.exec(line)?.[1]?.trim();
    if (!bundle) return null;
    return { id: bundle, name: MAC_NAME_RE.exec(line)?.[1]?.trim() || bundle };
  }
  // The GNOME bridge wraps its payload; unwrap it, then fall through to the
  // shared `id|name` split. It appends idle milliseconds, which the agent does not
  // use — chrome.idle already tells the extension that, and one source for one
  // fact is the whole point.
  const unwrapped = line.startsWith('(') || line.includes('dev.focus.Companion')
    ? GDBUS_RE.exec(line)?.[1] ?? ''
    : line;
  const parts = unwrapped.split('|');
  const id = parts[0]?.trim();
  if (!id) return null;
  return { id, name: parts[1]?.trim() || id };
}

// ── The long-lived child ──────────────────────────────────────────────────────
function onData(chunk: string, helper: Helper) {
  buffer += chunk;
  // A reading is one short line; anything larger is malfunction, not data.
  if (buffer.length > 64_000) buffer = buffer.slice(-4000);
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parse(trimmed, helper);
    if (!parsed) continue;
    last = parsed;
    lastAt = Date.now();
    restartMs = RESTART_MIN_MS; // a line arrived, so the child is healthy
  }
}

function spawnChild(helper: Helper) {
  if (stopped) return;
  let proc: ChildProcessByStdio<null, Readable, Readable>;
  try {
    proc = spawn(helper.command, helper.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    console.warn('Focus agent: could not start the watcher:', String(err).slice(0, 120));
    scheduleRestart(helper);
    return;
  }
  child = proc;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (c: string) => onData(c, helper));
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c: string) => {
    const text = c.trim();
    if (text) console.warn('Focus agent: watcher:', text.slice(0, 200));
  });
  proc.on('exit', () => { child = null; scheduleRestart(helper); });
  proc.on('error', () => { child = null; scheduleRestart(helper); });
}

/** Restart with a backoff. The common cause is transient — a display server
 *  restarting, a screen lock — so it starts short, and caps so a genuinely broken
 *  environment is not respawned in a tight loop. */
function scheduleRestart(helper: Helper) {
  if (stopped || restartTimer) return;
  const delay = restartMs;
  restartMs = Math.min(RESTART_MAX_MS, restartMs * 2);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    spawnChild(helper);
  }, delay);
}

export function start(): void {
  stopped = false;
  const helper = chooseHelper();
  if (!helper) {
    console.warn('Focus agent:', limitation);
    return; // still serves requests, reporting the limitation
  }
  spawnChild(helper);
}

export function stop(): void {
  stopped = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  child?.kill();
  child = null;
}
