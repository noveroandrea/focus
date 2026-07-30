-- ─────────────────────────────────────────────────────────────────────────────
--  Teams and competitions
-- ─────────────────────────────────────────────────────────────────────────────
--  Two join tables, exactly as specified:
--
--    team_members       (user_id, team)        primary key (user_id, team)
--    team_competitions  (team, competition)    primary key (team, competition)
--
--  The composite primary keys are the whole duplicate-prevention story: a user
--  cannot join the same team twice, and a team cannot enter the same competition
--  twice, because the database will not represent it. No application check to
--  forget, no race between two devices.
--
--  Two thin registries back them — `teams` and `competitions` — holding just the
--  name, who made it and when. They exist for two reasons:
--
--    1. Foreign keys. Without a row saying a team EXISTS, "join math_students" and
--       "join math_studnets" are equally valid and quietly create two teams.
--    2. Create and join have to be different operations. The UI offers both; the
--       only thing that distinguishes them is whether the name is already taken.
--
--  WHO CAN SEE WHOSE SCORES. This is the first feature that shows one participant
--  another participant's data, so the boundary is drawn explicitly and in one place,
--  build_teams():
--
--    • your teams' members             — you asked to compete with them
--    • members of teams that share a competition with one of yours  — likewise
--    • nobody else, ever
--
--  Names of teams and competitions are readable by any signed-in user (you must be
--  able to tell whether one exists before joining). SCORES are not: user_summary
--  keeps its RLS policy of user_id = auth.uid(), and the only path around it is
--  build_teams(), which takes no arguments, derives the caller from auth.uid(), and
--  is revoked from anon and PUBLIC. That shape is deliberate — see the note in
--  20260729210000_harden_function_privileges.sql for what happens when a
--  SECURITY DEFINER function takes a user_id instead.
--
--  PII: build_teams() exposes the local part of each member's email as
--  `display_name` (andrea9roa9@gmail.com -> "andrea9roa9"), so a leaderboard names
--  someone recognisable. That is a real disclosure between participants and should
--  be in the consent form. To anonymise instead, change the one `split_part`
--  expression below to a stable pseudonym.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Registries ────────────────────────────────────────────────────────────────
-- Names are stored already normalised (lower-cased, trimmed); the check constraint
-- makes that an invariant of the table rather than a habit of the callers.
create table if not exists public.teams (
  name       text primary key,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint teams_name_norm check (name = lower(btrim(name)) and length(name) between 2 and 40)
);

create table if not exists public.competitions (
  name       text primary key,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint competitions_name_norm check (name = lower(btrim(name)) and length(name) between 2 and 40)
);

-- ── The two join tables ───────────────────────────────────────────────────────
create table if not exists public.team_members (
  user_id   uuid not null references auth.users(id) on delete cascade,
  team      text not null references public.teams(name) on update cascade on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (user_id, team)
);

create table if not exists public.team_competitions (
  team        text not null references public.teams(name) on update cascade on delete cascade,
  competition text not null references public.competitions(name) on update cascade on delete cascade,
  added_by    uuid references auth.users(id) on delete set null,
  added_at    timestamptz not null default now(),
  primary key (team, competition)
);

-- The primary keys index (user_id, team) and (team, competition); these cover the
-- reverse direction, which is the one every leaderboard query travels.
create index if not exists team_members_team_idx      on public.team_members (team);
create index if not exists team_competitions_comp_idx on public.team_competitions (competition);

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table public.teams             enable row level security;
alter table public.competitions      enable row level security;
alter table public.team_members      enable row level security;
alter table public.team_competitions enable row level security;

-- Names are not secret: joining requires knowing whether a name is taken. No score
-- lives in these tables.
drop policy if exists teams_read on public.teams;
create policy teams_read on public.teams
  for select to authenticated using (true);

drop policy if exists teams_create on public.teams;
create policy teams_create on public.teams
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists competitions_read on public.competitions;
create policy competitions_read on public.competitions
  for select to authenticated using (true);

