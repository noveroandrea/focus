// ─────────────────────────────────────────────────────────────────────────────
//  Web Push — the phone nudge, sent by this browser to your own phone
// ─────────────────────────────────────────────────────────────────────────────
//  The one failure the extension exists to catch is the one nothing on screen can
//  help with: you have stopped looking at the screen. The beep needs the volume up
//  and the room quiet, the trembling character needs your eyes on it. A phone in a
//  pocket needs neither, and it is the only surface here that can vibrate.
//
//  ── WHY THE KEYPAIR IS GENERATED HERE ───────────────────────────────────────
//  Web Push identifies the sender with VAPID: an ECDSA P-256 keypair whose PUBLIC
//  half is handed to the phone at subscribe time and whose PRIVATE half signs every
//  push. The obvious design puts that keypair on a server and pushes from there —
//  and it is the wrong one for this project, twice over:
//
//    1. A shared key must never ship inside the extension (public repo, unpacked
//       folder, anyone can read it), which forces a backend to hold it, which means
//       every idle event travels through that backend. The timing of those events is
//       a record of when the user drifts — the most sensitive thing here.
//    2. Nothing else in this extension needs a server. Scores sync optionally;
//       heartbeats, the whitelist and the sprite are local. A notification channel
//       that made the backend mandatory would invert that.
//
//  So each INSTALL generates its own keypair, keeps it in chrome.storage.local, and
//  posts pushes straight from the service worker to the push service (FCM for
//  Chrome/Android, Mozilla autopush, APNs for Safari/iOS). The server is used for
//  ten minutes during pairing, to carry the phone's subscription back to the desktop,
//  and never again — see push_pairings in the migrations, which deletes the row on
//  collection. Nothing about a nudge is ever visible to it.
//
//  The consequence to remember: the keypair IS the sender identity. Lose it (a fresh
//  profile, cleared storage) and existing subscriptions answer 401/403, because they
//  were minted against the old public key. That is why send() prunes on those codes
//  and the popup says "pair again" rather than silently going quiet.
//
//  ── WHAT IS ACTUALLY SENT ───────────────────────────────────────────────────
//  A fixed, encrypted, one-line message. RFC 8291 (aes128gcm) is not optional: push
//  services refuse to carry a plaintext payload, and the encryption is end-to-end —
//  keyed by the phone's own `p256dh` + `auth` secrets, so FCM and Apple relay bytes
//  they cannot read. `Urgency: high` pierces Android's Doze, and the default `TTL: 0`
//  means a nudge that cannot be delivered RIGHT NOW is dropped rather than queued. A
//  warning that arrives forty seconds late is worse than one that never arrives — the
//  countdown is over and the penalty has already landed.
//
//  That default is right for a nudge and WRONG for a test, which is why the TTL is a
//  parameter. A confirmation or a "send test buzz" has no deadline; its whole job is to
//  prove the pipe works, so a queued delivery a few seconds later is a success and a
//  silent drop is the one outcome that teaches the user nothing. Those use
//  `TEST_PUSH_TTL_S`.
// ─────────────────────────────────────────────────────────────────────────────

/** How long a *test* push may sit in the push service's queue.
 *
 *  This once said the wait was for iOS hiding a notification while its own web app is in
 *  the foreground. That turned out not to happen — a real iPhone showed the test with the
 *  app open — but the TTL stays, because the reason above it never depended on that: a
 *  confirmation has no deadline, and a silent drop (the phone locked, out of signal, or
 *  halfway through being set up) is the one outcome that proves nothing either way. */
export const TEST_PUSH_TTL_S = 300;

/** How long the "switched to Not working" message may wait. It is the one push that
 *  reports a state rather than counting down to something, so it stays true while it
 *  sits in a queue — but only until the user comes back and presses Working, which is
 *  why it is a minute and not the test's five. */
export const PAUSE_PUSH_TTL_S = 60;

// The one import here, and only for the VAPID `sub` claim below. config.ts imports
// nothing itself, so this cannot become a cycle.
import { PUSH_LANDING_URL } from './server/config';

/** One paired phone. `endpoint` is the push service's URL for that device; the two
 *  keys are the device's own, used to encrypt so that only it can read the payload. */
export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Which phone the user said this was, for the popup's list. Display only. */
  platform: 'android' | 'ios' | 'other';
  addedAt: number;
}

/** Storage key for the VAPID keypair, as a pair of JWKs. */
const KEYS_KEY = 'focusPushKeys';
/** Storage key for the paired devices. */
const SUBS_KEY = 'focusPushSubs';

