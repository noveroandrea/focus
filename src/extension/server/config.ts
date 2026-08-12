// ─────────────────────────────────────────────────────────────────────────────
//  Supabase connection — fill these in for your own project
// ─────────────────────────────────────────────────────────────────────────────
//  These three values are the whole configuration. They are COMPILED INTO the
//  extension bundle, so treat them as public:
//
//    • SUPABASE_URL and SUPABASE_ANON_KEY are designed to be public. The anon key
//      is a signed JWT saying "anonymous role"; every table has RLS forcing
//      user_id = auth.uid(), so holding it grants no access to anyone's data.
//    • GOOGLE_CLIENT_ID is likewise public by design in an OAuth public client.
//
//  What must NEVER appear in this file (or anywhere in src/) is the service_role
//  key. It bypasses RLS entirely and would hand every user's data to anyone who
//  unzipped the extension. Researcher exports use it from the Supabase dashboard
//  only — see supabase/README.md.
//
//  Setup steps for all three values are in supabase/README.md.
// ─────────────────────────────────────────────────────────────────────────────

/** Project URL, e.g. https://abcdefghijklm.supabase.co (no trailing slash). */
export const SUPABASE_URL: string = 'https://zjdcanlogiidqqgkfutp.supabase.co';

/** Project `anon` / publishable key. Public by design — see the note above. */
export const SUPABASE_ANON_KEY: string = 'sb_publishable_HHxAUdAbNabMNZwri-imLw_x2X2cSpR';

/** Google OAuth 2.0 **Web application** client ID, ending in
 *  .apps.googleusercontent.com. Must be listed in Supabase → Authentication →
 *  Providers → Google → "Authorized Client IDs", or the id_token exchange is
 *  rejected. */
export const GOOGLE_CLIENT_ID: string = '6850334637-raa373p6et6vunpur0gofapq3cd3fhr1.apps.googleusercontent.com';

/** Where the pairing web app (`web/`) is deployed, no trailing slash.
 *
 *  The one page the phone ever opens: it asks whether this is an Android or an
 *  iPhone, walks through the steps for that one, subscribes to Web Push and hands
 *  the subscription back through `claim_pairing`. It must be **HTTPS** — a service
 *  worker, and therefore Web Push, exists nowhere else — which is why it cannot
 *  simply be a page inside the extension: `chrome-extension://` URLs mean nothing on
 *  a phone.
 *
 *  GitHub Pages is the intended host and is free for a public repo; any static HTTPS
 *  host works. Empty disables phone pairing entirely and the popup says so, rather
 *  than showing a QR that leads nowhere. Deployment is in web/README.md. */
export const PUSH_LANDING_URL: string = 'https://noveroandrea.github.io/focus';

/** True once the pairing page has somewhere to live. */
export function isPushConfigured(): boolean {
  return PUSH_LANDING_URL !== '';
}

/** True once the three values above are filled in. Every server call checks this
 *  first, so an unconfigured build simply behaves like the offline extension
 *  rather than throwing on every heartbeat.
 *
 *  The three constants are annotated `: string` rather than left to inference on
 *  purpose — inferred literal types make these emptiness checks provably false and
 *  tsc rejects them the moment real values are pasted in. */
export function isServerConfigured(): boolean {
  return SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== '' && GOOGLE_CLIENT_ID !== '';
}

/** Storage key holding the Supabase session (access + refresh token). */
export const SESSION_KEY = 'focusServerSession';

/** Storage key holding score deltas not yet accepted by the server. */
export const PENDING_KEY = 'focusServerPending';

/** Storage key holding the last summary the server returned. */
export const SUMMARY_KEY = 'focusServerSummary';

/** Storage key holding `{ [domain]: flagCount }` for the user's own whitelist.
 *
 *  Separate from the whitelist itself, which lives in `focusFlowSettings` and is read
 *  synchronously by heartbeat.ts on every page load. That one decides whether the
 *  extension runs; this one is display only, so a missing or stale entry costs a
 *  number on screen rather than a page that fails to activate. */
export const DOMAIN_FLAGS_KEY = 'focusServerDomainFlags';

/** The same, for `{ [program]: flagCount }`. A program is flagged from the same
 *  weekly budget as a domain — one flag a week, spent on either — but the tallies
 *  are counted per target and per kind, so they cannot share a map. */
export const PROGRAM_FLAGS_KEY = 'focusServerProgramFlags';

/** Storage key holding whether this week's red flag is still in hand.
 *
 *  Its own key rather than a field on the summary because two unrelated parts of the
 *  popup read it — the badge above the section pills, and the flag buttons on a
 *  member profile — and storage is how they stay in step without one owning the
 *  other. Written by every server reply AND by a successful flag, so spending one
 *  greys the badge immediately. */
export const FLAG_KEY = 'focusServerFlag';

/** Storage key holding the last team / competition leaderboards the server sent.
 *  A cache like all the others: the server recomputes them on every reply, and the
 *  popup renders whatever is here so it can paint before a request returns. */
export const TEAMS_KEY = 'focusServerTeams';

/** Storage key holding a whitelist edit not yet accepted by the server. Present
 *  only between the user's edit and the next successful post. */
export const PENDING_DOMAINS_KEY = 'focusServerPendingDomains';

/** The same, for a pending PROGRAM whitelist edit. Two keys rather than one object
 *  because the two lists are edited independently and each must be able to be in
 *  flight without dragging the other along. */
export const PENDING_PROGRAMS_KEY = 'focusServerPendingPrograms';

/** Storage key holding the whitelist as the server last reported it.
 *
 *  This is what makes the write path loop-free. Every server reply is written into
 *  `Settings.allowedDomains`, which fires storage.onChanged, which is also how a
 *  real user edit is detected — so without a way to tell the two apart the extension
 *  would push the server's own list straight back at it, forever. Comparing against
 *  this snapshot answers "did this change come from the server or from the user?". */
export const SERVER_DOMAINS_KEY = 'focusServerDomains';

/** The program whitelist as the server last reported it — the echo test above,
 *  applied to the other list. */
export const SERVER_PROGRAMS_KEY = 'focusServerPrograms';