drop policy if exists competitions_create on public.competitions;
create policy competitions_create on public.competitions
  for insert to authenticated with check (created_by = auth.uid());

-- Membership is private under RLS: you see your own rows only. Teammates become
-- visible solely through build_teams(), which scopes them to teams you are in.
drop policy if exists team_members_read on public.team_members;
create policy team_members_read on public.team_members
  for select to authenticated using (user_id = auth.uid());

drop policy if exists team_members_join on public.team_members;
create policy team_members_join on public.team_members
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists team_members_leave on public.team_members;
create policy team_members_leave on public.team_members
  for delete to authenticated using (user_id = auth.uid());

-- Entering a competition is a team decision, so any member of the team may do it,
-- and every member sees the result.
drop policy if exists team_competitions_read on public.team_competitions;
create policy team_competitions_read on public.team_competitions
  for select to authenticated using (true);

drop policy if exists team_competitions_add on public.team_competitions;
create policy team_competitions_add on public.team_competitions
  for insert to authenticated with check (
    added_by = auth.uid()
    and exists (
      select 1 from public.team_members m
      where m.team = team_competitions.team and m.user_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
--  build_teams — the leaderboard payload
-- ─────────────────────────────────────────────────────────────────────────────
--  SECURITY DEFINER, because it is the one place that legitimately reads another
--  user's user_summary row and auth.users.email. It therefore follows the safe
--  shape to the letter: NO arguments, caller taken from auth.uid(), EXECUTE revoked
--  from anon and PUBLIC. There is no parameter to pass someone else's id into.
--
--  ORDERING. Lists come back sorted by NET score, high to low, defined as
--  focus + distracted. `distracted_score` is stored as a NEGATIVE number, so adding
--  it IS subtracting the distraction — "focus minus distracted" in the intended
--  sense. Writing it as focus - distracted would instead reward being distracted
--  (50 focus, -30 distracted would rank as 80 rather than 20).
--
--  The client re-sorts anyway, because the same member list has to appear ordered
--  three different ways (live, 7-day, 30-day) and shipping it three times would be
--  wasteful. This ordering is the sensible default and makes the raw payload
--  readable when debugging.
--
--  Per-team lists inside a competition are NOT sent separately: every member row
--  carries its `team`, so the client groups them. One list, three views, no
--  duplication over the wire.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.build_teams()
returns json
language sql
security definer
set search_path = public
as $$
  with me as (
    select auth.uid() as uid
  ),
  -- Teams I belong to.
  my_teams as (
    select tm.team from team_members tm, me where tm.user_id = me.uid
  ),
  -- Competitions any of my teams has entered.
  my_comps as (
    select distinct tc.competition
    from team_competitions tc
    join my_teams t on t.team = tc.team
  ),
  -- Every team in those competitions — mine and the ones I am up against.
  comp_teams as (
    select tc.competition, tc.team
    from team_competitions tc
    join my_comps c on c.competition = tc.competition
  ),
  -- The complete set of teams whose members I am allowed to see. Anything outside
  -- this CTE is unreachable by construction, which is the security boundary.
  visible as (
    select team from my_teams
    union
    select team from comp_teams
  ),
  scores as (
    select v.team,
           m.user_id,
           -- Local part of the email. See the PII note at the top of this file.
           coalesce(nullif(split_part(u.email, '@', 1), ''), 'participant') as display_name,
           (m.user_id = (select uid from me)) as is_self,
           -- A member who has never posted has no user_summary row yet; they belong
           -- on the board at zero rather than vanishing from it.
           coalesce(s.live_focus, 0)::numeric       as live_focus,
           coalesce(s.live_distracted, 0)::numeric  as live_distracted,
           coalesce(s.avg7_focus, 0)::numeric       as avg7_focus,
           coalesce(s.avg7_distracted, 0)::numeric  as avg7_distracted,
           coalesce(s.avg30_focus, 0)::numeric      as avg30_focus,
           coalesce(s.avg30_distracted, 0)::numeric as avg30_distracted
    from visible v
    join team_members m on m.team = v.team
    left join user_summary s on s.user_id = m.user_id
    left join auth.users   u on u.id      = m.user_id
  ),
  member_json as (
    select team,
           json_agg(json_build_object(
             'user_id',          user_id,
             'display_name',     display_name,
             'is_self',          is_self,
             'live_focus',       live_focus,
             'live_distracted',  live_distracted,
             'avg7_focus',       avg7_focus,
             'avg7_distracted',  avg7_distracted,
             'avg30_focus',      avg30_focus,
             'avg30_distracted', avg30_distracted
           ) order by (live_focus + live_distracted) desc) as members
    from scores
    group by team
  ),
  -- "Cumulative stats of all the teams in the competition": one row per team, its
  -- members summed. Sums, not means, so a team's score is the work its members
  -- actually did — member_count travels with it so a reader can see the size
  -- difference that a sum inevitably reflects.
  team_totals as (
    select team,
           count(*)              as member_count,
           sum(live_focus)       as live_focus,
           sum(live_distracted)  as live_distracted,
           sum(avg7_focus)       as avg7_focus,
           sum(avg7_distracted)  as avg7_distracted,
           sum(avg30_focus)      as avg30_focus,
           sum(avg30_distracted) as avg30_distracted
    from scores
    group by team
  )
  select json_build_object(
    'teams', coalesce((
      select json_agg(json_build_object(
               'team',    t.team,
               'members', coalesce(mj.members, '[]'::json)
             ) order by t.team)
      from my_teams t
      left join member_json mj on mj.team = t.team
    ), '[]'::json),

    'competitions', coalesce((
      select json_agg(json_build_object(
        'competition', c.competition,

        -- Team-level board.
        'teams', coalesce((
          select json_agg(json_build_object(
                   'team',             ct.team,
                   'is_mine',          exists (select 1 from my_teams mt where mt.team = ct.team),
                   'member_count',     tt.member_count,
                   'live_focus',       tt.live_focus,
                   'live_distracted',  tt.live_distracted,
                   'avg7_focus',       tt.avg7_focus,
                   'avg7_distracted',  tt.avg7_distracted,
                   'avg30_focus',      tt.avg30_focus,
                   'avg30_distracted', tt.avg30_distracted
                 ) order by (tt.live_focus + tt.live_distracted) desc)
          from comp_teams ct
          join team_totals tt on tt.team = ct.team
          where ct.competition = c.competition
        ), '[]'::json),

        -- Every participant across every team in the competition. Each row carries
        -- its team, so the client renders both the combined board and the per-team
        -- boards from this one array.
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
          from scores s
          join comp_teams ct2 on ct2.team = s.team and ct2.competition = c.competition
        ), '[]'::json)
      ) order by c.competition)
      from my_comps c
    ), '[]'::json)
  );
