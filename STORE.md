# Publishing Focus to the Chrome Web Store

Everything the submission needs, in the order the dashboard asks for it. Copy the text
blocks verbatim — the permission justifications are the part reviews stall on, and they
are written to answer the reviewer's actual question ("why does it need *that*?") rather
than to restate the manifest.

```bash
npm run package        # build + focus-<version>.zip, ready to upload
```

---

## Before you upload (things only you can do)

| | |
|---|---|
| **1. Developer account** | $5 one-time fee at <https://chrome.google.com/webstore/devconsole>. Verify the publisher email; an unverified publisher cannot publish. |
| **2. Privacy policy URL** | `web/privacy.html` is written and ready. Deploy it: `git subtree push --prefix web origin gh-pages`, then use <https://noveroandrea.github.io/focus/privacy.html>. **Fill in `[contact email]` first** — it is the only placeholder in the file, and a policy with no contact is a rejection. |
| **3. Screenshots** | At least one, 1280×800 or 640×400 PNG. The obvious three: the popup on a whitelisted page, the companion window over an editor, the dashboard. **No mock data** — reviewers reject screenshots that show a UI the extension does not produce. |
| **4. The OAuth redirect URI** | See the blocker below. Do this *before* you tell anyone to install it. |
| **5. Ethics** | This build ships the study backend. Whatever your ethics approval says about consent, the extension is now the thing collecting the data — the consent flow has to exist before the listing goes public, not after. |

### ⚠ Blocker: publishing changes the extension ID, which breaks sign-in

`chrome.identity.getRedirectURL()` returns `https://<extension-id>.chromiumapp.org/`, and
`src/extension/server/auth.ts` sends that as the OAuth redirect URI. An unpacked extension
has a locally generated ID; a **published** one gets a permanent ID from the store — so the
first thing a real user does (press *Sign in with Google*) fails with
`redirect_uri_mismatch` until you fix it.

After the first upload, take the item's ID from the dashboard and:

1. Google Cloud Console → APIs & Services → Credentials → your **Web application** OAuth
   client → *Authorized redirect URIs* → add
   `https://<published-extension-id>.chromiumapp.org/`.
   Keep the old one too, so your unpacked dev copy keeps working.
2. Supabase → Authentication → Providers → Google → check the client ID is still listed
   under *Authorized Client IDs* (unchanged, but worth confirming while you are there).
3. Publish the OAuth consent screen (**In production**, not *Testing*) — a Testing app
   only lets the accounts you listed sign in, which is exactly the symptom "it works for
   me and nobody else".

Optional and worth it: paste the item's `key` from the dashboard into `manifest.json` so
your local unpacked build gets the *same* ID as the published one. Then one redirect URI
covers both, forever.

---

## Listing

**Name** (45 max)

```
Focus — stay on task
```

**Short description** (132 max)

```
An animated companion that reacts to your focus: it grows calm while you work and cries when you drift. For studying and working.
```

**Category:** Workflow & Planning · **Language:** English

**Detailed description**

```
Focus puts a small animated companion on the pages you decide are work. While you are
working it steps along and slowly shrinks — a reward for sustained attention — and when it
reaches its smallest size it bursts into fireworks and a new character takes over. Stop,
and it starts to tremble, then cries, and the points you earned start coming back off.

It works on a whitelist you write yourself. Every other page is left completely alone —
no companion, no counting, nothing injected. Add the page you are on with one click from
the popup or from the companion itself.

WHAT IT IS FOR
Anyone who loses the thread — through ADHD or ordinary distraction — while studying or
working. The idea is not to block anything. Nothing is blocked. It is to make the moment
you drift away visible at the moment it happens, instead of an hour later.

WHAT IT DOES
• A companion in the page — roaming, parked, or a full panel with your score and
  countdown. Or no companion at all: turn the drawing off and keep the scoring.
• A floating window that can sit on another screen while you work outside the browser.
• Scores per day, weekly and monthly averages, a calendar heatmap, and a full dashboard.
• Teams, friends and competitions — opt-in, password-protected, for studying alongside
  other people.
• An optional phone nudge: your own browser sends your own phone a notification the
  moment you drift, counting down what the lapse is about to cost. It is encrypted so
  only your phone can read it, and no server ever learns it was sent.
• An optional desktop agent (Windows, macOS, Linux) so work OUTSIDE the browser — a
  LaTeX editor, a PDF reader, a terminal — counts as work instead of looking like you
  walked away. It reports the name of the foreground program and nothing else: never a
  window title.
• An optional AI classifier, off by default, that can decide whether an unknown page is
  study material. It can point at a model running on your own machine, so nothing leaves
  it.

PRIVACY
Focus measures WHETHER you are working, not what you are working on. It records no
browsing history, no page content, no keystrokes and no window titles. Your URL is never
sent anywhere unless you switch on the AI classifier, and its default address is your own
computer. Full policy: https://noveroandrea.github.io/focus/privacy.html

Focus is free software under the GPL-3.0, developed as part of doctoral research at the
University of Padova. Source: https://github.com/noveroandrea/focus
```

