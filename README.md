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
- [Optional: Ollama AI auto-classify](#optional-ollama-ai-auto-classify)
  - [Working without Ollama](#working-without-ollama)
  - [Limiting Ollama CPU usage](#limiting-ollama-cpu-usage)
- [Code structure](#code-structure)
- [Local development](#local-development)
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
  iconChangeHeartbeats: number     // heartbeats of focus before the character changes (5–300, default 30)
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

---

## The popup menu

Click the Focus icon in the toolbar.

### Header

| Element | What it does |
|---|---|
| **Force-active toggle** (top-right) | When ON, the sprite is pinned to the **Active** state on every page regardless of real input — useful to keep the companion alive while reading something it can't "see" (e.g. a video lecture). When OFF, activity is detected normally. Clicking it also opens the **floating companion** helper window — see [Floating companion](#floating-companion). |

### Main tab

| Element | What it does |
|---|---|
| **Status badge** | `Active` (green) or `Idle` (grey) from the live heartbeat state. |
| **Whitelist this page** toggle | Adds / removes the current tab's domain from the authorized list and **reloads the tab** so the change applies immediately. |
| **Character card** | Reminds you how many heartbeats of focus trigger the next character change (configured in Settings). |

### Settings tab

**Timers**

| Setting | Default | What it does |
|---|---|---|
| **Idle timeout in Chrome** | `2 s` | Seconds without input on an authorized page before going Idle (while Chrome is focused). |
| **Change character every** | `30 hb` | **Heartbeats** of focused work before the character shrinks to minimum and changes. Range **5–300**. This is the slider that replaced the old "minutes" control. |

**Behaviour**

| Setting | Default | What it does |
|---|---|---|
| **Preserve state when leaving browser** | On | Freeze the current Active/Idle state when Chrome loses OS focus, instead of dropping to Idle instantly. |
| **Active state timer** | `60 s` | If a frozen **Active** state lasts longer than this outside the browser, it expires to Idle. `0` = never expire. |

**AI Auto-classify** (optional — see below)

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

**How to open it:** click the **Working** button in the popup header.

**How to keep it on top:** it is an ordinary browser window, so pinning it above other
apps is your window manager's job, not the extension's. Close it like any window.

- **Windows** — right-click the companion in the taskbar; if "Always on top" isn't
  offered, use a free utility such as [Microsoft PowerToys](https://learn.microsoft.com/windows/powertoys/)
  ("Always On Top", default shortcut **Win+Ctrl+T**) or AutoHotkey.
- **macOS** — the system has no built-in per-window always-on-top. Use a helper such as
  [Rectangle](https://rectangleapp.com/), Amethyst, or the paid *Afloat*/*Ontop* utilities,
  and pin the companion window through it.
- **Linux / GNOME (X11 or Wayland)** — GNOME no longer shows "Always on Top" in the
  title-bar menu, so bind the built-in action to a key once:
  ```bash
  gsettings set org.gnome.desktop.wm.keybindings toggle-above "['<Super><Shift>a']"
  ```
  Then click the companion window and press **Super+Shift+A** to pin it (press again to
  unpin). Undo the binding with `gsettings reset org.gnome.desktop.wm.keybindings toggle-above`.
- **Linux / KDE** — right-click the title bar → **More Actions → Keep Above Others**, or
  set a permanent Window Rule matching the companion window.

> **Note for Chromium-on-Wayland users:** a browser window cannot raise *itself* above
> others on Wayland — the compositor decides — which is why this is handled by the WM
> keybinding above rather than by the extension. See [Why it no longer uses
> picture-in-picture](#why-it-no-longer-uses-picture-in-picture).

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
│   │   ├── content/        # content scripts injected into pages    ← see content/README.md
│   │   │   ├── heartbeat.ts # activity detection + AI classify card
│   │   │   └── sprite.ts    # the animated companion
│   │   └── popup/          # toolbar popup UI                        ← see popup/README.md
│   │       └── Popup.tsx
│   ├── components/        # standalone dev demo (no Chrome APIs)     ← see components/README.md
│   │   └── SpriteSimulation.tsx
│   ├── App.tsx / main.tsx # mount the demo for `npm run dev`
│   └── index.css          # Tailwind entry (popup + demo only)
└── dist/                  # build output you load into Chrome
```

Each meaningful folder has its own `README.md` describing the modules inside it:

- [`src/README.md`](src/README.md) — overview of all source and the message contract
- [`src/extension/README.md`](src/extension/README.md) — the service worker and how the parts talk
- [`src/extension/content/README.md`](src/extension/content/README.md) — the two content scripts
- [`src/extension/popup/README.md`](src/extension/popup/README.md) — the popup UI
- [`src/components/README.md`](src/components/README.md) — the local demo

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
