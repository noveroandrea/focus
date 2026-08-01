-- ─────────────────────────────────────────────────────────────────────────────
--  A competition is EITHER individual or team — decided when it is created
-- ─────────────────────────────────────────────────────────────────────────────
--  The previous migration let both kinds of entrant into any competition, which
--  meant a leaderboard could mix one person's score against a twelve-person team's
--  sum. A competition now declares which it is, once, at creation:
--
--    kind = 'individual'   people enter themselves; teams are refused
--    kind = 'team'         teams enter; individuals are refused
--
--  The name stays the sole key, so "highschoolcup" is one competition of one kind,
--  and whichever route you try second is told plainly which one it is rather than
--  silently doing nothing.
--
--  ── THE KIND IS SET BY WHICH DOOR CREATED IT ────────────────────────────────
--  There is no third parameter to get wrong. join_competition creates 'individual'
--  and enroll_team creates 'team', because the call that creates a competition is
--  already the call that says how it will be entered. A radio button asking the same
--  question again would be a second place for the two to disagree.
--
--  ── ONE PERSON APPEARS ONCE PER COMPETITION ─────────────────────────────────
--  With kinds separated, and the "at most one of your teams per competition" rule
--  from the previous migration, a user can reach a given competition by exactly one
--  route. That makes (competition, user_id) unique, which is why the ranked table
--  below can key on it and stop carrying `team` in its primary key.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The column ────────────────────────────────────────────────────────────────
-- Existing competitions were reachable only by enroll_team, so they are team
-- competitions. Defaulting to 'team' backfills them correctly rather than guessing.
alter table public.competitions
  add column if not exists kind text not null default 'team'
  check (kind in ('individual', 'team'));

comment on column public.competitions.kind is
  'individual = people enter themselves; team = teams enter. Fixed at creation.';

