# `src/` — source overview

All TypeScript/TSX source for Focus lives here. It splits into **what ships in the
extension** (`extension/`) and **what is only used for local development** (`components/`,
`App.tsx`, `main.tsx`).

```
src/
├── types.ts          # shared types + constants — the contract between every part
├── index.css         # Tailwind entry (popup + dev demo only; content scripts use inline styles)
├── extension/        # the actual extension → see extension/README.md
│   ├── background.ts  # service worker (single source of truth)
│   ├── content/       # scripts injected into web pages → content/README.md
│   └── popup/         # toolbar popup UI → popup/README.md
├── components/       # standalone sprite demo → components/README.md
├── App.tsx           # mounts <SpriteSimulation/> for the demo
└── main.tsx          # React entry for index.html (the demo page)
```

## `types.ts` — the shared contract

This is the most important file to read first. Everything else imports from it, which keeps
the background worker, the content scripts and the popup in agreement.

It exports:

- **`SessionState`** — the live runtime state the background owns and broadcasts
  (active/idle, current character, `heartbeatCount`, etc.).
- **`Settings`** — the user-configurable options the popup edits and the rest of the app reads
  from `chrome.storage.local`.
- **`MessageType`** — the discriminated union of every `chrome.runtime` message:
  `HEARTBEAT`, `FOCUS_PING`, `GET_STATE`, `STATE_UPDATE`, `ADD_DOMAIN`, `REMOVE_DOMAIN`,
  `CLASSIFY_PAGE`. If you add a message, add it here first.
- **`CHARACTER_COUNT`** — number of characters in the sprite roster (kept in sync with the
  `CHARS` array in `content/sprite.ts`).
- **`ICON_CHANGE_MIN` / `ICON_CHANGE_MAX` / `clampIconChangeHeartbeats`** — the supported
  range (5–300) for how many focus heartbeats trigger a character change, and a clamp helper
  used everywhere a raw value comes in.
- **`DEFAULT_SETTINGS`** — defaults written to storage on first run.

## Dev-only files

`App.tsx` + `main.tsx` mount `components/SpriteSimulation.tsx` into `index.html` so you can
iterate on the animation with `npm run dev` without loading anything into Chrome. They are
**not** part of the shipped extension (the manifest never references them).

## Styling note

The popup and the demo use **Tailwind** (`index.css`). The **content scripts deliberately do
not** — they style every element with inline `style` properties so the host page's CSS can
never leak in and break the sprite.