$$;

comment on function public.build_teams is
  'Leaderboards for the caller''s teams and their competitions. SECURITY DEFINER with no arguments: the caller is auth.uid() and cannot be spoofed.';

revoke all on function public.build_teams() from anon, public;
grant execute on function public.build_teams() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
--  build_state — now carries the leaderboards too
-- ─────────────────────────────────────────────────────────────────────────────
--  Still SECURITY INVOKER and still scoped to auth.uid(). It calls build_teams()
--  once and splices both halves in, so every existing reply — apply_score_delta,
--  get_state — gains teams and competitions with no new round trip. The 1-minute
--  post floor therefore refreshes the boards as a side effect.
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
    'competitions', t.j -> 'competitions'
  )
  from t;
$$;

revoke all on function public.build_state() from anon, public;
grant execute on function public.build_state() to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
--  Membership writes
-- ─────────────────────────────────────────────────────────────────────────────
--  All SECURITY INVOKER: RLS is what confines them to the caller, so there is no
--  privilege to contain. Each returns build_state(), matching apply_score_delta —
--  one round trip both changes something and hands back the full new world.
--
--  p_create is not a convenience flag, it is the difference between two intents.
--  Creating refuses a name that exists and joining refuses one that does not, so a
--  mistyped "join" cannot silently found a one-person team, and a "create" cannot
--  silently drop you into a stranger's.

