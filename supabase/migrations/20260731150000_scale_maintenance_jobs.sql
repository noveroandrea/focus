-- ─────────────────────────────────────────────────────────────────────────────
--  Making the 5-minute jobs survive 50k users / 100k domains
-- ─────────────────────────────────────────────────────────────────────────────
--  Sized for the target scale rather than the pilot:
--
--    50,000 users × ~20 whitelisted domains = 1,000,000 rows in user_domains (~60 MB)
--    50,000 rows in user_summary and user_flags (~8 MB, stays cached)
--
--  At that size the two */5 jobs behave very differently, and only one of them was
--  actually a problem.
--
--  ── THE DOMAIN SWEEP WAS THE PROBLEM ────────────────────────────────────────
--  A full DISTINCT over user_domains every 5 minutes is 288 million rows and ~17 GB
--  of buffer churn per day. The CPU is survivable; the cache eviction is not the
--  kind of thing you want a *safety net* doing — 60 MB of cold pages displacing hot
--  ones, 288 times a day, to discover nothing 99.9% of the time.
--
--  It is now INCREMENTAL: user_domains.added_at already existed, so the sweep reads
--  only rows added since the last pass, via a watermark. A few rows instead of a
--  million. A full sweep still runs, once daily, as the backstop's backstop.
--
--  ── THE WEEKLY GRANT NEEDED ONE PREDICATE ───────────────────────────────────
--  It computed focus_week() for all 50,000 users every pass to find the handful
--  whose Monday had arrived. The fix is an indexable necessary condition:
--
--      flag_week < focus_week(now() + interval '14 hours', 'UTC')
--
--  UTC+14 is the largest real offset, so that expression is the EARLIEST-turning
--  timezone's week — an upper bound no user's own week can exceed. Any user who is
--  due must satisfy it, so it prunes safely, and it reads straight off
--  user_flags_week_idx.
--
--  It is also extremely selective, for a reason specific to weeks: local DATES
--  differ across timezones every single day, but local ISO WEEKS only differ during
--  the ~26 hours that Monday is sweeping round the globe. So for roughly 6.9 days
--  out of 7 this is an empty index scan and the function does nothing at all.
--
--  ── WHY roll_forward_due IS LEFT ALONE ──────────────────────────────────────
--  The same trick does NOT work there. `live_day < focus_day(now() + 14h, 'UTC')` is
--  true for everyone in a behind-timezone essentially all the time, because dates DO
--  differ across the world continuously — there is no quiet 6.9 days. It stays a
--  scan of user_summary, which is 8 MB, stays in cache, and costs tens of
--  milliseconds. 288 of those a day is a rounding error, and the 5-minute cadence is
--  exactly what bounds how long after a user's local 01:00 their day turns.
--
--  Both jobs stay on */5. That cadence is a correctness property — it is the
--  accuracy of every per-timezone boundary in the system — so the work was made to
--  fit the schedule rather than the schedule stretched to fit the work.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Watermarks ────────────────────────────────────────────────────────────────
-- One row per periodic task. Deliberately generic: the next job that needs to
-- remember where it got to should use this rather than inventing its own table.
create table if not exists public.maintenance_state (
  key        text        primary key,
  ts         timestamptz not null,
  updated_at timestamptz not null default now()
);

comment on table public.maintenance_state is
  'Watermarks for incremental background jobs. Server-side only; no client grants.';

alter table public.maintenance_state enable row level security;
revoke all on public.maintenance_state from anon, authenticated;

-- The index that makes the incremental sweep a range scan instead of a seq scan.
create index if not exists user_domains_added_at_idx on public.user_domains (added_at);

-- ── Incremental registration ──────────────────────────────────────────────────
create or replace function public.register_new_domains()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Rewind the new watermark by this much. A row whose added_at was stamped at
  -- statement start but whose transaction committed later would otherwise fall into
  -- the gap between two passes and never be swept. Re-reading a few minutes of rows
  -- is free — ON CONFLICT DO NOTHING writes nothing when the domain already exists —
  -- whereas missing one is silent and permanent.
  c_overlap constant interval := interval '10 minutes';

  v_since timestamptz;
  v_now   timestamptz := now();
  v_count integer;
