# `src/extension/` — the shipped extension

This folder contains everything that actually runs as the Chrome extension: the **service
worker**, the **content scripts**, and the **popup UI**. They never call each other directly —
they communicate only through `chrome.runtime` messages (typed by `MessageType` in
`../types.ts`) and through `chrome.storage.local`.

```
extension/
├── background.ts     # service worker — the single source of truth
├── content/          # injected into web pages → content/README.md
│   ├── heartbeat.ts   # detects activity, asks the AI classifier
│   └── sprite.ts      # renders the animated companion
└── popup/            # toolbar panel → popup/README.md
    └── Popup.tsx
```

## Who owns what

| Concern | Owner |
|---|---|
| The authoritative runtime state (`SessionState`) | `background.ts` |
| Deciding Active vs Idle | `background.ts` (1s monitor) |
| Counting heartbeats and changing the character | `background.ts` |
| Reporting raw activity | `content/heartbeat.ts` |
| Drawing the companion | `content/sprite.ts` |
| Editing `Settings` | `popup/Popup.tsx` |

`sprite.ts` and `Popup.tsx` are **pure renderers** — they show whatever state the background
sends and never decide anything themselves.

## `background.ts` — service worker

The brain. Responsibilities:

1. **Holds `SessionState`** and persists it to `chrome.storage.local` (survives worker
   restarts).
2. **1-second monitor** — the core loop. Each tick it:
   - refreshes the heartbeat for PDF tabs (see below),
   - counts **one heartbeat per active second** (`tickHeartbeat`); when `heartbeatCount`
     reaches `iconChangeHeartbeats` it advances `currentIconId`, resets the count to `0`, and
     bumps `iconChangeAt` (which makes the sprite fire its celebration),
   - applies the **idle logic**: how long since the last heartbeat / focus ping, and whether
     to preserve state when you've left the browser.
3. **Broadcasts `STATE_UPDATE`** to every tab and to the popup on any change.
4. **Handles messages**: `HEARTBEAT`, `FOCUS_PING`, `GET_STATE`, `ADD_DOMAIN`,
   `REMOVE_DOMAIN`, and `CLASSIFY_PAGE`.
5. **PDF fallback** — Chrome's built-in PDF viewer is isolated, so page input events never
   reach our content scripts. The worker instead infers activity from `chrome.idle` and, while
   a `.pdf` tab is focused and the OS reports the user active, keeps the heartbeat fresh.
6. **AI classify proxy** — on `CLASSIFY_PAGE` it calls an **Ollama-compatible** HTTP API at
   the configured **address** (`classifyUrl`, default `http://localhost:11434`) with the
   configured **model** (`classifyModel`) and a `num_thread` cap, and replies `YES`/`NO`. If a
   `classifyApiKey` is set it is sent as `Authorization: Bearer …` (for a remote backend);
   for a local model the key is left empty. If the backend is unreachable it replies
   `{ isStudy: false, offline: true }` so the page is simply left inactive — the extension
   keeps working without any AI.

   **Address vs model — both are needed.** The address says *where* the server is; the model
   name says *which* model to run. Ollama's `/api/chat` **requires** a `model` field, so the
   name is mandatory even for a local server — the address alone is not enough.

   **Local Ollama setup (recommended):**
   ```bash
   ollama pull qwen2.5:3b                       # any small instruct model works
   # a tiny YES/NO wrapper model keeps replies terse (optional but nice):
   printf 'FROM qwen2.5:3b\nSYSTEM "Answer only YES or NO."\n' > Modelfile
   ollama create qwen-yesno -f Modelfile
   OLLAMA_ORIGINS="*" ollama serve             # the origin allowance lets the extension call it
   ```
   Then in the popup leave **AI address** = `http://localhost:11434`, **API key** empty, and
   **Model name** = `qwen-yesno`. For a **remote** backend put its base URL + API key instead.

### Idle logic in one glance

```
on each heartbeat source (event-driven):
    page HEARTBEAT (mouse/keyboard)  ┐
    idle poll active (PDF/window)    ┼─▶ registerHeartbeat(): +1 count (≤1/s) → step
    forceActive (1s loop)            ┘
every 0.5s (idle poll):  queryState(idleTime)
                           idle   → Idle now  (fires the crying/beep)
                           active → on an authorized focused tab → Active + heartbeat
every 1s (status loop):  keep count moving in forceActive; backup Idle expiry
```

Counting (which drives the character change **and the sprite's one-step-per-heartbeat
movement**) is **event-driven**: every heartbeat source calls `registerHeartbeat`, which
advances `heartbeatCount` by one, throttled to ≈once per real second. We do **not** count
inside the 1s timer, because an MV3 service worker is suspended between events and its
timers don't fire reliably while asleep — but an incoming heartbeat always wakes the worker.
This is why the sprite now steps for **both** page interactions and the idle poll, not just
the latter.

`queryState(idleTime)` already means "no input for `idleTime` s", so it maps **straight onto
the status** — we do *not* stack a second `idleTime` recency on top (that would double the
time-to-idle). Twice a second the worker polls it: system idle → go Idle immediately (this is
what makes the sprite cry/beep); system active on an authorized focused tab → stay/become
Active. This covers HTML pages, PDFs/viewers (no content script), and other windows uniformly;
content scripts also send `HEARTBEAT` on real page activity for an instant wake-up.

`queryState` is a cheap native read, and while already Active the poll only refreshes the
timestamp in memory — no storage write or tab broadcast — so the fast poll is inexpensive.
Time-to-idle is `idleTime` (+ up to 0.5s); reactivation is ≤0.5s.

`idleTime` (default 20s, min 15s — Chrome's idle floor) is the single knob. Idle is *polled*,
not event-based, because idle transitions can be missed/late on some platforms (notably
Linux/Wayland).

## Message flow

```
heartbeat.ts ──HEARTBEAT────────▶ background.ts ──STATE_UPDATE──▶ sprite.ts
heartbeat.ts ──FOCUS_PING───────▶ background.ts                └─▶ Popup.tsx
heartbeat.ts ──CLASSIFY_PAGE────▶ background.ts ──(Ollama)──▶ YES/NO/offline
heartbeat.ts ──ADD_DOMAIN───────▶ background.ts (writes Settings)
Popup.tsx    ──REMOVE_DOMAIN────▶ background.ts
Popup.tsx    ──GET_STATE────────▶ background.ts (returns current SessionState)
Popup.tsx    ──(writes Settings to chrome.storage.local)──▶ background + sprite observe it
```

See `content/README.md` and `popup/README.md` for the details of each side.
