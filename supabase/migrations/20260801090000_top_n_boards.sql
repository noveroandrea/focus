-- ─────────────────────────────────────────────────────────────────────────────
--  Top-N boards — the last thing that scaled with participant count
-- ─────────────────────────────────────────────────────────────────────────────
--  get_competition_board returned EVERY member of every team in the competition.
--  At the design target — one competition of 10,000 people — that is a 2 MB JSON
--  array, ~514 KB on the wire, per open, per refresh. Ten thousand people opening it
--  once a day is ~474 GB a month for a screen that shows about six rows at a time.
--
--  A leaderboard is a ranking, and nobody reads position 4,000. Both board functions
--  now return the TOP N for the metric being displayed, and nothing else.
--
--  THREE THINGS MAKE THAT HONEST RATHER THAN JUST SMALLER:
--
--  1. The metric is a PARAMETER. Top 20 by live score is a different set of people
--     from top 20 by 30-day average, so a single "top 20" would silently be wrong on
--     two of the three tabs. Switching tabs refetches.
--  2. YOU ARE ALWAYS INCLUDED, however far down you are, along with every team you
--     belong to. A leaderboard you cannot find yourself on is a poster, not a game.
--  3. `my_rank` and `member_count` come back with it, so the popup can say "you are
--     487th of 10,000" rather than leaving you to infer it from an absence.
--
--  get_team_board is relaxed at the same time: it required MEMBERSHIP, which meant
--  the per-team panels inside a competition had to be fed from the competition's own
--  flat member list. With that list now topped, those panels need their own call, so
--  authorization moves to visible_teams() — the same boundary everything else uses.
--  A team you share a competition with was already fully visible; this changes which
--  function serves it, not who may see it.
--
--  COST NOTE. Ranking 10,000 rows means sorting them per request; there is no index
--  for `focus + distracted` across users. That is a few milliseconds and fine at this
--  scale, but it is the thing that would need a materialised ranking if a single
--  competition ever reached hundreds of thousands.
-- ─────────────────────────────────────────────────────────────────────────────

-- Shared bounds. A caller cannot ask for the whole competition by passing a huge
-- limit — that is the hole this migration exists to close.
create or replace function public.clamp_board_limit(p_limit int)
returns int language sql immutable as $$
  select least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

create or replace function public.clamp_metric(p_metric text)
returns text language sql immutable as $$
  select case when p_metric in ('live', 'avg7', 'avg30') then p_metric else 'live' end;
$$;

-- ── One team's board, topped ──────────────────────────────────────────────────
drop function if exists public.get_team_board(text);