/** The `sub` claim every push service requires in the VAPID JWT: a contact for whoever
 *  operates the sender. There is no operator here — the sender is the user's own browser
 *  — so it names the project rather than a person.
 *
 *  **It must be a URL a push service can parse, and Apple actually checks.** This was
 *  `mailto:focus-extension@localhost` for exactly as long as it took to try a real
 *  iPhone: `localhost` is not a domain, so `web.push.apple.com` answers 403 and refuses
 *  every push. FCM accepts the same token without complaint, which is why nothing on
 *  Android or in the decryption test ever noticed.
 *
 *  The pairing page is the honest answer — it is this sender's only public face — and it
 *  is always set when there is anything to send to, since a phone can only have paired
 *  by opening it. The fallback exists so the constant is never empty, not because it can
 *  be reached: with no landing page there are no subscriptions and sendPush returns
 *  early. */
function vapidSubject(): string {
  return PUSH_LANDING_URL || 'https://example.org/focus';
}

/** How long a signed VAPID token stays valid. The spec caps it at 24h; 12 is the
 *  usual choice and leaves room for a clock that is slightly ahead. */
const JWT_TTL_S = 12 * 60 * 60;

// ── Base64url ────────────────────────────────────────────────────────────────
function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ── The keypair ──────────────────────────────────────────────────────────────
let cached: { publicKey: CryptoKey; privateKey: CryptoKey; publicRaw: Uint8Array } | null = null;

function readStored<T>(key: string): Promise<T | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (r) => resolve((r[key] as T) ?? null));
  });
}

async function importPair(jwks: { pub: JsonWebKey; priv: JsonWebKey }) {
  const alg = { name: 'ECDSA', namedCurve: 'P-256' } as const;
  const publicKey = await crypto.subtle.importKey('jwk', jwks.pub, alg, true, ['verify']);
  const privateKey = await crypto.subtle.importKey('jwk', jwks.priv, alg, false, ['sign']);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  return { publicKey, privateKey, publicRaw };
}

/** The VAPID keypair for this install, generated on first use and kept forever.
 *
 *  Generated lazily rather than at startup: an install that never pairs a phone
 *  should never spend the entropy or the storage write. */
async function getKeys() {
  if (cached) return cached;
  const stored = await readStored<{ pub: JsonWebKey; priv: JsonWebKey }>(KEYS_KEY);
  if (stored?.pub && stored?.priv) {
    cached = await importPair(stored);
    return cached;
  }
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  ) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
  await new Promise<void>((r) => chrome.storage.local.set({ [KEYS_KEY]: { pub, priv } }, () => r()));
  cached = await importPair({ pub, priv });
  return cached;
}

/** The public key the phone must subscribe with, base64url — this is what travels in
 *  the pairing QR. A subscription is bound to it: the phone hands it back to the push
 *  service on every delivery, and a push signed by any other key is refused. */
export async function publicKeyB64(): Promise<string> {
  const { publicRaw } = await getKeys();
  return b64urlEncode(publicRaw);
}

// ── Paired devices ───────────────────────────────────────────────────────────
export async function listSubscriptions(): Promise<PushSubscriptionRecord[]> {
  const subs = await readStored<PushSubscriptionRecord[]>(SUBS_KEY);
  return Array.isArray(subs) ? subs : [];
}

async function writeSubscriptions(subs: PushSubscriptionRecord[]): Promise<void> {
  await new Promise<void>((r) => chrome.storage.local.set({ [SUBS_KEY]: subs }, () => r()));
}

/** Add a paired phone, replacing any entry with the same endpoint — re-pairing the
 *  same device must update it rather than push to it twice. */
export async function addSubscription(sub: PushSubscriptionRecord): Promise<void> {
  const subs = await listSubscriptions();
  await writeSubscriptions([...subs.filter((s) => s.endpoint !== sub.endpoint), sub]);
}

export async function removeSubscription(endpoint: string): Promise<void> {
  const subs = await listSubscriptions();
  await writeSubscriptions(subs.filter((s) => s.endpoint !== endpoint));
}

// ── VAPID ────────────────────────────────────────────────────────────────────
/** Sign the JWT that identifies this sender to the push service.
 *
 *  `aud` is the ORIGIN of the endpoint, not the endpoint itself — a token minted for
 *  fcm.googleapis.com is rejected by Mozilla's service and vice versa, which is why
 *  this is computed per push rather than cached. WebCrypto's ECDSA signature is
 *  already the raw r‖s pair JWS wants, so no DER unwrapping is needed. */
async function vapidHeader(endpoint: string): Promise<{ Authorization: string }> {
  const { privateKey, publicRaw } = await getKeys();
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64urlEncode(utf8(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + JWT_TTL_S,
    sub: vapidSubject(),
  })));
  const signed = `${header}.${body}`;
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, privateKey, utf8(signed),
  ));
  return { Authorization: `vapid t=${signed}.${b64urlEncode(sig)}, k=${b64urlEncode(publicRaw)}` };
}

