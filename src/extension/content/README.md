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
- **The tremble** — always on, no setting. It begins the moment the **idle warning** starts,
  not when the warning ends, so it is visible while there is still time to come back, and it
  grows for as long as the lapse runs — starting at `TREMBLE_MIN_PX` so it is visible
  immediately rather than ramping up from nothing through the very seconds the warning
  exists for, and reaching `TREMBLE_MAX_PX` (~2.5 cm) after 25 s. Clamped to the room the
  viewport has left, so a sprite parked in a corner cannot shake itself off-screen. The
  escalation is in the **distance**, never the rate: a new direction is picked on a fixed
  clock (`TREMBLE_STEP_MS`) and held until the next one, so what changes is how far it jumps
  rather than how fast it rattles. A rising rate would blur into a buzz; a rising distance
  stays a series of steps you can count.
- **`startGrowAnimation`** — the *other* half of the escalation, once the warning has run
  out, and the half you can refuse (`Settings.idleGrow`). It recenters the sprite and swells
  it to fill the viewport over ~20 s while `startCrying` cycles 😭 😢 💧. The same setting
  drives the canvas in `panel` mode and in the companion window, where the character grows
  inside its own frame with the score and countdown drawn over the top.
- **`triggerIconChange` / `triggerFireworks`** — on a fresh `iconChangeAt`, plays a fireworks
  burst and a spin-pop, after which the new character renders at full size (its count is back
  to `0`).
- **Movement** — one beat per heartbeat, spent according to `Settings.spriteMode`: a **step**
  across the page (`roam`), or a **hop in place** (`fixed`). Capped to the viewport.
- **Dragging** — pointer capture lets you reposition the sprite anywhere. In `fixed` and
  `panel` modes the drop point is remembered in `chrome.storage.local` under `focusSpritePos`,
  as a **fraction** of the viewport so a laptop and an external monitor agree.

### The two elements

The circle's **position** is on an outer wrapper and its **scale** on the circle itself.
That split is what makes the hop and the shake possible at all: `transform` holds one
value, and the `transform 0.9s linear` easing that makes the shrink pleasant would smear a
300 ms hop and a per-frame shiver into nothing. Position and per-frame motion on the
wrapper, size on the circle.

### `panel` mode

The third mode replaces the circle entirely with the [floating companion](../../../README.md#floating-companion)
drawn *inside the page* — the same `../ui/companion` module the companion window uses, so
the two are one implementation rather than two that look alike. It exists because that
window has one requirement the page does not: something outside the browser has to keep it
on top, and on macOS and most Wayland desktops nothing will. Inside the page the browser is
the compositor and the problem disappears; the cost is that it is only visible while you are
looking at the browser.

The roster (`CHARS`, 15 characters) lives in `../ui/companion.ts` and must stay length-synced
with `CHARACTER_COUNT` in `../../types.ts`.
