-- ─────────────────────────────────────────────────────────────────────────────
--  Materialised leaderboard ranks, rebuilt every minute
-- ─────────────────────────────────────────────────────────────────────────────
--  Topping the boards fixed the payload but not the query: every board request still
--  sorted the whole field, because there is no index for `focus + distracted` across
--  users. One competition of 10,000 with ~1,500 people watching on a 60-second
--  refresh is ~25 full sorts a second, forever, to answer a question whose answer is
--  identical for all of them.
--
--  It is now computed ONCE a minute into three ranked tables, and a board read
--  becomes an indexed range scan of the top N.
--
--  ── PLAIN TABLES, NOT MATERIALIZED VIEWS ────────────────────────────────────
--  The obvious tool is a materialized view, and it is the wrong one here:
--  REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run inside a transaction block,
--  which is precisely where pg_cron calls everything. The non-concurrent form holds
--  ACCESS EXCLUSIVE for the whole rebuild, so it blocks readers just as much as what
--  is done below, with less control. Plain tables it is.
--
--  ── TRUNCATE + INSERT, NOT DELETE + INSERT ──────────────────────────────────
--  A full rewrite every minute is 30k dead rows a minute at the design scale — 43
--  million a day for autovacuum to chase, on tables that never grow. TRUNCATE
--  reclaims immediately and leaves no bloat. The cost is an ACCESS EXCLUSIVE lock
--  for the length of the rebuild, so board reads queue for the ~100ms it takes at
--  10k rows: about 0.2% of each minute. If that ever bites, the escape hatch is to
--  build into a staging table and swap names — instant lock instead of a held one.
--
--  ── WHAT THIS COSTS IN FRESHNESS ────────────────────────────────────────────
--  Leaderboards are now up to 60 SECONDS STALE, on top of the client's own 60-second
--  board refresh — so a rival's score can be ~2 minutes behind reality. Your OWN live
--  score is unaffected everywhere it matters: the Personal section reads it straight
--  from user_summary via build_state. Only your position among others lags.
--
--  A user who has just joined a team will not appear on its board until the next
--  refresh. That is up to a minute of looking like you are not on your own team, and
--  it is the one visible rough edge of this design.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The three ranked tables ───────────────────────────────────────────────────
-- Server-side only: read exclusively by the SECURITY DEFINER board functions, so no
-- client grants at all. RLS on with no policy is a deny-all backstop.
create table if not exists public.rank_team_member (
  team             text          not null,
  user_id          uuid          not null,
  display_name     text          not null,
  live_focus       numeric(12,2) not null,
  live_distracted  numeric(12,2) not null,
  avg7_focus       numeric(12,2) not null,
  avg7_distracted  numeric(12,2) not null,
  avg30_focus      numeric(12,2) not null,
  avg30_distracted numeric(12,2) not null,
  rank_live        integer       not null,
  rank_avg7        integer       not null,
  rank_avg30       integer       not null,
  member_count     integer       not null,
  primary key (team, user_id)
);

create table if not exists public.rank_competition_member (
  competition      text          not null,
  team             text          not null,
  user_id          uuid          not null,
  display_name     text          not null,
  live_focus       numeric(12,2) not null,
  live_distracted  numeric(12,2) not null,
  avg7_focus       numeric(12,2) not null,
  avg7_distracted  numeric(12,2) not null,
  avg30_focus      numeric(12,2) not null,
  avg30_distracted numeric(12,2) not null,
  rank_live        integer       not null,
  rank_avg7        integer       not null,
  rank_avg30       integer       not null,
  member_count     integer       not null,
  -- Team is in the key because one user can belong to two teams of one competition.
  primary key (competition, team, user_id)
);

create table if not exists public.rank_competition_team (
  competition      text          not null,
  team             text          not null,
  member_count     integer       not null,
  live_focus       numeric(12,2) not null,
  live_distracted  numeric(12,2) not null,
  avg7_focus       numeric(12,2) not null,
  avg7_distracted  numeric(12,2) not null,
  avg30_focus      numeric(12,2) not null,
  avg30_distracted numeric(12,2) not null,
  rank_live        integer       not null,
  rank_avg7        integer       not null,
  rank_avg30       integer       not null,
  team_count       integer       not null,
  primary key (competition, team)
);

-- One index per metric: the whole point is that "top 20 by avg7" is a range scan
-- rather than a sort, and each metric needs its own ordering to get that.
create index if not exists rank_team_member_live_idx  on public.rank_team_member (team, rank_live);
create index if not exists rank_team_member_avg7_idx  on public.rank_team_member (team, rank_avg7);
create index if not exists rank_team_member_avg30_idx on public.rank_team_member (team, rank_avg30);

create index if not exists rank_comp_member_live_idx  on public.rank_competition_member (competition, rank_live);
create index if not exists rank_comp_member_avg7_idx  on public.rank_competition_member (competition, rank_avg7);
create index if not exists rank_comp_member_avg30_idx on public.rank_competition_member (competition, rank_avg30);
-- Finding YOUR row wherever it sits, which every board includes unconditionally.
create index if not exists rank_comp_member_self_idx  on public.rank_competition_member (competition, user_id);

