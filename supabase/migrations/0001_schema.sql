-- ─────────────────────────────────────────────────────────────────────────────
--  Focus — schema
-- ─────────────────────────────────────────────────────────────────────────────
--  Three tables, as specified:
--
--    daily_scores   per user, one row per completed focus-day
--    user_domains   per user, the whitelist of pages they track
--    user_summary   one row per user: live score, last 3 days, 7d + 30d averages
--
--  Identity comes from Supabase Auth (Google sign-in), so every table keys on
--  auth.users(id) and RLS restricts every row to its owner. Researcher access to
--  the whole dataset is deliberately NOT reachable from the extension — use the
--  service_role key in the dashboard / SQL editor (see supabase/README.md).
--
--  THE FOCUS DAY. Scores roll over at 01:00 local time, not midnight, so a "focus
--  day" runs 01:00 → 01:00. That boundary is expressed once, in focus_day(), and
--  everything else derives from it, so the rollover and every read agree by
--  construction about which day a score belongs to.
--
--  Ending a day is the cron job's business ALONE (0003_cron.sql). Nothing in the
--  extension, and no other function here, moves a score between days:
--  apply_score_delta only ever adds to the live score. One writer, one scheduler.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The focus-day boundary ────────────────────────────────────────────────────
-- Shifting back an hour before taking the date maps 00:00–00:59 onto the previous
-- day, which is exactly what "the day ends at 01:00" means. IMMUTABLE so it can be
-- used in indexes and generated columns if ever needed.
create or replace function public.focus_day(p_at timestamptz, p_timezone text)
returns date
language sql
immutable
as $$
  select ((p_at at time zone coalesce(p_timezone, 'UTC')) - interval '1 hour')::date;
$$;

comment on function public.focus_day is
  'The focus-day a timestamp belongs to in a given timezone. Days end at 01:00 local.';

-- ── daily_scores ──────────────────────────────────────────────────────────────
-- One row per user per completed focus-day. Written only by the rollover, which
-- banks the live score and then resets it. Mirrors the extension's DayScore.
--
-- focus_score is always >= 0 and distracted_score always <= 0: they are two
-- one-directional counters, deliberately kept apart so a bad stretch never erases
-- earned focus. Do NOT collapse them into a net score — 50/-50 and 0/0 are very
-- different days and the difference is unrecoverable once summed.
create table if not exists public.daily_scores (
  user_id           uuid          not null references auth.users(id) on delete cascade,
  day               date          not null,
  focus_score       numeric(12,2) not null default 0 check (focus_score >= 0),
  distracted_score  numeric(12,2) not null default 0 check (distracted_score <= 0),
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  primary key (user_id, day)
);

comment on table public.daily_scores is
  'One row per user per completed focus-day (banked by the 01:00 rollover).';

-- The averages scan a trailing window per user, so this is the index that matters.
create index if not exists daily_scores_user_day_idx
  on public.daily_scores (user_id, day desc);

-- ── user_domains ──────────────────────────────────────────────────────────────
-- The user's whitelist, mirrored from Settings.allowedDomains. Full replace on
-- sync (the extension owns the list), so there is no ordering column.
create table if not exists public.user_domains (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  domain     text        not null check (length(trim(domain)) > 0),
  added_at   timestamptz not null default now(),
  primary key (user_id, domain)
);

comment on table public.user_domains is
  'Per-user whitelist of tracked page domains, mirrored from the extension settings.';

-- ── user_summary ──────────────────────────────────────────────────────────────
-- One row per user, holding the six score slots the extension reads back:
--
--   live            the in-progress focus-day, incremented by apply_score_delta()
--   d1 / d2 / d3    the three most recent completed focus-days
--   avg7 / avg30    trailing averages over COMPLETE days ending yesterday
--
-- Each slot carries both focus and distracted (see the note on daily_scores), so
-- six logical slots are twelve physical value columns.
--
-- d1..d3 and the averages are denormalised from daily_scores, refreshed by
-- refresh_rollup(). That is safe rather than drift-prone because all five only
-- ever change when a day rolls over: they describe completed days, so they are
-- constant for the whole of the current focus-day.
create table if not exists public.user_summary (
  user_id           uuid          primary key references auth.users(id) on delete cascade,

  -- live (current focus-day, still accumulating)
  live_focus        numeric(12,2) not null default 0 check (live_focus >= 0),
  live_distracted   numeric(12,2) not null default 0 check (live_distracted <= 0),
  live_day          date          not null,

  -- the three most recent completed days (d1 = most recent)
  d1_focus          numeric(12,2) not null default 0,
  d1_distracted     numeric(12,2) not null default 0,
  d2_focus          numeric(12,2) not null default 0,
  d2_distracted     numeric(12,2) not null default 0,
  d3_focus          numeric(12,2) not null default 0,
  d3_distracted     numeric(12,2) not null default 0,

  -- trailing averages over complete days ending yesterday
  avg7_focus        numeric(12,2) not null default 0,
  avg7_distracted   numeric(12,2) not null default 0,
  avg30_focus       numeric(12,2) not null default 0,
  avg30_distracted  numeric(12,2) not null default 0,

  -- bookkeeping. timezone is the IANA name reported by the browser and is what
  -- makes the 01:00 rollover land at the user's local 01:00 rather than UTC's.
  timezone          text          not null default 'UTC',
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);

comment on table public.user_summary is
  'One row per user: live score, last 3 completed days, 7- and 30-day averages.';

-- The cron job selects the users whose local 01:00 has passed, so it filters on
-- (timezone, live_day) across the whole table.
create index if not exists user_summary_rollover_idx
  on public.user_summary (live_day);

-- ── Row-level security ────────────────────────────────────────────────────────
-- Every table: a user reads and writes only their own rows, and can never name a
-- different user_id (the WITH CHECK clauses pin it to auth.uid()).
alter table public.daily_scores  enable row level security;
alter table public.user_domains  enable row level security;
alter table public.user_summary  enable row level security;

drop policy if exists daily_scores_own on public.daily_scores;
create policy daily_scores_own on public.daily_scores
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists user_domains_own on public.user_domains;
create policy user_domains_own on public.user_domains
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists user_summary_own on public.user_summary;
create policy user_summary_own on public.user_summary
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Supabase grants the public schema to anon + authenticated by default, so state
-- both sides explicitly rather than inheriting: anon must never touch these tables,
-- and authenticated needs table-level rights for the RLS policies above to have
-- anything to narrow. (service_role bypasses RLS and is dashboard-only.)
revoke all on public.daily_scores, public.user_domains, public.user_summary from anon;
grant select, insert, update, delete
  on public.daily_scores, public.user_domains, public.user_summary
  to authenticated;
