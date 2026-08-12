# Focus — phone pairing page

The one page a phone ever opens. It turns a scanned QR code into a **Web Push
subscription** that the user's own browser can send to, and then gets out of the way:
no account, no score, no state beyond the pairing code it was opened with.

It exists as a hosted page rather than a page inside the extension for one reason:
**push needs a service worker, and a service worker needs HTTPS.** A
`chrome-extension://` URL means nothing on a phone.

## What it is not

**It is not where notifications come from.** Those are sent by the extension's own
service worker straight to the push service (FCM for Chrome, APNs for Safari), signed
with a VAPID keypair generated on the user's machine and never uploaded. This page
only tells the desktop *where to send*. See `src/extension/push.ts`.

The server's entire involvement is a ten-minute courier: `push_pairings` in
`supabase/migrations/20260812100000_push_pairing.sql`, which carries one subscription
from the phone to the desktop and deletes the row on collection. **No Edge Functions,
and no record of a nudge ever reaching anybody.**

## Deploy it

Five files, no build step, any static HTTPS host. **Use GitHub Pages** unless you have
a reason not to — the repo is already there, and the URL is short, which keeps the QR
code sparse and easy to scan.

### GitHub Pages (recommended)

```bash
# 1. commit the folder on whatever branch you are on
git add web && git commit -m "add the phone-pairing page"
git push origin <your-branch>

# 2. publish just that folder to a gh-pages branch
git subtree push --prefix web origin gh-pages
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → Branch: `gh-pages`,
folder `/ (root)` → Save.** Wait a minute, then open
`https://<your-user>.github.io/<repo>/` — you should see *"Start on your computer"*.
That is the page working: it has no pairing code yet, which is exactly right.

Re-run the `subtree push` after any change to `web/`.

### Supabase Storage (if you would rather not use Pages)

A **bucket** is Supabase's file store — it serves any file you upload over HTTPS, which
is all this page needs. In the dashboard: **Storage → New bucket**, name it `focus`,
tick **Public bucket**, create it, then **upload the five files into the bucket root**
(`index.html`, `app.js`, `config.js`, `sw.js`, `manifest.webmanifest`, plus the two
icons).

Two things to get right, and both are easy to miss:

- **`sw.js` must sit at the same level as `index.html`**, not in a subfolder. A service
  worker may only control pages at or below its own path, so one in the wrong place
  controls nothing and no notification ever arrives.
- **Content types matter.** Storage serves the type recorded at upload, and a service
  worker delivered as `text/plain` is refused by the browser. The dashboard usually
  infers them correctly from the extension; check `sw.js` and `manifest.webmanifest`
  in particular, and fix them with the CLI if they are wrong:

  ```bash
  npx supabase storage cp web/sw.js ss:///focus/sw.js --content-type application/javascript
  ```

| File | Content type |
|---|---|
| `index.html` | `text/html` |
| `app.js`, `config.js`, `sw.js` | `application/javascript` |
| `manifest.webmanifest` | `application/manifest+json` |
| `icon-*.png` | `image/png` |

The URL is then
`https://<project>.supabase.co/storage/v1/object/public/focus/index.html` — long, but
it works. It makes for a denser QR code, which is the only real cost.

### Then tell the extension where it is

```ts
// src/extension/server/config.ts
export const PUSH_LANDING_URL: string = 'https://<your-user>.github.io/<repo>';
```

No trailing slash. Rebuild (`npm run build`) and reload the extension at
`chrome://extensions`. While it is empty the popup says phone pairing is unavailable
instead of showing a QR that leads nowhere.

`config.js` already carries the same Supabase URL and anon key as the extension, both
public by design. If you point the extension at a different project, change that file
to match.

## Pairing, end to end

```
 EXTENSION POPUP                    SUPABASE                      PHONE
 ───────────────                    ────────                      ─────
 Android? iPhone?
      │
      ├── create_pairing() ───────► push_pairings
      │   ◄── nonce                 (empty row, 10 min)
      │
      ├── QR: <url>?p=<nonce>.<vapid public key> ──────────────►  scan
      │                                                            │
      │                             claim_pairing(nonce, sub) ◄────┤ subscribe
      │                                                            │
      ├── take_pairing(nonce) ────► row returned AND DELETED       │
      │   ◄── subscription                                         │
      │                                                            │
      └── push (VAPID-signed, aes128gcm) ──► FCM / APNs ──────────►│ 🔔
                                             (never Supabase)
```