// ── Payload encryption (RFC 8291, aes128gcm) ─────────────────────────────────
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** HKDF-Expand for exactly one block, which is all Web Push ever needs: every output
 *  here is 32 bytes or fewer, so the counter never leaves 0x01. */
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const out = await hmac(prk, concat(info, new Uint8Array([1])));
  return out.slice(0, length);
}

/**
 * Encrypt one message for one device.
 *
 * The shape is fixed by RFC 8188: a header of salt ‖ record-size ‖ key-id-length ‖
 * the ephemeral public key, followed by the AES-GCM ciphertext. The plaintext gets a
 * single 0x02 delimiter byte appended, which marks it as the LAST record — omitting
 * it produces a payload every push service accepts and every browser silently drops.
 */
async function encryptPayload(sub: PushSubscriptionRecord, plaintext: string): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);

  // A fresh ephemeral keypair per message. Reusing one would let anyone who ever
  // captured a payload decrypt every later one to the same device.
  const eph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  ) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, eph.privateKey, 256,
  ));

  // Two HKDF rounds, exactly as the RFC specifies: the first is salted with the
  // device's auth secret and mixes both public keys, the second with the random salt.
  const prk = await hmac(authSecret, shared);
  const keyInfo = concat(utf8('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdfExpand(prk, keyInfo, 32);
  const prk2 = await hmac(salt, ikm);
  const cek = await hkdfExpand(prk2, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk2, utf8('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, key, concat(utf8(plaintext), new Uint8Array([2])),
  ));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

// ── Sending ──────────────────────────────────────────────────────────────────
/**
 * Push one message to every paired phone.
 *
 * Failures are per-device and never retried. A nudge is only worth delivering inside
 * the few seconds the warning lasts, so a queue would deliver noise; and the caller
 * (buzzPhone in background.ts) is already rate-limited, so a device that is
 * unreachable simply misses this one.
 *
 * 404 and 410 mean the subscription is gone for good — the phone uninstalled the web
 * app, or the push service expired it — so those, and only those, are pruned. 401/403
 * are a rejection of the SENDER and say nothing about the device; they are logged with
 * the service's own explanation and the subscription is kept. See the note at the call
 * site: pruning on them once deleted a perfectly good pairing because of a `sub` claim
 * Apple would not parse.
 *
 * @returns how many devices accepted the push.
 */
export async function sendPush(title: string, body: string, ttlSeconds = 0): Promise<number> {
  const subs = await listSubscriptions();
  if (subs.length === 0) return 0;

  const payload = JSON.stringify({ title, body });
  let delivered = 0;
  const dead: string[] = [];

  await Promise.all(subs.map(async (sub) => {
    try {
      const [auth, encrypted] = await Promise.all([
        vapidHeader(sub.endpoint),
        encryptPayload(sub, payload),
      ]);
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          // 0 (the default) drops rather than queues — see the file header. A test
          // passes a real one, because there is nothing time-critical about it.
          TTL: String(Math.max(0, Math.floor(ttlSeconds))),
          // Wakes an Android device out of Doze. Without it the push waits for the
          // next maintenance window, which can be minutes.
          Urgency: 'high',
        },
        body: encrypted as unknown as BodyInit,
      });
      if (res.ok) { delivered++; return; }

      // 404/410 are the only codes that mean THIS SUBSCRIPTION is gone, and the only
      // ones that may delete it.
      if (res.status === 404 || res.status === 410) dead.push(sub.endpoint);

      // 401/403 used to prune as well, on the reasoning that a rejected token would be
      // rejected forever. It is the same reasoning and the opposite conclusion: those
      // codes are about the SENDER, so they fail identically for every device — and if
      // the fault is ours (a `sub` claim Apple would not parse, a lost keypair) then
      // deleting the pairing destroys the user's setup over a bug they cannot see and
      // takes the evidence with it. Keep the subscription, say so loudly, let a fixed
      // build simply work. The body is logged because Apple names the reason in it
      // ("BadJwtToken"), which is the difference between a guess and a diagnosis.
      const detail = await res.text().catch(() => '');
      console.warn(
        `Focus: push rejected (${res.status})${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
        res.status === 401 || res.status === 403
          ? '\nThis is a sender-side rejection: the VAPID token was refused, so every paired device will fail the same way. The subscription has been KEPT.'
          : '',
      );
    } catch (err) {
      // Offline, DNS, a blocked endpoint. Nothing to do and nothing to keep.
      console.warn('Focus: push unreachable:', String(err).slice(0, 120));
    }
  }));

  if (dead.length) {
    const left = (await listSubscriptions()).filter((s) => !dead.includes(s.endpoint));
    await writeSubscriptions(left);
  }
  return delivered;
}
