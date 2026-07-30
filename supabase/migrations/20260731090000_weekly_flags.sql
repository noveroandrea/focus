-- ─────────────────────────────────────────────────────────────────────────────
--  One red flag per user per week
-- ─────────────────────────────────────────────────────────────────────────────
--  Replaces the "one flag per person per domain, revocable" model with a weekly
--  budget:
--
--    • every user holds 0 or 1 flags, in user_flags;
--    • every Monday at 01:00 LOCAL the holding is SET to 1 — set, not incremented,
--      so a week you didn't spend is a week you lost;
--    • spending one adds +1 to a domain's global tally and is PERMANENT: there is
--      no un-flagging, by design;
--    • the same domain may be flagged again in a later week, by the same person.
--
--  WHY THE MODEL CHANGED. The old rule made the flag count meaningful by capping it
--  at one per person per domain. Scarcity now does that job instead, and does it
--  better: a flag costs a week, so it says "this is the one site I most object to"
--  rather than "I clicked". Because scarcity is the control, repeat flagging is
--  safe to allow — three flags on one domain across three weeks is real signal.
--
--  MONDAY 01:00 FALLS OUT OF THE EXISTING DEFINITION. focus_day() already shifts a
--  timestamp back an hour before taking the date, so a focus-day turns over at 01:00
--  local. Truncating THAT to an ISO week (which starts Monday) gives a boundary at
--  Monday 01:00 local exactly, with no second definition to keep in step: at Monday
--  00:30 the focus-day is still Sunday and the week is last week's; at 01:00 both
--  turn together.
--
--  Like the day rollover, the grant is the CRON JOB'S alone — nothing lazy, nothing
--  client-side. pg_cron is required, not optional, and a user's flag returns within
--  one pass (≤5 minutes) of their local Monday 01:00.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The focus-week ────────────────────────────────────────────────────────────
create or replace function public.focus_week(p_at timestamptz, p_timezone text)
returns date
language sql
immutable
as $$
  -- date_trunc('week') is ISO: Monday. Composed with focus_day's 01:00 shift, the
  -- boundary is Monday 01:00 in the user's own timezone.
  select date_trunc('week', public.focus_day(p_at, p_timezone)::timestamp)::date;
$$;

comment on function public.focus_week is
  'The Monday-anchored focus-week a timestamp falls in. Weeks turn at Monday 01:00 local.';

revoke all on function public.focus_week(timestamptz, text) from anon;
grant execute on function public.focus_week(timestamptz, text) to authenticated;

-- ── user_flags ────────────────────────────────────────────────────────────────
-- One row per user, keyed on the user so a second holding cannot exist. `flag` is
-- 0 or 1 and nothing else — the check constraint is what makes "flags do not
-- accumulate" a property of the table rather than a promise made by the code that
-- writes it.
create table if not exists public.user_flags (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  flag       smallint    not null default 1 check (flag in (0, 1)),
  -- The Monday this holding belongs to. Comparing it to focus_week(now()) is how the
  -- grant knows whose week has turned, without needing to have run on any schedule.
  flag_week  date        not null,
  updated_at timestamptz not null default now()
);

comment on table public.user_flags is
  'Weekly red-flag budget: 0 or 1 per user, reset to 1 each Monday 01:00 local.';

-- Reached only through the SECURITY DEFINER functions below; RLS on with no policy
-- is a deny-all backstop against a future stray GRANT.
alter table public.user_flags enable row level security;
revoke all on public.user_flags from anon, authenticated;

-- The grant sweep filters on this.
create index if not exists user_flags_week_idx on public.user_flags (flag_week);