-- ── Entering yourself ─────────────────────────────────────────────────────────
create or replace function public.join_competition(
  p_competition text,
  p_create      boolean default false,
  p_password    text    default ''
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_comp text := lower(btrim(coalesce(p_competition, '')));
  v_pw   text := coalesce(p_password, '');
  v_hash text;
  v_kind text;
begin
  if v_user is null then
    raise exception 'join_competition: not authenticated' using errcode = '28000';
  end if;
  if length(v_comp) < 2 or length(v_comp) > 40 then
    raise exception 'Competition name must be 2 to 40 characters' using errcode = '22023';
  end if;
  if length(v_pw) < 4 then
    raise exception 'Competition password must be at least 4 characters' using errcode = '22023';
  end if;

  select password_hash, kind into v_hash, v_kind from competitions where name = v_comp;

  if p_create then
    if v_hash is not null then
      raise exception 'Competition "%" already exists — join it instead', v_comp using errcode = '23505';
    end if;
    -- Created through this door, so it is an individual competition.
    insert into competitions (name, created_by, password_hash, kind)
    values (v_comp, v_user, crypt(v_pw, gen_salt('bf')), 'individual');
  else
    if v_hash is null then
      raise exception 'No competition called "%" — create it instead', v_comp using errcode = '23503';
    end if;
    -- Checked BEFORE the password: being told "wrong password" for a competition you
    -- could never join either way is a worse answer than the true one.
    if v_kind <> 'individual' then
      raise exception
        '"%" is a team competition — enter one of your teams into it instead', v_comp
        using errcode = '22023';
    end if;
    if v_hash <> crypt(v_pw, v_hash) then
      raise exception 'Wrong password for competition "%"', v_comp using errcode = '28P01';
    end if;
  end if;

  insert into competition_members (competition, user_id)
  values (v_comp, v_user)
  on conflict (competition, user_id) do nothing;

  return build_state();
end;
$$;

revoke all on function public.join_competition(text, boolean, text) from anon, public;
grant execute on function public.join_competition(text, boolean, text) to authenticated;

-- ── Entering a team ───────────────────────────────────────────────────────────
create or replace function public.enroll_team(
  p_team        text,
  p_competition text,
  p_create      boolean default false,
  p_password    text    default ''
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user  uuid := auth.uid();
  v_team  text := lower(btrim(coalesce(p_team, '')));
  v_comp  text := lower(btrim(coalesce(p_competition, '')));
  v_pw    text := coalesce(p_password, '');
  v_hash  text;
  v_kind  text;
  v_clash text;
begin
  if v_user is null then
    raise exception 'enroll_team: not authenticated' using errcode = '28000';
  end if;
  if length(v_comp) < 2 or length(v_comp) > 40 then
    raise exception 'Competition name must be 2 to 40 characters' using errcode = '22023';
  end if;
  if length(v_pw) < 4 then
    raise exception 'Competition password must be at least 4 characters' using errcode = '22023';
  end if;

  -- RLS is bypassed under SECURITY DEFINER, so this predicate is the ONLY thing
  -- confining the write to a team the caller belongs to. Load-bearing.
  if not exists (select 1 from team_members where user_id = v_user and team = v_team) then
    raise exception 'You are not a member of "%"', v_team using errcode = '42501';
  end if;

  -- Every member is checked, not just the caller: whoever presses the button is
  -- rarely the person whose two teams would clash.
  select m2.team into v_clash
  from team_members m
  join team_competitions tc on tc.competition = v_comp
  join team_members m2 on m2.team = tc.team and m2.user_id = m.user_id
  where m.team = v_team and tc.team <> v_team
  limit 1;

  if v_clash is not null then
    raise exception
      'Someone in "%" already competes in "%" with "%" — one team per person per competition',
      v_team, v_comp, v_clash using errcode = '23505';
  end if;

  select password_hash, kind into v_hash, v_kind from competitions where name = v_comp;

  if p_create then
    if v_hash is not null then
      raise exception 'Competition "%" already exists — join it instead', v_comp using errcode = '23505';
    end if;
    -- Created through this door, so it is a team competition.
    insert into competitions (name, created_by, password_hash, kind)
    values (v_comp, v_user, crypt(v_pw, gen_salt('bf')), 'team');
  else
    if v_hash is null then
      raise exception 'No competition called "%" — create it instead', v_comp using errcode = '23503';
    end if;
    if v_kind <> 'team' then
      raise exception
        '"%" is an individual competition — enter yourself into it instead', v_comp
        using errcode = '22023';
    end if;
    if v_hash <> crypt(v_pw, v_hash) then
      raise exception 'Wrong password for competition "%"', v_comp using errcode = '28P01';
    end if;
  end if;

  insert into team_competitions (team, competition, added_by)
  values (v_team, v_comp, v_user)
  on conflict (team, competition) do nothing;

  return build_state();
end;
$$;

revoke all on function public.enroll_team(text, text, boolean, text) from anon, public;
grant execute on function public.enroll_team(text, text, boolean, text) to authenticated;

-- ── Existing entries reconciled to the kind ───────────────────────────────────
-- Typing a competition retroactively invalidates entries made by the other route,
-- and they must go BEFORE the ranked table is rebuilt: (competition, user_id) is
-- unique from here on, and someone entered twice would fail the insert. This is not
-- a cache — it deletes real opt-ins — so it reports what it removed.
--
-- Everything that existed before this migration was reachable only by enroll_team
-- OR by join_competition into the same name; the backfill calls them all 'team', so
-- in practice the first delete is the one that fires.
do $$
declare
  v_solo int;
  v_team int;
begin
  delete from public.competition_members cm
  using public.competitions c
  where c.name = cm.competition and c.kind <> 'individual';
  get diagnostics v_solo = row_count;

  delete from public.team_competitions tc
  using public.competitions c
  where c.name = tc.competition and c.kind <> 'team';
  get diagnostics v_team = row_count;

  raise notice 'competition kind: removed % individual entr(ies) from team competitions, % team entr(ies) from individual competitions',
    v_solo, v_team;
end;
$$;

-- ── The ranked member table now covers both routes ────────────────────────────
-- Rebuilt rather than altered: it is a cache with a one-minute lifetime, so dropping
-- it costs nothing and avoids a migration that has to reason about existing rows.
--
-- `team` becomes nullable — an individual entrant has none — and the primary key
-- drops it, because kinds plus the one-team-per-competition rule mean a user reaches
-- any competition by exactly one route.
drop table if exists public.rank_competition_member;

create table public.rank_competition_member (
  competition      text          not null,
  team             text,
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
  primary key (competition, user_id)
);

create index rank_comp_member_live_idx  on public.rank_competition_member (competition, rank_live);
create index rank_comp_member_avg7_idx  on public.rank_competition_member (competition, rank_avg7);
create index rank_comp_member_avg30_idx on public.rank_competition_member (competition, rank_avg30);

alter table public.rank_competition_member enable row level security;
revoke all on public.rank_competition_member from anon, authenticated;

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

  -- ── Per-competition member ranks, from BOTH routes ─────────────────────────
  -- A competition is one kind, so in practice only one branch of the union
  -- contributes to any given competition. The union is what keeps that a property of
  -- the data rather than an assumption in the query.
  --
  -- `distinct on (competition, user_id)` is a seatbelt, not the rule. The rule lives
  -- at the doors (kinds, plus one-team-per-person-per-competition), and legal data
  -- never produces a second row. But this runs from pg_cron every minute, and a
  -- duplicate slipping in — legacy rows, a future route added without the check —
  -- would abort the refresh and freeze EVERY board on the last good snapshot. Losing
  -- one duplicate row beats losing all the leaderboards. `team nulls last` makes the
  -- choice deterministic and prefers the team route, which is the one whose totals
  -- another table depends on.
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
    select distinct on (e.competition, e.user_id) e.*
    from (
      select tc.competition, m.team, m.user_id,
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

      union all

      select cm.competition, null::text, cm.user_id,
             coalesce(nullif(split_part(u.email, '@', 1), ''), 'participant'),
             coalesce(s.live_focus, 0)::numeric(12,2),
             coalesce(s.live_distracted, 0)::numeric(12,2),
             coalesce(s.avg7_focus, 0)::numeric(12,2),
             coalesce(s.avg7_distracted, 0)::numeric(12,2),
             coalesce(s.avg30_focus, 0)::numeric(12,2),
             coalesce(s.avg30_distracted, 0)::numeric(12,2)
      from competition_members cm
      left join user_summary s on s.user_id = cm.user_id
      left join auth.users   u on u.id      = cm.user_id
    ) e
    order by e.competition, e.user_id, e.team nulls last
  ) t;

  -- ── Per-competition team totals ────────────────────────────────────────────
  -- Individual entrants have no team, so they contribute nothing here — which is
  -- correct: an individual competition has no team board.
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
    where team is not null
    group by competition, team
  ) t;
