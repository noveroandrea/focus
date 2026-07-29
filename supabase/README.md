# Focus — Supabase backend

Optional server for the Focus extension. It stores, per signed-in user:

| What | Where |
|---|---|
| Live score (current focus-day, still accumulating) | `user_summary.live_*` |
| Every completed day | `daily_scores` |
| Last 3 completed days | `user_summary.d1_* / d2_* / d3_*` |
| 7-day and 30-day averages | `user_summary.avg7_* / avg30_*` |
| Whitelisted page domains | `user_domains` |

The extension works **fully without any of this**. Until `src/extension/server/config.ts`
is filled in *and* the user signs in, every server call is a no-op.

---

## How the extension talks to it

Two endpoints, and only one of them writes:

```
POST /rest/v1/rpc/apply_score_delta   { p_focus_delta, p_distracted_delta, p_timezone }
  -> the whole summary as JSON

GET  /rest/v1/summary?select=*        (read-only; cannot trigger a rollover)
  -> the same shape
```

`apply_score_delta` sends a **delta** (`+focus` / `−distracted`), not an absolute
score, and returns the refreshed summary in the same round trip. So:

- **a score change** posts its delta and gets the new standing back;
- **browser start** and **the start of a day** post `(0, 0)` — a pure read.

Deltas rather than absolutes because two devices signed into one account can both
post `+1` and both land; absolutes would let the slower device silently overwrite
the faster one. The trade-off is that a duplicate post double-counts, so the
extension only ever retries a request it knows didn't land, and holds unsent deltas
in `chrome.storage.local` so a suspended service worker doesn't lose them.

### The 01:00 rollover

A **focus-day runs 01:00 → 01:00 local time.** That boundary is defined once, in
`focus_day()`, and both rollover paths derive from it:

1. **`pg_cron`, hourly** (`0003_cron.sql`) — rolls over every user whose local
   focus-day has ended. Hourly rather than daily because users are in different
   timezones, so there is no single minute at which everyone's day ends.
2. **Lazily, inside `apply_score_delta`** — the same check on every call.

Both call the same idempotent `roll_forward()`, so whichever runs first wins and the
other becomes a no-op. That means the cron job is a *convenience, not the
guarantee*: a user whose browser was shut at 01:00 is rolled over correctly the
moment they come back, and if `pg_cron` is unavailable nothing is lost — only
timeliness.

Rolling over banks the live score into `daily_scores`, resets it to 0, and
recomputes `d1..d3` + both averages. Recomputing only at rollover is correct rather
than lazy: all five describe **completed** days, so they cannot change during a day.

An empty day is deliberately **not** written, so it is excluded from the averages
rather than counted as a zero — a holiday shouldn't read as a day of failure. This
matches the extension's own `windowAvg()`, which averages only days actually
recorded.

---

## Setup

### 1. Create the project

1. <https://supabase.com/dashboard> → **New project**. Note the region — put it near
   your participants.
2. **Project Settings → API**: copy the **Project URL** and the **anon / publishable**
   key.

### 2. Apply the migrations

Either paste each file into **SQL Editor** in order, or use the CLI:

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

```
supabase/migrations/0001_schema.sql      tables, RLS, the focus_day() boundary
supabase/migrations/0002_functions.sql   apply_score_delta, rollover, summary view
supabase/migrations/0003_cron.sql        the hourly rollover + researcher export views
```

`0003` needs the `pg_cron` extension. It is available on all paid plans and on the
free plan in most regions; if `create extension pg_cron` fails, **skip that file** —
the lazy rollover in `apply_score_delta` keeps everything correct, days just get
banked when the user next opens their browser instead of at 01:00 sharp.

### 3. Google sign-in

Because Brave, Edge and plain Chromium don't support `chrome.identity.getAuthToken`,
the extension uses `launchWebAuthFlow` with a **Web application** OAuth client.

1. Build the extension once and load it, then copy its ID from `chrome://extensions`.
   Your redirect URI is:
   ```
   https://<extension-id>.chromiumapp.org/
   ```
2. [Google Cloud console](https://console.cloud.google.com/apis/credentials) →
   **Create credentials → OAuth client ID → Web application**. Add that URI under
   **Authorized redirect URIs**. Copy the client ID.
3. Supabase → **Authentication → Providers → Google**: enable it, and paste the same
   client ID into **Authorized Client IDs** (this is what lets Supabase accept the
   extension's `id_token`).

> **The extension ID must be stable.** An unpacked extension's ID is derived from its
> path, so moving the folder changes it and breaks the redirect URI. For a study,
> either publish to the Web Store (fixed ID) or pin the ID by adding a `"key"` field
> to `manifest.json`.

### 4. Configure and build

Fill in `src/extension/server/config.ts`:

```ts
export const SUPABASE_URL = 'https://<ref>.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...';
export const GOOGLE_CLIENT_ID = '....apps.googleusercontent.com';
```

```bash
npm run lint && npm run build
```

Then **Settings → Data sync → Sign in with Google** in the popup.

The anon key and client ID are compiled into the bundle and are **public by
design** — the anon key just says "anonymous role", and RLS pins every row to
`user_id = auth.uid()`. The **`service_role` key must never go in `src/`**: it
bypasses RLS entirely and would expose every participant's data to anyone who
unzipped the extension.

---

## Getting the data out

Researcher access is deliberately **not reachable from the extension**. Nothing a
signed-in user can call reads across users; RLS allows only their own rows.

Use the **SQL Editor** in the dashboard (it runs as `service_role`, bypassing RLS):

```sql
select * from export_daily;    -- every banked day, all users
select * from export_domains;  -- every user's whitelist
```

Both views are `revoke`d from `anon` and `authenticated`, so they are only reachable
this way. Use the toolbar's **Download CSV** to export.

Handy queries:

```sql
-- participants and how many days each has contributed
select u.email, count(*) as days, min(d.day), max(d.day)
from daily_scores d join auth.users u on u.id = d.user_id
group by u.email order by days desc;

-- current standing for everyone
select u.email, s.live_focus, s.avg7_focus, s.avg30_focus
from user_summary s join auth.users u on u.id = s.user_id
order by s.avg30_focus desc nulls last;
```

---

## Before you collect from real participants

Flagging these because this is set up to gather data from multiple people, not just
to sync your own devices. None of it is a blocker — it's what to decide *before* the
first participant signs in.

- **Google sign-in stores an email address.** `auth.users.email` is personal data and
  directly identifies each participant. If your ethics approval expects pseudonymous
  data, either strip it (`update auth.users set email = ...` is not viable — instead
  join through a separate participant-code table and export only the code), or make
  sure the approval covers holding it.
- **`user_domains` is browsing data.** The whitelist reveals which sites someone
  works on — potentially their employer, university, medical interests. It is more
  sensitive than the scores.
- **Consent and withdrawal.** There is no UI for "delete my data". `on delete
  cascade` means removing the `auth.users` row erases everything, so withdrawal is
  one dashboard action — but a participant currently has to ask you.
- **Sign-out doesn't delete anything**, on purpose: a study participant shouldn't
  destroy their contribution by accident.
- **The extension's local day starts at midnight, the server's at 01:00.** Points
  earned between 00:00 and 01:00 land on the previous day server-side and the new day
  locally, so the popup's chart and `daily_scores` can differ by that window. The
  server is the one to trust for analysis; tell me if you'd rather both used 01:00.
