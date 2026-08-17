# Focus agent

A tiny background program that tells the Focus browser extension **which program is in
the foreground**. That is all it does — plus, on Windows only, keeping the extension's
companion window on top, because nothing else there can.

The extension can only see inside the browser. Everything else — a thesis in a local LaTeX
editor, a paper in a desktop PDF reader, a compile in a terminal — reaches it only as a
`chrome.idle` reading, which says *input happened somewhere* and nothing more. That is why
`osHeld` and the violet countdown exist. The agent attaches a name to "somewhere", so the
extension can tell working in Overleaf apart from playing a game.

**The extension is the central node.** It owns the program whitelist, the heartbeats, the
score, the sprite, the floating companion and the sync. The agent has no account, no
session, no settings file, no window and no tray. If it stops, the extension carries on
exactly as it did before the agent existed.

## Install it in one step (what most people should do)

Open the extension popup while signed out. Step 1 offers **one file per platform** —
pick Linux, Windows or macOS, press download, and run it once:

```bash
sh ~/Downloads/focus-agent-linux.sh          # Linux and macOS
```

```powershell
powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\Downloads\focus-agent-windows.ps1"
```

That file **is** the agent. It carries the compiled JavaScript, the TypeScript source,
the launcher, the icon installer, the GPL licence and the GNOME Shell bridge, embedded as
base64 — so it downloads nothing, and needs no git, no npm and no TypeScript. It checks
for **Node.js** (the one thing it cannot bring, because a language runtime is a decision
about the machine), unpacks into `~/.local/share/focus-agent`
(`~/Library/Application Support/focus-agent` · `%LOCALAPPDATA%\focus-agent`), installs the
clickable icon, sets up the GNOME bridge if the session is GNOME, and starts it.

| Flag | |
|---|---|
| `--autostart` / `-Autostart` | also start it at every login |
| `--no-bridge` | skip the GNOME Shell bridge |
| `--no-start` | install but do not launch |
| `--uninstall` / `-Uninstall` | stop it and remove everything it wrote |

The two files are **generated** by `scripts/build-agent-installer.mjs` during the
extension's `npm run build`, from [`install/template.sh`](install/template.sh) and
[`install/template.ps1`](install/template.ps1) — edit the templates, never the output.
They land in `dist/agent/` and the popup serves them out of its own bundle, which is why
the flow needs no public repository, no release process and no network.

## Or run it from a clone

```bash
cd desktop
npm install     # three packages, all TypeScript tooling — no runtime dependencies
npm start       # builds, then serves on http://127.0.0.1:47317
```

Then open the extension popup: under **Allowed pages** there is now **Allowed programs**,
with a green *agent on* dot and the program you are using right now, with one button to
add it. Nothing counts as work until it is on that list.

## Start it by clicking an icon

Install a **Focus agent** icon once, then start the agent the way you start anything else:

```bash
./install-icon.sh              # Linux: applications menu + desktop icon
                               # macOS: ~/Applications/Focus agent.app
./install-icon.sh --autostart  # …and start it at login as well
./install-icon.sh --uninstall  # remove the icon again
```

```powershell
powershell -ExecutionPolicy Bypass -File install-icon.ps1    # Desktop + Start menu
```

Nothing appears when you click it — the agent has no window. It says so with a desktop
notification, and the popup's dot turns green. Clicking again while it runs does nothing
(one copy is enough), and on Linux **right-click → Stop the agent** stops it. Everything
the icon does is in [`launch.sh`](launch.sh), which also works from a terminal:

```bash
./launch.sh          # start (or say it is already running)
./launch.sh status   # is it answering?
./launch.sh stop     # stop it
```

`stop` asks the agent for its own pid over the socket rather than matching a command
line, because `npm start`, the icon and a hand-typed `node dist/index.js` all look
different to `pkill` — and a pattern loose enough to catch all three eventually catches
something else.

> **The browser extension cannot start the agent**, by design: no extension API can run
> a local program. Only native messaging can, and its host manifest must name an exact
> extension ID — the installer step this whole transport exists to avoid. Hence the icon.

## What it exposes

`GET http://127.0.0.1:47317/`

```json
{ "program": { "id": "code", "name": "Visual Studio Code" }, "note": null, "ts": 1785644600001 }
```

`id` is the platform's own notion of application identity — executable name on Windows,
bundle identifier on macOS, process name on Linux. `note` carries anything the agent
cannot do on this machine, so the failure names its own fix.

**No web page can read this.** The socket binds to `127.0.0.1` only; **no CORS headers are
sent**, so a page's `fetch` is blocked from reading the response by the browser itself
while the extension — which holds an explicit host permission — is exempt; and requests
carrying a web `Origin` are refused with `403`. Verified both ways.

