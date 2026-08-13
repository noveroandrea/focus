// ─────────────────────────────────────────────────────────────────────────────
//  The pairing web app — the only page a phone ever opens
// ─────────────────────────────────────────────────────────────────────────────
//  It does one thing: turn a scanned QR into a push subscription that the user's
//  desktop can send to. It never shows a score, never signs anyone in, and holds no
//  state beyond the pairing code it was opened with.
//
//  ── THE TWO PLATFORMS ARE GENUINELY DIFFERENT ───────────────────────────────
//  Android subscribes straight from a browser tab: permission prompt, done, and the
//  notifications arrive with the tab closed and the phone locked. iOS refuses to
//  subscribe at all until the page has been added to the Home Screen and launched
//  from that icon — Apple exposes Web Push only to installed web apps. That is not a
//  detail to paper over with one set of instructions; it is several extra taps through
//  a menu most people have never opened, so each platform gets its own steps.
//
//  ── GETTING THE CODE ACROSS THE INSTALL IS THE HARD PART ────────────────────
//  On iOS the code has to survive a trip from a Safari tab into a separately installed
//  app, and BOTH of the obvious ways of carrying it can fail:
//
//    • The URL. Add to Home Screen saves the page's URL — unless the manifest declares
//      a start_url, in which case that wins and the query string is dropped. Ours
//      deliberately declares none (see index.html), so ?p=<code> comes along.
//    • localStorage. A Home Screen web app on iOS gets its OWN storage, partitioned
//      from Safari's. Anything written in the tab is invisible in the app, so the
//      mirror below cannot rescue an iPhone — it is there for a reload or a second
//      Android tab, and that is all it was ever able to do.
//
//  Hence the third route, which is the only one that is guaranteed: the system
//  clipboard, which every app on the phone shares. The iOS steps show the **whole link**
//  with a Copy button, and the installed app offers to paste it back. The link rather
//  than the bare code, deliberately: it is what the user already has in the address bar,
//  it is what a person recognises as "the thing I was sent", and the parser pulls the
//  code out of it — so copying by hand from Safari's own address bar works just as well
//  as the button, which matters on a platform that can refuse clipboard access outright.
// ─────────────────────────────────────────────────────────────────────────────

const STORE_KEY = 'focusPairing';

// Which code this device has already spent. The app relaunches at the URL it was
// installed with — the same ?p= every time — and that code is single-use and gone from
// the server the moment the desktop collects it. Without a record of having spent it,
// reopening the app offered to pair again with a dead code and answered "that pairing
// code has expired", which reads as a broken pairing rather than a finished one. A
// DIFFERENT code arriving is a genuine re-pair and still goes through the whole flow.
const DONE_KEY = 'focusPairedCode';

// <32 hex nonce>.<base64url VAPID public key>. Validated rather than trusted because
// this now accepts typed and pasted input, and "nothing happened" is a terrible answer
// to a mis-paste: anything not matching is rejected with a sentence saying so.
const CODE_RE = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{40,}$/;

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle('hide', !on);

function say(text, cls) {
  const el = $('msg');
  el.textContent = text;
  el.className = 'note' + (cls ? ' ' + cls : '');
}

function sayRecover(text, cls) {
  const el = $('recover-msg');
  el.textContent = text;
  el.className = 'note' + (cls ? ' ' + cls : '');
}

// ── The pairing code ─────────────────────────────────────────────────────────
let code = '';
let nonce = '';
let vapidKey = '';

/** Pull a code out of whatever the user gave us. A whole pasted link works as well as
 *  the bare code — people copy the address bar, and refusing that would be pedantry. */