**Single purpose** (the dashboard asks for one sentence, and a vague answer here is the
most common cause of a slow review)

```
Focus helps a user sustain attention on tasks they have designated as work, by showing an
animated companion that reacts to their activity on those pages and scoring their focus
over the day.
```

---

## Permission justifications

One box each in the dashboard. Every claim is true of the code; do not soften them.

**`host_permissions` for `http://*/*` and `https://*/*` (broad host access)** — the one
that gets asked about:

```
The companion is drawn into the page the user is working on, and which pages those are is
decided by the user's own whitelist — any site can be on it (a university library, a lab
wiki, an internal tool), so the set cannot be enumerated in advance. The content scripts
therefore match broadly but act narrowly: on any page not on the user's whitelist they
draw nothing, count nothing and send nothing. No page URL or content is transmitted or
stored by the extension.
```

**`tabs`** — `To read the URL of the active tab and compare it against the user's whitelist, so the extension knows whether the current page is one they said counts as work, and can colour the toolbar icon accordingly.`

**`activeTab`** — `To act on the page the user is looking at when they press "whitelist this page" in the popup, and to reload it so the companion appears immediately.`

**`scripting`** — `To inject the companion into a page that was already open when the user whitelisted it, without asking them to reload.`

**`storage`** — `To keep the user's settings, whitelists and daily scores. Chrome's storage is also the only place a suspended MV3 service worker can leave state.`

**`idle`** — `The extension's entire function is noticing when the user stops working. chrome.idle is what reports OS-wide inactivity, which is the only way to distinguish "reading a PDF in another window" from "walked away".`

**`alarms`** — `An MV3 service worker is suspended constantly and its timers do not fire. Alarms are used for the periodic server check-in and to finish a phone-pairing flow that takes minutes on another device.`

**`windows`** — `To open and track the floating companion window, and to know which browser window has focus.`

**`system.display`** — `To place one floating companion window on each monitor, bottom-right of each. Without it the windows all open on the primary display, stacked on top of each other.`

**`identity`** — `Google sign-in via launchWebAuthFlow, requesting only "openid email profile", so scores follow the user's account across devices. No other Google data is requested or accessed.`

**`downloads`** — `To hand the user the optional desktop-agent installer, which ships inside the extension package. It is the only file ever downloaded, and it comes from the extension itself rather than the network.`

**`host_permissions` for `https://*.supabase.co/*`** — `The study's own backend, which stores the user's scores and whitelists under row-level security.`

**`host_permissions` for `http://127.0.0.1:47317/*`** — `The optional desktop agent, which runs on the user's own machine and answers one question: which program is in the foreground. Loopback only.`

---

## Data-use disclosures

Tick honestly; a wrong tick here is what gets an item taken down later.

| Question | Answer |
|---|---|
| Personally identifiable information | **Yes** — email address (Google sign-in) |
| Health information | No |
| Financial and payment information | No |
| Authentication information | **Yes** — the sign-in session token, stored locally |
| Personal communications | No |
| Location | No |
| Web history | **No** — see the note below |
| User activity | **Yes** — whether the user was active, per second, on pages they whitelisted |
| Website content | No |

**On "Web history":** the extension stores the *domain strings the user typed into their
own whitelist* and never records which pages they visited or when. If a reviewer reads
"whitelist" as history, the honest expansion is the sentence above — say it in the
justification box rather than ticking a box that implies a browsing log exists.

Then certify all three: **not sold to third parties**, **not used for anything unrelated
to the single purpose**, **not used to determine creditworthiness or for lending**.

---

## Two risks worth knowing before you submit

**1. The package contains `.sh` and `.ps1` files** (`agent/`, ~85 kB each — the
self-contained desktop-agent installers). They are inert data: nothing in the extension
executes them, the browser cannot, and the user downloads one deliberately. They are also
plain text with the agent's own source inside, so a reviewer can read every line. Still,
a package containing an installer for a native program is unusual enough to draw a
question. If it is rejected on those grounds, the fix is small: deploy the two files to
the GitHub Pages site next to `privacy.html` and have the popup link them instead of
serving them from the bundle. Do not do it pre-emptively — hosting them means they can
drift from the extension that offers them, and today they cannot.

**2. Review takes days, and the first version sets the ID.** Upload as **Unlisted**
first, install from the store link yourself, and check the OAuth redirect fix above
actually works before going public. An item's ID never changes, so this is the one
mistake with no cheap undo.

---

## Every release after the first

```bash
# bump "version" in manifest.json  (the store rejects a re-upload of the same version)
npm run lint && npm run package
```

Upload the new zip to the same item. Anything that adds a permission re-triggers a full
review and, for broad ones, can silently pause automatic updates for existing users until
it clears — so add permissions in a release you are willing to wait on.