create or replace function public.join_team(
  p_team   text,
  p_create boolean default false
)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_team text := lower(btrim(coalesce(p_team, '')));
begin
  if v_user is null then
    raise exception 'join_team: not authenticated' using errcode = '28000';
  end if;
  if length(v_team) < 2 or length(v_team) > 40 then
    raise exception 'Team name must be 2 to 40 characters' using errcode = '22023';
  end if;

  if p_create then
    if exists (select 1 from teams where name = v_team) then
      raise exception 'Team "%" already exists — join it instead', v_team using errcode = '23505';
    end if;
    insert into teams (name, created_by) values (v_team, v_user);
  elsif not exists (select 1 from teams where name = v_team) then
    raise exception 'No team called "%" — create it instead', v_team using errcode = '23503';
  end if;

  -- Idempotent by the primary key, so a double-tap on a slow connection is harmless.
  insert into team_members (user_id, team) values (v_user, v_team)
  on conflict (user_id, team) do nothing;

  return build_state();
end;
$$;

revoke all on function public.join_team(text, boolean) from anon, public;
grant execute on function public.join_team(text, boolean) to authenticated;

create or replace function public.leave_team(p_team text)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_team text := lower(btrim(coalesce(p_team, '')));
begin
  if v_user is null then
    raise exception 'leave_team: not authenticated' using errcode = '28000';
  end if;

  -- Only your own membership: the RLS delete policy would refuse anything else, and
  -- the predicate says so out loud.
  delete from team_members where user_id = v_user and team = v_team;

  -- The team row itself is left standing even when empty. Deleting it would cascade
  -- the competition enrolments away, and a team emptying for an afternoon is not the
  -- same as a team being disbanded.
  return build_state();
end;
$$;

revoke all on function public.leave_team(text) from anon, public;
grant execute on function public.leave_team(text) to authenticated;

create or replace function public.enroll_team(
  p_team        text,
  p_competition text,
  p_create      boolean default false
)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_team text := lower(btrim(coalesce(p_team, '')));
  v_comp text := lower(btrim(coalesce(p_competition, '')));
begin
  if v_user is null then
    raise exception 'enroll_team: not authenticated' using errcode = '28000';
  end if;
  if length(v_comp) < 2 or length(v_comp) > 40 then
    raise exception 'Competition name must be 2 to 40 characters' using errcode = '22023';
  end if;
  if not exists (select 1 from team_members where user_id = v_user and team = v_team) then
    raise exception 'You are not a member of "%"', v_team using errcode = '42501';
  end if;

  if p_create then
    if exists (select 1 from competitions where name = v_comp) then
      raise exception 'Competition "%" already exists — join it instead', v_comp using errcode = '23505';
    end if;
    insert into competitions (name, created_by) values (v_comp, v_user);
  elsif not exists (select 1 from competitions where name = v_comp) then
    raise exception 'No competition called "%" — create it instead', v_comp using errcode = '23503';
  end if;

  insert into team_competitions (team, competition, added_by)
  values (v_team, v_comp, v_user)
  on conflict (team, competition) do nothing;

  return build_state();
end;
$$;

revoke all on function public.enroll_team(text, text, boolean) from anon, public;
grant execute on function public.enroll_team(text, text, boolean) to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
--   select p.proname, p.prosecdef as security_definer,
--          has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_can_call,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_can_call
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname in
--         ('build_teams','build_state','join_team','leave_team','enroll_team')
--   order by p.proname;
--
-- Expected: anon_can_call false everywhere, auth_can_call true everywhere, and
-- build_teams the only SECURITY DEFINER of the five.
