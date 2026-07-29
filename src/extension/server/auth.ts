// ─────────────────────────────────────────────────────────────────────────────
//  Google sign-in → Supabase session
// ─────────────────────────────────────────────────────────────────────────────
//  Deliberately uses chrome.identity.launchWebAuthFlow rather than
//  chrome.identity.getAuthToken. getAuthToken is Chrome-only: it hands back a
//  token for whatever Google account is signed into the *browser profile*, and it
//  simply does not exist in Brave, Edge or Chromium builds without Google's
//  proprietary bits. launchWebAuthFlow is plain OAuth in a popup window and works
//  everywhere the extension does.
//
//  The flow, once:
//
//    1. open Google's consent screen with response_type=id_token + a fresh nonce
//    2. Google redirects to https://<extension-id>.chromiumapp.org/#id_token=…
//       which launchWebAuthFlow intercepts and returns to us as a string
//    3. exchange that id_token with Supabase (grant_type=id_token) for a real
//       Supabase session, so RLS sees a normal auth.users row
//    4. persist { access_token, refresh_token, expires_at } to chrome.storage.local
//
//  Thereafter getAccessToken() refreshes silently and sign-in is never shown
//  again unless the refresh token is revoked.
//
//  WHY id_token AND NOT AN ACCESS TOKEN: Supabase needs to *verify* who the user
//  is. An id_token is a JWT signed by Google carrying the user's identity, so
//  Supabase can validate it against Google's public keys without trusting us. A
//  Google access token is an opaque bearer string and proves nothing about who
//  presented it.
// ─────────────────────────────────────────────────────────────────────────────

import { SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_CLIENT_ID, SESSION_KEY, isServerConfigured } from './config';

export interface ServerSession {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms at which accessToken expires. */
  expiresAt: number;
  userId: string;
  email: string;
}

/** Refresh this long before the token actually expires, so a request never starts
 *  with a token that dies mid-flight. */
const REFRESH_MARGIN_MS = 60_000;

let cached: ServerSession | null = null;
let loaded = false;
let refreshing: Promise<ServerSession | null> | null = null;

// ── Storage ───────────────────────────────────────────────────────────────────
function readStored(): Promise<ServerSession | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([SESSION_KEY], (r) => {
      const s = r[SESSION_KEY] as ServerSession | undefined;
      resolve(s && s.refreshToken ? s : null);
    });
  });
}

function writeStored(s: ServerSession | null): Promise<void> {
  return new Promise((resolve) => {
    cached = s;
    loaded = true;
    if (s) chrome.storage.local.set({ [SESSION_KEY]: s }, () => resolve());
    else chrome.storage.local.remove(SESSION_KEY, () => resolve());
  });
}

/** The stored session, if any — without triggering sign-in or a refresh. */
export async function getSession(): Promise<ServerSession | null> {
  if (!loaded) {
    cached = await readStored();
    loaded = true;
  }
  return cached;
}

export async function isSignedIn(): Promise<boolean> {
  return (await getSession()) !== null;
}

// ── Token plumbing ────────────────────────────────────────────────────────────
function sessionFromTokenResponse(data: {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { id?: string; email?: string };
}): ServerSession | null {
  if (!data?.access_token || !data?.refresh_token || !data?.user?.id) return null;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    userId: data.user.id,
    email: data.user.email ?? '',
  };
}

async function exchange(path: string, body: unknown): Promise<ServerSession | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn(`Focus: auth ${path} failed (${res.status}):`, text.slice(0, 200));
    return null;
  }
  try {
    return sessionFromTokenResponse(JSON.parse(text));
  } catch {
    return null;
  }
}

/** A valid access token, refreshing if it is close to expiry. Returns null when
 *  the user is not signed in or the refresh token has been revoked — callers treat
 *  that as "work offline", never as a hard error. */
export async function getAccessToken(): Promise<string | null> {
  if (!isServerConfigured()) return null;
  const s = await getSession();
  if (!s) return null;
  if (Date.now() < s.expiresAt - REFRESH_MARGIN_MS) return s.accessToken;

  // Collapse concurrent refreshes: the service worker can field several score
  // deltas at once and Supabase rotates the refresh token on every use, so two
  // parallel refreshes would invalidate each other and sign the user out.
  if (!refreshing) {
    refreshing = exchange('refresh_token', { refresh_token: s.refreshToken })
      .then(async (next) => {
        if (next) {
          await writeStored(next);
          return next;
        }
        // The refresh token is dead: drop the session so the UI offers sign-in
        // again rather than retrying a doomed request on every heartbeat.
        console.warn('Focus: server session expired — sign in again to resume syncing');
        await writeStored(null);
        return null;
      })
      .finally(() => { refreshing = null; });
  }
  const refreshed = await refreshing;
  return refreshed?.accessToken ?? null;
}

// ── Interactive sign-in ───────────────────────────────────────────────────────
function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function launchGoogle(nonce: string): Promise<string | null> {
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: 'id_token',
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    nonce,
    prompt: 'select_account',
  });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  return new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirect) => {
      if (chrome.runtime.lastError || !redirect) {
        // Also the normal path when the user closes the consent window.
        console.warn('Focus: Google sign-in cancelled:', chrome.runtime.lastError?.message ?? 'no redirect');
        resolve(null);
        return;
      }
      resolve(redirect);
    });
  });
}

/** id_token arrives in the URL *fragment*, which is why this parses the hash
 *  rather than the query string. */
function idTokenFromRedirect(redirect: string): string | null {
  const hash = redirect.split('#')[1];
  if (!hash) return null;
  return new URLSearchParams(hash).get('id_token');
}

/** Run the interactive Google flow and store the resulting Supabase session.
 *  Resolves to the session, or null if the user cancelled or the exchange failed. */
export async function signIn(): Promise<ServerSession | null> {
  if (!isServerConfigured()) {
    console.warn('Focus: server not configured — fill in src/extension/server/config.ts');
    return null;
  }
  const nonce = randomNonce();
  const redirect = await launchGoogle(nonce);
  if (!redirect) return null;

  const idToken = idTokenFromRedirect(redirect);
  if (!idToken) {
    console.warn('Focus: no id_token in the Google redirect');
    return null;
  }

  // The same nonce goes to Supabase: it checks the id_token's nonce claim matches,
  // which is what stops a token minted for another site being replayed here.
  const session = await exchange('id_token', {
    provider: 'google',
    id_token: idToken,
    nonce,
  });
  if (!session) return null;

  await writeStored(session);
  console.log('Focus: signed in as', session.email);
  return session;
}

/** Forget the local session. Deliberately does NOT delete server-side data — a
 *  user signing out of a study should not silently destroy their contribution;
 *  removal is a separate, explicit request. */
export async function signOut(): Promise<void> {
  const s = await getSession();
  if (s && isServerConfigured()) {
    // Best effort: revoke the refresh token so it can't be reused.
    fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${s.accessToken}`,
      },
    }).catch(() => {});
  }
  await writeStored(null);
  console.log('Focus: signed out');
}
