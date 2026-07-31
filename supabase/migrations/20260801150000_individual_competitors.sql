-- ─────────────────────────────────────────────────────────────────────────────
--  Competing individually as well as with a team
-- ─────────────────────────────────────────────────────────────────────────────
--  A competition now has two kinds of entrant, and one person can be both:
--
--    competition_members    you, personally, ranked against other individuals
--    team_competitions      your team, its members summed, ranked against teams
--
--  They are separate opt-ins. Being in a team that entered "highschoolcup" does not
--  enter YOU in it, and entering yourself does not enter your team. That is what
--  makes "both" meaningful rather than automatic — and it is why the popup shows the
--  competition twice, once per entry.
--
--  ── AT MOST ONE OF YOUR TEAMS PER COMPETITION ───────────────────────────────
--  A person may not have two of their teams competing in the same competition. It
--  cannot be a table constraint: the rule spans team_members and team_competitions,
--  and neither table alone can see the violation. So it is enforced at both doors
--  through which it can be broken, and BOTH are needed —
--
--    enroll_team   entering a team into a competition where one of its members
--                  already has another team. Checks every member, not just the
--                  caller: whoever presses the button is rarely the person the
--                  clash belongs to.
--    join_team     joining a team that is already in a competition you are in via a
--                  different team.
--
--  Guarding only the first would leave the second as a way in, and vice versa.
--
--  ── VISIBILITY ──────────────────────────────────────────────────────────────
--  Entering a competition individually puts you in the same arena as everyone else
--  in it, so it grants and receives the same visibility a team entry does. The rule
--  stays in one place: my_competitions() now covers both routes, visible_teams()
--  reads it, and can_see_user() gains the individual-participant case.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.competition_members (
  competition text        not null references public.competitions(name) on update cascade on delete cascade,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (competition, user_id)
);

comment on table public.competition_members is
  'Individual entrants. Separate from team_competitions: a person can be in both, or either.';

create index if not exists competition_members_user_idx on public.competition_members (user_id);

alter table public.competition_members enable row level security;

drop policy if exists competition_members_read on public.competition_members;
create policy competition_members_read on public.competition_members
  for select to authenticated using (true);

revoke all on public.competition_members from anon;
grant select on public.competition_members to authenticated;

-- ── Every competition the caller is in, by either route ───────────────────────
create or replace function public.my_competitions()
returns table (competition text)
language sql
stable
security definer
set search_path = public
as $$
  select tc.competition
  from team_competitions tc
  join team_members tm on tm.team = tc.team
  where tm.user_id = auth.uid()
  union
  select cm.competition
  from competition_members cm
  where cm.user_id = auth.uid();
$$;

revoke all on function public.my_competitions() from anon, public;
grant execute on function public.my_competitions() to authenticated;

-- ── visible_teams, now fed by both routes ─────────────────────────────────────
create or replace function public.visible_teams()
returns table (team text)
language sql
security definer
set search_path = public
as $$
  select tm.team from team_members tm where tm.user_id = auth.uid()
  union
  -- Every team in a competition you are in — whether you got there through a team
  -- of your own or by entering yourself.
  select tc.team
  from team_competitions tc
  join my_competitions() mc on mc.competition = tc.competition;
$$;

revoke all on function public.visible_teams() from anon, public;
grant execute on function public.visible_teams() to authenticated;