function extractCode(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const inUrl = s.match(/[?&]p=([^&#\s]+)/);
  let candidate = s;
  if (inUrl) {
    try { candidate = decodeURIComponent(inUrl[1]); } catch { candidate = inUrl[1]; }
  }
  return CODE_RE.test(candidate) ? candidate : '';
}

function useCode(raw) {
  const c = extractCode(raw);
  if (!c) return false;
  code = c;
  [nonce, vapidKey] = c.split('.');
  try { localStorage.setItem(STORE_KEY, c); } catch { /* private mode */ }
  render();
  return true;
}

// ── Which phone ──────────────────────────────────────────────────────────────
// Detected, then left switchable. iPadOS reports itself as a Mac, so the touch test
// is what catches it; getting this wrong shows the wrong steps, which is exactly the
// sort of thing a user must be able to correct.
const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua)
  || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

let platform = isIOS ? 'ios' : 'android';

function alreadyDone() {
  try { return !!code && localStorage.getItem(DONE_KEY) === code; } catch { return false; }
}

function render() {
  const paired = !!(nonce && vapidKey);
  const done = alreadyDone();

  // Finished, and reopened. Nothing here to do again — showing the button would offer a
  // code that has already been spent.
  show($('done'), done);

  // No code at all: two different situations that must not share a card. In a browser
  // tab the user has wandered in and belongs back at their computer. In the installed
  // app they have already done the work and are one paste away from finishing.
  show($('no-code'), !paired && !standalone && !done);
  show($('recover'), !paired && standalone && !done);
  show($('flow'), paired && !done);
  if (!paired || done) return;

  $('tab-android').setAttribute('aria-selected', String(platform === 'android'));
  $('tab-ios').setAttribute('aria-selected', String(platform === 'ios'));

  // On iOS the button cannot work until the app has been installed and opened from
  // the Home Screen, so it is hidden rather than disabled: a button that is present
  // and refuses reads as broken, while its absence sends people to the steps above it.
  const iosPreInstall = platform === 'ios' && !standalone;
  show($('steps-android'), platform === 'android');
  show($('steps-ios'), iosPreInstall);
  show($('ios-standalone'), platform === 'ios' && standalone);
  show($('go'), !iosPreInstall);
}

$('tab-android').addEventListener('click', () => { platform = 'android'; render(); });
$('tab-ios').addEventListener('click', () => { platform = 'ios'; render(); });

// The URL first, then the mirror. On iOS the mirror is a different storage partition
// and will be empty; on Android it survives a reload, which is the case it is for.
const fromUrl = new URLSearchParams(location.search).get('p');
let mirrored = null;
try { mirrored = localStorage.getItem(STORE_KEY); } catch { mirrored = null; }
if (!useCode(fromUrl)) useCode(mirrored);
render();

// ── Recovering a code that did not survive the install ───────────────────────
// The copy-the-link half of this pair is gone, along with the field it wrote to.
// It existed only to work around `start_url` in the manifest relaunching the installed
// app at "./" and dropping the `?p=` code; removing `start_url` fixed that at the
// source. Reading the clipboard stays, because it costs one button and rescues the
// case where the code genuinely was lost.
$('paste').addEventListener('click', async () => {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { text = ''; }
  if (useCode(text)) { sayRecover(''); return; }
  // Either the clipboard was refused or it held something else. Both end in the same
  // place: a box the user can paste into with a long press.
  show($('code-in'), true);
  $('code-in').focus();
  sayRecover(
    text ? 'That was not a Focus pairing link. Paste it into the box.'
         : 'Paste it into the box instead — tap and hold, then Paste.',
    'bad',
  );
});

$('code-in').addEventListener('input', (e) => {
  if (useCode(e.target.value)) sayRecover('');
});

// ── Subscribing ──────────────────────────────────────────────────────────────
function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function pair() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    say(standalone
      ? 'This app cannot receive web notifications. iOS needs version 16.4 or newer.'
      : 'This browser cannot receive web notifications. On iPhone use Safari; on Android use Chrome.', 'bad');
    return;
  }
  if (!window.FOCUS_CONFIG?.SUPABASE_URL) {
    say('This pairing page has not been configured — see web/README.md.', 'bad');
    return;
  }

  $('go').disabled = true;
  say('Asking for permission…');

  try {
    // Registered before the prompt, because a permission granted with no service
    // worker to receive the push is a permission that does nothing.
    const reg = await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      say(permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser settings, then try again.'
        : 'Permission was dismissed — tap the button again.', 'bad');
      $('go').disabled = false;
      return;
    }

    say('Linking to your computer…');
    // An existing subscription belongs to whichever key it was minted against, which
    // may be a previous install of the extension. Dropping it first means re-pairing
    // always produces a subscription this desktop can actually push to.
    const existing = await reg.pushManager.getSubscription();
    if (existing) await existing.unsubscribe();

    const sub = await reg.pushManager.subscribe({
      // Required by Chrome, and true here anyway: every push this ever receives
      // shows a notification.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });

    const res = await fetch(`${window.FOCUS_CONFIG.SUPABASE_URL}/rest/v1/rpc/claim_pairing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: window.FOCUS_CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${window.FOCUS_CONFIG.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        p_nonce: nonce,
        p_subscription: sub.toJSON(),
        p_platform: platform,
      }),
    });

    if (!res.ok) {
      say(`Could not reach the Focus server (${res.status}). Check your connection and try again.`, 'bad');
      $('go').disabled = false;
      return;
    }
    // The RPC returns a bare boolean: false means the code was unknown, already used
    // or older than ten minutes. All three have the same remedy, so they get the same
    // sentence.
    if ((await res.json()) !== true) {
      say('That pairing code has expired or was already used. Open the Focus extension and show a new QR code.', 'bad');
      $('go').disabled = false;
      return;
    }

    // Remember WHICH code was spent, not merely that one was: a new QR from the desktop
    // brings a different code and must still be able to pair this phone again.
    try {
      localStorage.removeItem(STORE_KEY);
      localStorage.setItem(DONE_KEY, code);
    } catch { /* private mode — the app just offers to pair again, harmlessly */ }
    render();
  } catch (err) {
    say(`Something went wrong: ${String(err).slice(0, 120)}`, 'bad');
    $('go').disabled = false;
  }
}

$('go').addEventListener('click', pair);
