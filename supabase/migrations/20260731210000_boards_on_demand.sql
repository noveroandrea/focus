-- ─────────────────────────────────────────────────────────────────────────────
--  Leaderboards on demand instead of on every post
-- ─────────────────────────────────────────────────────────────────────────────
--  build_state shipped every visible member's scores on EVERY check-in — including
--  the once-a-minute floor, when the popup is usually shut and nobody is looking at
--  a leaderboard. That made egress quadratic: N users each pulling O(competition
--  size) every minute. A 50-person competition cost ~145 MB per user per month and
--  put the free tier's ceiling at about 35 participants.
--
--  build_state now carries only the NAMES of your teams and competitions — enough to
--  draw the section pills, about 70 bytes. The boards themselves come from two new
--  calls, made when a section is actually opened.
--
--  The routine payload drops from ~6.5 KB to ~0.85 KB gzipped, and the ceiling stops
--  depending on competition size at all.
--
--  AUTHORIZATION. Both new functions take a name as an argument, so both check
--  membership before reading anything — the same discipline as get_member_profile:
--
--    get_team_board(t)         caller must be a member of t
--    get_competition_board(c)  caller must have one of their teams in c
--
--  They are SECURITY DEFINER because they read other users' user_summary rows and
--  auth.users.email, which is exactly what those checks exist to license.
--
--  build_teams() is DROPPED. Nothing calls it once build_state stops, and leaving an
--  unused SECURITY DEFINER function that returns every visible member's scores is
--  attack surface kept for sentiment. visible_teams() stays — get_member_profile and
--  both new functions authorize against it.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── build_state: names only ───────────────────────────────────────────────────
create or replace function public.build_state()
returns json
language sql
security invoker
set search_path = public
as $$
  with f as (select build_flags() as j)
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

    -- Names only. Readable as INVOKER: team_members' RLS policy already scopes the
    -- caller to their own rows, and team_competitions is readable by design.
    'my_teams', coalesce(
      (select json_agg(tm.team order by tm.team)
       from team_members tm where tm.user_id = auth.uid()),
      '[]'::json),

    'my_competitions', coalesce(
      (select json_agg(distinct tc.competition order by tc.competition)
       from team_competitions tc
       join team_members tm on tm.team = tc.team
       where tm.user_id = auth.uid()),
      '[]'::json),

    'domain_flags', f.j -> 'domains',
    'flag',         f.j -> 'flag'
  )
  from f;
$$;

revoke all on function public.build_state() from anon, public;
grant execute on function public.build_state() to authenticated;

