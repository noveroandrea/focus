-- ─────────────────────────────────────────────────────────────────────────────
--  Focus — the 01:00 rollover schedule
-- ─────────────────────────────────────────────────────────────────────────────
--  This is the ONLY thing that ends a day. The extension never triggers a rollover
--  and does not need to — this runs inside the database, so a user's day rolls over
--  at their 01:00 whether their browser is open, shut, or the laptop is in a bag.
--
--  WHY NOT '0 1 * * *'. A cron schedule is a single wall-clock time on the SERVER,
--  and pg_cron's clock is UTC. `0 1 * * *` would mean 01:00 UTC — which is 02:00 in
--  Rome, 20:00 the previous day in New York, and 06:30 in Delhi. There is no single
--  minute at which every user's day ends.
--
--  So instead the job runs FREQUENTLY and asks each user's own row whether their
--  focus-day is over, using their stored timezone. focus_day() encodes the 01:00
--  boundary, so "over" is just live_day < focus_day(now(), timezone). Every 5
--  minutes covers every real-world UTC offset (they are all multiples of 15 min,
--  including the :30 and :45 ones like Delhi and Kathmandu) and bounds how long a
--  finished day stays open.
--
--  That window matters because apply_score_delta only ever adds to the live score:
--  a delta arriving between a user's 01:00 and the next pass is attributed to the
--  day being closed. Five minutes of misattribution at 1 a.m. is a fair price for
--  having exactly one place that ends a day.
--
--  The query behind this is a single indexed scan that returns no rows almost every
--  time, so a 5-minute cadence is cheap.
--
--  pg_cron is therefore REQUIRED, not optional: without it days never roll over,
--  the live score grows forever and daily_scores stays empty. Verify it is enabled
--  before collecting data (see supabase/README.md).
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;

-- Re-running this migration must not stack duplicate schedules.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'focus-rollover') then
    perform cron.unschedule('focus-rollover');
  end if;
end;
$$;

select cron.schedule(
  'focus-rollover',
  '*/5 * * * *',   -- every 5 minutes; see the note above on why not '0 1 * * *'
  $$ select public.roll_forward_due(); $$
);

-- Check it registered, and watch it run:
--   select jobname, schedule, active from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;

-- ── Researcher export ─────────────────────────────────────────────────────────
-- Deliberately NOT granted to `authenticated`: nothing reachable from the
-- extension may read across users. Query these through the SQL editor or with the
-- service_role key, which bypasses RLS (see supabase/README.md).
--
-- Joins the banked days to each user's current standing. auth.users.email is
-- included because that is what Google sign-in gives you as an identifier — see
-- the README's note on what that means for a study before you export it.
create or replace view public.export_daily as
select
  d.user_id,
  u.email,
  d.day,
  extract(isodow from d.day)          as weekday_number,
  to_char(d.day, 'FMDay')             as weekday,
  d.focus_score,
  d.distracted_score,
  s.timezone
from public.daily_scores d
join auth.users u          on u.id = d.user_id
left join public.user_summary s on s.user_id = d.user_id
order by d.user_id, d.day;

comment on view public.export_daily is
  'Researcher-only: every banked day across all users. Not granted to authenticated.';

revoke all on public.export_daily from anon, authenticated;

create or replace view public.export_domains as
select
  w.user_id,
  u.email,
  w.domain,
  w.added_at
from public.user_domains w
join auth.users u on u.id = w.user_id
order by w.user_id, w.domain;

comment on view public.export_domains is
  'Researcher-only: every user''s whitelisted domains. Not granted to authenticated.';

revoke all on public.export_domains from anon, authenticated;
