-- ─────────────────────────────────────────────────────────────────────────────
--  A day series for a GROUP — the two Personal charts, over a team or your friends
-- ─────────────────────────────────────────────────────────────────────────────
--  The Personal section draws two charts the group sections had no data for: the
--  diverging bars (30-day average, 7-day average, then the last few days) and the
--  whole-history trend line. Both need a SERIES of days, and nothing sent so far
--  carries one for anybody but the caller —
--
--    get_my_days          the caller's own 30 days
--    get_team_board       members' live / 7d / 30d, three numbers each, no history
--    get_member_profile   one member's days, but only when you click that member
--
--  So a team's chart cannot be assembled client-side from what the popup already
--  has: it would need every member's full history, which is precisely the payload
--  the on-demand split exists to avoid. Aggregating in SQL sends ~30 rows however
--  many members there are.
--
--  ── TWO AVERAGING CONVENTIONS, ON PURPOSE ───────────────────────────────────
--  member-level (live / avg7 / avg30)
--      Mean over EVERY member, a missing user_summary row counting as 0. This is
--      exactly what the leaderboard shows — a member who has never posted appears
--      on it at 0 — so the "7 d" bar equals the mean of the board's 7-day column.
--      Any other choice would make the chart and the board above it disagree.
--
--  day-level (one bar per date)
--      Mean over the members who RECORDED that day. A day someone's machine was
--      never switched on is absent, not zero; counting it as zero would drag every
--      team average down in proportion to how many people took the weekend off.
--      This is the same rule windowAvg() applies per-user on the client.
--
--  ── COST ────────────────────────────────────────────────────────────────────
--  Scans members × 30 days through daily_scores_user_day_idx and returns 30 rows.
--  Fetched ONCE when a section opens — not on the boards' 60-second refresh —
--  because a completed day changes once a day, at the 01:00 rollover. That is the
--  same rule get_my_days follows, and it is what keeps a large team affordable.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The shared aggregation ────────────────────────────────────────────────────
-- SECURITY INVOKER, and callable by nobody. It takes a user array, which is the
-- shape that caused the vulnerability fixed in 20260729210000 — so it is never
-- reachable from a client: EXECUTE is revoked, and its only callers are the two
-- DEFINER functions below, which run as the owner and decide the array themselves.
-- Invoker is deliberate: inside those callers the effective user IS the owner, so
-- it reads daily_scores without a privilege of its own to be abused.
create or replace function public.group_day_series(p_users uuid[])
returns json
language sql
stable
security invoker
set search_path = public
as $$
  select json_build_object(
    'member_count', coalesce(array_length(p_users, 1), 0),

    -- Every member counts, missing summary row included as 0 — the board's rule.
    'summary', (
      select json_build_object(
               'live_focus',       coalesce(round(avg(coalesce(s.live_focus, 0)), 2), 0),
               'live_distracted',  coalesce(round(avg(coalesce(s.live_distracted, 0)), 2), 0),
               'avg7_focus',       coalesce(round(avg(coalesce(s.avg7_focus, 0)), 2), 0),
               'avg7_distracted',  coalesce(round(avg(coalesce(s.avg7_distracted, 0)), 2), 0),
               'avg30_focus',      coalesce(round(avg(coalesce(s.avg30_focus, 0)), 2), 0),
               'avg30_distracted', coalesce(round(avg(coalesce(s.avg30_distracted, 0)), 2), 0)
             )
      from unnest(p_users) as m(user_id)
      left join user_summary s on s.user_id = m.user_id
    ),

    -- Only members who recorded the day count toward it.
    'days', coalesce((
      select json_agg(json_build_object(
               'day',              d.day,
               'focus_score',      d.focus_score,
               'distracted_score', d.distracted_score) order by d.day desc)
      from (
        select day,
               round(avg(focus_score), 2)      as focus_score,
               round(avg(distracted_score), 2) as distracted_score
        from daily_scores
        where user_id = any(p_users)
        group by day
        order by day desc
        limit 30
      ) d), '[]'::json)
  );
$$;

comment on function public.group_day_series is
  'Internal: mean day series + mean averages over a set of users. Not callable by clients — see the two wrappers.';

revoke all on function public.group_day_series(uuid[]) from anon, authenticated, public;

-- ── One team ──────────────────────────────────────────────────────────────────
create or replace function public.get_team_days(p_team text)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me   uuid := auth.uid();
  v_team text := lower(btrim(coalesce(p_team, '')));
begin
  if v_me is null then
    raise exception 'get_team_days: not authenticated' using errcode = '28000';
  end if;

  -- DEFINER bypasses RLS, so this predicate is the only thing keeping one team's
  -- history from being readable by anyone who can name the team. Load-bearing.
  if not exists (select 1 from team_members where user_id = v_me and team = v_team) then
    raise exception 'You are not a member of "%"', v_team using errcode = '42501';
  end if;

  return group_day_series(
    array(select tm.user_id from team_members tm where tm.team = v_team));
end;
$$;

comment on function public.get_team_days is
  'Averaged day series for one of the caller''s own teams. One call per section open.';

revoke all on function public.get_team_days(text) from anon, public;
grant execute on function public.get_team_days(text) to authenticated;

-- ── Your friends ──────────────────────────────────────────────────────────────
create or replace function public.get_friends_days()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'get_friends_days: not authenticated' using errcode = '28000';
  end if;

  -- Accepted both ways, plus yourself — the same set get_friends_board ranks, so the
  -- chart and the board underneath it describe the same people. A PENDING request
  -- contributes nothing, here as everywhere.
  return group_day_series(array(
    select case when f.requester = v_me then f.addressee else f.requester end
    from friendships f
    where f.status = 'accepted' and (f.requester = v_me or f.addressee = v_me)
    union
    select v_me));
end;
$$;

comment on function public.get_friends_days is
  'Averaged day series over the caller and their accepted friends.';

revoke all on function public.get_friends_days() from anon, public;
grant execute on function public.get_friends_days() to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
--   begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<your-uuid>','role','authenticated')::text, true);
--
--   select public.get_team_days('<one of your teams>');   -- summary + up to 30 days
--   select public.get_friends_days();                     -- you alone if no friends
--
--   -- Refused for a team you are not in, and the helper is unreachable:
--   select public.get_team_days('<someone else''s team>');       -- 42501
--   select public.group_day_series(array[]::uuid[]);             -- permission denied
--   rollback;
