# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Focus is a Chrome browser extension (packaged as **"Focus"**) that helps **anyone who struggles to stay focused** — whether from ADHD or ordinary distraction — keep on task during **study or work**. It injects an animated sprite companion into web pages that reacts to your activity: the character **bounces/steps while you work** and **cries (with an optional beep)** when you go idle.

The active character is rewarded for sustained focus — it starts at full size and gradually **shrinks** toward a minimum in proportion to accumulated focus "heartbeats" (≈one per active second), then bursts into **fireworks** and switches to a new character once it reaches the minimum size at `N` heartbeats (configurable 5–300, default 30). The new character restarts at full size with the count reset to 0.

The extension only activates on a **user-editable whitelist** of focus domains (writing editors, research/reference sites, docs, mail, etc. — anything the user considers "work"); every other page is left alone. An **optional AI classifier** (local by default, or a remote backend) can auto-whitelist unknown pages.

## Repository Status

- **Standalone public repository**, licensed **GPL-3.0** (`LICENSE`) with a §7(b) attribution term (© Andrea Novero). Published independently — note this folder may also live inside a larger parent folder, but its own git repo is the source of truth for publishing.
- `node_modules/`, `dist/`, `.env*`, editor cruft, and the whole `.claude/` directory are gitignored. Clone → `npm install` → `npm run build`; `dist/` is not committed.
- No secrets or `.env` file are needed. Old Google AI Studio scaffolding — `.env.example`, `metadata.json`, a dead `GEMINI_API_KEY` Vite injection, and ~12 unused template dependencies — has been removed; the package is named `focus`.

## Commands

```bash
npm run dev       # Local dev server (port 3000) for testing the SpriteSimulation demo
npm run build     # Build extension to dist/
npm run lint      # TypeScript type-check (tsc --noEmit)
npm run clean     # Remove dist/
npm run preview   # Preview built app
```

To load the extension in Chrome after building: go to `chrome://extensions`, enable Developer Mode, and load the `dist/` folder as an unpacked extension. **Always run `npm run lint && npm run build` after changes** — both must pass.

## Architecture

The extension uses a **message-passing architecture** where `background.ts` is the single source of truth for all state:

```
User activity (mouse/keyboard/scroll)           OS-level activity (any window / PDF viewer)
    ↓                                                ↓
heartbeat.ts (content script)                    chrome.idle poll (in background.ts)
  sends HEARTBEAT on real page activity            queried every 0.5s
    └───────────────┬───────────────────────────────┘
                    ↓
background.ts (service worker) — owns SessionState, persists to chrome.storage.local
  • registerHeartbeat(): advances the heartbeat count (≈1/s) on EACH source above
  • broadcasts STATE_UPDATE to all tabs + popup on any change
                    ↓
sprite.ts (injected UI) + popup/Popup.tsx — pure renderers of the received state
```

### Activity & counting model (important)

State is driven by **heartbeats**, and there are two heartbeat sources, unified in the background:

1. **Page activity** — `heartbeat.ts` sends a `HEARTBEAT` message on mouse/keyboard/scroll on an authorized page.
2. **OS activity** — a `chrome.idle.queryState(idleTime)` poll (every **0.5s**) covers PDFs, plugin viewers, and other windows where no content script runs.

Two intervals live in `background.ts`:

- **Idle poll (every 0.5s)** — `queryState(idleTime)` already means "no input for `idleTime` seconds", so it maps straight onto status: **idle → go Idle now** (fires the crying/beep); **active on an authorized focused tab → stay/become Active**. While already Active it only refreshes `lastHeartbeat` in memory (no storage write / no broadcast) to stay cheap.
- **Status loop (every 1s)** — keeps counting alive in `forceActive` mode and provides a **backup Idle expiry** if nothing refreshed the heartbeat within `idleTime`.

**Counting is event-driven, NOT timer-driven.** `registerHeartbeat()` is called from every heartbeat source (the `HEARTBEAT` message, the idle-poll active branch, and the `forceActive` 1s tick). It advances `heartbeatCount` by one, **throttled to ≈once per real second** via `lastCountAt`. This matters because an MV3 service worker is suspended between events and its `setInterval` timers don't fire reliably while asleep — but an incoming heartbeat always wakes the worker and lands in `registerHeartbeat`. When the count hits `iconChangeHeartbeats` it advances `currentIconId`, resets the count to 0, and bumps `iconChangeAt`.

