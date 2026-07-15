# `src/extension/popup/` — toolbar popup

```
popup/
└── Popup.tsx   # the 320px React panel shown when you click the toolbar icon
```

`Popup.tsx` is a self-contained React app (mounted into `popup.html`). It is a **thin editor
of `Settings` and a viewer of `SessionState`** — it never owns runtime logic.

## What it renders

- **Header** — title + a **Force-active** toggle that writes `settings.forceActive`. When on,
  the background pins the sprite to Active on every page.
- **Main tab** (`MainTab`)
  - **Status badge** — live `Active` / `Idle` from `SessionState.isHeartbeatActive`.
  - **Whitelist this page** toggle — adds/removes the current tab's domain and reloads the tab.
  - **Character card** — shows the configured `iconChangeHeartbeats`.
- **Settings tab** (`SettingsTab`)
  - **Idle time** (`idleTime`) — slider (15–300s) for seconds of no activity before going
    idle; also sets `chrome.idle`'s detection interval.
  - **Change character every N heartbeats** — the slider over `iconChangeHeartbeats`
    (clamped 5–300 via `clampIconChangeHeartbeats`). This replaced the old "minutes" control.
  - **Idle beep volume / duration** (`cryBeepVolume`, `cryBeepDuration`).
  - **AI Auto-classify** — **AI address** (`classifyUrl`; local host:port or a remote base
    URL), **API key** (`classifyApiKey`; empty for a local model, sent as a Bearer token
    otherwise), **Model name** (`classifyModel`; required — the address alone isn't enough),
    **CPU threads cap** (`classifyNumThreads`, sent as `num_thread` so a request can't pin the
    CPU), and the classification **prompt** (`classifyPrompt`). The copy makes clear the AI
    backend is optional.
  - **Allowed Pages** — view/add/remove whitelist domains.

## How it talks to the rest of the app

```
on open:  GET_STATE  ─────────────▶ background  (returns SessionState)
          read chrome.storage.local ── Settings
live:     onMessage STATE_UPDATE  ◀── background  (keeps the badge fresh)

edit settings: chrome.storage.local.set({ focusFlowSettings })
               └─▶ background + sprite observe the change live (no reload)

whitelist toggle:
   add    → write Settings + reload tab
   remove → REMOVE_DOMAIN message (+ forces Idle) + reload tab
```

Because settings are written straight to `chrome.storage.local`, both the background worker
and every injected sprite pick up changes immediately through their `chrome.storage.onChanged`
listeners — there is no extra plumbing to keep in sync.

## Styling

Uses Tailwind (`../../index.css`) and `lucide-react` icons. Unlike the content scripts, the
popup lives in its own document, so normal class-based styling is safe here.