end;
$$;

revoke all on function public.refresh_leaderboards() from anon, authenticated, public;

select public.refresh_leaderboards();

-- ── The board reports its kind ────────────────────────────────────────────────
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
  v_kind   text;
begin
  if v_me is null then
    raise exception 'get_competition_board: not authenticated' using errcode = '28000';
  end if;

  -- Live tables: authorization must never lag behind the ranked snapshot.
  if not exists (select 1 from my_competitions() mc where mc.competition = v_comp) then
    raise exception 'You are not in "%"', v_comp using errcode = '42501';
  end if;

  select kind into v_kind from competitions where name = v_comp;

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
      'kind',         coalesce(v_kind, 'team'),
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
--   -- Wrong door, both directions. Both must raise 22023 with a readable message:
--   select public.join_competition('<a team competition>', false, 'pw');
--   select public.enroll_team('my_team', '<an individual competition>', false, 'pw');
--
--   -- Creation sets the kind from the door used:
--   select name, kind from public.competitions order by created_at desc limit 5;
--
--   -- Nobody reaches a competition twice any more (must return no rows):
--   select competition, user_id, count(*)
--   from (select tc.competition, m.user_id
--         from public.team_competitions tc
--         join public.team_members m on m.team = tc.team
--         union all
--         select competition, user_id from public.competition_members) e
--   group by 1, 2 having count(*) > 1;
--
--   -- If it DOES return rows, they are the legacy two-teams-one-competition case
--   -- the doors now refuse. Pick which team that person keeps and remove them from
--   -- the other with leave_team — the refresh will not fail meanwhile, it just drops
--   -- one of the two rows.