The nonce is 128 bits from `gen_random_bytes`, single-use, and good for ten minutes.
It is the phone's only credential — the phone is not signed in and never is — which
is why `claim_pairing` is the one function in the whole schema granted to `anon`, and
why it can do nothing but fill in a subscription on a row whose nonce the caller
already knew.

## The two platforms

|  | Android (Chrome) | iPhone (Safari 16.4+) |
|---|---|---|
| Install needed? | **No** — subscribes from a tab | **Yes** — Add to Home Screen, then open the icon |
| Taps to pair | 2 | ~6 |
| Vibration pattern | honoured (subject to the channel's settings) | ignored; the system's own haptics apply |
| Works locked / app closed | yes | yes |

The iOS install step is not a nicety and cannot be scripted: Apple exposes Web Push
only to web apps launched from the Home Screen, and Safari offers no programmatic
install. That is why the extension asks **which phone** before showing the QR, and why
this page keeps the choice switchable — a wrong guess would show the wrong four steps.

## Getting the code across the install (iOS)

This is the fiddly part, and it is worth reading before changing anything here. The
pairing code has to travel from a **Safari tab** into a **separately installed app**,
and two of the three ways of carrying it can fail:

| Carrier | Survives Safari → Home Screen app? |
|---|---|
| `?p=` in the URL | **yes — but only because the manifest declares no `start_url`** |
| `localStorage` | **no.** A Home Screen web app has its own storage partition |
| the system clipboard | **yes**, always — every app on the phone shares it |

> ⚠ **`manifest.webmanifest` deliberately has no `start_url`, and adding one breaks
> iPhone pairing.** When a manifest names a `start_url`, that is the URL the installed
> app launches — *not* the URL that was on screen when it was added — so `?p=<code>`
> would be dropped and the app would open belonging to no pairing. With the key absent,
> the spec defaults it to the document URL and the query string comes along. JSON cannot
> carry a comment, so the warning lives beside the `<link rel="manifest">` in
> `index.html`; see BUGS.md for the version of this that shipped.

The code is still mirrored to `localStorage`, but only for what it can actually do:
surviving a reload, or a second tab on Android. It cannot cross onto an iPhone.

So the guaranteed route is the clipboard. The iOS steps offer **Copy code** *before*
the install, and the installed app offers **Paste pairing code** whenever it opens
without one (falling back to a plain text box if the clipboard API is refused — a whole
pasted link is accepted as well as the bare code). Most users never see either: the URL
normally works, and this is the path that makes "normally" not matter.

**Pairing does not need the popup to stay open.** The extension's popup closes the
moment the browser loses focus, which during this flow is guaranteed. The background
keeps polling on a one-minute alarm and completes the pairing on its own; reopening the
panel rejoins the same QR rather than issuing a new code.

## Troubleshooting

- **"That pairing code has expired"** — ten minutes passed, or the code was already
  used. Show a new QR; each one is single-use by design.
- **Nothing arrives on Android** — check the site's notification channel in Android
  settings. The extension can send them; only the phone decides whether they buzz.
  Aggressive battery managers (MIUI, some Samsung profiles) also delay browser
  notifications; this is the one real reliability gap versus a native app.
- **Nothing arrives on iOS** — confirm you opened the app from the **Home Screen
  icon** and not from Safari, and that Focus appears in Settings → Notifications.
- **The Home Screen icon asks for a pairing code** — the code did not survive the
  install. Go back to Safari, open the QR link again, tap **Copy code**, then paste it
  in the app. If this happens every time, check that nobody has put a `start_url` back
  into `manifest.webmanifest`.
- **There is no "Add to Home Screen" in the share menu** — you are not in Safari. Brave
  on iOS does not offer it. Open the same link in Safari; the QR link is an ordinary
  URL and can be pasted there.
- **It worked, then stopped** — subscriptions expire, and iOS drops them for apps left
  unopened for long stretches. The extension prunes a subscription the moment the push
  service says it is gone (404/410) and the popup shows no paired phone; pair again.