**No window title is ever reported.** Titles leak document names, message contents and
page titles; application identity is all a whitelist ever needed, so no reading contains
one. The single exception looks but never tells: on Windows the helper compares titles
against the fixed string `Focus companion` to find the extension's own companion window
and keep it on top (see [Always on top](#always-on-top)) — a lookup key, discarded at
once, never printed and never sent. Nothing is stored on disk either: the agent keeps one
reading in memory and forgets it when it exits. The extension remembers the `name` so its
list can read *Visual Studio Code* instead of `code`, but saves only the names of programs
already on that list.

## How the extension uses it

Added to the existing `chrome.idle` poll, twice a second:

| `chrome.idle` | Foreground program | Result |
|---|---|---|
| idle | anything | **idle** — you are away from the machine |
| active | on the program whitelist | **working** — counts, even with no tab involved |
| active | a **browser** | the **active tab** decides, exactly as before |
| active | anything else | **idle** — busy, but not at work |
| active | agent not running | the **active tab** decides, exactly as before |

Browsers are excluded on purpose and cannot be whitelisted: the agent only knows "Chrome
is in front", which says nothing about whether that window is on Overleaf or on Instagram.
The extension already knows, and the page whitelist is where that judgement belongs.

## Platforms

- **Windows** — nothing to install. `GetForegroundWindow` + `GetWindowThreadProcessId` via
  one long-lived PowerShell helper, no permission prompt. Identifier: executable name
  (`winword`, `code`); the `.exe` is optional when typing a rule. The same helper pins the
  companion window — see [Always on top](#always-on-top).
- **macOS** — nothing to install, and **no permission prompt of any kind**: `lsappinfo`
  needs no entitlement. Window *titles* are what would require Accessibility, which is
  exactly why none are read. Identifier: bundle id (`com.microsoft.vscode`).
- **Linux / X11** — nothing to install beyond `xprop` (`x11-utils` on Debian/Ubuntu,
  `xorg-x11-utils` on Fedora, `xorg-xprop` on Arch). Identifier: process name from
  `/proc/<pid>/comm`, which the kernel caps at 15 characters — which is why
  `gnome-terminal-server` appears as `gnome-terminal-`.
- **Linux / Wayland** — see below.

Each platform spawns **one long-lived helper** printing a line per reading, never a process
per sample, and every one of them emits the same `id|name` line so there is a single parser.

## Always on top

The extension's [floating companion](../README.md#floating-companion) is meant to sit above
your other windows, and a browser cannot put it there itself. Who can differs completely by
platform, which is why this is not one feature but three answers:

| | Who pins it | What you do |
|---|---|---|
| **Windows** | this agent | nothing — run the agent |
| **Linux / GNOME** | the [Shell bridge](#wayland), from inside the compositor | nothing — install the bridge |
| **Linux / KDE, Sway, …** | you | your WM's "keep above" |
| **macOS** | you, via a helper app | see below |

On **Windows** the helper calls `SetWindowPos(HWND_TOPMOST)` every two seconds on any
visible window whose title starts with `Focus companion` and which is smaller than
900×700 — the same size guard the GNOME bridge uses, so a page that happens to carry that
title cannot drag a whole browser window on top. A window already marked topmost is left
alone, so unpinning it by hand sticks. No elevation, no injection, no extra process: on
Windows one program may raise another's window, unlike Wayland or macOS.

On **macOS** no process may change another application's window level — there is no public
API, with or without permissions, which is why utilities that do this are all
window-manager helpers you install and grant Accessibility to. So the agent does not try.
Use one of:

- [Rectangle](https://rectangleapp.com/) (free) — enable *Always on Top* and give it a
  shortcut, then focus the companion window and press it.
- [Amethyst](https://ianyh.com/amethyst/) (free) — a tiling manager with a float-on-top layer.
- *Afloat* or *Ontop* (paid) — single-purpose always-on-top utilities.

Each needs Accessibility permission (System Settings → Privacy & Security → Accessibility)
because it manipulates other applications' windows. That is exactly the permission this
agent is designed never to ask for.

## See-through

The companion can also be made translucent, so you can tell what is underneath it. This is
the same wall as pinning and has the same three answers, for the same reason: a browser
cannot make its own window see-through either. `chrome.windows.create` opens a real
toplevel that the browser paints onto an opaque surface, so no CSS in the window can reach
past it — the one API that could went away with Chrome Apps.

| | Who fades it | How you set it |
|---|---|---|
| **Windows** | this agent | `FOCUS_COMPANION_OPACITY=180`, then restart the agent |
| **Linux / GNOME** | the Shell bridge | `gnome-extensions prefs focus-companion@focus.dev` — live |
| **macOS** | nobody | — |

Both use the same **100–255** scale, where 255 is fully solid and the default is **180** (≈70%).
On GNOME the slider applies as you drag it, with the companion open. On Windows the value
is read from the environment at start-up, but it is re-applied on every pin pass, so
restarting the agent updates a companion that is already open — you do not have to reopen
the window.

**What you get is uniform translucency, not a transparent background behind opaque
content.** Both platforms fade the whole window, so the character and the score dim by as
much as the panel under them. That is unavoidable from outside the window: only the page
could separate the two, and this is not a page. It is also **not** click-through — the
companion still takes the clicks that land on it.

Don't go too low. The companion exists to be caught out of the corner of your eye, and the
idle tremble and countdown depend on it staying legible; faded far enough to comfortably
read what is behind it, it stops registering at all. That is why the scale floors at **100**
rather than 0 on both platforms: the limit is legibility, not invisibility. (A window at 0
would be worse still — invisible but still taking clicks, which reads as a broken desktop
rather than a setting you chose, and the way back is a dialog you can no longer see a reason
to open.)

## Wayland

A Wayland client **cannot** see which other application has focus. That is a security
property of the protocol, not a gap — under Xwayland, `xprop -root _NET_ACTIVE_WINDOW`
answers `0x0` forever. The only way through is to ask something already **inside** the
compositor.

**GNOME's bridge is bundled**, because GNOME/Wayland is the default on Ubuntu, Fedora and
Debian. It is a Shell extension exporting one D-Bus object, needed because
`org.gnome.Shell.Eval` has been locked down since GNOME 41 and there is no other general
hook.

It has a **second job the agent could never do**: keeping the extension's floating
companion windows above other windows, and putting each one in a screen's corner. A
Wayland client can neither raise nor position its own window — there is no protocol
request for either — while code inside the compositor calls `make_above()` and
`move_frame()` in one line each.

It finds the window by the exact title `Focus companion` and pins it only while it is
smaller than 900×700 — so a page that happens to carry that title cannot drag a whole
browser window on top, and a companion stretched across the screen never becomes an
overlay you cannot work under. This is the only window title anything here reads, and it
is compared against a constant rather than reported anywhere.

Placement sends each companion to the **first monitor that has not got one**, bottom-right
of that monitor's *work area* — the compositor's own figure, so panels and docks are
cleared exactly rather than guessed at. It happens **once per window**, on the frame the
window is recognised: re-placing it later would drag a companion you had deliberately
moved back into the corner. Closing one frees its screen for the next.

Windows, macOS and Linux/X11 need none of this — the browser positions its own windows
there, and the extension already asks it to.

```bash
desktop/gnome-extension/install.sh   # copies in, and marks it enabled for next login
#  → log out and back in             ← the only remaining step
```

**Do not run `gnome-extensions enable` first.** It answers *"Extension does not exist"*
however many times you try, because the running Shell has never scanned the extension — it
looks in that directory only at start-up. Nor is there a way around the logout:
`ReloadExtension` answers *"deprecated and does not work"*, `EnableExtension` returns
`false` for an unscanned extension, and `org.gnome.Shell.Introspect` is `AccessDenied`
outside a fixed allowlist. GNOME Shell restarts in place on X11 (`Alt+F2`, `r`) but not on
Wayland, where it *is* the compositor. The installer writes the `enabled-extensions`
setting itself, which is what that command would have done.

Check it afterwards:

```bash
gdbus call --session --dest org.gnome.Shell \
  --object-path /dev/focus/Companion --method dev.focus.Companion.GetFocused
# ('code|Visual Studio Code|1240',)
```

The bridge emits the same line the X11 helper prints, so a program whitelist written under
Xorg keeps working after logging into Wayland. It also reports Mutter's idle time — free to
include, and the only correct idle source on Wayland — but the agent ignores it, because
the extension already gets idle from `chrome.idle` and one source per fact is the point.

**Other compositors** are the same shape and not implemented: KDE would need a KWin script
exporting an equivalent D-Bus object; Sway and Hyprland already expose the information
(`swaymsg -t get_tree`, `hyprctl activewindow`, or `wlr-foreign-toplevel-management-v1`).
On those the agent says which component would be needed and reports no program, and the
extension falls back to browser-only tracking.

**Or skip all of it:** log out and pick **"Ubuntu on Xorg"** at the login screen.

## Troubleshooting

```bash
curl http://127.0.0.1:47317/          # what the agent is reporting right now
```

- `program: null` with a `note` — the note says what is missing; on Wayland that is
  almost always the GNOME bridge or the logout after installing it.
- `agent off` in the popup — the agent is not running, or the extension was loaded before
  `http://127.0.0.1:47317/*` was added to `host_permissions` (reload the extension).
- `EADDRINUSE` — a second copy is already running; only one is needed.
