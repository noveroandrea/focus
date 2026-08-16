# Bug log

Every bug that cost real time on this project, what actually caused it, and how it was
fixed or worked around. Kept because several of these looked like something they were
not — an extension bug that turned out to be a browser launch flag, a Wayland limitation
that turned out to be the protocol working as designed — and re-deriving that from the
code is far more expensive than reading it.

**Entries never get deleted, only marked.** A fixed bug whose entry disappears is a bug
somebody re-introduces. Where the fix is a *decision* rather than a patch, the entry says
so, because those are the ones most likely to be "cleaned up" by a future change.

Format: symptom → cause → fix. Newest first within each section.

- [Environment traps](#environment-traps) — not our code, but our problem
- [The idle model](#the-idle-model) — the longest-running source of bugs
- [Scoring and status](#scoring-and-status)
- [The desktop agent and the companion window](#the-desktop-agent-and-the-companion-window)
- [Server, auth and database](#server-auth-and-database)
- [Build, tooling and process](#build-tooling-and-process)
- [Still open / accepted](#still-open--accepted)

---

## Environment traps

### `--ozone-platform=x11` froze `chrome.idle` forever
**Status: fixed (browser launch, not code) — 2157afb**

*Symptom.* `chrome.idle.queryState()` answered `"active"` permanently, however long the
machine was left alone. Every countdown built on it froze at its maximum, the sprite never
cried, and no idle penalty ever landed.

*Cause.* Brave was being launched with `--ozone-platform=x11` on a Wayland session — a
leftover from the picture-in-picture always-on-top experiment. Under that flag the browser
runs through **Xwayland**, whose idle signal comes from XScreenSaver's counter, and that
counter **never advances on Wayland** because the compositor handles input, not the X
server. So the browser was asking a clock that had stopped.

*Fix.* Remove the flag from the `.desktop` file. Nothing in the extension changed.

*Cost.* This is the most expensive bug in the project, because it was diagnosed as an
extension bug three times before the real cause was found. It produced an entire subsystem
built on the false premise that `chrome.idle` is unreliable:

- `idleApiProven` — a persisted "has `chrome.idle` ever proven itself?" gate (27a3a16),
- a `FOCUS_PING` staleness probe used to infer "the user is in another app" (460eaee),
- a viewer-vs-observable split in the poll, so PDFs could bypass the untrusted API (8b3bd55),
- per-transition diagnostic logging, and a heartbeat-weight mechanism that never did
  anything because every call site passed `1`.

All of it was deleted in 2157afb once the flag was found — about 130 lines of the
heartbeat module, plus a storage key that is still explicitly removed on startup for
anyone who ran an old build.

> **If the idle countdown ever freezes again, check how the browser is launched before
> touching any code.** This is written at the top of `CLAUDE.md` for the same reason.

### GNOME refuses to run a `.desktop` file you just wrote
**Status: fixed — `desktop/install-icon.sh`**

*Symptom.* The Focus agent icon appeared on the desktop but double-clicking it did
nothing, or GNOME showed it as untrusted text.

*Cause.* GNOME requires the `metadata::trusted` attribute on desktop launchers placed in
`~/Desktop`, and the executable bit.

*Fix.* The installer sets both: `chmod +x` and `gio set … metadata::trusted true`. The
copy in `~/.local/share/applications` needs neither, which is why the installer writes two
separate files rather than a symlink — the trust flag is metadata on the file you click.

### `gnome-extensions enable` says "Extension does not exist"
**Status: worked around — `desktop/gnome-extension/install.sh`**

*Symptom.* After installing the Shell bridge, `gnome-extensions enable
focus-companion@focus.dev` fails with *"Extension does not exist"*, however many times it
is run.

*Cause.* That command asks the **running** Shell, which scans the extensions directory
only at start-up. It has genuinely never heard of the extension. There is no way to make
it look again: `ReloadExtension` answers *"deprecated and does not work"*,
`EnableExtension` returns `false` for an unscanned extension, and
`org.gnome.Shell.Introspect` is `AccessDenied` outside a fixed allowlist. On X11 you would
restart the Shell in place (`Alt+F2`, `r`); on **Wayland the Shell is the compositor**, so
restarting it takes the session down.

*Workaround.* The installer writes the `enabled-extensions` GSetting itself — exactly what
that command would have done — and the Shell reads it at next start-up. **A logout is
unavoidable** and is stated up front in the installer output, both READMEs, and the agent's
own error message.

### Headless screenshots are impossible on this session
**Status: accepted**

`import -window root` and friends fail with *"Resource temporarily unavailable"* on
Wayland: a client cannot capture the screen, by design. Visual bugs in the companion
window had to be diagnosed by asking the user what they saw, and by polling the
compositor over D-Bus for the state the UI was supposed to reflect.

---

## The idle model

### Reading the dashboard counted as walking away
**Status: fixed**

Opening the extension's own dashboard tab and sitting there reading it ran the idle
countdown to a penalty. The user was docked points for looking at the page that shows
the points.

Two gates, and it is worth being precise about which one actually did it, because
fixing only the obvious one changes nothing:

1. **No content script runs on a `chrome-extension://` page.** `manifest.json` matches
   `<all_urls>`, which does not cover the extension's own origin — by design, and not
   something a match pattern can opt into. So `heartbeat.js` is absent and no `HEARTBEAT`
   can ever arrive from that tab. That alone is fine; it is the same situation as a PDF
   viewer, and the OS idle poll exists to cover exactly it.
2. **The OS poll refused the tab on its scheme.** `withTrackedActiveTab` tested
   `/^(https?|file):/` *before* consulting `isTrackedUrl`, so the one remaining heartbeat
   source bailed out early and the whitelist never got a say. This is the one that caused
   the bug: whitelisting the dashboard by any means would not have helped while this test
   stood.

Fixed on both sides. `heartbeats.ts` admits our own origin as a **scheme**
(`OWN_PAGE_PREFIX = chrome.runtime.getURL('')`) and leaves the verdict to
`host.isAllowedUrl`, so the fail-closed shape is unchanged and no other extension page
gains anything. `background.ts` gets `isOwnDashboard()`, consulted first in
`isAllowedUrl`.

> **The dashboard is hard-coded, not seeded into `allowedDomains`, and that is a
> decision.** All three properties of that list would get it wrong: the extension id is
> generated per install (an unpacked extension changes it when the folder moves), so no
> fixed entry could match; the list is a **substring** test, so an entry that was a bare
> id would silently match any URL containing it; and on `withserver` the list is replaced
> wholesale by the server's copy, which would carry one machine's id to every other
> machine and drop it here. Hard-coded, it is right on every install and cannot be
> deleted by accident.

Two things deliberately left alone. `matchingDomains()` has **no** matching exception —
it answers "what would removing this page delete", and for the dashboard that is nothing;
giving it one would produce a ✕ that visibly does nothing, the same defect recorded for
`UNWHITELIST_PAGE`. And the **companion window is not included**: it is meant to be
watched while you work somewhere else, so counting it as work would mean the session
never went idle at all.

The popup's per-page toggle now hides itself on our own pages. It was building
`currentTabDomain` from `new URL(tab.url).hostname`, which on a `chrome-extension://`
URL is the install's generated id — so the row offered to add that id to the whitelist,
where it would have been a meaningless substring rule for a page that no longer needs one.

### The "I" countdown never moved
**Status: fixed — c9b47fc, d9832b0**

Two independent causes, found together:

1. **Two different clocks.** `sprite.ts` counted down from page-local DOM activity while
   `background.ts` decided idle from `chrome.idle`. The readout therefore predicted a
   different event than the one that actually fired: it ignored input in other windows and
   could reach zero with the session still active. Both the sprite and the companion now
   derive the countdown from `state.lastHeartbeat` — the same field the idle rule reads.
2. **`chrome.idle.queryState(N)` is binary.** Polling it at the user's own `idleTime`
   refreshed `lastHeartbeat` to *now* right up until the instant it flipped, pinning every
   countdown at its maximum and then dropping it to zero in one step. The poll now always
   queries at **Chrome's 15 s floor** and anchors the last-input estimate at `now − 15s`,
   so the tail of the wait ticks down for real. The flip still lands at `idleTime`.

> `OS_IDLE_FLOOR_S` is not a tuning knob. Raising it to the user's `idleTime` restores the
> binary flip and the frozen readout.

### PDFs counted nothing at all
**Status: fixed — 5f4dd7d (after a wrong first fix in 1cf4174)**

*Symptom.* On an arXiv PDF, no heartbeats from any source while the mouse moved over the
document. Nothing counted.

*Cause.* Chrome serves a PDF as a small HTML wrapper around
`<embed type="application/pdf">`, so the `<all_urls>` content script really does run
there — but input goes to the viewer's own inner frame, which the wrapper can never
observe. It saw the page and never saw a single event. The two heartbeat sources then
**cancelled each other out**: the wrapper's `FOCUS_PING` marked the tab as "has a content
script", so the background stood the OS source down and waited for `HEARTBEAT`s that could
never arrive.

*Fix.* `heartbeat.ts` detects a plugin-rendered document (`document.contentType !==
'text/html'`, or an `embed[type="application/pdf"]`) and **stays completely silent** — no
pings at all. That restores the meaning `contentTabs` always assumed: reporting in means
*"I can observe input"*. A silent tab is picked up by the OS idle poll like any other
viewer.

*Related, earlier and wrong.* 1cf4174 tried to fix the opposite symptom — a focused PDF
generating a heartbeat on every poll forever — by adding a `viewer` flag to `FOCUS_PING`
so the wrapper could report focus without claiming observability. That was more machinery
built on the `chrome.idle` false premise above, and 2157afb removed it. Silence was the
answer all along.

### A focused PDF could never go idle
**Status: fixed — 8b3bd55, then simplified by 2157afb**

*Symptom.* Walk away mid-paper with a PDF in the front tab and it kept earning points.

*Cause.* A viewer tab runs no usable content script, so "this tab is in front" was the only
positive evidence of work, and there was nothing to end the session.

*Fix (at the time).* Use `chrome.idle` as a **veto**: its two readings are not equally
trustworthy. `"active"` is the dangerous one — a stuck API asserting it holds the clock up
forever. A non-active reading is a positive assertion that the OS saw no input, so acting
on it can only ever end a session *earlier*. Safe to honour even from an API you do not
trust. Once the launch flag was found, `chrome.idle` needed no special-casing at all and
the veto became the ordinary path.

### `chrome.windows` focus was a constant
**Status: fixed — 460eaee**

`win.focused` from `chrome.windows.getLastFocused()` came back `true` on every single poll,
making "the browser has focus" a constant and rendering the entire unfocused branch
unreachable — nothing could detect that the user had left the browser. Replaced with the
page's own `document.hasFocus()`, which is accurate. The lesson generalises: **the page
knows its own focus; `chrome.windows` evidently did not.**

### A long `idleTime` stalled the OS-idle countdown for a minute
**Status: fixed — 460eaee**

By the time `chrome.idle` reports idle you have already been away at least 15 s, so
replaying the *full* `idleTime` from that moment left a long setting sitting visibly still.
The OS-idle countdown is now a fixed `OS_IDLE_COUNTDOWN_S` (5 s) from the anchor,
regardless of `idleTime`.

---

## Scoring and status

### Switching the sprite off still fired fireworks and "−15" across the page
**Status: fixed — `sprite.ts`**

*Symptom.* With **Show sprite** off — the setting whose whole promise is that nothing is
drawn into the page — a character change still burst confetti over the page, and every
idle penalty still threw a screen-sized red `−15` across it. The circle itself was
correctly invisible, which made it look less like a setting being ignored than like the
page had started celebrating on its own.

*Cause.* `applyMode()` implements the kill switch as `wrapEl.style.display = 'none'`, and
that is genuinely everything the *circle* is. But the two celebrations are not in `wrapEl`
— `triggerFireworks()` appends its dots to `#focus-flow-root`, and `triggerPenalty()`
deliberately renders its label at the screen centre so that a grown idle sprite cannot
cover it. Both were parented outside the element the switch hides, so hiding it never
touched them. Each already carried a `spriteMode === 'panel'` guard, which is probably why
the missing one was never noticed: the functions *looked* like they were gated.

*Fix.* An explicit `if (!spriteEnabled) return;` in both, beside the existing panel guard
rather than at the call site — the nonce (`lastIconChangeAt` / `lastPenaltyAt`) is already
advanced *before* the call, so returning early keeps the bookkeeping in step and re-enabling
the sprite cannot replay a burst that was skipped.

*Not* fixed by hiding `#focus-flow-root`: the score readout and the phase countdown live
there too and are wanted. And deliberately unchanged: the **beep**, which belongs to the
idle escalation rather than to the drawing, and the floating companion window and the
`panel` canvas, which are their own surfaces and keep their own bursts — someone who
stopped the sprite walking over their page has not asked the companion to go quiet.

### Clicking "Working" docked 10 points and did nothing
**Status: fixed — `background.ts`**

*Symptom.* Open the browser (toolbar icon grey, i.e. "Not working"), click **Working**:
the companion window opened correctly, but the status stayed grey **and** −10 distraction
points landed immediately. A second click then worked.

*Cause.* One tick of the status loop, with two faults stacked on it.

1. The settings listener set `isHeartbeatActive: settings.forceActive`. Entering "Not
   working" that is right — it pins the sprite active. Coming *back out* it evaluates to
   `false`, so clicking **Working** declared the user idle at the exact moment they said
   the opposite.
2. `idleSince` starts at `0`, and `0` is a **timestamp**. An MV3 worker starts fresh on
   every browser launch and every revival from suspension, so it routinely arrives
   mid-lapse having never seen the `active → idle` edge that anchors the lapse. The lapse
   was therefore dated to **1970**, making `now − idleSince` several decades — so on that
   single tick both the penalty threshold *and* the auto-pause threshold fired at once:
   −10, and an immediate switch back to "Not working" (grey). The second click appeared to
   work only because the one-per-lapse flags were already spent.

*Fix.* Both directions of the toggle now snap the session **active** with a fresh
`lastHeartbeat` — clicking Working is a statement of intent, and earns a full `idleTime`
before anything may call you idle — and the lapse bookkeeping is cleared there too. A lapse
found without an anchor is anchored at **now**, deliberately not at `state.lastHeartbeat`:
time the worker spent suspended, or the browser spent closed, is not evidence the user sat
there doing nothing, and charging for it would dock people for going to bed.

*Note.* Fault 2 alone also explains grey-on-startup: a worker that woke with the session
already idle would auto-pause itself within a second of the browser opening.

### The Working toggle needed two clicks to turn green
**Status: fixed — 996885c**

Opening the companion window focuses a new window, which **closes the popup**. Doing that
in the same tick as the settings write raced the write and could lose it, so the toggle
appeared not to apply. The write now completes first and the companion is opened from its
storage callback. The companion also opens only when *resuming* work, never when pausing.

### Counting stopped whenever the service worker slept
**Status: fixed by design — `heartbeats.ts`**

An MV3 service worker is suspended between events and its `setInterval` timers do not fire
reliably while asleep, so any timer-driven counter silently loses time. Counting is
therefore **event-driven**: `registerHeartbeat()` is called from every heartbeat source and
throttled to ≈once per real second. An incoming heartbeat always wakes the worker and lands
there. The same reasoning forces `chrome.alarms` (not `setTimeout`) for the sync floor.

> Do not "simplify" the counter back into an interval. It will appear to work while the
> worker happens to be awake.

---

## The desktop agent and the companion window

### The Electron companion app — deleted, not fixed
**Status: removed by decision**

The first desktop app was an Electron overlay. Three bugs in a row, all Wayland,
established that the design could not work:

1. **No icon, no window.** It launched with no renderer process visible; `--enable-logging`
   showed the app *was* loading. Diagnosis on Wayland was blind (see screenshots, above).
2. **It flashed open and closed every second.** `refreshOverlayVisibility()` hid the
   overlay when the compositor reported the overlay itself as focused — and on Wayland
   mapping a window focuses it. A feedback loop: show → focus → hide → show. Confirmed by
   polling the bridge and watching focus alternate between `electron` and `code`.
3. **Always-on-top made the desktop unusable.** `setIgnoreMouseEvents` does not reach the
   Wayland compositor, so the overlay swallowed every click meant for the window beneath
   it. This killed an always-on-top change that was about to ship.

*Resolution.* The whole app was deleted in favour of a ~350-line dependency-free Node
**agent** that only reports the foreground program, with the extension remaining the single
central node. The existing D-Bus contract was preserved deliberately, so no second GNOME
logout was needed.

### Video picture-in-picture disabled the very idle timeline it displayed
**Status: removed by decision — c9b47fc**

PiP needs a continuously playing `<video>`, and the browser holds a **screen wake lock**
while video plays, which on Linux can stop the session ever being reported idle. The
companion was suppressing the idle detection it existed to show. It also never stayed on
top under Wayland. The only browser-side workaround for *that* was `--ozone-platform=x11`,
which breaks `chrome.idle` — so the two fixes were **mutually exclusive**. Replaced with a
plain extension window pinned by the window manager, and later pinned automatically (below).

### The whitelist button offered you your own browser
**Status: fixed — `AgentStatus.recent`**

*Symptom.* The popup's "This is work" button, and later the companion's "+ Whitelist",
offered whatever program was in front — which, while you are looking at the popup or the
companion, is **always the browser**. Browsers are the one thing that must never go on the
program whitelist: counting one as work counts every distraction site as work.

*Cause.* Structural, not incidental. Both surfaces *are* the browser, so the live reading
at the moment of the click is guaranteed to be the wrong answer.

*Fix.* `AgentStatus.recent` — the last **non-browser** foreground program (5-minute
freshness). Every surface that *offers* a program renders `recent`, never `program`. It is
also what the user means by "this app", and it survives the click, which necessarily
focuses the browser to happen at all. The door is shut a second time in the `ADD_PROGRAM`
handler, which refuses a browser id whatever the UI sent.

### A page whitelisted from the companion un-whitelisted itself seconds later
**Status: fixed — `saveSettings()` in `background.ts`**

*Symptom.* Pressing **+ Whitelist** in the companion window worked: the tick appeared, the
tab reloaded, the sprite woke up. A few seconds later the page stopped counting on its own
and the entry was nowhere in the popup's domain editor. Same for **✕**, and for every other
whitelist change the background makes on its own — `ADD_DOMAIN`, `REMOVE_DOMAIN`, the AI
classifier's auto-add, `ADD_PROGRAM`.

*Cause.* Two correct-looking pieces that only work for one of the two writers.

`background.ts` reacts to settings changes through a `chrome.storage.onChanged` listener,
which diffs the incoming value against its own `settings` and, on a whitelist change,
mirrors the list to the server with `queueDomains()`. That is right for the **popup**,
which writes storage directly — the background's copy really is the old one at that
moment. It cannot work for a write made **in the background**, which assigns the new value
to `settings` *before* calling `chrome.storage.local.set`: by the time the listener fires,
`prev` and the new value are the same array, `whitelistChanged` is `false`, and the mirror
never runs.

That alone would only have been a missing sync. What made the entry *vanish* is the other
half: with the edit never queued, the next post (a score change, or the 1-minute floor)
came back carrying the server's **older** list, and `applyState()` in `sync.ts` overwrites
`Settings.allowedDomains` with whatever the server sent — by design, since the server is
the source of truth for the whitelist. So the local edit was deleted by the first reply
that arrived after it.

*Fix.* `saveSettings(next)` — one background-side writer that does the follow-ups
(`queueDomains`, `updateActionIcon`, `setNamedPrograms`) itself rather than hoping a
listener will notice. Every background write goes through it. The listener keeps its
comment explaining that it covers the popup only, so the follow-ups are not "tidied" back
into it.

*Worth noting for anything similar:* an in-memory cache that is also the diff baseline can
only detect changes made by *someone else*. Any writer that updates the cache first is
invisible to its own listener.

### `osHeld` is not "the page is idle", and reading it as such shows idle 18 s early
**Status: avoided by construction — `programIsDriving()` in `background.ts`**

*The trap.* The companion's page bar has to say **WORKING** for the whole idle timeout and
only turn **IDLE** when the warning starts. `SessionState.osHeld` looks like exactly the
flag for it — false means "a page heartbeat is feeding this session" — so the obvious
implementation is `working: isHeartbeatActive && !osHeld`.

It is wrong twice over.

`osHeld` is set whenever the OS poll sees input but no page heartbeat has arrived within
`PAGE_INPUT_FRESH_MS` (**2 s**). Sit still on a page you are reading and it flips true after
two seconds — while `isHeartbeatActive` stays true for the remaining eighteen. The bar would
have gone idle 18 s before the session did, on a page that was still being counted the whole
time. It is also set while reading a **PDF**, where the browser genuinely is the work and no
page heartbeat can ever arrive, so that case would read as idle permanently.

*The shape that works.* Only the PROGRAM side gets a positive test — heartbeats landing,
`osHeld`, and the *live foreground* program is a non-browser one on the whitelist — and the
page's answer is its **complement**. Exactly one side can be driving, so "no allowed program
is holding this session up" is the page's answer, and with no agent installed it degrades to
what was always true: a live session on a whitelisted page is that page working.

*And `isHeartbeatActive` is not "heartbeats are landing" either.* It stays true for the whole
idle timeout, **including the final stretch where `chrome.idle` has already reported idle**,
the anchor is set, and the "I" countdown is visibly falling. Nothing is registered and no
point is earned in that stretch, so a bar saying WORKING there describes a session that has
already stopped counting — next to a number counting down to zero. Both answers are therefore
gated on `heartbeatsLanding()`: active **and** `lastHeartbeat` fresher than `WORKING_FRESH_MS`.
That flips at the exact moment the background pins `lastHeartbeat` back to the OS anchor,
which is itself a broadcast, so the companion's bars turn over on it rather than up to two
seconds later on their poll.

*The resulting timeline*, with the default 20 s timeout and the OS path: **0–15 s** one side
says WORKING and the other IDLE; **15–20 s** `chrome.idle` has said idle, the countdown is
falling and no heartbeat is landing — *both* say IDLE; **20–25 s** the warning, the character
trembles and cries; **25 s+** the escalation (beep, grow). Nothing claims to be working once
the countdown has started, which is the entire requirement.

### The companion took up to 15 seconds to notice the agent had started
**Status: fixed — `agent.ts`**

*Symptom.* The companion said *"Focus agent is off"*, the user clicked the icon, got the
"running" notification — and the window kept saying off for many seconds.

*Cause.* Two delays stacked. `refreshProgram()` backs off to a **15 s** retry once the
agent looks absent (otherwise a machine with no agent attempts a connection twice a second
forever), and `AGENT_STATUS` answered from the *cache* before its own probe resolved,
costing another poll on top.

*Fix.* Requests from a UI pass `eager`, which shortens only the offline retry to 1.5 s — a
UI asking for status is a human waiting for an answer — and `AGENT_STATUS` now replies
*after* its probe resolves. The 0.5 s idle poll keeps the 15 s backoff, since nothing is
waiting on it. Measured against the live agent: detection at ~2 s (bounded by the
companion's own poll) instead of up to 15 s.

### `pkill -f` killed the wrong process — twice, including my own shell
**Status: fixed — `launch.sh` reads the pid from the agent's HTTP reply**

*Symptom.* `pkill -f "electron \."` and later `pkill -f "dist/index.js"` returned exit code
144 and took down the shell that ran them, because the pattern matched the shell's own
command line.

*Cause.* One agent has several possible command lines — `npm start`, the desktop icon, a
hand-typed `node dist/index.js` — and a pattern loose enough to catch all three catches
other things too.

*Fix.* The agent reports `process.pid` in its JSON, and `launch.sh stop` kills exactly that
process. `pkill -f` remains only as a fallback for an older agent that reports no pid.
(Interactive rule of thumb from the same lesson: prefer `pkill -x`.)

### Sprite could start off-screen in a small viewport
**Status: fixed — `sprite.ts`**

`px`/`py` are seeded up to (400, 300); in a smaller window the sprite sat outside the
viewport until the first heartbeat moved it. Now clamped to
`window.innerWidth/Height − SIZE` before the first paint.

### Audio never unlocked on some SPAs
**Status: fixed by design — `sprite.ts`**

Web Audio must be unlocked inside a real user gesture, but some SPAs (Telegram Web, for
one) call `stopPropagation()` on input events, so a bubble-phase listener never fires. The
unlock listeners are registered in the **capture** phase, across four gesture types.

### Content-script re-injection threw "Identifier already declared"
**Status: fixed by design — `vite.config.ts`**

Reloading the extension with tabs already open re-injects the content scripts into the same
page context. Every content-script bundle is wrapped in an IIFE by a small Vite plugin so
top-level names cannot clash with the previous injection.

---

## Server, auth and database

### Reloading the extension deleted every added domain and every program
**Status: fixed — `background.ts`**

*Symptom.* Whitelist a domain or a program; it appears in Supabase immediately, exactly
as designed. Reload the extension — and it is gone. Not just from the popup: gone from
`user_domains` / `user_programs` too. Programs came off worst, since **all** of them
vanished every time, while domains fell back to the built-in defaults.

*Cause.* `chrome.runtime.onInstalled` fires on every reload of an unpacked extension, and
its listener seeded the server from the module-level `settings`:

```ts
chrome.runtime.onInstalled.addListener(() => {
  void queueDomains(settings.allowedDomains);
  void queuePrograms(settings.allowedPrograms ?? []);
});
```

But `settings` is only filled in by the callback of a `chrome.storage.local.get`, which is
**asynchronous**, and Chrome dispatches onInstalled inside the window before it returns. So
`settings` was still `DEFAULT_SETTINGS` — the built-in domain list, and `allowedPrograms:
[]`. `queueDomains`/`queuePrograms` **replace rather than merge** (`p_domains`, `p_programs`
in `apply_score_delta`), so that posted the defaults as the user's whole whitelist and the
server deleted the rest. `applyState()` then did its job perfectly and copied the result
back over local storage, so the evidence was consistent everywhere and looked like the
edit had never been saved.

Nothing here is individually wrong, which is why it survived: the listener is right to
seed, `queueDomains` is right to replace, and `applyState` is right to trust the server.
The bug is only in *when* the first one runs.

*Fix.* A `settingsReady` promise resolved by the storage callback, awaited by the listener
before it reads `settings`. The rule it encodes is the general one: **anything in a
lifecycle listener that reads `settings` and then writes that reading anywhere must await
`settingsReady` first** — the module's initial value is not the user's configuration, it
is a placeholder that happens to be a valid-looking whitelist.

Not fixed by gating on `details.reason === 'install'`: that hides this path but leaves the
same trap for the next listener, and a genuine update should still be able to seed.

### `SECURITY DEFINER` functions were callable with any `user_id`
**Status: fixed — 408fcec (migration `20260729210000`)**

*The serious one.* Postgres grants `EXECUTE` to `PUBLIC` by default on a new function. Four
functions were created `SECURITY DEFINER` — so they run as the owner and **bypass RLS** —
while taking a `user_id` **parameter**, and none had that default revoked.

`build_state(uuid)` was the worst: any signed-in user, and `anon`, could call it with
somebody else's UUID and receive their **entire state** — live score, 7- and 30-day
averages, whitelisted domains and 30 days of history. A complete, read-only, total RLS
bypass. `roll_forward(uuid)` let anyone end another user's day early; `refresh_rollup(uuid)`
was an unauthorised write to another user's summary row.

RLS on the tables was correct throughout and was never the weakness. `SECURITY DEFINER` is
precisely the mechanism for stepping around it.

*Fix.* `build_state` no longer takes a `user_id` at all: it reads `auth.uid()` itself and is
`SECURITY INVOKER`, so it is **structurally unable** to return another user's rows rather
than merely forbidden from doing so — a future careless `grant execute … to authenticated`
cannot reopen it. The cross-user maintenance functions stay `DEFINER` (pg_cron must write
across every user) with `EXECUTE` revoked from `anon`, `authenticated` and `PUBLIC`.

> **The rule this leaves behind:** a `DEFINER` function must not take a user id.
> `get_member_profile(p_user)` is the single deliberate exception, and it is safe *only*
> because its body refuses any target `can_see_user()` rejects. Delete that check and it
> becomes a full dump of any user by id.

### The competition-kind migration failed on existing rows
**Status: fixed — 4bea01d**

*Symptom.* The migration adding competition *kinds* (individual vs team) aborted with a
duplicate-key error on real data.

*Cause.* Typing a competition retroactively invalidates entries made by the other route,
and `(competition, user_id)` becomes unique from that migration onward. Anyone who had
entered by both routes broke the insert.

*Fix.* A reconciliation `do` block **before** the ranked table is rebuilt, deleting the
entries the new type makes illegal and `raise notice`-ing how many — it deletes real
opt-ins, so it says so. Plus a `distinct on (competition, user_id)` **seatbelt** in the
refresh: the rule lives at the doors, but this runs from `pg_cron` every minute and one
stray duplicate would abort the refresh and freeze **every** leaderboard on the last good
snapshot. Losing a duplicate row beats losing all the boards.

### Two parallel token refreshes signed the user out
**Status: fixed by design — `server/auth.ts`**

Supabase **rotates the refresh token on use**, so two concurrent refreshes race and the
loser holds a token that no longer exists. Refreshes are collapsed into a single in-flight
promise.

### Google sign-in did not work in Brave
**Status: fixed by design — `server/auth.ts`**

`chrome.identity.getAuthToken` is Chrome-only and absent in Brave. Sign-in uses
`launchWebAuthFlow` instead, exchanging Google's `id_token` for a Supabase session.

### `/auth/v1/authorize` returned `400 … missing OAuth secret`
**Status: fixed — design changed**

The first sign-in design routed PKCE through Supabase's `/authorize`, which requires a
Google **client secret** configured in the Supabase project. This project has none, so it
failed with *"Unsupported provider: missing OAuth secret"*. Rewritten to the Google
`response_type=id_token` → Supabase `grant_type=id_token` route, with the nonce sent
**hashed to Google and raw to Supabase**. Caught by testing, not by reading — the failure
mode was indistinguishable from a bad redirect URI until the error body was read.

### The local rollover and the server rollover disagreed
**Status: fixed — 79ace40**

The extension ended the day at **local midnight**; the server ends it at **01:00 in the
user's timezone**. The two boundaries are an hour apart, so the client zeroed the score at
00:00 and the next server reply put it back. The local rollover was deleted outright: the
server owns day boundaries, and `state.scoreDate` comes from the server's `live_day`.

> **Consequence, by design:** with no server configured, or signed out, nothing ever ends a
> day. The live score grows indefinitely and no history is banked.

### Reconciled scores were posted straight back, compounding
**Status: fixed — 5ad1e19**

`applyServerScores()` writes through `writeState()`, **not** `updateState()`. `updateState`
is the sync hook: it diffs `focusScore`/`distractedScore` and queues the difference — so
feeding it the server's own reply posts that reply back as a delta, compounding on every
round trip. The reconciled value is `server + still_pending`, because deltas queued
mid-flight are not in the server's figure yet and dropping them makes the number jump twice.

### A local Postgres with pgcrypto in `public` hid a Supabase-only failure
**Status: fixed — `20260812110000_pairing_search_path.sql`**

*Symptom.* Pairing a phone failed at the first step. The popup said the server refused
the request; the service worker logged `create_pairing failed (400)`.

*Cause.* `create_pairing` was declared `set search_path = public` and called
`gen_random_bytes(16)` unqualified. **Supabase installs pgcrypto into the `extensions`
schema**, not `public`, so the call resolved to nothing:
`function gen_random_bytes(integer) does not exist`. `20260730160000_team_passwords.sql`
had already documented this for `crypt()`/`gen_salt()` — the trap was known and the new
migration walked into it anyway.

*Why testing missed it.* The migrations were verified against a scratch PostgreSQL
instance where `create extension pgcrypto` put the functions in `public`, which is the
default everywhere except Supabase. The broken version passed locally and failed only in
production. **A local database is not a copy of Supabase**; when a migration touches an
extension, reproduce the layout (`create schema extensions; create extension pgcrypto
with schema extensions;`) or the test proves nothing.

*Fix.* `set search_path = public, extensions`, with the call left unqualified — which
resolves on Supabase and on a plain install both, and a schema in `search_path` that does
not exist is ignored rather than an error. `extensions.gen_random_bytes(...)` was the
other option and is worse: it hard-codes the Supabase layout into a file that also has to
run locally, which is where the bug hid in the first place.

*Also worth knowing.* The migration that shipped the bug was already applied to
production, so the fix is a NEW migration rather than an edit. Editing an applied
migration fixes fresh installs and leaves every existing database broken.

### Web Push encryption is unverifiable by inspection, so it was verified by decryption
**Status: verified — `src/extension/push.ts`**

*The trap.* RFC 8291's `aes128gcm` payload is two HKDF rounds over an ECDH secret, and
every way of getting it wrong produces the **same symptom**: the push service accepts the
POST with a 201 and the phone silently shows nothing. A swapped key order in `key_info`, a
missing `\0` in a label, the `0x02` last-record delimiter left off the plaintext, the
record size written little-endian — all of them look exactly like "notifications don't
work on my phone", which is also what a wrong browser setting, a Doze delay and an
expired subscription look like.

*What was done.* Before shipping, `sendPush()` was driven with `fetch` stubbed and its
captured body **decrypted by an independently written receiver** playing the phone: an
ECDH keypair standing in for the device, the derivation run in reverse, AES-GCM opened,
the delimiter and the JSON checked. The VAPID JWT was verified against the advertised
public key, `aud` checked against the endpoint's origin, and a 410 confirmed to prune the
subscription. The test is not in the repo because it needs no fixture and no network — it
is thirty lines and recreating it is faster than maintaining it — but **recreate it before
touching the crypto**: the alternative is debugging silence on a phone.

*Related trap, same file.* `TTL: 0` is deliberate and looks like a mistake to anyone
tidying up. It means "deliver now or drop", which is right for a nudge that is only
meaningful during a five-second warning. Raising it to a "safer" value buys nothing except
notifications that arrive after the penalty has already landed.

### `start_url` threw away the pairing code on the way into the iPhone app
**Status: fixed — `web/manifest.webmanifest`, `web/app.js`**

*The symptom.* On iPhone: scan the QR, the page opens, Add to Home Screen, tap the new
icon — and the app says **"Start on your computer: scan the QR code"**. The QR it had just
scanned. No notification prompt ever appeared, so the phone could never pair.

*The cause.* `manifest.webmanifest` declared `"start_url": "./"`. **When a manifest names a
start_url, that is what the installed app launches — not the URL that was on screen when it
was added.** The pairing code travels as `?p=<nonce>.<vapid key>`, so the Home Screen icon
opened a codeless page. The comment in `app.js` asserting that "Add to Home Screen saves
the URL Safari is currently showing" was true only for the pre-manifest path.

*Why the fallback did not fire.* The code was also mirrored to `localStorage` "so whichever
survives, one of them is there". Neither survives on iOS: **a Home Screen web app gets its
own storage partition, separate from Safari's**, so anything the tab wrote is invisible to
the app. The belt and the braces were the same belt — two carriers that both ride on the
same install boundary, chosen without checking whether either crosses it.

*The fix, in two independent layers.*
1. **`start_url` removed entirely.** Absent, the spec defaults it to the document URL, so
   the query string comes along. There is a loud comment beside the `<link rel="manifest">`
   because a missing key in a JSON file is exactly the kind of thing someone helpfully adds
   back, and JSON cannot hold the comment itself.
2. **The clipboard**, which is the only channel that genuinely crosses the partition: the
   iOS steps keep the pairing **link** on screen with a Copy button, and the installed app
   offers to paste it back. Most users will never see either.

*And the fallback needed a fallback.* The first version of that button called
`navigator.clipboard.writeText` and, on failure, revealed a `readonly` field for the user
to copy by hand. On a real iPhone it appeared to do nothing: the async API is refused far
more often than its spec suggests, **and iOS will not select the contents of a readonly
field**, so the rescue failed as silently as the thing it was rescuing. Now the field is
visible from the start (long-press → Copy needs no permission at all), and the button
tries the async API, then selection + `execCommand` with `readonly` lifted for the call.
It also copies the **whole link** rather than the bare code — that is what is already in
Safari's address bar, so the user has a fourth route that involves none of our code.

*The general lesson.* "Two mechanisms, one will work" is only true if they fail
independently. Both of these were downstream of the same platform boundary, so the
redundancy was imaginary — and the platform in question could not be tested on the
development machine, which is precisely when a stated fallback deserves to be checked
rather than assumed.

### Apple rejected every push over one word in the VAPID token
**Status: fixed — `vapidSubject()` in `src/extension/push.ts`**

The VAPID JWT's `sub` claim was `mailto:focus-extension@localhost`. **`localhost` is not a
domain**, and `web.push.apple.com` validates that claim: 403, every push, forever. FCM
accepts the identical token without comment, so nothing on Android and nothing in the
decrypt-it-yourself verification ever saw it — the test proved the *payload* was right and
said nothing about whether a real service would take the *token*.

It presented as everything except a token problem. Pairing completed, the phone showed
✅ Paired (that is `claim_pairing` succeeding, which involves no push at all), and then the
phone simply never buzzed. `sub` now comes from `PUSH_LANDING_URL` — an `https:` URL, the
sender's only public face, and always set whenever a subscription can exist.

*The second bug, which hid the first.* `sendPush` pruned the subscription on 401/403 as
well as 404/410, reasoning that a rejected token stays rejected. Same premise, wrong
conclusion: **401/403 are about the sender**, so they fail identically for every device —
and when the fault is ours, deleting the pairing destroys the user's setup over a bug they
cannot see and throws away the evidence. The visible symptom was a *Send test buzz* button
greyed out with no phone listed, minutes after a successful pairing. Only 404/410 prune
now; 401/403 keep the subscription and log the service's own explanation (Apple names it —
`BadJwtToken`), which is the difference between a diagnosis and a guess.

*The lesson worth keeping.* Two push services are not one interface with two
implementations. Every failure here was Apple enforcing something Google ignores, and the
only way to find any of them was a real iPhone: a stubbed `fetch` verifies your crypto, not
their acceptance criteria.

### The pairing test fired at the one moment iOS cannot show it
**Status: fixed — `TEST_PUSH_TTL_S`, and the wording on both surfaces**

Pairing succeeded, Apple accepted the push (`delivered > 0`, so the desktop said "your
phone should have just buzzed") and the phone showed nothing. Neither half was broken:

**iOS does not display a notification while the web app it belongs to is the app on
screen.** Native apps opt into that with `UNUserNotificationCenterDelegate`; a web app has
no equivalent and no way to ask. The confirmation push is sent the instant the desktop
collects the subscription — which is one or two seconds after the user tapped *Allow*, so
by construction they are staring at the one app whose notifications are being suppressed.
The single most confusing possible moment to prove the feature works.

Made worse by `TTL: 0`. Right for a nudge (a warning that arrives after the penalty is
worse than none), actively wrong for a test: the push service is told to discard rather
than queue, so it could not arrive later either. Tests now use `TEST_PUSH_TTL_S` (5
minutes) and the nudge keeps the default 0 — the TTL is a parameter precisely because
those two messages have opposite deadlines.

The rest is wording, which is most of the fix: the popup says *leave the app or lock the
phone* instead of promising a buzz, and the app's own "Paired" card leads with **close
this app to see it**. Also worth knowing, and now in the README: **Safari never appears in
Settings → Notifications on iOS**, because the notification belongs to the installed web
app — the entry is called *Focus*, and it does not exist until permission is granted
inside the app.

### Reopening the paired app said the code had expired
**Status: fixed — `focusPairedCode` in `web/app.js`**

A Home Screen web app relaunches at the URL it was installed with, so it reopens carrying
the same `?p=` code every time — and that code is single-use and deleted from the server
the moment the desktop collects it. The app had no memory of having spent it, so it
offered the pairing flow again and `claim_pairing` answered false: **"that pairing code has
expired or was already used"**, shown to a user whose pairing had just completed perfectly.

It now records *which* code it spent and shows the finished card instead. Which code, not
merely that one was spent: a new QR from the desktop carries a different code and must
still be able to re-pair the same phone.

### A pairing outlived the popup that was watching it
**Status: fixed — `PUSH_PAIR_RESUME` / `PUSH_PAIR_CANCEL` + the `focus-pair-poll` alarm**

Found while fixing the entry above. Polling for the phone's answer lived in the popup's
2-second ticker — and **a Chrome popup closes the moment the browser loses focus**, which
during the iPhone flow is not a risk but a certainty: the user is holding a phone through
six taps and several minutes. So the claim landed on the server and nobody ever collected
it; `take_pairing` was never called and the row expired.

Worse, reopening the panel showed the Android/iPhone buttons again, and pressing one called
`create_pairing`, which **deletes the caller's outstanding rows** — destroying the pairing
the phone was on its way to claim.

The pending nonce now lives in `chrome.storage.local` and the poll on a `chrome.alarms`
job, for the same reason every other periodic task here does: a suspended worker's timers
do not fire. The popup asks `PUSH_PAIR_RESUME` on open and rejoins the QR already in
flight. One minute of alarm granularity is fine — the popup's own 2-second poll still makes
the ✓ instant whenever somebody is actually watching.

### A program in the page whitelist would have matched half the web
**Status: designed around — `20260812090000_program_flags.sql`**

Adding red flags for programs invited a `kind` column on `domain_flags` and
`user_domains`. It was rejected because `build_state()`'s `domains` array is written
straight into `Settings.allowedDomains`, which `heartbeat.ts` **substring-matches against
every URL**. One forgotten `where kind = 'domain'` in one of the several readers would put
`code` into the page whitelist, where it matches vscode.dev, qrcode.com and any URL
containing those four letters — the extension would start counting arbitrary browsing as
work, with nothing on screen to say why and nothing in the diff that looks wrong.

Parallel tables (`user_programs` / `program_flags` / `program_flag_events`) cost some
duplicated function bodies and make that failure unrepresentable. The shared thing is the
one that should be shared: the weekly budget in `user_flags`, which both `flag_domain` and
`flag_program` contend on, so a flag really is one flag spent on either kind.

### `ArXiv.org` and `arxiv.org` would have been two different domains
**Status: fixed before it could bite — `domain_flags`**

`flag_domain` lower-cased its input; `user_domains` did not. Two tables that are joined on
the domain string could therefore hold rows that never match, so a flagged domain would show
no flags. Caught while writing the flag registry; domains are lower-cased on write
everywhere now. Worth recording because the two writers are in different migrations and
nothing in the schema forces them to agree.

### One-team-per-competition has to be enforced at two doors
**Status: by design — `enroll_team` *and* `join_team`**

"At most one of your teams may be in any one competition" spans `team_members` and
`team_competitions`, so **no table constraint can express it** — unlike every other
duplicate rule here, which is a composite primary key and therefore impossible to forget.
It is checked in both `enroll_team` and `join_team`, because guarding only enrolment leaves
*joining a team that is already entered* as a way in. `enroll_team` must check **every**
member of the team, since whoever presses the button is rarely the person the clash belongs
to.

### A password column cannot be hidden with RLS
**Status: fixed by design**

RLS filters **rows**, not columns, so a `password_hash` column on `teams`/`competitions` is
visible to any client that can see the row. Withheld with column-level
`GRANT SELECT (name, created_by, created_at)` instead. `join_team` and `enroll_team` are
therefore `SECURITY DEFINER` (they must read that column) — which makes the explicit
`user_id = auth.uid()` and membership predicates inside them **load-bearing, not
redundant**.

### The `*/5` cron cadence is a correctness property
**Status: by design, do not "optimise"**

`pg_cron` schedules are one wall-clock moment in UTC, while users are in every timezone. A
`0 1 * * *` job would end the day at 01:00 UTC for everyone. The rollover and the weekly
flag grant run **every five minutes**, each pass asking per user whether *their* local day
or week has turned. That bounds how long after a user's local 01:00 their day turns — so
the jobs are pruned to fit the cadence, not the other way round. `pg_cron` is **required**,
not optional.

---

## Build, tooling and process

### `$pid` is read-only in PowerShell
Assigning to it in the Windows foreground helper silently broke the script. Renamed to
`$procId`.

### A backtick inside a TypeScript template literal
A `` `state` `` written inside a comment *within* a template literal terminated the literal
and produced a `TS1005` several lines later. The rule: nothing inside a template literal is
a comment, including things that look like prose.

### `ChildProcessWithoutNullStreams` does not describe `stdio: ['ignore','pipe','pipe']`
The helper child ignores stdin, so its type is `ChildProcessByStdio<null, Readable,
Readable>`. It must also be assigned to a local `const` before use, or the narrowing is
lost across the closure boundaries.

### `status` collides with the DOM global
A variable named `status` in a renderer silently shadowed `window.status` (a string), so
type errors appeared far from the declaration. Renamed to `appStatus`.

### PowerShell 5.1 mis-reads a BOM-less script
**Status: fixed pre-emptively**

Windows PowerShell 5.1 reads a `.ps1` without a byte-order mark as the **system ANSI
codepage**, so any non-ASCII byte comes back mangled — and a mangled character inside the
embedded C# type definition would be a compile error on somebody else's machine and nowhere
else. The generated script is written with a UTF-8 BOM *and* kept to plain ASCII.

### `--disable-features=Vulkan` did not silence the Wayland/Vulkan error
Reverted rather than shipped, because the comment justifying the flag would have claimed
something untrue. Noise in the console is better than a lie in the source.

---

## Still open / accepted

| | |
|---|---|
| **macOS cannot pin the companion window** | No public API lets a process change another application's window level. Every utility that does it is an Accessibility-granted window manager. The agent deliberately does not try — asking for that permission is what it is built to avoid. Documented with three helper apps in the README. |
| **KDE and wlroots report no foreground program** | Same shape as the GNOME bridge (a KWin script; `swaymsg`/`hyprctl`) and simply not implemented. Those sessions fall back to browser-only tracking, which is exactly the behaviour with no agent installed. |
| **Installing the GNOME bridge needs a logout** | Not fixable — see the entry above. |
| **The Windows pin is untested on real hardware** | Written and reviewed, never run: there is no PowerShell on the development machine. The two things most likely to be wrong are the exact window title Chromium gives a popup window, and the script's encoding (handled pre-emptively above). The **GNOME** pin — same design, same title match, same 900×700 ceiling — is **confirmed working** on real hardware, so the shape is sound and it is the platform half that is unproven. |
| **The extension ID is not pinned** | No `"key"` in `manifest.json`, so the ID changes when the unpacked folder moves. This is *why* the agent uses a loopback port rather than native messaging, and why the extension cannot start the agent itself. Pinning it is a deliberate open decision, not an oversight. |
