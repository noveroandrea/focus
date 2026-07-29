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
score, and returns the refreshed summary in the same round trip. Because a `(0, 0)`
delta is just a read, that one endpoint covers all three moments the client checks
in:

| Trigger | Delta sent |
|---|---|
| a score change | the points earned/lost |
| the browser opening | `(0, 0)` unless something is pending |
| the **Working** button clicked | `(0, 0)` unless something is pending |

**The client knows nothing about rollover.** It posts deltas and renders whatever
live score comes back. Days are ended by the server, on the server's schedule —
nothing in the extension tracks, triggers, or asks about it. Just after a rollover
the client may still show the previous day's figure until its next post returns the
reset one. That is by design: teaching both sides the same calendar, and keeping them
agreeing, costs far more than a briefly stale number.

### Why deltas and not absolute scores

Each device sends only what **it** earned since its own last successful post, and
gets back the running total across **all** devices:

| | server total | that device shows |
|---|---|---|
| starting point | 10 | |
| laptop posts `+1` | 11 | 11 |
| phone posts `+1` | 12 | 12 |
| laptop posts `+0` | 12 | 12 |

Every device converges on the same total without needing to know what the others
did. Sending absolutes would *lose* points: the laptop would claim "my total is 11"
and the phone "my total is 11", and the server would settle on 11 instead of 12 —
the slower device silently overwriting the faster.

Unsent deltas live in `chrome.storage.local`, not memory, because an MV3 service
worker is suspended between events. They clear only once the server confirms them,
so being offline delays a post but never drops it.

### The 01:00 rollover

A **focus-day runs 01:00 → 01:00 local time**, defined once in `focus_day()`.

Ending a day happens **only on the server**, in the `pg_cron` job
(`0003_cron.sql`). The extension never triggers a rollover and doesn't need to: the
job runs inside the database, so a user's day rolls over at their 01:00 whether
their browser is open, shut, or the laptop is in a bag.

**Why the schedule isn't `0 1 * * *`.** A cron schedule is one wall-clock time on
the server, and pg_cron's clock is UTC. `0 1 * * *` means 01:00 UTC — which is 02:00
in Rome, 20:00 the previous day in New York, 06:30 in Delhi. There is no single
minute at which everyone's day ends. So the job instead runs **every 5 minutes** and
asks each user's row whether *their* focus-day is over, using their stored timezone.
Five minutes covers every real-world UTC offset, including the `:30`/`:45` ones.

Because `apply_score_delta` only ever adds to the live score, a delta arriving
between a user's 01:00 and the next pass is attributed to the day being closed —
at most 5 minutes of misattribution, at 1 a.m., in exchange for having exactly one
place that ends a day.

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
supabase/migrations/0003_cron.sql        the 01:00 rollover schedule + researcher export views
```

**`0003` is required, not optional.** It installs `pg_cron`, which is the only thing
that ends a day: without it the live score grows forever and `daily_scores` stays
empty. Confirm it registered before collecting any data:

```sql
select jobname, schedule, active from cron.job;
select * from cron.job_run_details order by start_time desc limit 20;
```

If `create extension pg_cron` fails, enable it under **Database → Extensions** and
re-run the file.

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