create index if not exists rank_comp_team_live_idx    on public.rank_competition_team (competition, rank_live);
create index if not exists rank_comp_team_avg7_idx    on public.rank_competition_team (competition, rank_avg7);
create index if not exists rank_comp_team_avg30_idx   on public.rank_competition_team (competition, rank_avg30);

alter table public.rank_team_member       enable row level security;
alter table public.rank_competition_member enable row level security;
alter table public.rank_competition_team  enable row level security;

revoke all on public.rank_team_member        from anon, authenticated;
revoke all on public.rank_competition_member from anon, authenticated;
revoke all on public.rank_competition_team   from anon, authenticated;

-- ── The rebuild ───────────────────────────────────────────────────────────────
create or replace function public.refresh_leaderboards()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- ── Per-team member ranks ──────────────────────────────────────────────────
  truncate public.rank_team_member;
  insert into public.rank_team_member
  select team, user_id, display_name,
         live_focus, live_distracted, avg7_focus, avg7_distracted,
         avg30_focus, avg30_distracted,
         rank() over (partition by team order by live_focus  + live_distracted  desc),
         rank() over (partition by team order by avg7_focus  + avg7_distracted  desc),
         rank() over (partition by team order by avg30_focus + avg30_distracted desc),
         count(*) over (partition by team)
  from (
    select m.team,
           m.user_id,
           coalesce(nullif(split_part(u.email, '@', 1), ''), 'participant') as display_name,
           coalesce(s.live_focus, 0)::numeric(12,2)       as live_focus,
           coalesce(s.live_distracted, 0)::numeric(12,2)  as live_distracted,
           coalesce(s.avg7_focus, 0)::numeric(12,2)       as avg7_focus,
           coalesce(s.avg7_distracted, 0)::numeric(12,2)  as avg7_distracted,
           coalesce(s.avg30_focus, 0)::numeric(12,2)      as avg30_focus,
           coalesce(s.avg30_distracted, 0)::numeric(12,2) as avg30_distracted
    from team_members m
    left join user_summary s on s.user_id = m.user_id
    left join auth.users   u on u.id      = m.user_id
  ) t;

  -- ── Per-competition member ranks ───────────────────────────────────────────
  truncate public.rank_competition_member;
  insert into public.rank_competition_member
  select competition, team, user_id, display_name,
         live_focus, live_distracted, avg7_focus, avg7_distracted,
         avg30_focus, avg30_distracted,
         rank() over (partition by competition order by live_focus  + live_distracted  desc),
         rank() over (partition by competition order by avg7_focus  + avg7_distracted  desc),
         rank() over (partition by competition order by avg30_focus + avg30_distracted desc),
         count(*) over (partition by competition)
  from (
    select tc.competition,
           m.team,
           m.user_id,
           coalesce(nullif(split_part(u.email, '@', 1), ''), 'participant') as display_name,
           coalesce(s.live_focus, 0)::numeric(12,2)       as live_focus,
           coalesce(s.live_distracted, 0)::numeric(12,2)  as live_distracted,
           coalesce(s.avg7_focus, 0)::numeric(12,2)       as avg7_focus,
           coalesce(s.avg7_distracted, 0)::numeric(12,2)  as avg7_distracted,
           coalesce(s.avg30_focus, 0)::numeric(12,2)      as avg30_focus,
           coalesce(s.avg30_distracted, 0)::numeric(12,2) as avg30_distracted
    from team_competitions tc
    join team_members m on m.team = tc.team
    left join user_summary s on s.user_id = m.user_id
    left join auth.users   u on u.id      = m.user_id
  ) t;

  -- ── Per-competition team totals ────────────────────────────────────────────
  -- Sums, so a bigger team scores higher; member_count travels with them so the
  -- board can be read honestly.
  truncate public.rank_competition_team;
  insert into public.rank_competition_team
  select competition, team, member_count,
         live_focus, live_distracted, avg7_focus, avg7_distracted,
         avg30_focus, avg30_distracted,
         rank() over (partition by competition order by live_focus  + live_distracted  desc),
         rank() over (partition by competition order by avg7_focus  + avg7_distracted  desc),
         rank() over (partition by competition order by avg30_focus + avg30_distracted desc),
         count(*) over (partition by competition)
  from (
    select competition, team,
           count(*)::int                        as member_count,
           sum(live_focus)::numeric(12,2)       as live_focus,
           sum(live_distracted)::numeric(12,2)  as live_distracted,
           sum(avg7_focus)::numeric(12,2)       as avg7_focus,
           sum(avg7_distracted)::numeric(12,2)  as avg7_distracted,
           sum(avg30_focus)::numeric(12,2)      as avg30_focus,
           sum(avg30_distracted)::numeric(12,2) as avg30_distracted
    from rank_competition_member
    group by competition, team
  ) t;
end;
$$;

revoke all on function public.refresh_leaderboards() from anon, authenticated, public;

