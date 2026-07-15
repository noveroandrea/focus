# `src/extension/content/` — content scripts

Two scripts are injected into **every page** (`"matches": ["<all_urls>"]` in the manifest).
They are deliberately independent and both written in plain DOM/TypeScript with **inline
styles**, so the host page's CSS can never interfere.

```
content/
├── heartbeat.ts   # senses activity, decides authorization, runs the AI classify card
└── sprite.ts      # draws and animates the companion
```

Both are wrapped in IIFEs at build time (see `vite.config.ts`) and expose a
`window.__ff*Cleanup` function so a re-injection (after an extension reload with the tab still
open) tears the previous instance down first.

---

## `heartbeat.ts` — activity sensor + classifier

Runs on load and immediately starts a **focus-ping loop** (tells the background "Chrome is
focused" once a second while `document.hasFocus()`), regardless of authorization.

Then it reads `Settings` from storage and decides whether the page is **authorized**:

- the URL ends in `.pdf`, **or**
- the URL contains one of the `allowedDomains` (substring match), **or**
- (first run, before settings exist) it matches a built-in fallback list.

**If authorized → `activate()`:** shows a brief "Focus Active" badge and attaches
throttled listeners (`mousemove`, `scroll`, `wheel`, `keydown`, `mousedown`) that send a
`HEARTBEAT` to the background **at most once per second**.

**If not authorized → optional AI classify:** it builds the prompt (`classifyPrompt` + the
page URL and title) and sends `CLASSIFY_PAGE` to the background, showing a small status card
in the bottom-right corner. The card has three outcomes:

| Background reply | Card shows | Result |
|---|---|---|
| `isStudy: true` | ✅ + "adding…" | sends `ADD_DOMAIN`, then `activate()` immediately (no reload) |
| `isStudy: false` | ❌ | page stays inactive; card dismisses |
| `offline: true` | 💤 "AI classifier offline" | **Ollama not running** — page stays inactive, add it manually; card dismisses |
| `error` | ⚠️ | shows the API error for a few seconds |

This is the graceful-degradation path: **no Ollama ⇒ unknown pages are just treated as
inactive**, and the only lost feature is automatic whitelisting.

`youtube.com` / `youtu.be` are never auto-added (enforced on the background side too).

---

## `sprite.ts` — the companion

Injects a single 60 px circular sprite into a fixed-position root and renders it purely from
the `SessionState` it receives via `STATE_UPDATE` (and an initial `GET_STATE`).

Key pieces:

- **`applyState(s)`** — the render entry point. Picks the character from `CHARS[currentIconId]`,
  sets colour/icon, starts crying or stops it, and triggers the celebration when `iconChangeAt`
  changes.
- **Heartbeat-driven sizing** (`activeScale` / `applyActiveSize`) — while **active**, the
  sprite scale is a direct function of `heartbeatCount / iconChangeHeartbeats`: full size
  (`scale 2`) at `0`, minimum (`scale 0.5`) at the threshold. The mirror of
  `iconChangeHeartbeats` is read from settings storage and kept live.
- **`startGrowAnimation`** — while **idle**, the sprite recenters and grows to fill the
  viewport over ~20 s while `startCrying` cycles 😭 😢 💧.
- **`triggerIconChange` / `triggerFireworks`** — on a fresh `iconChangeAt`, plays a fireworks
  burst and a spin-pop, after which the new character renders at full size (its count is back
  to `0`).
- **Movement** — small step-based bouncing that only happens while active, queued from real
  input events; capped to the viewport.
- **Dragging** — pointer capture lets you reposition the sprite anywhere.

`CHARS` (the 15-character roster) must stay length-synced with `CHARACTER_COUNT` in
`../../types.ts`.
