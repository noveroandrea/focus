-- ─────────────────────────────────────────────────────────────────────────────
--  Focus — the 01:00 rollover schedule
-- ─────────────────────────────────────────────────────────────────────────────
--  Runs HOURLY, not once a day at 01:00 UTC. Users are in different timezones, so
--  there is no single wall-clock minute at which everyone's day ends; the hourly
--  pass asks each user's own row whether their focus-day is over (focus_day()
--  encodes the 01:00 boundary) and rolls over only those that are.
--
--  The cron job is a convenience, NOT the guarantee. apply_score_delta() performs
--  the same check on every call, so a user is rolled over correctly even if cron
--  is unavailable, the project is paused, or they were offline at 01:00. Both paths
--  call the same idempotent roll_forward(), so a race just makes one of them a
--  no-op. Deleting this file's schedule degrades timeliness, never correctness.
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

-- At minute 5 of every hour: a few minutes' slack past the hour boundary so a user
-- whose clock is slightly ahead of the server's is not banked a minute early.
select cron.schedule(
  'focus-rollover',
  '5 * * * *',
  $$ select public.roll_forward_due(); $$
);

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
