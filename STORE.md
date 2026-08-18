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
| **2. Privacy policy URL** | **Done and live**: <https://noveroandrea.github.io/focus/privacy.html> (`gh-pages` carries `web/`, contact address filled in). Paste that into *URL norme sulla privacy*. Re-deploy after any edit to `web/`: `git subtree push --prefix web origin gh-pages`. |
| **3. Store icon** | Upload **`store/icon-128.png`** — 128×128, the mark inset into the middle 96×96 with transparent padding, which is the framing the listing asks for. (`icons/icon128.png` is the full-bleed version that ships *inside* the package; both are the same artwork, so the tile and the toolbar match.) |
| **4. Screenshots** | The six in **`screenshots/focus_*.png`**, all 1280×800 (the store takes only that or 640×400, landscape). `notifications.png` is the raw phone capture they came from — portrait, and JPEG bytes under a `.png` name, so it is rejected on both counts; `focus_notification.png` is it letterboxed onto a 1280×800 slate canvas rather than cropped, because cropping cuts off the notification text the shot exists to show. **No mock data** — reviewers reject screenshots that show a UI the extension does not produce. |
| **5. Promotional tiles** | Optional, but the small one is what the store shows in category and search listings, so an item without it is a plain text row. Upload **`store/promo-small-440x280.png`** and **`store/promo-marquee-1400x560.png`** (the marquee only ever appears if the store features the item). Both are **24-bit RGB with no alpha**, which the dashboard requires and rejects silently. Regenerate with `python3 scripts/make-promo.py`. |
| **6. The OAuth redirect URI** | See the blocker below. Do this *before* you tell anyone to install it. |
| **7. Ethics** | This build ships the study backend. Whatever your ethics approval says about consent, the extension is now the thing collecting the data — the consent flow has to exist before the listing goes public, not after. |

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

**`windows` — removed, and do not put it back.** It sat in `permissions` from the first
commit and is **not a permission Chrome recognises**: the `chrome.windows` API is available
to every extension, and URL access through it comes from `tabs`, which is declared. All ten
`chrome.windows` calls in `background.ts` — the companion window, `onFocusChanged`,
`getLastFocused` — work exactly as before without it. What it bought was the install-time
warning *"Permission 'windows' is unknown or URL pattern is malformed"*, which a reviewer
mid-review can see. The dashboard asking for a justification for every other permission in
the manifest and not this one is how you can tell.

**`system.display`** — `To place one floating companion window on each monitor, bottom-right of each. Without it the windows all open on the primary display, stacked on top of each other.`

**`identity`** — `Google sign-in via launchWebAuthFlow, requesting only "openid email profile", so scores follow the user's account across devices. No other Google data is requested or accessed.`

**`downloads`** — `To hand the user the optional desktop-agent installer, which ships inside the extension package. It is the only file ever downloaded, and it comes from the extension itself rather than the network.`

**`host_permissions` for `https://*.supabase.co/*`** — `The study's own backend, which stores the user's scores and whitelists under row-level security.`

**`host_permissions` for `http://127.0.0.1:47317/*`** — `The optional desktop agent, which runs on the user's own machine and answers one question: which program is in the foreground. Loopback only.`

**Remote code** — answer **`No, I do not use Remote code`**:

```
All JavaScript that runs is inside the package. There is no eval(), no new Function(), no
importScripts(), and no script element pointing at a URL — every script tag in the four
HTML pages is a relative path to a bundled file. The extension does make network requests
(the study backend, the user's own AI endpoint, the loopback desktop agent, Web Push), but
every one of them exchanges JSON or plain text that is parsed as data. None of it is
evaluated as code.
```

---

## Test instructions (the dashboard's "Istruzioni per il test")

**This section is not optional for this build, and the reason is `Popup.tsx`.** With a
server configured in `config.ts` — which it is — the popup is *gated*: signed out, the only
thing that renders is the sign-in screen, so a reviewer pressing the toolbar button reaches
a wall and can see no setting, no whitelist and no score.

What saves the review is that the **companion itself needs no account**. The content
scripts read the whitelist straight out of storage and `DEFAULT_SETTINGS.allowedDomains`
ships with `wikipedia.org` on it, so the core feature is one navigation away from a fresh
install. Lead with that, then hand over the account for the rest.

**Ulteriori istruzioni** (492 of the 500 characters allowed):

```
No account is needed for the core feature. After installing, open en.wikipedia.org - it is on the default whitelist. An animated character appears in the page: type or move the mouse and it steps and shrinks; after ~30s it bursts into fireworks and a new one starts. Stop for 20s and it trembles, cries and the score falls. A site not on the whitelist is untouched: nothing drawn, counted or sent.

The toolbar popup (settings, whitelist, scores) needs Google sign-in - use the account above.
```

**Nome utente / Password** — a **dedicated throwaway Gmail account**, created for this and
nothing else. Never the personal one: the box is shared with the review team, and the
account will be signed into from a machine and a country that are not yours.

Three things decide whether that account actually works, and all three are outside the
extension:

1. **Two-factor authentication off.** A reviewer cannot answer a prompt on your phone.
2. **The OAuth consent screen must be *In production*.** While it is in *Testing*, only
   the accounts listed as test users can sign in — so the credentials you hand over fail
   with a Google error that looks nothing like an extension bug.
3. **The published extension's `chromiumapp.org` redirect URI must be registered** (see
   the blocker above). Same failure, same confusion.

Even with all three right, Google routinely blocks a sign-in from an unfamiliar device and
location, and there is nothing you can do about it from here. That is exactly why the
instructions put the no-account path first: if the credentials fail, the reviewer has still
seen the extension's core function.

*If this ever becomes a recurring review problem, the structural fix is to ungate the
popup — whitelist and settings signed out, sign-in only for sync and teams. It is a real
change, not a tweak: the gate is deliberate, because the study wants participants signed
in. Do not do it just to make one review easier.*

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
| Web history | **Yes** — see the note below |
| User activity | **Yes** — whether the user was active, per second, on pages they whitelisted |
| Website content | No |

**On "Web history", which is the one genuinely arguable tick.** Nothing here keeps a
browsing log: the server stores the *domain strings the user typed into their own
whitelist* (`user_domains` — the whitelist and an `added_at`, no visits, no timestamps of
visits), and the scores are one number a day.

But `classifyPage()` sends `URL: <url>\nTitle: <title>` in the body of a request to the AI
endpoint, which is a visited page's address and title leaving the machine. It is off by
default and its default address is `localhost`, so for most users this never happens — and
none of it is retained. **Tick Yes anyway.** Under-declaring is the mistake with teeth (it
gets an item pulled after the fact); over-declaring costs a label on the listing. A
reviewer reading the source will find that string in a `fetch` body, and "we decided it
did not count" is a much worse conversation than the disclosure. Say exactly this:

```
Only when the user switches on the optional AI classifier, which is off by default. In
that one case the address and title of a page they are visiting are sent to the endpoint
THEY configured, to get back a yes/no about whether it is study material. The default
endpoint is a model on their own computer (http://localhost:11434), so by default nothing
leaves the machine. Nothing is retained: no visit log, no history, no timestamps of
visits. The extension's own backend never receives a URL — it stores the whitelist the
user typed and one score per day.
```

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