-- ── domain_flag_events ────────────────────────────────────────────────────────
-- domain_flag_voters was keyed (domain, user_id) to make flagging idempotent. That
-- was the anti-spam control; the weekly budget is now, and repeat flags are wanted,
-- so the key has to go. It becomes an append-only LEDGER instead — which keeps the
-- property that mattered: flag_count is RECOMPUTED from the events, never
-- incremented, so it cannot drift from the acts that justify it. It also tells the
-- researcher who flagged what and when, which the counter alone never could.
create table if not exists public.domain_flag_events (
  id         bigserial   primary key,
  domain     text        not null references public.domain_flags(domain) on delete cascade,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  flagged_at timestamptz not null default now()
);

create index if not exists domain_flag_events_domain_idx on public.domain_flag_events (domain);
create index if not exists domain_flag_events_user_idx   on public.domain_flag_events (user_id);

-- Carry over anything already flagged under the old model, then retire it.
insert into public.domain_flag_events (domain, user_id, flagged_at)
select domain, user_id, flagged_at from public.domain_flag_voters;

drop table if exists public.domain_flag_voters;

alter table public.domain_flag_events enable row level security;
revoke all on public.domain_flag_events from anon, authenticated;

comment on table public.domain_flag_events is
  'Append-only ledger of every red flag ever raised. domain_flags.flag_count is recomputed from this, never incremented.';

-- ── The weekly grant ──────────────────────────────────────────────────────────
-- Mirrors roll_forward_due(): the schedule fires often and each pass asks, per user,
-- whether THEIR week has turned. A cron time is one instant in UTC while users are in
-- every timezone, so "0 1 * * 1" would grant at Monday 01:00 UTC for everybody and be
-- wrong nearly everywhere.
create or replace function public.grant_weekly_flags()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with due as (
    select f.user_id,
           focus_week(now(), coalesce(s.timezone, 'UTC')) as wk
    from user_flags f
    left join user_summary s on s.user_id = f.user_id
  )
  update user_flags f
  -- SET to 1, never f.flag + 1. An unspent flag expires with its week; that is the
  -- whole point of the budget and the reason `flag` is constrained to 0 or 1.
  set flag       = 1,
      flag_week  = due.wk,
      updated_at = now()
  from due
  where due.user_id = f.user_id
    and due.wk > f.flag_week;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.grant_weekly_flags() from anon, authenticated, public;

-- Every 5 minutes, for the timezone reason above. Unscheduled first so re-running
-- this migration cannot stack duplicate jobs.
select cron.unschedule('focus-weekly-flags')
where exists (select 1 from cron.job where jobname = 'focus-weekly-flags');

select cron.schedule('focus-weekly-flags', '*/5 * * * *', $cron$ select public.grant_weekly_flags(); $cron$);

