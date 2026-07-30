# Focus — Supabase backend

Optional server for the Focus extension. It stores, per signed-in user:

| What | Where |
|---|---|
| Live score (current focus-day, still accumulating) | `user_summary.live_*` |
| Every completed day | `daily_scores` |
| Last 3 completed days | `user_summary.d1_* / d2_* / d3_*` |
| 7-day and 30-day averages | `user_summary.avg7_* / avg30_*` |
| Whitelisted page domains | `user_domains` |
| Team membership | `team_members` (pk `user_id, team`) |
| Which competitions a team is in | `team_competitions` (pk `team, competition`) |

The extension works **fully without any of this**. Until `src/extension/server/config.ts`
is filled in *and* the user signs in, every server call is a no-op.

---

## How the extension talks to it

Two endpoints, and only one of them writes:

```
POST /rest/v1/rpc/apply_score_delta   { p_focus_delta, p_distracted_delta,
                                        p_timezone, p_domains }
POST /rest/v1/rpc/get_state           { p_timezone }        read-only
```

Both return the **full state** — everything the client renders, so it never has to
assemble a view of the world from its own records:

```json
{ "summary": { "live_focus": 12, "live_distracted": -30, "live_day": "2026-07-29",
               "d1_focus": 8, "...": "...", "avg7_focus": 9.5, "avg30_focus": 7.1 },
  "domains": ["arxiv.org", "overleaf.com"],
  "days":    [ { "day": "2026-07-28", "focus_score": 8, "distracted_score": -10 },
               "... 30 most recent completed days ..." ],
  "teams":   [ { "team": "math_students",
                 "members": [ { "display_name": "andrea", "is_self": true,
                                "live_focus": 12, "live_distracted": -30,
                                "avg7_focus": 9.5, "avg30_focus": 7.1, "...": "..." } ] } ],
  "competitions": [
    { "competition": "uni_cup",
      "teams":   [ { "team": "math_students", "is_mine": true, "member_count": 3,
                     "live_focus": 40, "...": "..." } ],
      "members": [ { "team": "psycho_students", "display_name": "ada", "...": "..." } ] } ] }
```

The **whitelist is written through the same call** (`p_domains`) rather than its own
endpoint, so a score delta and a whitelist edit cannot race — the reply always
reflects the write that just happened. `p_domains` is `null` on almost every call,
meaning "no edit"; an empty *array* is different and does clear the list.

### Teams and competitions

Three more write endpoints, all returning that same full state so a membership change
repaints everything from its own reply:

```
POST /rest/v1/rpc/join_team          { p_team, p_create, p_password }
POST /rest/v1/rpc/leave_team         { p_team }
POST /rest/v1/rpc/enroll_team        { p_team, p_competition, p_create, p_password }
POST /rest/v1/rpc/leave_competition  { p_team, p_competition }
```

**Teams and competitions both have a password** (bcrypt, in `password_hash` on each
table). Creating sets it, joining must match it. Neither hash is reachable by any
client: `SELECT` on the table is revoked and re-granted column by column, omitting
`password_hash`, so PostgREST cannot be asked for it at any URL — RLS filters *rows*
and cannot hide a *column*, which is why this layer exists at all.

That is also why `join_team` and `enroll_team` are the two membership functions that
are `SECURITY DEFINER`: they have to read the column nobody else can. Both keep the
safe shape — no `user_id` parameter, caller from `auth.uid()`, `EXECUTE` revoked from
`anon` and `PUBLIC` — and because RLS is bypassed under `DEFINER`, the explicit
`user_id = auth.uid()` / team-membership predicates in their bodies are load-bearing
rather than belt-and-braces.

The competition password closes a route that the team password left open: create a
team with your own password, enrol it into a known competition name, and you shared a
competition with every team in it — so `visible_teams()` legitimately returned them
and `get_member_profile` handed over their scores and browsing data. Nothing there
was a bug; the rule was just satisfiable unilaterally. Now step two needs a secret.

`leave_competition` is deliberately **not** passworded: withdrawing your own team
needs no permission you didn't already have, and requiring the password to leave
would strand a team whose organiser forgot it.

### Profiles and domain flags

```
POST /rest/v1/rpc/get_member_profile  { p_user }      read-only
POST /rest/v1/rpc/flag_domain         { p_domain }
```

Tapping a participant on a leaderboard opens their live / 7-day / 30-day scores,
their day history, and their whitelisted domains. Each domain carries a **global**
red-flag tally — flagging `youtube.com` on one profile raises the same counter every
other profile shows. `flag_domain` is a toggle, and the count is *recomputed* from
`domain_flag_voters` rather than incremented, so it cannot drift from the votes
behind it.

`domain_flag_voters` (keyed `domain, user_id`) is not in the original spec and is
there so one person cannot inflate a count by holding the button down — the same
composite-key trick `team_members` uses.