-- ── can_see_user, now with individual competitors ─────────────────────────────
create or replace function public.can_see_user(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_user = auth.uid()
    or exists (
      select 1 from team_members m
      join visible_teams() v on v.team = m.team
      where m.user_id = p_user)
    -- An individual entrant in a competition you are also in.
    or exists (
      select 1 from competition_members cm
      join my_competitions() mc on mc.competition = cm.competition
      where cm.user_id = p_user)
    or exists (
      select 1 from friendships f
      where f.status = 'accepted'
        and ((f.requester = auth.uid() and f.addressee = p_user)
          or (f.addressee = auth.uid() and f.requester = p_user)));
$$;

revoke all on function public.can_see_user(uuid) from anon, public;
grant execute on function public.can_see_user(uuid) to authenticated;

-- ── Entering yourself ─────────────────────────────────────────────────────────
-- Passworded exactly like a team entry, and for the same reason: sharing a
-- competition is what makes people visible to each other.
create or replace function public.join_competition(
  p_competition text,
  p_create      boolean default false,
  p_password    text    default ''
)
returns json
language plpgsql
security definer                        -- reads competitions.password_hash
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_comp text := lower(btrim(coalesce(p_competition, '')));
  v_pw   text := coalesce(p_password, '');
  v_hash text;
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

  select password_hash into v_hash from competitions where name = v_comp;

  if p_create then
    if v_hash is not null then
      raise exception 'Competition "%" already exists — join it instead', v_comp using errcode = '23505';
    end if;
    insert into competitions (name, created_by, password_hash)
    values (v_comp, v_user, crypt(v_pw, gen_salt('bf')));
  else
    if v_hash is null then
      raise exception 'No competition called "%" — create it instead', v_comp using errcode = '23503';
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

create or replace function public.leave_competition_solo(p_competition text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_comp text := lower(btrim(coalesce(p_competition, '')));
begin
  if v_user is null then
    raise exception 'leave_competition_solo: not authenticated' using errcode = '28000';
  end if;

  -- `user_id = v_user` is the whole control: SECURITY DEFINER bypasses RLS, so this
  -- predicate is what stops anyone withdrawing somebody else. It leaves any TEAM
  -- entry of yours untouched — the two are separate memberships.
  delete from competition_members where competition = v_comp and user_id = v_user;

  return build_state();
end;
$$;

revoke all on function public.leave_competition_solo(text) from anon, public;
grant execute on function public.leave_competition_solo(text) to authenticated;

-- ── The one-team-per-competition rule, at both doors ──────────────────────────
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
  v_user   uuid := auth.uid();
  v_team   text := lower(btrim(coalesce(p_team, '')));
  v_comp   text := lower(btrim(coalesce(p_competition, '')));
  v_pw     text := coalesce(p_password, '');
  v_hash   text;
  v_clash  text;
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

  select password_hash into v_hash from competitions where name = v_comp;

  if p_create then
    if v_hash is not null then
      raise exception 'Competition "%" already exists — join it instead', v_comp using errcode = '23505';
    end if;
    insert into competitions (name, created_by, password_hash)
    values (v_comp, v_user, crypt(v_pw, gen_salt('bf')));
  else
    if v_hash is null then
      raise exception 'No competition called "%" — create it instead', v_comp using errcode = '23503';
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

-- The other door: joining a team already entered in a competition you are in via a
-- different team. Without this check the rule is trivially avoidable.
create or replace function public.join_team(
  p_team     text,
  p_create   boolean default false,
  p_password text    default ''
)
returns json
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user  uuid := auth.uid();
  v_team  text := lower(btrim(coalesce(p_team, '')));
  v_pw    text := coalesce(p_password, '');
  v_hash  text;
  v_clash record;
begin
  if v_user is null then
    raise exception 'join_team: not authenticated' using errcode = '28000';
  end if;
  if length(v_team) < 2 or length(v_team) > 40 then
    raise exception 'Team name must be 2 to 40 characters' using errcode = '22023';
  end if;
  if length(v_pw) < 4 then
    raise exception 'Team password must be at least 4 characters' using errcode = '22023';
  end if;

  select password_hash into v_hash from teams where name = v_team;

  if p_create then
    if v_hash is not null then
      raise exception 'Team "%" already exists — join it instead', v_team using errcode = '23505';
    end if;
    insert into teams (name, created_by, password_hash)
    values (v_team, v_user, crypt(v_pw, gen_salt('bf')));
  else
    if v_hash is null then
      raise exception 'No team called "%" — create it instead', v_team using errcode = '23503';
    end if;
    if v_hash <> crypt(v_pw, v_hash) then
      raise exception 'Wrong password for team "%"', v_team using errcode = '28P01';
    end if;

    -- Only meaningful when joining an existing team; a team you just created has no
    -- competitions yet.
    --
    -- Reads as: of the competitions this team is in, is there one where I already
    -- field a DIFFERENT team?
    select tc.competition as competition, mine_tc.team as my_team
    into v_clash
    from team_competitions tc
    join team_competitions mine_tc
      on mine_tc.competition = tc.competition and mine_tc.team <> tc.team
    join team_members mine
      on mine.team = mine_tc.team and mine.user_id = v_user
    where tc.team = v_team
    limit 1;

    if v_clash is not null then
      raise exception
        'You already compete in "%" with "%" — one team per person per competition',
        v_clash.competition, v_clash.my_team using errcode = '23505';
    end if;
  end if;

  insert into team_members (user_id, team) values (v_user, v_team)
  on conflict (user_id, team) do nothing;

  return build_state();
end;
$$;

revoke all on function public.join_team(text, boolean, text) from anon, public;
grant execute on function public.join_team(text, boolean, text) to authenticated;

-- ── build_state: two kinds of competition entry ───────────────────────────────
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

    'my_teams', coalesce(
      (select json_agg(tm.team order by tm.team)
       from team_members tm where tm.user_id = auth.uid()),
      '[]'::json),

    -- Where you compete as yourself.
    'my_competitions', coalesce(
      (select json_agg(cm.competition order by cm.competition)
       from competition_members cm where cm.user_id = auth.uid()),
      '[]'::json),

    -- Where one of your teams competes. Separate array, so the popup can show the
    -- same competition twice — once per entry — which is what having two entries
    -- looks like.
    'my_team_competitions', coalesce(
      (select json_agg(json_build_object('competition', tc.competition, 'team', tc.team)
                       order by tc.competition, tc.team)
       from team_competitions tc
       join team_members tm on tm.team = tc.team
       where tm.user_id = auth.uid()),
      '[]'::json),

    'friend_requests', (select count(*) from friendships
                        where addressee = auth.uid() and status = 'pending'),

    'domain_flags', f.j -> 'domains',
    'flag',         f.j -> 'flag'
  )
  from f;
$$;

revoke all on function public.build_state() from anon, public;
grant execute on function public.build_state() to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
--   -- The invariant, from both directions. Both must raise 23505:
--   select public.enroll_team('team_b', 'uni_cup', false, 'pw');  -- you already in via team_a
--   select public.join_team('team_b', false, 'pw');               -- team_b already in uni_cup
--
--   -- Two entries, two pills:
--   select public.build_state()::jsonb -> 'my_competitions';
--   select public.build_state()::jsonb -> 'my_team_competitions';