**One step per heartbeat.** `sprite.ts` moves one step on every change of `heartbeatCount`, so the sprite steps exactly once per heartbeat regardless of source (page interaction OR idle poll). There is no separate per-DOM-event movement path.

### Key Files

- **`src/types.ts`** — Shared types: `SessionState`, `Settings`, `MessageType`, `CryBeepStyle`. Exports `CHARACTER_COUNT` (15), `DEFAULT_SETTINGS`, and clamps: `clampIconChangeHeartbeats` (5–300), `clampIdleTime` (15–300, default 20; 15 is Chrome's idle floor), `clampCryBeepVolume/Duration/Style`.
- **`src/extension/background.ts`** — Service worker. Owns `SessionState`, runs the 0.5s idle poll + 1s status loop, `registerHeartbeat()` counting, the AI classify proxy, the PDF/viewer classification flow, and draws the toolbar icon (green "Working" / grey "forceActive") with OffscreenCanvas.
- **`src/extension/content/heartbeat.ts`** — Content script that detects activity on authorized domains and sends `HEARTBEAT` / `FOCUS_PING` / `CLASSIFY_PAGE`. Domain defaults: Overleaf, arXiv, Nature, IEEE, Claude AI, Google Scholar, Wikipedia, UNIPD, mail (Gmail/Outlook) — all editable.
- **`src/extension/content/sprite.ts`** — Vanilla-TS sprite injected into all pages. Renders the 15 characters, shrinks as `heartbeatCount` rises, steps once per heartbeat, cries + beeps when idle (beep styles: **`ramp`** rising volume, **`pulse`** steady beeps every 5s, **`siren`**), plays fireworks on `iconChangeAt` change, and is draggable. Uses inline styles (not Tailwind) to survive host-page CSS. Audio uses the Web Audio API with **capture-phase** unlock listeners (`pointerdown`/`keydown`/`touchstart`/`click`) so it works even on SPAs that `stopPropagation` input events.
- **`src/extension/popup/Popup.tsx`** — 320px popup: activity status, per-page whitelist toggle, and Settings (idle time, icon-change heartbeats, beep volume/duration/style, AI classifier fields, allowed-domain editor).
- **`src/components/SpriteSimulation.tsx`** — Standalone demo used by `index.html` (`npm run dev`) to develop the sprite without Chrome APIs (shortened interval).

### AI auto-classify (configurable backend)

On `CLASSIFY_PAGE` (HTML pages) or the background viewer flow (PDFs), `classifyPage()` in `background.ts` calls an **Ollama-compatible** HTTP API and expects a `YES`/`NO` answer:

- **`classifyUrl`** — backend address. Local: `http://localhost:11434`. Remote: the server's base URL.
- **`classifyApiKey`** — sent as `Authorization: Bearer …`; leave empty for a local model.
- **`classifyModel`** — model name. **Required** — the address says *where*, the model says *which*; Ollama's `/api/chat` needs a `model` field.
- **`classifyNumThreads`** — `num_thread` cap so a request can't pin the CPU.

The code speaks Ollama's request/response shape (`/api/generate` warm-up + `/api/chat`, reads `data.message.content`). To target **Gemini / OpenAI / Claude**, edit `classifyPage()` — the README has ready-to-paste examples. If the backend is unreachable it returns `{ isStudy: false, offline: true }` and the page is simply left inactive, so the extension always works without any AI.

### Build Entries (vite.config.ts)

Vite compiles multiple entry points into separate `dist/` bundles:
- `main` → index.html (demo) · `background` → service worker · `heartbeat`, `sprite` → content scripts · `popup` → popup panel. Content-script bundles are wrapped in IIFEs so re-injection after reload doesn't throw "Identifier already declared".

### State Shape

```typescript
SessionState {
  isHeartbeatActive: boolean    // Active vs Idle
  lastHeartbeat: number         // Timestamp of last heartbeat
  activeWindowId: number | null // Focused window
  enabled: boolean              // Master on/off
  currentIconId: number         // Active character index (0..CHARACTER_COUNT-1)
  heartbeatCount: number        // Active heartbeats toward the next change (drives shrink + steps)
  iconChangeAt: number          // Timestamp nonce; bumped on each character change (triggers fireworks)
}
```

### Debugging

All extension console logs are prefixed `"Focus:"`. Inspect the service worker from `chrome://extensions` → Focus → **Service Worker**. Content scripts use inline styles to avoid CSS-isolation issues with the host page.
