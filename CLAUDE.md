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

The extension uses a **message-passing architecture** where `background.ts` is the single source of truth for all state, but heartbeat *generation* lives in its own module:

```
User activity (mouse/keyboard/scroll)           OS-wide activity (any window / PDF viewer)
    ↓                                                ↓
heartbeat.ts (content script)                    chrome.idle poll (in heartbeats.ts)
  sends HEARTBEAT on real page activity            queried every 0.5s
    └───────────────┬───────────────────────────────┘
                    ↓
heartbeats.ts — the two heartbeat sources + accumulation + the idle countdown anchor
    ↓ (via a small host interface: getState/getSettings/updateState/touchState/isAllowedUrl)
background.ts (service worker) — owns SessionState, persists to chrome.storage.local
  • broadcasts STATE_UPDATE to all tabs + popup on any change
                    ↓
sprite.ts (injected UI) + popup/Popup.tsx + pip.ts (floating companion) — pure renderers of the received state
```

### Activity & counting model (important)

State is driven by **heartbeats**, generated entirely in `src/extension/heartbeats.ts` (not `background.ts` — that file only owns the state and reacts to it). There are exactly two heartbeat sources:

1. **Page activity** — `heartbeat.ts` sends a `HEARTBEAT` message on mouse/keyboard/scroll on an authorized page.
2. **OS activity** — a `chrome.idle.queryState(15)` poll (every **0.5s**) covers PDFs, plugin viewers, and other windows where no content script runs. Always queried at the **15s floor** (Chrome's minimum), never at the user's `idleTime` — querying at `idleTime` gives a binary flip with no visible countdown, because "active" refreshes `lastHeartbeat` to now right up until the instant it isn't. The first "idle" reading anchors the last input at `now − 15s` and the readout counts down a fixed `OS_IDLE_COUNTDOWN_S` (5s) from there, regardless of `idleTime`.

**Counting is event-driven, NOT timer-driven.** `registerHeartbeat()` (in `heartbeats.ts`) is called from every heartbeat source. It advances `heartbeatCount` by one, **throttled to ≈once per real second**. This matters because an MV3 service worker is suspended between events and its `setInterval` timers don't fire reliably while asleep — but an incoming heartbeat always wakes the worker and lands in `registerHeartbeat`. When the count hits `iconChangeHeartbeats` it advances `currentIconId`, resets the count to 0, and bumps `iconChangeAt`.

**One step per heartbeat.** `sprite.ts` moves one step on every change of `heartbeatCount`, so the sprite steps exactly once per heartbeat regardless of source (page interaction OR idle poll). There is no separate per-DOM-event movement path.

**PDF/plugin viewer tabs are a special case.** Chrome serves a PDF as an HTML wrapper around `<embed type="application/pdf">`, so `heartbeat.ts` technically runs there — but real input goes to the viewer's inner frame, which the wrapper can never observe. `heartbeat.ts` therefore detects this (`document.contentType !== 'text/html'` or an `embed[type="application/pdf"]`) and **stays completely silent** rather than pinging: pinging would register the tab as an observable HTML page and make the background wait forever for HEARTBEATs that can never arrive. A silent tab is picked up correctly by the OS idle poll instead, exactly like any other viewer.

**`osHeld` (violet countdown).** When the OS poll sees input but no page heartbeat arrived recently (`PAGE_INPUT_FRESH_MS`), the work is happening somewhere the page can't see — another app, or inside a PDF viewer — and `SessionState.osHeld` is set so the sprite's "I ⋯s" countdown renders violet instead of blue. Same countdown either way; only the colour differs.

> **Platform gotcha (do not re-litigate):** if `chrome.idle.queryState` reports `"active"` forever and the idle countdown never falls, **check how the browser is launched before touching this code.** Running Chromium/Brave with `--ozone-platform=x11` on a Wayland session routes it through Xwayland, whose XScreenSaver idle counter never advances (the Wayland compositor handles input) — `chrome.idle` will report `"active"` permanently no matter what the extension does. This is a browser-launch problem, not an extension bug; an earlier version of this codebase built a large amount of `idleApiProven`-style workaround machinery around this exact symptom, all of which was later deleted once the real cause (a stray `--ozone-platform=x11` flag in a `.desktop` file, left over from a picture-in-picture experiment) was found and removed.

### Key Files

- **`src/types.ts`** — Shared types: `SessionState`, `Settings`, `MessageType`, `CryBeepStyle`. Exports `CHARACTER_COUNT` (15), `DEFAULT_SETTINGS`, `round2`, and clamps: `clampIconChangeHeartbeats` (5–300), `clampIdleTime` (15–300, default 20; 15 is Chrome's idle floor), `clampCryBeepVolume/Duration/Style`.
- **`src/extension/heartbeats.ts`** — **All heartbeat generation**, isolated from state ownership. Both sources (page `HEARTBEAT`, the `chrome.idle` poll), the throttled accumulation (`registerHeartbeat`), the OS-idle countdown anchor, and the viewer-tab bookkeeping (`contentTabs`) live here. Talks to `background.ts` only through a small `HeartbeatHost` interface (`getState`/`getSettings`/`updateState`/`touchState`/`isAllowedUrl`) — `background.ts` remains the only writer of `SessionState`.
- **`src/extension/background.ts`** — Service worker. Owns `SessionState`, wires up `heartbeats.ts` via `initHeartbeats()`, runs the 1s status loop (day rollover, `forceActive` tick, backup idle expiry, idle-penalty scoring), the AI classify proxy, the PDF/viewer classification flow, and draws the toolbar icon (green "Working" / grey "forceActive") with OffscreenCanvas.
- **`src/extension/content/heartbeat.ts`** — Content script that detects activity on authorized domains and sends `HEARTBEAT` / `FOCUS_PING` / `CLASSIFY_PAGE`. Domain defaults: Overleaf, arXiv, Nature, IEEE, Claude AI, Google Scholar, Wikipedia, UNIPD, mail (Gmail/Outlook) — all editable. **Detects and stays silent on PDF/plugin-viewer documents** (see below) rather than pinging from a wrapper that can't see input.
- **`src/extension/content/sprite.ts`** — Vanilla-TS sprite injected into all pages. Renders the 15 characters, shrinks as `heartbeatCount` rises, steps once per heartbeat, cries + beeps when idle (beep styles: **`ramp`** rising volume, **`pulse`** steady beeps every 5s, **`siren`**), plays fireworks on `iconChangeAt` change, and is draggable. Uses inline styles (not Tailwind) to survive host-page CSS. Audio uses the Web Audio API with **capture-phase** unlock listeners (`pointerdown`/`keydown`/`touchstart`/`click`) so it works even on SPAs that `stopPropagation` input events. Shows an "I ⋯s" / "W ⋯s" phase countdown (violet when `osHeld`).
- **`src/extension/pip/pip.ts`** — The **floating companion**: a small standalone `chrome-extension://` window (`pip.html`) mirroring the sprite's character, score, and phase countdown, meant to float above other apps while you work outside the browser. Not video picture-in-picture (removed — see the README's "Floating companion" section for why) and not raised on top by the extension itself; the window manager does that (per-OS instructions live in both the README and the Settings → Features → Floating companion (i) panel). Opened from the popup's Working button only when *resuming* work, gated on `Settings.companionEnabled`.
- **`src/extension/popup/Popup.tsx`** — 320px popup: activity status, per-page whitelist toggle, and Settings (idle time, icon-change heartbeats, beep volume/duration/style, AI classifier fields, allowed-domain editor, floating-companion toggle + always-on-top help).
- **`src/components/SpriteSimulation.tsx`** — Standalone demo used by `index.html` (`npm run dev`) to develop the sprite without Chrome APIs (shortened interval).

### AI auto-classify (configurable backend)

On `CLASSIFY_PAGE` (HTML pages) or the background viewer flow (PDFs), `classifyPage()` in `background.ts` calls an **Ollama-compatible** HTTP API and expects a `YES`/`NO` answer:

- **`classifyUrl`** — backend address. Local: `http://localhost:11434`. Remote: the server's base URL.
- **`classifyApiKey`** — sent as `Authorization: Bearer …`; leave empty for a local model.
- **`classifyModel`** — model name. **Required** — the address says *where*, the model says *which*; Ollama's `/api/chat` needs a `model` field.
- **`classifyNumThreads`** — `num_thread` cap so a request can't pin the CPU.

The code speaks Ollama's request/response shape (`/api/generate` warm-up + `/api/chat`, reads `data.message.content`). To target **Gemini / OpenAI / Claude**, edit `classifyPage()` — the README has ready-to-paste examples. If the backend is unreachable it returns `{ isStudy: false, offline: true }` and the page is simply left inactive, so the extension always works without any AI.

### Optional Supabase sync (`withserver` branch)

Off by default and **completely inert** until `src/extension/server/config.ts` is filled in *and* the user signs in — every call short-circuits on `isServerConfigured()`, so the extension still works with no backend.

- **`src/extension/server/auth.ts`** — Google sign-in via `chrome.identity.launchWebAuthFlow` (**not** `getAuthToken`, which is Chrome-only and absent in Brave), exchanging Google's `id_token` for a Supabase session. Refreshes are collapsed into one in-flight promise because Supabase rotates the refresh token on use — two parallel refreshes would sign the user out.
- **`src/extension/server/sync.ts`** — sends score **deltas** (`+focus` / `−distracted`), never absolutes, so two devices on one account can both post without overwriting each other. Pending deltas live in `chrome.storage.local` (an MV3 worker is suspended constantly) and clear only on server confirmation. The client posts at four moments — a score change, the browser opening, the Working button, and a **1-minute floor** — and **knows nothing about rollover**: it renders whatever live score comes back, so just after a server rollover it may briefly show the old figure until its next post.

The floor is a `chrome.alarms` one-shot (`focus-sync-post`) re-armed by every post, so it measures *time since last contact* rather than free-running. It exists because the other three triggers are all things the **user** does: a session with no score changes — reading a PDF, another device doing the earning, or simply idle — would otherwise sit indefinitely on a stale live score, stale averages, and a day the server has already ended. It must be `chrome.alarms` and not `setTimeout` for the same reason heartbeat counting is event-driven (a suspended worker's timers don't fire), and 1 minute is the shortest useful period because Chrome clamps alarms below that. Signing out clears it; signing in re-arms it, since signing in posts.
- **`supabase/migrations/`** — three score tables (`daily_scores`, `user_domains`, `user_summary`), four team tables (`teams`, `competitions`, `team_members`, `team_competitions`), one write RPC (`apply_score_delta`) and its read-only twin (`get_state`), and the rollover. Every RPC returns the **full state**: `{ summary, domains, days, teams, competitions }`.

**Teams and competitions.** `team_members` is keyed `(user_id, team)` and `team_competitions` `(team, competition)` — the composite primary keys *are* the duplicate prevention, with no application check to forget. `teams`/`competitions` are thin registries so foreign keys work and so "create" (refuses an existing name) and "join" (refuses a missing one) can be different operations. Membership writes are `join_team` / `leave_team` / `enroll_team` / `leave_competition`. **Teams and competitions both carry a bcrypt password** (create sets it, join must match), held in a `password_hash` column withheld from clients by column-level `GRANT SELECT (name, created_by, created_at)` — RLS filters rows and cannot hide a column. `join_team` and `enroll_team` are therefore SECURITY DEFINER (they read that column); the others are SECURITY INVOKER under RLS. Because DEFINER bypasses RLS, the explicit `user_id = auth.uid()` and team-membership predicates inside those two are load-bearing, not redundant. The competition password exists because without it anyone could create a throwaway team and enrol it into a known competition name, which legitimately made every rival team visible to them. `leave_competition` is deliberately not passworded.

**`visible_teams()` is the single definition of who a participant may see**: their own teams, plus every team sharing a competition with one of theirs. Both consumers go through it — `build_teams()` (which displays) and `get_member_profile()` (which authorizes) — so the two can never drift into disagreeing. `build_teams()` is SECURITY DEFINER built to the safe shape: **no arguments**, caller from `auth.uid()`, `EXECUTE` revoked from `anon`/`PUBLIC`.

**`get_member_profile(p_user)` is the one exception to "no user_id parameter"** — the shape that caused the vulnerability fixed in `20260729210000`. It is safe *only* because its body refuses any target not already reachable through `visible_teams()`. Delete that check and it becomes a full dump of any user by id. It returns another participant's scores, day history **and whitelisted domains** — the last is browsing data and the schema's most sensitive peer-to-peer exposure; it belongs in the consent form. `domain_flags` holds a global per-domain red-flag tally, recomputed (never incremented) from the append-only `domain_flag_events` ledger.

**Red flags are a weekly budget.** `user_flags` holds 0 or 1 per user; `grant_weekly_flags()` (a second `pg_cron` job, same `*/5 * * * *` schedule and same per-timezone reason as the rollover) **sets** it to 1 each Monday 01:00 local — set, not incremented, so an unspent week is lost. Spending is permanent. A **second, independent limit** caps one user at **3 flags on any one domain, ever** — the weekly budget controls how *often* someone flags, the ceiling how far they can push a *single* domain, so a high tally means breadth of objection rather than one person's persistence. The ceiling looks like a check-then-act race but isn't: the single `update user_flags … where flag = 1` serialises a user against themselves, so two concurrent calls can never both reach the insert. Monday 01:00 needs no new definition — `focus_week()` is just `focus_day()` (which already turns at 01:00) truncated to an ISO week, so both turn together. Ranking everywhere is `focus + distracted`, because `distracted_score` is stored *negative* and that expression is "focus minus distraction"; the literal subtraction would rank a distracted user higher. Team totals are **sums** (so `member_count` ships alongside). Per-team lists inside a competition aren't sent separately — each member row carries its `team` and the popup groups by it.
- **The server is the source of truth** for scores, whitelist and history. The extension still writes the same `chrome.storage.local` keys (`focusFlowSettings.allowedDomains`, `focusScoreHistory`), but they are a **cache overwritten by every response**, not a record. It cannot be zero local storage — `heartbeat.ts` must decide whether to activate on every page load, instantly and offline — so everything reading those keys keeps working unchanged. The whitelist is written through `apply_score_delta` (`p_domains`) rather than its own endpoint so an edit and a score delta cannot race; `SERVER_DOMAINS_KEY` records what the server last sent, which is how a server echo is told apart from a real user edit and the write loop is broken.

**The hook point is `updateState()`** in `background.ts` — the single writer of `SessionState`. Diffing `focusScore`/`distractedScore` there means any future code path that awards points is synced automatically. `queueDelta` ignores anything that isn't a *rise* in focus / *fall* in distracted, so the local daily rollover zeroing both counters is correctly not forwarded as a huge negative delta.

**No local day rollover.** `maybeRollover()`/`archiveDay()` are gone on this branch: the server ends the day (cron, 01:00 in the user's timezone) and every reply carries the reset live score plus the 30 most recent completed days, which `applyState()` writes into the local history cache. A second midnight-based rollover could only disagree — the boundaries are an hour apart, so it zeroed the score at 00:00 and had it jump back on the next post. `state.scoreDate` is now set from the server's `live_day`. **Consequence: with no server configured, or signed out, nothing ever ends a day** — the live score grows indefinitely and no history is banked.

**Scores are optimistic locally, authoritative from the server.** A point lands in `SessionState` immediately (so the sprite's `+1` and `−10` fly-up need no round trip), then the post's reply reconciles the displayed figure to the server's live score via `applyServerScores()`. That function goes through `writeState()`, **not** `updateState()` — deliberately: `updateState` would diff the scores it just received and post the difference straight back, compounding on every reply. The reconciled value is `server + still_pending`, because deltas queued mid-flight aren't in the server's figure yet and dropping them would make the number jump twice.

**A focus-day runs 01:00 → 01:00 local**, defined once in the SQL `focus_day()`. Ending a day happens **only** in the `pg_cron` job — it runs inside the database, so it works while the browser is shut, and the extension never triggers a rollover. The schedule is `*/5 * * * *`, not `0 1 * * *`, because a cron time is one wall-clock moment in UTC while users are in every timezone; each pass asks per-user whether *their* day is over. `pg_cron` is therefore **required**, not optional. Note this differs from the *extension's* local midnight rollover, so 00:00–01:00 points land on different days locally vs server-side. Setup and the research/PII caveats are in `supabase/README.md`.

### Build Entries (vite.config.ts)

Vite compiles multiple entry points into separate `dist/` bundles:
- `main` → index.html (demo) · `background` → service worker · `heartbeat`, `sprite` → content scripts · `popup` → popup panel · `pip` → the floating companion window. Content-script bundles are wrapped in IIFEs so re-injection after reload doesn't throw "Identifier already declared".

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
  focusScore: number            // Points earned by focusing; only ever rises
  distractedScore: number       // Points lost to distraction; only ever falls (runs negative)
  scoreDate: string             // Local YYYY-MM-DD the two scores above belong to
  penaltyAt: number             // Timestamp nonce; bumped when an idle penalty lands (triggers "−10" animation)
  osHeld: boolean                // True when the OS poll (not a page heartbeat) is keeping the session alive — colours the "I" countdown violet
}
```

### Debugging

All extension console logs are prefixed `"Focus:"`. Inspect the service worker from `chrome://extensions` → Focus → **Service Worker**. Content scripts use inline styles to avoid CSS-isolation issues with the host page.
