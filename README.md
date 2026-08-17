# Focus

A Chrome / Chromium browser extension that helps **anyone who struggles to stay focused**
— whether from ADHD or ordinary distraction — keep on task while **studying or working**.
It injects a small animated sprite companion into the pages you work on. The sprite
**bounces and works while you are active**
and **cries when you go idle**, turning sustained focus into a tiny, rewarding game:

> The active character starts at full size. Every focus *heartbeat* (≈ one per active
> second) it **shrinks** a little. When it reaches its minimum size — after the number of
> heartbeats you choose — it **bursts into fireworks**, a **new character** takes over at
> full size, and the heartbeat counter resets to `0`.

There is **no account, no cloud, and no tracking**. All state lives in `chrome.storage.local`
on your machine. An **optional** local AI helper (Ollama) can auto-detect study pages, but
**the extension works perfectly without it** (see [Working without Ollama](#working-without-ollama)).

---

## Table of contents

- [Minimum requirements](#minimum-requirements)
- [Install](#install)
- [How it works](#how-it-works)
- [The sprite](#the-sprite)
- [The popup menu](#the-popup-menu)
- [Floating companion](#floating-companion)
- [Phone nudge](#phone-nudge)
- [Desktop agent (Windows, macOS, Linux)](#desktop-agent-windows-macos-linux)
  - [Run it](#run-it)
  - [How the extension uses it](#how-the-extension-uses-it)
  - [What the agent does not do](#what-the-agent-does-not-do)
  - [Platforms](#platforms)
  - [Wayland](#wayland)
- [Optional: Ollama AI auto-classify](#optional-ollama-ai-auto-classify)
  - [Working without Ollama](#working-without-ollama)
  - [Limiting Ollama CPU usage](#limiting-ollama-cpu-usage)
- [Code structure](#code-structure)
- [Local development](#local-development)
  - [Something behaving strangely? Read the bug log first](#something-behaving-strangely-read-the-bug-log-first)
- [Publishing to the Chrome Web Store](#publishing-to-the-chrome-web-store)
- [Privacy](#privacy)
- [License](#license)

---

## Minimum requirements

**To run the extension**

| Requirement | Minimum |
|---|---|
| Browser | Chrome / Chromium / Edge / Brave with **Manifest V3** support (Chrome **110+** recommended) |
| OS | Any desktop OS the browser runs on (Windows, macOS, Linux) |
| RAM / CPU | Negligible — the extension is a few small scripts |

**To build it from source**

| Requirement | Minimum |
|---|---|
| Node.js | **18+** (20+ recommended) |
| npm | 9+ |

**To use the optional AI auto-classify (Ollama)** — see [that section](#optional-ollama-ai-auto-classify)

| Requirement | Minimum |
|---|---|
| [Ollama](https://ollama.com) | Any recent version |
| A tiny instruct model | e.g. `qwen3:0.6b` (~0.5 GB) wrapped as `qwen-yesno` |
| Free RAM | ~1–2 GB while the model is loaded |
| CPU | Any; load is **capped from the popup** so it never freezes the machine |

---

## Install

### 1. Build

```bash
npm install
npm run build      # compiles everything into dist/
```

### 2. Load into the browser

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select the `dist/` folder

After any code change, run `npm run build` again and press the **↺ reload** icon on the
extension card.

### 3. First run

Signed out, the popup is nothing but the three steps to set up, in order — the sign-in
button used to be the only thing on it, which left the other two discoverable only by
reading this file:

1. **Install the [desktop agent](#desktop-agent-windows-macos-linux)** — optional but
   recommended, and the one step that happens outside the browser. Pick **Linux /
   Windows / macOS** and press download: the extension hands you **one file that
   contains the whole agent** (compiled, plus its source and the licence), and running
   it once installs and starts everything. Picking macOS also prints the two features
   that platform cannot have. The extension cannot run it for you — no extension API
   may start a local program — so this is a file plus one line to paste, and the line
   is on screen with a copy button.
2. **Sign in with Google** — required, and what gates the rest of the popup.
3. **Pair your phone** — afterwards, in **Settings → Phone nudge**: turn it on and scan
   the QR. See [Phone nudge](#phone-nudge).

---

## How it works

The extension uses a **message-passing architecture**. The background service worker is the
**single source of truth**; everything else just reports activity to it or renders the state
it broadcasts.

```
        mouse / keyboard / scroll / wheel
                       │
                       ▼
  ┌─────────────────────────────────────────────┐
  │ heartbeat.ts  (content script, runs on every │
  │ page; only *activates* on authorized pages)  │
  │   • throttled HEARTBEAT  → every 1s of input │
  │   • FOCUS_PING           → "Chrome is focused"│
  │   • CLASSIFY_PAGE        → unknown page? ask  │
  └───────────────┬─────────────────────────────┘
                  │ chrome.runtime messages
                  ▼
  ┌─────────────────────────────────────────────┐
  │ background.ts (service worker)               │
  │   • owns SessionState                        │
  │   • 1s monitor: idle logic + heartbeat count │
  │   • persists to chrome.storage.local         │
  │   • broadcasts STATE_UPDATE to all tabs      │
  └───────────────┬─────────────────────────────┘
                  │ STATE_UPDATE
        ┌─────────┴─────────┐
        ▼                   ▼
  sprite.ts            popup/Popup.tsx
  (injected UI)        (toolbar panel)
   renders state        reads state + edits Settings
```

- **`heartbeat.ts`** decides if the current page is *authorized* (in your whitelist, or a
  `.pdf`). If yes, it listens for input and sends a `HEARTBEAT` at most once per second. If
  not, it optionally asks the AI helper whether to whitelist the page.
- **`background.ts`** keeps a single `SessionState`. A 1-second monitor decides Active vs
  Idle, counts one *heartbeat* per active second, advances the character when the count
  reaches your configured threshold, and saves + broadcasts every change.
- **`sprite.ts`** and **`Popup.tsx`** are pure renderers of that state. The popup also writes
  `Settings` directly to storage, which both the background and the sprite observe live.

### State shape

```ts
SessionState {
  isHeartbeatActive: boolean    // active in the last few seconds
  lastHeartbeat: number         // timestamp of the last HEARTBEAT
  activeWindowId: number | null // focused browser window
  enabled: boolean              // master on/off
  currentIconId: number         // which character is showing (0..14)
  heartbeatCount: number        // active heartbeats toward the next change
  iconChangeAt: number          // nonce bumped on each change → triggers fireworks
}
```

### Settings shape

```ts
Settings {
  enabled: boolean                 // master on/off
  forceActive: boolean             // pin "active" on every page (demo / focus-anyway mode)
  heartbeatTimeout: number         // seconds to Idle when Chrome is focused (default 2)
  preserveStateOnExternal: boolean // freeze state when you leave the browser (default true)
  externalActiveTimer: number      // seconds a frozen Active survives outside Chrome (0 = never)
  idleTime: number                 // FIXED at 20 — seconds of no activity before Idle
  iconChangeHeartbeats: number     // FIXED at 30 — heartbeats of focus before the character changes
  cryBeepVolume: number            // FIXED at 100 — mute with soundEnabled, not with 0
  cryBeepDuration: number          // FIXED at 60 — how long a lapse runs before the auto-pause
  aiRequestEnabled: boolean        // ask the AI about unknown pages (default OFF — it needs a backend)
  allowedDomains: string[]         // the whitelist (substring-matched against the URL)
  classifyUrl: string              // AI backend address (default "http://localhost:11434"); local host:port or remote base URL
  classifyApiKey: string           // Bearer key for a remote backend (empty for a local model)
  classifyModel: string            // model name for auto-classify (required, default "qwen-yesno")
  classifyNumThreads: number       // CPU-thread cap per AI request (default 2, 0 = backend default)
  classifyPrompt: string           // the YES/NO classification prompt
}
```

---

## The sprite

A 60 px circular companion injected into every **authorized** page:

| State | Behaviour |
|---|---|
| **Active** (heartbeat within the idle timeout) | Shows a coloured Nintendo-style character, **hops around** the screen as you type/move, and **shrinks** step by step as focus heartbeats accumulate. |
| **Reached the minimum size** | Plays a **fireworks burst** + spin, switches to the **next character at full size**, and resets the heartbeat counter to `0`. |
| **Idle** (no heartbeat) | Drifts to the centre, **grows** to fill the viewport, and **cries** (rotating 😭 😢 💧). |
| **Draggable** | Click-and-drag to move it anywhere on the page. |

The shrink amount is a direct function of `heartbeatCount / iconChangeHeartbeats`, so the
sprite size always tells you how close you are to the next character.

### What a lapse costs

Drifting off is not one flat charge — it gets worse the longer it runs, and the readout
under the score says what is coming next (`−10 in 24s`) so it is never a surprise:

| When | Cost |
|---|---|
| 10 s idle (after the warning + grace) | **−5** |
| 30 s later | **−10** |
| When Focus gives up and switches itself to *Not working* | **−15** |

The first one is deliberately the smallest: ten seconds is a glance out of the window, and
charging −15 for that is how a feature gets switched off. Coming back at any point stops
the staircase where it is, and the whole thing resets for the next lapse.

The last step is pinned to the auto-pause rather than a clock of its own, so the **beep
duration** slider stays the single answer to "how long does a lapse go on for". Set it
short enough (under ~35 s) and there is simply no room for the middle step — the schedule
drops it rather than promising a penalty that could never land.

---

## The popup menu

Click the Focus icon in the toolbar.

### Header

| Element | What it does |
|---|---|
| **Force-active toggle** (top-right) | When ON, the sprite is pinned to the **Active** state on every page regardless of real input — useful to keep the companion alive while reading something it can't "see" (e.g. a video lecture). When OFF, activity is detected normally. Clicking it also opens the **floating companion** helper window — see [Floating companion](#floating-companion). The same toggle is in the corner of every companion window, for when the browser is buried behind whatever you are working in. |

### Main tab

| Element | What it does |
|---|---|
| **Status badge** | `Active` (green) or `Idle` (grey) from the live heartbeat state. |
| **Whitelist this page** toggle | Adds / removes the current tab's domain from the authorized list and **reloads the tab** so the change applies immediately. |
| **Character card** | Reminds you how many heartbeats of focus trigger the next character change (configured in Settings). |

### Settings tab

**Timings are fixed and are not settings**

Four sliders used to live here — idle time, heartbeats per character change, beep volume
and beep duration — and every one of them sat at its default. They are now constants
(`FIXED_TIMINGS` in `src/types.ts`), stated in the popup rather than offered:

| | |
|---|---|
| **Idle after** | `20 s` of no activity |
| **New character every** | `30` heartbeats of focus (≈30 s of work) |
| **A lapse runs** | `60 s`, after which Focus switches itself to *Not working* |
| **Beep volume** | full — muting is the **speaker button** in the header, which is a thing you do for ten minutes rather than a setting |

They stay *fields* on `Settings` (a dozen places read them off it), but `loadSettings()`
pins them over whatever is stored, so a profile that moved one of the old sliders can't
be left holding a value with no UI left to change it back.

**Idle beep**

| Setting | Default | What it does |
|---|---|---|
| **Beep style** | Rising volume | `ramp` — one tone fading in from silence · `pulse` — short beeps every 5 s · `siren` — a two-tone alarm the whole time. |

**Sprite on the page**

| Setting | Default | What it does |
|---|---|---|
| **Show the sprite** | On | Off, **nothing at all is drawn into your pages**. Everything else carries on untouched — heartbeats, scoring, the whitelist and the idle beep all belong to the background, not to the sprite — so this is the setting for working off a [companion window](#floating-companion) on another screen instead. |

Three shapes for the same information, because what makes a companion work differs per
person: some people need it moving to notice it at all, some can't read a page with
something crawling over it, and some want the whole companion — whitelist buttons
included — without a second window to keep on top.

| Mode | What you get |
|---|---|
| **Roaming** *(default)* | The small circle walks across the page, one step per heartbeat. The original behaviour. |
| **Fixed** | The same circle, parked where you drag it. It spends each heartbeat on a **hop in place** instead of a step. Where you drop it is remembered, and every tab agrees on it. |
| **Panel** | The whole [floating companion](#floating-companion) **inside the page** — character, score, countdown and both whitelist buttons — in a box you drag where you like. Same code as the window, so the two can't drift apart. |

**Panel** is worth knowing about if you are on macOS or a Wayland desktop other than
GNOME: the companion *window* needs something outside the browser to keep it on top, and
there, nothing will. Inside the page the browser is the compositor and the problem
disappears — at the cost of only being visible while you are looking at the browser.

**When it goes idle.** The character does two things, and only one of them is a setting.

**It trembles — always.** The shaking starts with the **5-second warning**, not with the
escalation that follows it, so it is already moving while there is still time to come back;
that is the whole job of a warning. It then shakes further and further the longer you stay
away — visible from the first second, and up to about **two and a half centimetres** of
movement after 25 seconds. Inside the companion window and the panel it tops out sooner,
because the picture is only 480×240 and the character cannot be flung past its own frame.
The escalation is in the *distance*, never the speed: it jumps on a fixed clock and what
grows is how far it goes each time, which stays a series of steps you can count instead of
blurring into a buzz. There is no setting for this. Being impossible to ignore is the point.

| Setting | Default | What it does |
|---|---|---|
| **Grow when idle** | On | The crying character also **swells until it fills the view** — the page, for the two circle modes; its own frame, in the panel and the companion window. Off, it stays its own size and only trembles. |

A fixed-size box does not stop the *drawing* inside it from growing, which is why the panel
and the window are not exempt. In both, the score, the phase countdown and the two whitelist
bars are drawn **over** the character (the bars are separate rows below the picture
altogether), so a character big enough to fill the frame covers the background and never the
numbers you opened it for.

**Behaviour**

| Setting | Default | What it does |
|---|---|---|
| **Preserve state when leaving browser** | On | Freeze the current Active/Idle state when Chrome loses OS focus, instead of dropping to Idle instantly. |
| **Active state timer** | `60 s` | If a frozen **Active** state lasts longer than this outside the browser, it expires to Idle. `0` = never expire. |

**AI Auto-classify** (optional — see below)

**Off by default**, unlike every other switch: the others need nothing, while this one
needs an address, a model and a backend that is actually running. The five fields below
appear **under the toggle only while it is on** — off, the section is a single switch,
because there is nothing to configure about a feature that is not asking anything.

| Setting | Default | What it does |
|---|---|---|
| **AI address** | `http://localhost:11434` | Where the AI backend lives. **Local:** just host:port. **Remote:** the server's base URL. |
| **API key** | (empty) | Bearer token for a **remote** backend. Leave empty for a local model — no auth needed. |
| **Model name** | `qwen-yesno` | Which model classifies unknown pages. Must reply `YES` / `NO`. **Required** — the address alone isn't enough (the API needs a model). |
| **CPU threads cap** | `2` | Maximum CPU threads the backend may use **per classification request** (`num_thread`). `0` lets it decide. Keep this low so a request never freezes your PC. |
| **Prompt** | (built-in) | The exact text sent to the model. The page **URL and title are appended automatically**. |

**Allowed Pages**

Manage the whitelist by hand. Domains are plain strings matched **by substring** against the
full URL (`arxiv.org` matches `https://arxiv.org/abs/...`). Add with **Add**/Enter, remove
with **✕**. Newly added pages need a tab reload to start tracking.

**Default whitelist** (pre-authorized out of the box): `overleaf.com`, `arxiv.org`,
`nature.com`, `ieee.org`, `claude.ai`, `scholar.google.com`, `wikipedia.org`, `unipd.it`,
`mail.google.com`, `outlook.live.com`, `outlook.office.com` — plus **every `.pdf` URL**.

---

## Floating companion

A small **companion window** mirroring the sprite — the character, the focus/distracted
score and the phase countdown — so you can keep an eye on it while working in another
program that covers the browser.

> **Pairs with the [desktop agent](#desktop-agent-windows-macos-linux).** The agent tells
> the extension which program you are actually in, so this window keeps showing a live,
> *correct* score while you work outside the browser — instead of one frozen by an idle
> timer that cannot tell a LaTeX editor from a game.

**How to open it:** click the **Working** button in the popup header.

**Pause without going back to the browser.** The same **⚡ Working / ⏸ Not working** toggle
sits in the top-left corner of the drawing. It is the identical setting the popup's button
writes — flipping it here greys the character, stops the counting and greys the toolbar
icon exactly as flipping it there does — and it is here because the moment you most want it
is the moment the popup is hardest to reach: the browser is behind whatever you were working
in, and pausing meant raising it, finding the toolbar and opening the popup while the
companion sat in the corner still saying you were being counted. Resuming from here does
*not* open more companions, unlike the popup's button — you are already in one.

**The title-bar icon says it too.** The window's icon is the character in miniature, so a
companion that is minimised, half-covered or one line in a window list still answers the
question: **full colour** while the session is counting, **grey and crying** once it has
gone idle, and greyed out entirely while paused.

**The two whitelist bars.** Under the character and the score, two strips answer the one
question the sprite cannot: *is what I am doing right now being counted?*

- **The page bar** — the site in the front tab, with a one-click **+ Whitelist** button, or
  a live **✓ WORKING** / **IDLE** status and a **✕** to take it off again. Either way that
  tab is reloaded, exactly as the popup's toggle does, so the sprite appears (or stops)
  straight away.
- **The program bar** — the program you were last working in, same button, same status,
  same **✕**. Hidden when the agent cannot see the foreground.

The **✕** is deliberately quiet rather than a second coloured button: removing something is
the rarer action and the one you would least like to hit by accident. Hovering it says what
it will drop — usually just that domain, but a page can be counting because of a *broader*
entry (`unipd.it` is what makes `overleaf.dei.unipd.it` count), and removing the page
removes that entry, so everything else under it stops counting too. The popup's toggle has
always worked this way; here it says so before you click.

They are here, and not only in the popup, because **this window is always visible**: the
popup is several clicks away and covers the page it is describing, while the companion is
already on screen, on top, beside the page you want to count.

Neither bar can ask *"what is in front right now?"* — this window **is** a window of the
browser, so at the moment you look at it the live answers are "the companion" and "a
browser". They show the last ordinary **page** and the last **non-browser** program instead,
which is also what a person means by "this page" and "this app", and both survive the click,
which necessarily focuses the browser to happen at all.

If the agent is **not running**, the program strip turns red: *"Focus agent is off —
double-click the Focus agent icon to run it."* Opening this window is the moment work moves
outside the browser, so a stopped agent means everything you are about to do goes uncounted,
and nothing else on screen would say so.

**One per screen, automatically.** On a two-monitor desk the browser is on one screen and
the work is on the other, so a single companion is on the wrong one about half the time.
Clicking **Working** therefore opens **one companion per display**, each bottom-right of its
own screen and clear of panels and docks.

There is no number to set, deliberately: how many you want is a fact about your desk rather
than a preference, the browser already knows it, and a slider you have to remember to change
every time you plug a monitor in is a slider that will be wrong. The **⧉** button in the
corner of the drawing opens one *more*, for the rare screen that wants two. They all read the
same state, so there is nothing to keep in sync between them.

> **Wayland places them itself.** Under Wayland a client cannot position its own windows —
> there is no protocol request for it — so the corner placement is done by the
> [GNOME bridge](#wayland) instead, from inside the compositor, which is also where the
> work areas are known exactly. Windows, macOS and Linux/X11 need nothing extra; the browser
> places them. On KDE or wlroots without a bridge the windows still open, wherever the
> compositor decides to put them.

**They tell you which whitelist is earning right now.** Once something is whitelisted, its
bar shows **✓ WORKING** or **IDLE** rather than just a tick, and only one side can be
working at a time. Whitelist your editor and a page, then move from one to the other: the
editor's companion goes quiet as the browser's lights up. Whitelisted and *being counted*
are two different facts, and the second is the one that changes minute to minute — which
is also the quickest way to see that the program whitelist is doing what you think it is.

**How to keep it on top:** it is an ordinary browser window, so pinning it above other
apps is your window manager's job, not the extension's — no browser can raise its own
window on Wayland. Close it like any window.

The line along the bottom of the window tells you which of the three cases below applies
to *your* machine. On Windows and Linux something outside the browser does it for you, so
it is a **"Pinning on top…"** progress line that gets out of the way; on macOS nothing can,
so it prints what you have to do by hand and stays until you click it away. If the agent is
stopped on Windows, or reports it cannot see the foreground on Linux (which means the GNOME
bridge isn't installed), the line says so instead — those are the two cases where nothing
is going to pin the window and waiting would be pointless.

- **Linux / GNOME — automatic.** If you installed the
  [companion bridge](#wayland), it pins the window for you **and puts it in its screen's
  corner**. The bridge runs *inside* the compositor, which is the only thing that can
  raise or position a window on Wayland, so it does what the browser cannot. It matches
  the window by its exact title (`Focus companion`) and only pins it while it is small —
  under 900×700 — so a page that happens to share that title can't drag a whole browser
  window on top, and a companion stretched across the screen never becomes an overlay you
  can't work under. Each companion goes to the first monitor that hasn't got one, in its
  **work area** so panels and docks are cleared, and is placed **once** — move it by hand
  afterwards and it stays where you put it. Nothing to configure, and it works on
  GNOME/X11 too.
- **Windows — automatic.** If the [desktop agent](#desktop-agent-windows-macos-linux) is
  running, it pins the window for you: on Windows one program may raise another's window
  (`SetWindowPos(HWND_TOPMOST)`), needing no elevation, no injection and no extra process.
  Same guards as GNOME — the title must start with `Focus companion` and the window stay
  under 900×700 — and a window you unpin by hand is left unpinned. Without the agent, use
  [Microsoft PowerToys](https://learn.microsoft.com/windows/powertoys/) ("Always On Top",
  default shortcut **Win+Ctrl+T**) or AutoHotkey.
- **macOS — manual, and unavoidably so.** No process may change another application's
  window level: there is no public API for it at all, which is why every utility that does
  this is a window-manager helper you install and grant Accessibility to. The agent
  therefore does not try — asking for Accessibility is precisely what it is built to avoid.
  Install one of these, then pin the companion window with it:
  - [Rectangle](https://rectangleapp.com/) (free) — enable **Always on Top** in its
    preferences, give it a shortcut, then focus the companion window and press it.
  - [Amethyst](https://ianyh.com/amethyst/) (free) — a tiling manager with a float-on-top
    layer; add the companion to it and use **Toggle float for focused window**.
  - *Afloat* or *Ontop* (paid) — single-purpose always-on-top utilities.

  Each will ask for **System Settings → Privacy & Security → Accessibility**, because
  moving another app's window is exactly what that permission governs.
- **Linux / GNOME without the bridge** — GNOME no longer shows "Always on Top" in the
  title-bar menu, so bind the built-in action to a key once:
  ```bash
  gsettings set org.gnome.desktop.wm.keybindings toggle-above "['<Primary>backslash']"
  ```
  Then click the companion window and press **Ctrl+\\** to pin it (press again to unpin).
  Pick any free combo you like — but because `toggle-above` is a *global* shortcut, avoid
  keys apps rely on (`Ctrl+T`, `Ctrl+W`, …), or you'll shadow them everywhere. Undo with
  `gsettings reset org.gnome.desktop.wm.keybindings toggle-above`.
- **Linux / KDE** — right-click the title bar → **More Actions → Keep Above Others**, or
  set a permanent Window Rule matching the companion window.

> **Note for Chromium-on-Wayland users:** a browser window cannot raise *itself* above
> others on Wayland — the compositor decides — which is why this is never done by the
> extension. It is either the compositor doing it (the GNOME bridge, above) or you doing
> it with a WM shortcut. See [Why it no longer uses
> picture-in-picture](#why-it-no-longer-uses-picture-in-picture).

### How to see through it

The companion can be made **translucent**, so you can tell what is underneath it instead of
having a solid rectangle parked over the corner of your work.

**A browser cannot do this to its own window**, which is why the setting is not in the
extension's popup and never can be. `chrome.windows.create` opens a real desktop window that
the browser paints onto an opaque surface, so no CSS inside the window can reach past it —
the one API that could disappeared along with Chrome Apps. It is the same wall as pinning,
and it has the same three answers:

| Your system | Who fades it | Where you change it |
|---|---|---|
| **Linux / GNOME** | the [companion bridge](#wayland) | its preferences — **live**, see below |
| **Windows** | the [desktop agent](#desktop-agent-windows-macos-linux) | an environment variable |
| **macOS** | nobody | — |

Both use the same scale: **100 to 255**, where 255 is fully solid. The default is **180**
(about 70%).

**On Linux / GNOME** — install the bridge (`desktop/gnome-extension/install.sh`, then log out
and back in), and open its preferences:

```bash
gnome-extensions prefs focus-companion@focus.dev
```

or open the **Extensions** app, find *Focus companion bridge*, and click the **gear**. Drag
the slider with a companion window open: it re-fades as you drag, no logout and no
reinstall. This is a GNOME Shell extension and has nothing to do with the Chrome extension
of the same name — the compositor is the only thing that can fade a window, so the setting
lives where the work is done.

**On Windows** — the agent reads one environment variable at start-up:

```powershell
setx FOCUS_COMPANION_OPACITY 180
```

Then restart the agent (`launch.sh stop`, then the Focus agent icon). For a single session
you can instead run `$env:FOCUS_COMPANION_OPACITY=180` in the terminal you start it from.
There is no dialog because the agent deliberately has no settings file, no window and no
tray — every other preference in this project belongs to the extension. You do **not** need
to reopen the companion: the value is re-applied on every pass, so restarting the agent
updates windows that are already open.

**What you actually get is uniform translucency** — not a transparent background behind
opaque content. Both platforms fade the *whole* window, so the character and the score dim
by exactly as much as the panel behind them. That is unavoidable from outside the window:
only the page could separate the two, and this is not a page. It is also **not**
click-through — the companion still takes any click that lands on it.

**Don't go too low.** The whole job of this window is to be caught out of the corner of your
eye, and the idle tremble and countdown depend on it staying readable; faded far enough to
comfortably read what is behind it, it stops registering at all. That is why the scale stops
at 100 rather than 0 — the limit is legibility, not invisibility.

### Why it's a separate extension window

A content script can only draw *inside its page*, so it disappears the moment another app
covers Chrome — exactly when you want the companion. The companion is therefore a dedicated
**extension page** (`pip.html` / `src/extension/pip/pip.ts`) opened as its own window. It
mirrors the live state broadcast by `background.ts` and renders the character to a `<canvas>`.

### Why it no longer uses picture-in-picture

An earlier version popped the canvas out as **video picture-in-picture** to get an
OS-level always-on-top overlay. That was removed because it didn't actually deliver
always-on-top where it mattered, and it dragged in extra fragility for nothing:

1. **On Wayland it didn't stay on top anyway.** Whether a PiP window floats above others is
   decided by the **compositor**, not the browser. Wayland's core protocol does not let a
   client mark its own window always-on-top, so Chromium browsers (Chrome, Edge, **Brave** —
   all of them) let the overlay drop behind the next window you focus. It was a
   Chromium-on-Wayland limitation, not a Brave or extension bug — and the only browser-side
   workaround was to run the whole browser on the X11 backend (`--ozone-platform=x11`).
2. **That X11 workaround silently broke idle detection.** Under `--ozone-platform=x11` on a
   Wayland session the browser runs through Xwayland, whose XScreenSaver idle counter never
   advances (the Wayland compositor handles input), so `chrome.idle.queryState` answers
   `"active"` forever — the countdown freezes at its maximum and the crying/beep never fire.
   So the two "fixes" were mutually exclusive: the flag that pinned the PiP window on top was
   the same flag that disabled the idle timeline the window existed to display.

A normal window left on the native Wayland backend keeps idle detection working, and is
pinned above other apps by the window manager instead (see **How to keep it on top** above) —
the same result with none of the coupling, and consistent across platforms. Sites that
disable PiP via `Permissions-Policy` (many Overleaf deployments send `picture-in-picture=()`)
are likewise no longer a concern.

---

## Desktop agent (Windows, macOS, Linux)

A tiny background program in **[`desktop/`](desktop/)** that tells the extension **which
program is in the foreground**. That is all it does — plus, on Windows only, keeping the
[floating companion](#floating-companion) on top, because nothing else there can.

The extension can only see inside the browser. Everything else — a thesis in a local LaTeX
editor, a paper in a desktop PDF reader, a compile in a terminal — reaches it only as a
`chrome.idle` reading, which says *input happened somewhere* and nothing more. That is why
`osHeld` and the violet countdown exist. The agent attaches a name to "somewhere", so the
extension can finally tell working in a local editor apart from playing a game.

**The extension stays the central node.** It owns the program whitelist, the heartbeats,
the score, the sprite, the floating companion and any sync. The agent has **no account, no
session, no settings file, no window and no tray** — it is a sensor with an HTTP socket.
Stop it and the extension behaves exactly as it did before the agent existed.

### Install it in one step

The signed-out popup offers **one file per platform** — pick Linux, Windows or macOS,
press download, run it once:

```bash
sh ~/Downloads/focus-agent-linux.sh          # Linux and macOS
```

```powershell
powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\Downloads\focus-agent-windows.ps1"
```

That file **is** the agent: the compiled JavaScript, the TypeScript source, the launcher,
the icon installer, the GPL licence and the GNOME Shell bridge are all embedded in it as
base64. It downloads nothing and needs no git, no npm and no TypeScript — only **Node.js**,
which it looks for first (including the nvm and Homebrew locations a desktop launcher
cannot see) and refuses to install for you, because a language runtime is a decision about
the machine rather than a side effect of installing a 350-line helper.

It unpacks into `~/.local/share/focus-agent` (`~/Library/Application Support/focus-agent`
· `%LOCALAPPDATA%\focus-agent`), installs the clickable icon, sets up the GNOME bridge if
the session is GNOME, starts the agent, and prints what your platform can and cannot do.
`--autostart` also starts it at login; `--uninstall` removes exactly what it wrote.

**Why embedded rather than a link.** The two files are generated by
`scripts/build-agent-installer.mjs` during `npm run build` (from
`desktop/install/template.sh` and `template.ps1`) and served by the popup out of the
extension's own bundle. A link would need the repository to be public and to keep a URL
alive — this one is private today, so `raw.githubusercontent.com` answers 404 to anybody
not signed in, and *a download button that silently fails is worse than no button*. This
way the file always matches the extension you are holding, and it works with no network,
which is often the state of the machine when someone finally sits down to install it. The
popup needs the `downloads` permission for the save, and nothing else: the file is handed
over as a blob, so it is never exposed to web pages.

### Or run it from a clone

```bash
cd desktop
npm install     # three packages, all TypeScript tooling — no runtime dependencies
npm start       # builds, then serves on http://127.0.0.1:47317
```

Then open the popup: under **Allowed pages** there is now an **Allowed programs** list,
showing a green *agent on* dot and the program you are using right now, with one button to
add it. Nothing outside the browser counts as work until it is on that list.

### Start it by clicking an icon

So you never have to open a terminal for it again:

```bash
cd desktop
./install-icon.sh              # Linux: applications menu + desktop icon
                               # macOS: ~/Applications/Focus agent.app
./install-icon.sh --autostart  # …and start it at login as well
```

```powershell
powershell -ExecutionPolicy Bypass -File install-icon.ps1    # Desktop + Start menu
```

Clicking it starts the agent. Nothing appears — it has no window — so it tells you with a
desktop notification, and the popup's dot turns green. Clicking again while it runs does
nothing; on Linux, **right-click → Stop the agent** stops it.

> **The extension cannot start the agent itself.** No extension API can run a local
> program; the only one that can is native messaging, whose host manifest must name an
> exact extension ID — the installer step this transport exists to avoid. Hence the icon.

Full detail is in **[`desktop/README.md`](desktop/README.md)**.

### How the extension uses it

Folded into the existing `chrome.idle` poll, twice a second:

| `chrome.idle` | Foreground program | Result |
|---|---|---|
| idle | anything | **idle** — you are away from the machine |
| active | on the program whitelist | **working** — counts, with no tab involved |
| active | a **browser** | the **active tab** decides, exactly as before |
| active | anything else | **idle** — busy, but not at work |
| active | agent not running | the **active tab** decides, exactly as before |

**Browsers are excluded on purpose and cannot be whitelisted.** The agent only knows
"Chrome is in front", which says nothing about whether that window is on Overleaf or on
Instagram. The extension already knows, and the page whitelist is where that judgement
belongs — so when a browser is in front the agent steps out of the way entirely.

The program list is a **separate list from the site whitelist**, not a variant of it: a
domain is matched by substring against a URL, a program by an exact platform identifier
(executable name on Windows, bundle id on macOS, process name on Linux).

### What the agent does not do

- **No window title is ever reported.** They leak document names, message contents and
  page titles; application identity is all a whitelist ever needed, so no reading contains
  one. The single exception looks but never tells: on Windows the helper compares titles
  with the fixed string `Focus companion` to find the extension's own companion window and
  keep it on top — a lookup key, discarded at once, never printed and never sent.
- **Nothing is written to disk.** The agent holds one reading in memory and forgets it on
  exit. The program list itself lives in the extension, like every other setting.
- **No history of what you have opened is kept.** The extension remembers each program's
  proper name — so the list can read *Visual Studio Code* rather than `code` — but saves
  only the names of programs **already on your list**. Anything else it sees is held in
  memory and gone when the browser closes it.
- **No web page can read the agent.** The socket binds to `127.0.0.1` only; **no CORS
  headers are sent**, so a page's `fetch` is blocked from reading the response by the
  browser itself while the extension — which holds an explicit host permission — is
  exempt; and requests carrying a web `Origin` are refused with `403`.

### Platforms

- **Windows** — nothing to install, no permission prompt. Identifier: executable name
  (`winword`, `code`); the `.exe` is optional when typing a rule. Its helper also pins the
  [floating companion](#floating-companion) on top, which nothing else on Windows does
  without a third-party tool.
- **macOS** — nothing to install, and **no permission prompt of any kind**: `lsappinfo`
  needs no entitlement. Window *titles* are what would require Accessibility, which is
  exactly why none are read. Identifier: bundle id (`com.microsoft.vscode`).
- **Linux / X11** — needs `xprop` (`x11-utils` on Debian/Ubuntu, `xorg-x11-utils` on
  Fedora, `xorg-xprop` on Arch). Identifier: process name from `/proc/<pid>/comm`, which
  the kernel caps at 15 characters — which is why `gnome-terminal-server` appears as
  `gnome-terminal-`.
- **Linux / Wayland** — see below.

### Wayland

A Wayland client **cannot** see which other application has focus. That is a security
property of the protocol, not a gap — under Xwayland, `xprop -root _NET_ACTIVE_WINDOW`
answers `0x0` forever. The only way through is to ask something already **inside** the
compositor.

**GNOME's bridge is bundled**, since GNOME/Wayland is the default on Ubuntu, Fedora and
Debian. It is a small Shell extension exporting one D-Bus object, needed because
`org.gnome.Shell.Eval` has been locked down since GNOME 41 and there is no other general
hook. It sends the application name and process name only — never a window title.

Because it runs inside the compositor it also **keeps the [floating
companion](#floating-companion) above other windows automatically**, which no browser can
do for itself on Wayland. That is the one place in this project that looks at a window
title, and it only ever compares it with the fixed string `Focus companion`.

```bash
desktop/gnome-extension/install.sh   # copies in, and marks it enabled for next login
#  → log out and back in             ← the only remaining step
```

**Do not run `gnome-extensions enable` first.** It answers *"Extension does not exist"*
however many times you try, because the running Shell has never scanned the extension — it
looks in that directory only at start-up. The installer writes the `enabled-extensions`
setting directly, which is what that command would have done. Nor is there a way around
the logout: GNOME Shell restarts in place on X11 (`Alt+F2`, `r`) but **not on Wayland**,
where it *is* the compositor.

Check it afterwards:

```bash
gdbus call --session --dest org.gnome.Shell \
  --object-path /dev/focus/Companion --method dev.focus.Companion.GetFocused
# ('code|Visual Studio Code|1240',)
```

The bridge emits the same line the X11 helper prints, so a program list written under Xorg
keeps working after logging into Wayland.

**Other compositors** are the same shape and not implemented: KDE would need a KWin script
exporting an equivalent D-Bus object; Sway and Hyprland already expose the information
(`swaymsg -t get_tree`, `hyprctl activewindow`). On those the agent reports no program and
the extension falls back to browser-only tracking, which is exactly its behaviour without
the agent.

**Or skip all of it:** log out and pick **"Ubuntu on Xorg"** at the login screen.

---

## Phone nudge

Everything else Focus does needs you to be looking at the screen — and the one failure
it exists to catch is that you have stopped. The beep needs the volume up and the room
quiet; the trembling character needs your eyes on it. A phone in your pocket needs
neither.

Switch it on in Settings and Focus sends **one notification the moment the 5-second
warning starts** — while there is still time to come back before anything is lost — and
then **repeats every 5 seconds**, counting down to what the lapse is about to cost
(*"5 seconds before −5"*, *"22 seconds before −10"*, then just **FOCUS!** once the last
one has landed). They arrive on a locked
phone with the app closed, because they ride the same push channel native apps use.

The repeating stops when you come back, or when the lapse outlasts the beep and Focus
switches itself to *Not working* — about a minute with the default settings, and governed
by the same **beep duration** slider that decides how long everything else nags you. That
last moment gets one final message, **⏸️ Not working**, which is the only one that reports
rather than warns. Your phone shows **one** notification throughout rather than a dozen:
each push replaces the last and re-alerts.

The countdowns in those messages are written a few seconds **ahead**, because a push takes
a few seconds to arrive and a number computed at send time lands already wrong. They round
in your favour, so the phone under-promises by about a second rather than running out
early.

### Pair a phone (one QR)

Settings → **Phone nudge** asks **which phone you have** before showing anything else,
because the two are genuinely different — then shows a QR code and the steps for that
one:

| | Android | iPhone |
|---|---|---|
| Scan the QR, open the link | ✔ | ✔ — **in Safari** |
| Add to Home Screen, open the icon | — | **required** |
| Tap *Turn on notifications* → *Allow* | ✔ | ✔ |
| **Taps in total** | **2** | ~6 |

The iPhone install step cannot be shortened or scripted: Apple exposes web
notifications only to web apps launched from the Home Screen, and Safari offers no
programmatic install. It is a few extra taps, once.

Two iPhone-only notes, both of which will otherwise look like the pairing is broken:
**it has to be Safari** (Brave has no *Add to Home Screen* in its share menu), and if
the new icon opens **asking for the link**, go back to Safari, copy the link from that
page and paste it in — the app is installed separately from the tab and the code does
not always come with it. You can close the popup while you do all this; pairing finishes
on its own.

The same link sits under the QR with a **Copy** button, for when there is no camera
pointed at the screen — send it to yourself and open it on the phone. It is exactly what
the QR encodes, secret included, and expires on the same ten-minute clock.

Your computer sends a test notification the instant pairing completes — which is the
only honest way to find out whether the phone is set to vibrate for it, since that is
the phone's setting and nothing here can read it.

### Where the notification actually comes from

**Your own browser, straight to your phone.** The extension generates its own VAPID
signing key on your machine, encrypts each message so that only your phone can read it
(RFC 8291), and posts it to the push service. Google and Apple relay bytes they cannot
decrypt.

The server's entire involvement is a **ten-minute courier**: it carries the
subscription from the phone that scanned the QR to the computer that showed it, and
deletes the row the moment your computer collects it. No notification ever passes
through it, and there is no record anywhere of when you drift — which is the whole
reason it is built this way rather than as a normal push backend.

Setting it up means publishing one small static page (`web/`) — five files, no build
step. GitHub Pages takes two commands and a checkbox; see
[`web/README.md`](web/README.md). Until it is published and its address is in
`PUSH_LANDING_URL`, the popup says so rather than showing a QR that leads nowhere.

### Every lapse nudges

There is **no cooldown between lapses**. Go idle, the phone buzzes; come back, work, drift
off again, and it buzzes again.

This used to be capped at one nudge per five minutes, on the reasoning that a buzz per
lapse is a phone you would silence by lunchtime. That held when a lapse sent a single
push — but a lapse now *repeats*, one push every five seconds until you come back or the
auto-pause fires, so the restraint already lives inside the lapse. All the cap could still
do was swallow the next real one, silently, while the points came off exactly the same. It
also made the feature look broken in the most confusing way possible: notifications that
stop for a while and later start again, with nothing on screen explaining either.

What limits the rate now is the shape of the event. A nudge fires only on the
active→idle edge, and reaching another one costs real input followed by a full `idleTime`
of silence.

---

## Optional: Ollama AI auto-classify

When you visit a page that is **not** whitelisted, Focus can ask a **local** LLM (via
[Ollama](https://ollama.com)) whether the page looks like study/research material. If the
model says **YES**, the domain is added to your whitelist and the sprite activates
immediately (no reload). If **NO**, a small dismissible card tells you so.

Everything runs **on your machine** — no page content ever leaves your computer, and only the
URL + title are sent to your local model.

### Setup

**1. Install Ollama** — <https://ollama.com> (or `curl -fsSL https://ollama.com/install.sh | sh`).

**2. Create a tiny YES/NO model.** Save this as `Modelfile`:

```Dockerfile
FROM qwen3:0.6b
SYSTEM """
You are a classifier. You MUST reply with exactly one word: YES or NO.
Do not add punctuation, explanation, or any other text.
"""
```

```bash
ollama create qwen-yesno -f Modelfile
```

> You can use any model you like — set its name in **Settings → AI Auto-classify → Model
> name**, leave **AI address** at `http://localhost:11434` and **API key** empty for a local
> run. Smaller = faster and lighter. `qwen3:0.6b` is a good default.
>
> To use a **remote** backend instead, point **AI address** at its base URL and paste its
> **API key**. The backend must speak Ollama's `/api/chat` + `/api/generate` HTTP API.

**3. Start Ollama with the extension allowed as an origin** (a browser extension is a
cross-origin caller, so Ollama must permit it):

```bash
OLLAMA_ORIGINS="*" ollama serve
```

**4. Verify:**

```bash
curl http://localhost:11434/api/tags     # should list your model
```

### Using a non-Ollama backend (Gemini / OpenAI / Claude)

The **AI address** and **API key** settings let you point at any HTTP backend, but the code
speaks **Ollama's** request/response shape out of the box. To use a provider with a different
API (Gemini, OpenAI, Anthropic/Claude, …) you edit **one function**:

> **File:** `src/extension/background.ts` → `classifyPage()`

Three things change: **(1)** the endpoint path appended to the base URL (and drop the
Ollama-only `/api/generate` warm-up ping), **(2)** the request `body`, **(3)** the line that
reads the answer out of the response — currently:

```ts
const raw = (data?.message?.content ?? '').trim();   // Ollama shape
```

After editing, run `npm run build` and reload the extension. `settings.classifyModel` (Model
name), `settings.classifyApiKey` (API key) and `settings.classifyUrl` (AI address) are already
in scope as `model`, `key` and `base`. Examples:

**OpenAI** — set **AI address** to `https://api.openai.com`, **Model name** to e.g. `gpt-4o-mini`:

```ts
return fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers,                                   // Authorization: Bearer <key> is already set
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: `${settings.classifyPrompt}\n\nURL: ${url}\nTitle: ${title}` }],
  }),
})
  .then(async (r) => {
    const data = JSON.parse(await r.text());
    const raw = (data?.choices?.[0]?.message?.content ?? '').trim();
    return { isStudy: raw.toUpperCase().startsWith('YES'), raw };
  })
  .catch(() => ({ isStudy: false, raw: '', offline: true }));
```

**Anthropic / Claude** — **AI address** `https://api.anthropic.com`, **Model name** e.g.
`claude-haiku-4-5-20251001`. Claude uses different auth headers, so also change the `headers`:

```ts
const headers = {
  'Content-Type': 'application/json',
  'x-api-key': key ?? '',
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',   // allow the call from the extension
};
return fetch(`${base}/v1/messages`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    model,
    max_tokens: 10,
    messages: [{ role: 'user', content: `${settings.classifyPrompt}\n\nURL: ${url}\nTitle: ${title}` }],
  }),
})
  .then(async (r) => {
    const data = JSON.parse(await r.text());
    const raw = (data?.content?.[0]?.text ?? '').trim();
    return { isStudy: raw.toUpperCase().startsWith('YES'), raw };
  })
  .catch(() => ({ isStudy: false, raw: '', offline: true }));
```

**Google Gemini** — **AI address** `https://generativelanguage.googleapis.com`, **Model name**
e.g. `gemini-2.0-flash`. Gemini puts the model in the URL and the key in an `x-goog-api-key`
header:

```ts
const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': key ?? '' };
return fetch(`${base}/v1beta/models/${model}:generateContent`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    contents: [{ parts: [{ text: `${settings.classifyPrompt}\n\nURL: ${url}\nTitle: ${title}` }] }],
  }),
})
  .then(async (r) => {
    const data = JSON.parse(await r.text());
    const raw = (data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
    return { isStudy: raw.toUpperCase().startsWith('YES'), raw };
  })
  .catch(() => ({ isStudy: false, raw: '', offline: true }));
```

Only the classifier needs a `YES`/`NO` answer, so a small/cheap model is plenty. Remember these
send the page **URL and title** (and your API key) to that provider — see **Privacy** below.

### Working without Ollama

**Ollama is entirely optional.** If it is not installed, not running, or unreachable, the
extension keeps working:

- The sprite, heartbeats, shrinking, character changes, popup, and manual whitelist all work
  exactly the same.
- For a page that is **not** on your whitelist, the classification request simply fails, and
  the page is **treated as inactive** (the sprite does not appear there). A small card briefly
  notes *"AI classifier offline — page left inactive"*.
- The **only** thing you lose is **automatic** whitelisting. You can still add any page by
  hand with the **Whitelist this page** toggle or the **Allowed Pages** list.

In code this is the `offline` branch in `background.ts` (the `fetch().catch(...)` that
responds with `{ isStudy: false, offline: true }`) and its gentle handling in `heartbeat.ts`.

### Limiting Ollama CPU usage

A classification runs a real LLM, so on a busy machine you want to **cap** how much CPU it can
grab. There are two layers:

**1. From the extension (recommended, per request).** Set **Settings → AI Auto-classify →
CPU threads cap**. This sends `options.num_thread` with every request, so Ollama uses at most
that many threads for the classification. Default is `2`. Use `0` to let Ollama decide.

**2. From the Ollama server (system-wide).** Any of:

```bash
# Cap threads for the whole server
OLLAMA_NUM_THREADS=2 OLLAMA_ORIGINS="*" ollama serve

# Avoid running several model loads at once
OLLAMA_NUM_PARALLEL=1 ollama serve

# Pin Ollama to specific cores (Linux)
taskset -c 0,1 ollama serve

# Hard CPU quota via systemd (Linux) — 50% of one core:
#   sudo systemctl edit ollama
#   [Service]
#   CPUQuota=50%
```

Combine a small model + a low **CPU threads cap** and a request will never freeze your PC.

### Never-whitelist domains

`youtube.com` / `youtu.be` are hard-blocked from auto-adding (the model might say YES from a
video title, but the page is passive). You can still add them manually.

---

## Code structure

```
focus/
├── manifest.json          # MV3 manifest (permissions, content scripts, service worker)
├── vite.config.ts         # multi-entry build; wraps content scripts in IIFEs
├── index.html / popup.html # HTML hosts for the demo and the popup
├── src/
│   ├── types.ts           # shared types + constants (SessionState, Settings, MessageType)
│   ├── extension/         # everything that ships in the extension  ← see src/extension/README.md
│   │   ├── background.ts   # service worker — single source of truth
│   │   ├── push.ts         # Web Push: per-install VAPID key, encryption, sending
│   │   ├── content/        # content scripts injected into pages    ← see content/README.md
│   │   │   ├── heartbeat.ts # activity detection + AI classify card
│   │   │   └── sprite.ts    # the animated companion (roaming / fixed / panel)
│   │   ├── pip/            # the floating companion window
│   │   │   └── pip.ts       # layout, state, and the per-platform "pin on top" line
│   │   ├── ui/
│   │   │   └── companion.ts # the companion panel — ONE implementation, two homes
│   │   └── popup/          # toolbar popup UI                        ← see popup/README.md
│   │       └── Popup.tsx
│   ├── components/        # standalone dev demo (no Chrome APIs)     ← see components/README.md
│   │   └── SpriteSimulation.tsx
│   ├── App.tsx / main.tsx # mount the demo for `npm run dev`
│   └── index.css          # Tailwind entry (popup + demo only)
├── web/                   # the phone-pairing web app (deploy to any HTTPS host)  ← see web/README.md
│   ├── index.html          # Android-or-iPhone, then the steps for that one
│   ├── app.js              # subscribe, then hand the subscription back
│   └── sw.js               # the service worker that draws the notification
├── desktop/               # the foreground-program agent — its OWN npm package  ← see desktop/README.md
│   ├── src/foreground.ts  # per-OS: which program is in front. Nothing else.
│   ├── src/index.ts       # the loopback HTTP endpoint the extension polls
│   └── gnome-extension/   # GNOME Shell bridge, required only on Wayland
└── dist/                  # build output you load into Chrome
```

Each meaningful folder has its own `README.md` describing the modules inside it:

- [`src/README.md`](src/README.md) — overview of all source and the message contract
- [`src/extension/README.md`](src/extension/README.md) — the service worker and how the parts talk
- [`src/extension/content/README.md`](src/extension/content/README.md) — the two content scripts
- [`src/extension/popup/README.md`](src/extension/popup/README.md) — the popup UI
- [`src/components/README.md`](src/components/README.md) — the local demo
- [`desktop/README.md`](desktop/README.md) — the foreground-program agent
- [`web/README.md`](web/README.md) — the phone-pairing page and how to deploy it

The agent **shares no code with the extension** and deliberately knows nothing about
heartbeats, whitelists or scoring — it reports a program name over loopback and the
extension decides what that means. The two packages are built and type-checked
independently.

### Build entries (`vite.config.ts`)

Each entry compiles to its own bundle in `dist/`:

| Entry | Output | Role |
|---|---|---|
| `background` | `dist/background.js` | service worker |
| `heartbeat` | `dist/heartbeat.js` | content script (activity) |
| `sprite` | `dist/sprite.js` | content script (companion UI) |
| `popup` | `dist/assets/popup-*.js` + `popup.html` | toolbar panel |
| `main` | `dist/index.html` | dev demo (not used by the extension at runtime) |

Content scripts are wrapped in IIFEs so re-injection after an extension reload can't throw
"Identifier already declared".

---

## Local development

```bash
npm run dev      # standalone sprite demo at http://localhost:3000 (no Chrome APIs needed)
npm run build    # production build into dist/
npm run lint     # TypeScript type-check (tsc --noEmit)
npm run clean    # remove dist/
```

The demo (`src/components/SpriteSimulation.tsx`) mirrors the sprite behaviour with a short
heartbeat threshold so the shrink-and-change cycle is quick to watch.

### Something behaving strangely? Read the bug log first

**[`BUGS.md`](BUGS.md)** records every bug that cost real time on this project, what
actually caused it, and how it was fixed or worked around — with the environment traps
first, because several of them were not bugs in this code at all. The idle countdown
freezing, in particular, has a one-line answer that is not in any source file: check how
the browser was launched.

It also records the fixes that are **decisions** rather than patches, so they are not
undone by a later tidy-up. Please add an entry whenever a fix is not obvious from the diff.

---

## Publishing to the Chrome Web Store

The build in `dist/` is a valid MV3 extension. Before submitting:

1. **Icons** — add 16/32/48/128 px PNGs and reference them in `manifest.json`
   (`"icons"` + `"action": { "default_icon" }`). The store requires at least a 128 px icon.
2. **Listing assets** — at least one 1280×800 (or 640×400) screenshot and a short + long
   description.
3. **Privacy** — because the content scripts match `<all_urls>` and the extension can call
   `localhost`, you must provide a **privacy policy** and justify the broad host access in the
   submission form (the justification: the companion must be injectable on any page the user
   whitelists, and `localhost` is the optional local AI helper — no data leaves the machine).
4. **Zip** `dist/` and upload it in the Chrome Web Store Developer Dashboard.

---

## Privacy

- All state and settings are stored **locally** (`chrome.storage.local`). Nothing is sent to
  any server controlled by the author.
- The optional AI classifier sends **only the page URL and title** to **the AI address you
  configure** — by default your own local model (`http://localhost:11434`), so nothing leaves
  the machine. If you point it at a **remote** backend, the URL and title go to that server
  (and your API key is sent to it as a Bearer token); nothing is sent anywhere else. The
  feature is off unless a backend is reachable.
- The optional **phone nudge** sends a fixed message ("you have gone idle") to **your own
  phone** each time you go idle. It goes from your browser to your phone's push
  service and nowhere else: the notification is encrypted so that only your phone can read
  it, and **no server involved in Focus ever learns that one was sent**. The pairing QR
  puts a subscription on the server for at most ten minutes, and it is deleted the moment
  your computer collects it.
- Console logs are prefixed `Focus:`. Inspect the service worker from
  `chrome://extensions` → Focus → **Service Worker**.

---

## License

**Copyright © 2026 Andrea Novero.**

Focus is free software, licensed under the **GNU General Public License v3.0**
(GPL-3.0). You may use, copy, study, modify, and redistribute it, **provided that**:

- any distributed version — original or modified — **stays open source under the GPL-3.0**, and
- all copyright and license notices are **kept intact** (GPL-3.0 §5).

**Attribution (additional term, GPL-3.0 §7(b)):** you must **preserve attribution to Andrea
Novero** as the original author in all copies and derivative works. This term is permitted by
§7(b) and does not otherwise alter the GPL-3.0.

The full license text is in [`LICENSE`](./LICENSE). See <https://www.gnu.org/licenses/gpl-3.0>
for details.