begin
  select ts into v_since from maintenance_state where key = 'domain_registry_swept_at';
  -- No watermark yet (first run, or the row was cleared) → sweep everything once.
  v_since := coalesce(v_since, '-infinity'::timestamptz);

  insert into domain_flags (domain)
  select distinct lower(btrim(d.domain))
  from user_domains d
  where d.added_at >= v_since
    and length(btrim(d.domain)) > 0
    and length(btrim(d.domain)) <= 253
  on conflict (domain) do nothing;

  get diagnostics v_count = row_count;

  insert into maintenance_state (key, ts)
  values ('domain_registry_swept_at', v_now - c_overlap)
  on conflict (key) do update set ts = excluded.ts, updated_at = now();

  return v_count;
end;
$$;

revoke all on function public.register_new_domains() from anon, authenticated, public;

-- ── Full registration, as the daily backstop ──────────────────────────────────
-- Everything the incremental path could ever miss — a watermark written wrongly, a
-- future code path that inserts into user_domains with a backdated added_at, a
-- restore from backup. One 1M-row DISTINCT per day is nothing; 288 of them is what
-- this migration exists to stop.
create or replace function public.register_all_domains()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into domain_flags (domain)
  select distinct lower(btrim(d.domain))
  from user_domains d
  where length(btrim(d.domain)) > 0
    and length(btrim(d.domain)) <= 253
  on conflict (domain) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.register_all_domains() from anon, authenticated, public;

-- ── grant_weekly_flags, pruned ────────────────────────────────────────────────
create or replace function public.grant_weekly_flags()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  -- The earliest-turning timezone's week. UTC+14 is the largest real offset, so no
  -- user's own focus_week can exceed this — which is what makes it a safe prefilter
  -- rather than an approximation.
  v_max_wk date := focus_week(now() + interval '14 hours', 'UTC');
  v_count  integer;
begin
  -- Cheap now: only rows added since the last pass. See the header.
  perform register_new_domains();

  with due as (
    select f.user_id,
           focus_week(now(), coalesce(s.timezone, 'UTC')) as wk
    from user_flags f
    left join user_summary s on s.user_id = f.user_id
    -- Indexable, and empty ~6.9 days out of 7. Everything below only ever sees the
    -- users who could possibly be due.
    where f.flag_week < v_max_wk
  )
  update user_flags f
  -- SET to 1, never f.flag + 1. An unspent flag expires with its week; that is the
  -- whole point of the budget and the reason `flag` is constrained to 0 or 1.
  set flag       = 1,
      flag_week  = due.wk,
      updated_at = now()
  from due
  where due.user_id = f.user_id
    -- The exact per-user check. v_max_wk narrows the candidates; this decides.
    and due.wk > f.flag_week;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.grant_weekly_flags() from anon, authenticated, public;

-- ── Schedule ──────────────────────────────────────────────────────────────────
-- Unscheduled first so re-running this migration cannot stack duplicate jobs.
select cron.unschedule('focus-domain-registry')
where exists (select 1 from cron.job where jobname = 'focus-domain-registry');

-- 03:17 rather than 03:00: an odd minute keeps it off the same tick as the */5 jobs
-- and every other cron on the box.
select cron.schedule('focus-domain-registry', '17 3 * * *',
                     $cron$ select public.register_all_domains(); $cron$);

-- ── Verify ────────────────────────────────────────────────────────────────────
-- The prefilter must prune to nothing outside the Monday window:
--
--   explain (analyze, buffers)
--   select f.user_id from public.user_flags f
--   where f.flag_week < public.focus_week(now() + interval '14 hours', 'UTC');
--   -- expect an Index Scan on user_flags_week_idx, 0 rows, single-digit buffers
--
-- Actual job cost, once there is real data — this is the number that settles it:
--
--   select jobname, status, end_time - start_time as duration, start_time
--   from cron.job_run_details
--   order by start_time desc limit 20;
--
-- And the registry must still be complete despite the incremental path:
--
--   select count(*) as unregistered
--   from (select distinct lower(btrim(domain)) as d from public.user_domains) u
--   left join public.domain_flags f on f.domain = u.d
--   where f.domain is null;                       -- must be 0