-- ── One team's board ──────────────────────────────────────────────────────────
create or replace function public.get_team_board(p_team text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   uuid := auth.uid();
  v_team text := lower(btrim(coalesce(p_team, '')));
begin
  if v_me is null then
    raise exception 'get_team_board: not authenticated' using errcode = '28000';
  end if;

  -- Membership, not visibility: this view is for teams you are IN. A rival team's
  -- roster is reachable through the competition board, which says so in its name.
  if not exists (select 1 from team_members where user_id = v_me and team = v_team) then
    raise exception 'You are not a member of "%"', v_team using errcode = '42501';
  end if;

  return json_build_object(
    'team', v_team,
    'members', coalesce((
      select json_agg(json_build_object(
               'user_id',          m.user_id,
               'display_name',     coalesce(nullif(split_part(u.email, '@', 1), ''), 'participant'),
               'is_self',          m.user_id = v_me,
               'live_focus',       coalesce(s.live_focus, 0),
               'live_distracted',  coalesce(s.live_distracted, 0),
               'avg7_focus',       coalesce(s.avg7_focus, 0),
               'avg7_distracted',  coalesce(s.avg7_distracted, 0),
               'avg30_focus',      coalesce(s.avg30_focus, 0),
               'avg30_distracted', coalesce(s.avg30_distracted, 0)
             ) order by (coalesce(s.live_focus, 0) + coalesce(s.live_distracted, 0)) desc)
      from team_members m
      left join user_summary s on s.user_id = m.user_id
      left join auth.users   u on u.id      = m.user_id
      where m.team = v_team), '[]'::json)
  );
end;
$$;

revoke all on function public.get_team_board(text) from anon, public;
grant execute on function public.get_team_board(text) to authenticated;

-- ── One competition's board ───────────────────────────────────────────────────
create or replace function public.get_competition_board(p_competition text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   uuid := auth.uid();
  v_comp text := lower(btrim(coalesce(p_competition, '')));
begin
  if v_me is null then
    raise exception 'get_competition_board: not authenticated' using errcode = '28000';
  end if;

  -- One of the caller's own teams must be entered in it. This is the same condition
  -- visible_teams() uses to admit rival teams, stated here for one competition.
  if not exists (
    select 1
    from team_competitions tc
    join team_members tm on tm.team = tc.team
    where tm.user_id = v_me and tc.competition = v_comp
  ) then
    raise exception 'None of your teams are in "%"', v_comp using errcode = '42501';
  end if;

  return (
    with comp_teams as (
      select tc.team from team_competitions tc where tc.competition = v_comp
    ),
    scores as (
      select ct.team,
             m.user_id,
             coalesce(nullif(split_part(u.email, '@', 1), ''), 'participant') as display_name,
             (m.user_id = v_me) as is_self,
             coalesce(s.live_focus, 0)::numeric       as live_focus,
             coalesce(s.live_distracted, 0)::numeric  as live_distracted,
             coalesce(s.avg7_focus, 0)::numeric       as avg7_focus,
             coalesce(s.avg7_distracted, 0)::numeric  as avg7_distracted,
             coalesce(s.avg30_focus, 0)::numeric      as avg30_focus,
             coalesce(s.avg30_distracted, 0)::numeric as avg30_distracted
      from comp_teams ct
      join team_members m on m.team = ct.team
      left join user_summary s on s.user_id = m.user_id
      left join auth.users   u on u.id      = m.user_id
    ),
    -- Sums, not means, so a team's score is the work its members actually did.
    -- member_count travels with it so the size difference is visible.
    totals as (
      select team,
             count(*)              as member_count,
             sum(live_focus)       as live_focus,
             sum(live_distracted)  as live_distracted,
             sum(avg7_focus)       as avg7_focus,
             sum(avg7_distracted)  as avg7_distracted,
             sum(avg30_focus)      as avg30_focus,
             sum(avg30_distracted) as avg30_distracted
      from scores group by team
    )
    select json_build_object(
      'competition', v_comp,
      'teams', coalesce((
        select json_agg(json_build_object(
                 'team',             t.team,
                 'is_mine',          exists (select 1 from team_members mm
                                             where mm.user_id = v_me and mm.team = t.team),
                 'member_count',     t.member_count,
                 'live_focus',       t.live_focus,
                 'live_distracted',  t.live_distracted,
                 'avg7_focus',       t.avg7_focus,
                 'avg7_distracted',  t.avg7_distracted,
                 'avg30_focus',      t.avg30_focus,
                 'avg30_distracted', t.avg30_distracted
               ) order by (t.live_focus + t.live_distracted) desc)
        from totals t), '[]'::json),
      -- One flat list carrying each row's team; the client groups it for the
      -- per-team panels rather than receiving the same people twice.
      'members', coalesce((
        select json_agg(json_build_object(
                 'team',             s.team,
                 'user_id',          s.user_id,
                 'display_name',     s.display_name,
                 'is_self',          s.is_self,
                 'live_focus',       s.live_focus,
                 'live_distracted',  s.live_distracted,
                 'avg7_focus',       s.avg7_focus,
                 'avg7_distracted',  s.avg7_distracted,
                 'avg30_focus',      s.avg30_focus,
                 'avg30_distracted', s.avg30_distracted
               ) order by (s.live_focus + s.live_distracted) desc)
        from scores s), '[]'::json)
    )
  );
end;
$$;

revoke all on function public.get_competition_board(text) from anon, public;
grant execute on function public.get_competition_board(text) to authenticated;

-- ── Retire build_teams ────────────────────────────────────────────────────────
-- Unused now, and it is a SECURITY DEFINER function that returns every visible
-- member's scores. Dropping beats keeping it for sentiment.
drop function if exists public.build_teams();

-- ── Verify ────────────────────────────────────────────────────────────────────
--   begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<your-uuid>','role','authenticated')::text, true);
--
--   -- Should be small: names only, no member arrays.
--   select length(public.build_state()::text) as routine_payload_bytes;
--
--   select public.get_team_board('math_students');          -- yours: returns rows
--   select public.get_competition_board('uni_cup');         -- yours: returns rows
--   select public.get_team_board('physics_students');       -- must ERROR 42501
--   rollback;
