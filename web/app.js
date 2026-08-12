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
//  detail to paper over with one set of instructions; it is four extra taps through a
//  menu most people have never opened, so each platform gets its own steps.
//
//  ── WHY THE CODE IS IN THE QUERY STRING ─────────────────────────────────────
//  Add to Home Screen saves the URL Safari is currently showing. A fragment is the
//  part most likely to be dropped on the way into an installed app, and losing it
//  would strand the user inside an app with no idea which pairing it belonged to. So
//  the code travels as ?p=<nonce>.<vapid-public-key> and is ALSO copied into
//  localStorage on first sight, because the installed app may or may not inherit it
//  and one of the two will be there.
// ─────────────────────────────────────────────────────────────────────────────

const STORE_KEY = 'focusPairing';

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle('hide', !on);

function say(text, cls) {
  const el = $('msg');
  el.textContent = text;
  el.className = 'note' + (cls ? ' ' + cls : '');
}

// ── The pairing code ─────────────────────────────────────────────────────────
const fromUrl = new URLSearchParams(location.search).get('p');
if (fromUrl) {
  try { localStorage.setItem(STORE_KEY, fromUrl); } catch { /* private mode */ }
}
let stored = fromUrl;
if (!stored) {
  try { stored = localStorage.getItem(STORE_KEY); } catch { stored = null; }
}

const [nonce, vapidKey] = (stored || '').split('.');

// ── Which phone ──────────────────────────────────────────────────────────────
// Detected, then left switchable. iPadOS reports itself as a Mac, so the touch test
// is what catches it; getting this wrong shows the wrong four steps, which is exactly
// the sort of thing a user must be able to correct.
const ua = navigator.userAgent;
const isIOS = /iPad|iPhone|iPod/.test(ua)
  || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia('(display-mode: standalone)').matches
  || window.navigator.standalone === true;

let platform = isIOS ? 'ios' : 'android';

function render() {
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

show($('no-code'), !nonce || !vapidKey);
show($('flow'), !!(nonce && vapidKey));
if (nonce && vapidKey) render();

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
    say('This browser cannot receive web notifications. On iPhone use Safari; on Android use Chrome.', 'bad');
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

    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    show($('flow'), false);
    show($('done'), true);
  } catch (err) {
    say(`Something went wrong: ${String(err).slice(0, 120)}`, 'bad');
    $('go').disabled = false;
  }
}

$('go').addEventListener('click', pair);