create or replace function public.get_team_board(
  p_team   text,
  p_metric text default 'live',
  p_limit  int  default 20
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_team   text := lower(btrim(coalesce(p_team, '')));
  v_metric text := clamp_metric(p_metric);
  v_limit  int  := clamp_board_limit(p_limit);
begin
  if v_me is null then
    raise exception 'get_team_board: not authenticated' using errcode = '28000';
  end if;

  -- visible_teams() rather than membership: a team sharing a competition with one of
  -- yours was already fully visible through the competition board, so serving its
  -- roster here grants nothing new. One boundary, used everywhere.
  if not exists (select 1 from visible_teams() v where v.team = v_team) then
    raise exception 'You cannot see "%"', v_team using errcode = '42501';
  end if;

  return (
    with scores as (
      select m.user_id,
             coalesce(nullif(split_part(u.email, '@', 1), ''), 'participant') as display_name,
             (m.user_id = v_me) as is_self,
             coalesce(s.live_focus, 0)::numeric       as live_focus,
             coalesce(s.live_distracted, 0)::numeric  as live_distracted,
             coalesce(s.avg7_focus, 0)::numeric       as avg7_focus,
             coalesce(s.avg7_distracted, 0)::numeric  as avg7_distracted,
             coalesce(s.avg30_focus, 0)::numeric      as avg30_focus,
             coalesce(s.avg30_distracted, 0)::numeric as avg30_distracted,
             case v_metric
               when 'avg7'  then coalesce(s.avg7_focus, 0)  + coalesce(s.avg7_distracted, 0)
               when 'avg30' then coalesce(s.avg30_focus, 0) + coalesce(s.avg30_distracted, 0)
               else              coalesce(s.live_focus, 0)  + coalesce(s.live_distracted, 0)
             end as net
      from team_members m
      left join user_summary s on s.user_id = m.user_id
      left join auth.users   u on u.id      = m.user_id
      where m.team = v_team
    ),
    ranked as (select *, rank() over (order by net desc) as rnk from scores)
    select json_build_object(
      'team',         v_team,
      'metric',       v_metric,
      'member_count', (select count(*) from scores),
      'my_rank',      (select min(rnk) from ranked where is_self),
      'members', coalesce((
        select json_agg(json_build_object(
                 'user_id',          r.user_id,
                 'display_name',     r.display_name,
                 'is_self',          r.is_self,
                 'rank',             r.rnk,
                 'live_focus',       r.live_focus,
                 'live_distracted',  r.live_distracted,
                 'avg7_focus',       r.avg7_focus,
                 'avg7_distracted',  r.avg7_distracted,
                 'avg30_focus',      r.avg30_focus,
                 'avg30_distracted', r.avg30_distracted
               ) order by r.rnk)
        -- Top N, plus you wherever you are. UNION dedupes when you are in both.
        from (select * from ranked where rnk <= v_limit
              union
              select * from ranked where is_self) r), '[]'::json)
    )
  );
end;
$$;

revoke all on function public.get_team_board(text, text, int) from anon, public;
grant execute on function public.get_team_board(text, text, int) to authenticated;

-- ── One competition's board, topped on both axes ──────────────────────────────
drop function if exists public.get_competition_board(text);

create or replace function public.get_competition_board(
  p_competition text,
  p_metric      text default 'live',
  p_limit       int  default 20
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_comp   text := lower(btrim(coalesce(p_competition, '')));
  v_metric text := clamp_metric(p_metric);
  v_limit  int  := clamp_board_limit(p_limit);
begin
  if v_me is null then
    raise exception 'get_competition_board: not authenticated' using errcode = '28000';
  end if;

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
    my_teams as (
      select tm.team from team_members tm where tm.user_id = v_me
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
             coalesce(s.avg30_distracted, 0)::numeric as avg30_distracted,
             case v_metric
               when 'avg7'  then coalesce(s.avg7_focus, 0)  + coalesce(s.avg7_distracted, 0)
               when 'avg30' then coalesce(s.avg30_focus, 0) + coalesce(s.avg30_distracted, 0)
               else              coalesce(s.live_focus, 0)  + coalesce(s.live_distracted, 0)
             end as net
      from comp_teams ct
      join team_members m on m.team = ct.team
      left join user_summary s on s.user_id = m.user_id
      left join auth.users   u on u.id      = m.user_id
    ),
    ranked as (select *, rank() over (order by net desc) as rnk from scores),
    -- Team totals are SUMS, so a bigger team scores higher; member_count travels
    -- with them so the board can be read honestly.
    totals as (
      select team,
             count(*)              as member_count,
             sum(live_focus)       as live_focus,
             sum(live_distracted)  as live_distracted,
             sum(avg7_focus)       as avg7_focus,
             sum(avg7_distracted)  as avg7_distracted,
             sum(avg30_focus)      as avg30_focus,
             sum(avg30_distracted) as avg30_distracted,
             sum(net)              as net
      from scores group by team
    ),
    ranked_totals as (select *, rank() over (order by net desc) as rnk from totals)
    select json_build_object(
      'competition',  v_comp,
      'metric',       v_metric,
      'member_count', (select count(*) from scores),
      'team_count',   (select count(*) from totals),
      'my_rank',      (select min(rnk) from ranked where is_self),

      -- Top teams, plus every team of yours wherever it sits.
      'teams', coalesce((
        select json_agg(json_build_object(
                 'team',             t.team,
                 'is_mine',          exists (select 1 from my_teams mt where mt.team = t.team),
                 'rank',             t.rnk,
                 'member_count',     t.member_count,
                 'live_focus',       t.live_focus,
                 'live_distracted',  t.live_distracted,
                 'avg7_focus',       t.avg7_focus,
                 'avg7_distracted',  t.avg7_distracted,
                 'avg30_focus',      t.avg30_focus,
                 'avg30_distracted', t.avg30_distracted
               ) order by t.rnk)
        from (select * from ranked_totals where rnk <= v_limit
              union
              select * from ranked_totals
              where team in (select team from my_teams)) t), '[]'::json),

      -- Top participants across the whole field, plus you.
      'members', coalesce((
        select json_agg(json_build_object(
                 'team',             r.team,
                 'user_id',          r.user_id,
                 'display_name',     r.display_name,
                 'is_self',          r.is_self,
                 'rank',             r.rnk,
                 'live_focus',       r.live_focus,
                 'live_distracted',  r.live_distracted,
                 'avg7_focus',       r.avg7_focus,
                 'avg7_distracted',  r.avg7_distracted,
                 'avg30_focus',      r.avg30_focus,
                 'avg30_distracted', r.avg30_distracted
               ) order by r.rnk)
        from (select * from ranked where rnk <= v_limit
              union
              select * from ranked where is_self) r), '[]'::json)
    )
  );
end;
$$;

revoke all on function public.get_competition_board(text, text, int) from anon, public;
grant execute on function public.get_competition_board(text, text, int) to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
--   begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<your-uuid>','role','authenticated')::text, true);
--
--   -- Must stay small no matter how large the competition is:
--   select length(public.get_competition_board('uni_cup','live',20)::text) as bytes;
--
--   -- The limit must be clamped, not obeyed:
--   select json_array_length(public.get_competition_board('uni_cup','live',100000) -> 'members');
--   rollback;
