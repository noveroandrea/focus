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

The pairing code travels in the **query string**, not the fragment, because Add to
Home Screen saves the URL Safari is showing and a fragment is the part most likely to
be dropped. It is also copied to `localStorage` on first sight, so whichever of the
two survives into the installed app, one of them is there.

## Troubleshooting

- **"That pairing code has expired"** — ten minutes passed, or the code was already
  used. Show a new QR; each one is single-use by design.
- **Nothing arrives on Android** — check the site's notification channel in Android
  settings. The extension can send them; only the phone decides whether they buzz.
  Aggressive battery managers (MIUI, some Samsung profiles) also delay browser
  notifications; this is the one real reliability gap versus a native app.
- **Nothing arrives on iOS** — confirm you opened the app from the **Home Screen
  icon** and not from Safari, and that Focus appears in Settings → Notifications.
- **It worked, then stopped** — subscriptions expire, and iOS drops them for apps left
  unopened for long stretches. The extension prunes a subscription the moment the push
  service says it is gone (404/410) and the popup shows no paired phone; pair again.
