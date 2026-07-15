# `src/components/` — local dev demo

```
components/
└── SpriteSimulation.tsx   # the sprite, simulated in a plain web page (no Chrome APIs)
```

This folder is **development-only**. It is **not** part of the shipped extension — the
manifest never references it. It exists so you can iterate on the companion's look and feel
with a fast reload loop.

## `SpriteSimulation.tsx`

A React component that reproduces the extension's sprite behaviour **without** any
`chrome.*` APIs, so it runs in an ordinary browser tab via `npm run dev`
(`App.tsx` → `main.tsx` → `index.html`).

It mirrors the real logic:

- **Activity detection** — `mousemove` / `keydown` mark you active; ~2 s without input → idle.
- **Heartbeat counting** — one heartbeat per active second (`DEMO_HEARTBEATS`, deliberately
  small so the cycle is quick to watch).
- **Shrinking** — while active the sprite scales from `START_SCALE` (full) down to `MIN_SCALE`
  (minimum) as heartbeats accumulate — the same `count / threshold` mapping as
  `extension/content/sprite.ts`.
- **Character change** — at the threshold it advances the character, **fires fireworks**, and
  resets the count so the new character starts at full size.
- **Idle** — cycles the crying emoji.
- **Movement** — simple bounce around the viewport while active.

It is intentionally a **separate implementation** from the real `sprite.ts` (which is plain
DOM, runs as a content script, and is driven by the background's `SessionState`). Keep the two
visually consistent, but the demo is just a playground — production behaviour always lives in
`extension/`.

```bash
npm run dev    # open http://localhost:3000 and move the mouse / type
```