> **This is the schema's most sensitive exposure.** `user_domains` is browsing data:
> it says where someone works, which university, which mail provider, which projects.
> Until now only the researcher could read it. A participant's peers can now read it
> too. **That belongs in the consent form in those words.** If it shouldn't, delete
> the `domains` key from `get_member_profile`'s payload — the profile still works
> without it, and the flag tables remain useful to the researcher.

`get_member_profile` takes a `user_id` — the exact shape behind the vulnerability
fixed in `20260729210000_harden_function_privileges.sql`. It is safe only because of
the explicit authorization check in its body: the target must already be visible to
the caller through a shared team or competition. That check and `build_teams()` now
consult one definition, `visible_teams()`, so the thing that authorizes and the
thing that displays cannot drift apart.

`p_create` is the difference between two intents, not a convenience flag: creating
refuses a name that already exists, joining refuses one that doesn't. A mistyped
"join" therefore cannot silently found a one-person team, and a "create" cannot drop
you into a stranger's.

**Who can see whose scores** is decided in exactly one place, `build_teams()`:

- members of teams you are in;
- members of teams that share a competition with one of yours;
- nobody else.

`user_summary` keeps its `user_id = auth.uid()` RLS policy. `build_teams()` is the
only way around it, and is built to the safe shape: **no arguments** (the caller is
`auth.uid()` and cannot be passed in), `EXECUTE` revoked from `anon` and `PUBLIC`.
See the header of `20260729210000_harden_function_privileges.sql` for what goes wrong
when a `SECURITY DEFINER` function takes a `user_id` parameter instead.

**Ranking** is by `focus + distracted`. `distracted_score` is stored *negative*, so
that expression is "focus minus distraction". Writing the subtraction literally would
rank a distracted user above a focused one.

**Team scores are sums**, not means, so a bigger team scores higher; `member_count`
travels with every team row so the board can be read honestly.

> **PII:** `build_teams()` exposes the local part of each member's email as
> `display_name` (`andrea9roa9@gmail.com` → `andrea9roa9`), because a leaderboard has
> to name someone. That is a disclosure *between participants* and belongs in the
> consent form. To anonymise, change the single `split_part` expression in
> `20260730120000_teams.sql` to a stable pseudonym.

### The client has no day rollover

`maybeRollover()` and `archiveDay()` are removed on this branch. The server ends the
day and every reply carries the reset live score plus the 30 most recent completed
days, so a second midnight-based rollover in the client could only disagree with it —
the two boundaries are an hour apart, so it used to zero the score at 00:00 and then
have it jump back on the next post.

> **This makes the server mandatory for day tracking.** Signed out, or with
> `config.ts` unfilled, nothing ends a day: the live score grows indefinitely and no
> history is banked. The extension still works as a focus companion — sprite, idle
> detection, beeps, whitelist — but scores stop being daily.

### Instant feedback, server-authoritative numbers

Scores update **locally the instant a point is earned**, so the sprite's `+1` and the
`−10` fly-up need no round trip. The post then goes out, and the live score in its
reply **replaces** the displayed figure — on both the sprite and the popup.

The reconciled value is `server_live_score + still_pending`. The `+ pending` matters:
deltas queued while that request was in flight are not in the number the server just
sent, so using the bare server value would visibly take away points the user was
already shown earning, and the next post would re-add them — the number would jump
twice.

Neither the fly-up nor the character-change fireworks are disturbed by
reconciliation, because both are triggered by their own timestamp nonces
(`penaltyAt`, `iconChangeAt`), not by the score numbers changing.

### The server is the source of truth

Scores, the whitelist and the day history all live on the server. The extension keeps
a local copy in the same `chrome.storage.local` keys it always used
(`focusFlowSettings.allowedDomains`, `focusScoreHistory`), but those are now a
**cache**, overwritten by every response — not an independent record.

It cannot be *zero* local storage: `heartbeat.ts` has to decide whether to activate
on every page load, instantly and offline, long before any request could return. So
the local copy stays and is simply demoted from record to cache. Everything that
reads it — the content script, `isAllowedUrl()`, the popup charts — keeps working
unchanged, offline included.

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

Ending a day happens **only on the server**, in the `pg_cron` job set up by the cron
migration. The extension never triggers a rollover and doesn't need to: the
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

```
supabase/migrations/
  20260729183000_schema.sql      tables, RLS, the focus_day() boundary
  20260729183100_functions.sql   apply_score_delta, get_state, build_state, rollover
  20260729183200_cron.sql        the 01:00 rollover schedule + researcher export views
```

Filenames use the Supabase `<timestamp>_<name>.sql` convention, so they apply in
order and register correctly in the migration history. Three ways to apply them:

**a. GitHub integration** — if the repo is connected to the project under
**Project Settings → Integrations → GitHub**, migrations deploy on push to the
configured production branch. Nothing to run by hand; watch the deploy under the
integration's activity log. Note it deploys **only** SQL: `config.ts`, the Google
OAuth client and the provider settings are all still manual (steps 3–5).

**b. CLI**

```bash
npx supabase link --project-ref <your-project-ref>
npx supabase db push
```

**c. SQL Editor** — paste each file's contents and Run, in filename order.

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