-- ── flag_domain, rewritten around the budget ──────────────────────────────────
-- No longer a toggle. Spending is one-way and the flag is gone until Monday.
create or replace function public.flag_domain(p_domain text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    uuid    := auth.uid();
  v_dom   text    := lower(btrim(coalesce(p_domain, '')));
  v_tz    text;
  v_spent boolean := false;
  v_count integer;
begin
  if v_me is null then
    raise exception 'flag_domain: not authenticated' using errcode = '28000';
  end if;
  if length(v_dom) = 0 or length(v_dom) > 253 then
    raise exception 'Not a domain' using errcode = '22023';
  end if;

  select coalesce(timezone, 'UTC') into v_tz from user_summary where user_id = v_me;
  v_tz := coalesce(v_tz, 'UTC');

  -- A user who has never posted has no row yet; first contact starts them with a
  -- flag for the current week rather than making them wait for a Monday.
  insert into user_flags (user_id, flag, flag_week)
  values (v_me, 1, focus_week(now(), v_tz))
  on conflict (user_id) do nothing;

  -- The `flag = 1` predicate IS the check. Two clicks racing each other can only
  -- match this row once, so the budget cannot be spent twice — no read-then-write
  -- window to lose.
  update user_flags
  set flag = 0, updated_at = now()
  where user_id = v_me and flag = 1;

  if not found then
    raise exception 'Your weekly red flag is already spent — you get another on Monday'
      using errcode = '55000';
  end if;
  v_spent := true;

  insert into domain_flags (domain) values (v_dom) on conflict (domain) do nothing;
  insert into domain_flag_events (domain, user_id) values (v_dom, v_me);

  update domain_flags
  set flag_count = (select count(*) from domain_flag_events where domain = v_dom),
      updated_at = now()
  where domain = v_dom
  returning flag_count into v_count;

  -- Both halves in one statement's transaction: a failure anywhere rolls the spend
  -- back with it, so a flag can never be deducted without landing.
  return json_build_object(
    'domain',         v_dom,
    'flag_count',     v_count,
    'flag_available', not v_spent
  );
end;
$$;

revoke all on function public.flag_domain(text) from anon, public;
grant execute on function public.flag_domain(text) to authenticated;

-- ── get_member_profile: domains carry my own tally, not a boolean ──────────────
-- `flagged_by_me` meant "and you cannot do it again". Repeats are allowed now, so it
-- becomes a count: how many of this domain's flags are mine.
create or replace function public.get_member_profile(p_user uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'get_member_profile: not authenticated' using errcode = '28000';
  end if;

  -- THE authorization check. p_user must be someone the caller can already see on a
  -- leaderboard; anything else is refused before a single score is read.
  if not exists (
    select 1
    from team_members m
    join visible_teams() v on v.team = m.team
    where m.user_id = p_user
  ) then
    raise exception 'That participant is not in any of your teams or competitions'
      using errcode = '42501';
  end if;

  return (
    select json_build_object(
      'user_id',      p_user,
      'display_name', coalesce(nullif(split_part(u.email, '@', 1), ''), 'participant'),
      'is_self',      p_user = v_me,

      'live_focus',       coalesce(s.live_focus, 0),
      'live_distracted',  coalesce(s.live_distracted, 0),
      'avg7_focus',       coalesce(s.avg7_focus, 0),
      'avg7_distracted',  coalesce(s.avg7_distracted, 0),
      'avg30_focus',      coalesce(s.avg30_focus, 0),
      'avg30_distracted', coalesce(s.avg30_distracted, 0),

      'days', coalesce((
        select json_agg(json_build_object(
                 'day', day,
                 'focus_score', focus_score,
                 'distracted_score', distracted_score) order by day desc)
        from (select day, focus_score, distracted_score
              from daily_scores
              where user_id = p_user
              order by day desc
              limit 30) recent), '[]'::json),

      'domains', coalesce((
        select json_agg(json_build_object(
                 'domain',     d.domain,
                 'flag_count', coalesce(f.flag_count, 0),
                 'my_flags',   (select count(*) from domain_flag_events w
                                where w.domain = d.domain and w.user_id = v_me)
               ) order by coalesce(f.flag_count, 0) desc, d.domain)
        from user_domains d
        left join domain_flags f on f.domain = d.domain
        where d.user_id = p_user), '[]'::json)
    )
    from auth.users u
    left join user_summary s on s.user_id = p_user
    where u.id = p_user
  );
end;
$$;

revoke all on function public.get_member_profile(uuid) from anon, public;
grant execute on function public.get_member_profile(uuid) to authenticated;

-- ── build_state: report whether the flag is in hand ────────────────────────────
-- Rides along on the reply every client already makes, so the badge in the popup is
-- refreshed by the same 1-minute post floor as everything else.
--
-- coalesce(..., 1): a user with no row yet has never spent anything, so showing the
-- flag as available is the truthful default — and flag_domain creates the row on the
-- way past, so the two agree the moment it matters.
create or replace function public.build_state()
returns json
language sql
security invoker
set search_path = public
as $$
  with t as (select build_teams() as j)
  select json_build_object(
    'summary', (select to_json(s) from summary s where s.user_id = auth.uid()),
    'domains', coalesce(
      (select json_agg(domain order by domain)
       from user_domains where user_id = auth.uid()),
      '[]'::json),
    'days', coalesce(
      (select json_agg(json_build_object(
                'day', day,
                'focus_score', focus_score,
                'distracted_score', distracted_score) order by day desc)
       from (select day, focus_score, distracted_score
             from daily_scores
             where user_id = auth.uid()
             order by day desc
             limit 30) recent),
      '[]'::json),
    'teams',        t.j -> 'teams',
    'competitions', t.j -> 'competitions',
    'flag', json_build_object(
      'available', coalesce((select flag from user_flags where user_id = auth.uid()), 1) = 1
    )
  )
  from t;
$$;

revoke all on function public.build_state() from anon, public;
grant execute on function public.build_state() to authenticated;

-- ── Give every new account its first flag ─────────────────────────────────────
-- apply_score_delta is where an account first materialises server-side, so the flag
-- row is created in the same breath as the summary row. Without this a participant
-- would hold no flag until their first Monday.
create or replace function public.apply_score_delta(
  p_focus_delta      numeric default 0,
  p_distracted_delta numeric default 0,
  p_timezone         text    default 'UTC',
  p_domains          text[]  default null
)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_tz   text := coalesce(nullif(trim(p_timezone), ''), 'UTC');
begin
  if v_user is null then
    raise exception 'apply_score_delta: not authenticated' using errcode = '28000';
  end if;

  begin
    perform now() at time zone v_tz;
  exception when others then
    v_tz := 'UTC';
  end;

  insert into user_summary (user_id, live_day, timezone)
  values (v_user, focus_day(now(), v_tz), v_tz)
  on conflict (user_id) do update set timezone = excluded.timezone;

  -- SECURITY INVOKER, and user_flags grants nothing to `authenticated` — so this has
  -- to go through the DEFINER helper rather than writing the table directly.
  perform ensure_weekly_flag(v_tz);

  update user_summary set
    live_focus      = live_focus      + greatest(coalesce(p_focus_delta, 0), 0),
    live_distracted = live_distracted + least(coalesce(p_distracted_delta, 0), 0),
    updated_at      = now()
  where user_id = v_user;

  if p_domains is not null then
    delete from user_domains
    where user_id = v_user and domain <> all (p_domains);

    insert into user_domains (user_id, domain)
    select v_user, trim(d)
    from unnest(p_domains) as d
    where length(trim(d)) > 0
    on conflict (user_id, domain) do nothing;
  end if;

  return build_state();
end;
$$;

revoke all on function public.apply_score_delta(numeric, numeric, text, text[]) from anon, public;
grant execute on function public.apply_score_delta(numeric, numeric, text, text[]) to authenticated;

-- Created before apply_score_delta references it at runtime; plpgsql resolves the
-- call on first execution, so declaration order in the file does not matter, but
-- keeping it adjacent does.
create or replace function public.ensure_weekly_flag(p_timezone text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into user_flags (user_id, flag, flag_week)
  values (auth.uid(), 1, focus_week(now(), coalesce(nullif(btrim(p_timezone), ''), 'UTC')))
  on conflict (user_id) do nothing;
$$;

revoke all on function public.ensure_weekly_flag(text) from anon, public;
grant execute on function public.ensure_weekly_flag(text) to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
--   select public.focus_week('2026-08-03 00:30+02'::timestamptz, 'Europe/Rome');  -- 2026-07-27
--   select public.focus_week('2026-08-03 01:30+02'::timestamptz, 'Europe/Rome');  -- 2026-08-03
-- (3 Aug 2026 is a Monday: the week turns between those two, at 01:00 local.)
--
-- Spending twice in one week must raise 55000:
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<your-uuid>','role','authenticated')::text, true);
--   select public.flag_domain('youtube.com');   -- ok
--   select public.flag_domain('youtube.com');   -- ERROR 55000
--   commit;