-- Every minute — the shortest period pg_cron allows, and the freshness the boards
-- are documented to have.
select cron.unschedule('focus-leaderboards')
where exists (select 1 from cron.job where jobname = 'focus-leaderboards');

select cron.schedule('focus-leaderboards', '* * * * *',
                     $cron$ select public.refresh_leaderboards(); $cron$);

-- Populate immediately so the first board after deployment is not empty.
select public.refresh_leaderboards();

-- ── Board reads, now indexed lookups ──────────────────────────────────────────
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

  -- Authorization reads the LIVE tables, never the ranked ones: who may see what
  -- must not be a minute out of date, even when the scores are.
  if not exists (select 1 from visible_teams() v where v.team = v_team) then
    raise exception 'You cannot see "%"', v_team using errcode = '42501';
  end if;

  return (
    with picked as (
      select *, case v_metric when 'avg7' then rank_avg7
                              when 'avg30' then rank_avg30
                              else rank_live end as rnk
      from rank_team_member
      where team = v_team
    ),
    -- Top N, plus you wherever you are. The index makes the first half a range scan
    -- and the primary key makes the second half a single lookup.
    slice as (
      select * from picked where rnk <= v_limit
      union
      select * from picked where user_id = v_me
    )
    select json_build_object(
      'team',         v_team,
      'metric',       v_metric,
      'member_count', coalesce((select max(member_count) from picked), 0),
      'my_rank',      (select rnk from picked where user_id = v_me),
      'members', coalesce((
        select json_agg(json_build_object(
                 'user_id',          r.user_id,
                 'display_name',     r.display_name,
                 'is_self',          r.user_id = v_me,
                 'rank',             r.rnk,
                 'live_focus',       r.live_focus,
                 'live_distracted',  r.live_distracted,
                 'avg7_focus',       r.avg7_focus,
                 'avg7_distracted',  r.avg7_distracted,
                 'avg30_focus',      r.avg30_focus,
                 'avg30_distracted', r.avg30_distracted
               ) order by r.rnk)
        from slice r), '[]'::json)
    )
  );
end;
$$;

revoke all on function public.get_team_board(text, text, int) from anon, public;
grant execute on function public.get_team_board(text, text, int) to authenticated;

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

  -- Live tables again, for the same reason: authorization must not lag.
  if not exists (
    select 1
    from team_competitions tc
    join team_members tm on tm.team = tc.team
    where tm.user_id = v_me and tc.competition = v_comp
  ) then
    raise exception 'None of your teams are in "%"', v_comp using errcode = '42501';
  end if;

  return (
    with my_teams as (
      select tm.team from team_members tm where tm.user_id = v_me
    ),
    members as (
      select *, case v_metric when 'avg7' then rank_avg7
                              when 'avg30' then rank_avg30
                              else rank_live end as rnk
      from rank_competition_member
      where competition = v_comp
    ),
    teams as (
      select *, case v_metric when 'avg7' then rank_avg7
                              when 'avg30' then rank_avg30
                              else rank_live end as rnk
      from rank_competition_team
      where competition = v_comp
    )
    select json_build_object(
      'competition',  v_comp,
      'metric',       v_metric,
      'member_count', coalesce((select max(member_count) from members), 0),
      'team_count',   coalesce((select max(team_count) from teams), 0),
      'my_rank',      (select min(rnk) from members where user_id = v_me),

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
        from (select * from teams where rnk <= v_limit
              union
              select * from teams where team in (select team from my_teams)) t), '[]'::json),

      'members', coalesce((
        select json_agg(json_build_object(
                 'team',             r.team,
                 'user_id',          r.user_id,
                 'display_name',     r.display_name,
                 'is_self',          r.user_id = v_me,
                 'rank',             r.rnk,
                 'live_focus',       r.live_focus,
                 'live_distracted',  r.live_distracted,
                 'avg7_focus',       r.avg7_focus,
                 'avg7_distracted',  r.avg7_distracted,
                 'avg30_focus',      r.avg30_focus,
                 'avg30_distracted', r.avg30_distracted
               ) order by r.rnk)
        from (select * from members where rnk <= v_limit
              union
              select * from members where user_id = v_me) r), '[]'::json)
    )
  );
end;
$$;

revoke all on function public.get_competition_board(text, text, int) from anon, public;
grant execute on function public.get_competition_board(text, text, int) to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- The read must now be an Index Scan, not a Sort over the whole competition:
--
--   explain (analyze, buffers)
--   select * from public.rank_competition_member
--   where competition = 'uni_cup' and rank_live <= 20 order by rank_live;
--
-- Rebuild cost — this is the number that decides whether once a minute is right:
--
--   select jobname, status, end_time - start_time as duration, start_time
--   from cron.job_run_details where jobname = 'focus-leaderboards'
--   order by start_time desc limit 20;
--
-- And the ranks must agree with the live tables right after a rebuild:
--
--   select public.refresh_leaderboards();
--   select team, display_name, rank_live, live_focus + live_distracted as net
--   from public.rank_team_member where team = 'math_students' order by rank_live;
