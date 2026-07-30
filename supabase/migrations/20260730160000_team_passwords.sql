-- ─────────────────────────────────────────────────────────────────────────────
--  Team passwords, and leaving a competition
-- ─────────────────────────────────────────────────────────────────────────────
--  Until now a team name was the only thing standing between a stranger and a
--  team's scores: knowing "math_students" was enough to join it and see everyone
--  in it, and — through any competition that team had entered — everyone in the
--  competing teams too. A shared secret closes that.
--
--  The hash is bcrypt via pgcrypto, and it is NOT READABLE BY CLIENTS: SELECT on
--  public.teams is revoked and re-granted column by column, leaving password_hash
--  off the list. PostgREST therefore cannot be asked for it at any URL.
--
--  That is also why join_team becomes SECURITY DEFINER — it has to read the column
--  nobody else can. It keeps the safe shape: no user_id parameter, caller taken
--  from auth.uid(), EXECUTE revoked from anon and PUBLIC.
--
--  NOT SOLVED HERE: competitions have no password. Any team can still enter any
--  competition by name, and entering it exposes that team's members to everyone
--  already in it, and vice versa. Whether that matters depends on whether
--  competition names are guessable in your study. Same pattern would fix it.
-- ─────────────────────────────────────────────────────────────────────────────

-- Supabase ships pgcrypto in `extensions`; a plain `create extension` would land it
-- in public. Functions below set search_path to cover both so an existing install
-- in either schema resolves.
create extension if not exists pgcrypto with schema extensions;

-- ── The column ────────────────────────────────────────────────────────────────
alter table public.teams add column if not exists password_hash text;

-- Teams created before this migration have no password. NULL must not come to mean
-- "no password required" — that would be a permanent hole in exactly the thing this
-- migration exists to close — so they are given a known one and the column is made
-- NOT NULL. Tell anyone already in a team that theirs is now `changeme`, or delete
-- the rows and let them recreate.
update public.teams
set password_hash = extensions.crypt('changeme', extensions.gen_salt('bf'))
where password_hash is null;

alter table public.teams alter column password_hash set not null;

comment on column public.teams.password_hash is
  'bcrypt. Never selectable by anon or authenticated — see the column grants below.';

-- ── Hide the hash from every client ───────────────────────────────────────────
-- Table-level SELECT is withdrawn and handed back one column at a time. RLS still
-- applies on top; this is the layer that decides which COLUMNS exist at all for a
-- client, which RLS cannot express.
revoke select on public.teams from anon, authenticated;
grant select (name, created_by, created_at) on public.teams to authenticated;

-- ── join_team, now with a password ────────────────────────────────────────────
-- Signature changes (a third argument), so the old one has to go rather than be
-- replaced — otherwise both overloads stay callable and the passwordless one is
-- still a way in.
drop function if exists public.join_team(text, boolean);

create or replace function public.join_team(
  p_team     text,
  p_create   boolean default false,
  p_password text    default ''
)
returns json
language plpgsql
security definer                        -- reads teams.password_hash; nothing else can
set search_path = public, extensions    -- unqualified crypt() resolves in either schema
as $$
declare
  v_user uuid := auth.uid();
  v_team text := lower(btrim(coalesce(p_team, '')));
  v_pw   text := coalesce(p_password, '');
  v_hash text;
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
    -- v_hash is NOT NULL on every row, so "found a hash" and "team exists" are the
    -- same test.
    if v_hash is not null then
      raise exception 'Team "%" already exists — join it instead', v_team using errcode = '23505';
    end if;
    insert into teams (name, created_by, password_hash)
    values (v_team, v_user, crypt(v_pw, gen_salt('bf')));
  else
    if v_hash is null then
      raise exception 'No team called "%" — create it instead', v_team using errcode = '23503';
    end if;
    -- crypt(candidate, stored_hash) re-derives with the stored salt and cost, so this
    -- is a constant-time-ish bcrypt comparison, not a string equality on secrets.
    if v_hash <> crypt(v_pw, v_hash) then
      raise exception 'Wrong password for team "%"', v_team using errcode = '28P01';
    end if;
  end if;

  insert into team_members (user_id, team) values (v_user, v_team)
  on conflict (user_id, team) do nothing;

  -- build_state() is SECURITY INVOKER, but called from here it inherits THIS
  -- function's privileges and so runs as the owner, RLS bypassed. It is safe only
  -- because every one of its reads carries an explicit `user_id = auth.uid()`
  -- predicate. Those predicates are load-bearing — do not "simplify" them away.
  return build_state();
end;
$$;

revoke all on function public.join_team(text, boolean, text) from anon, public;
grant execute on function public.join_team(text, boolean, text) to authenticated;

-- ── Leaving a competition ─────────────────────────────────────────────────────
-- Withdrawing is the mirror of entering, so it carries the same authority: any
-- member of the team may do it, exactly as any member may enter it.
drop policy if exists team_competitions_remove on public.team_competitions;
create policy team_competitions_remove on public.team_competitions
  for delete to authenticated using (
    exists (
      select 1 from public.team_members m
      where m.team = team_competitions.team and m.user_id = auth.uid()
    )
  );

create or replace function public.leave_competition(
  p_team        text,
  p_competition text
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
    raise exception 'leave_competition: not authenticated' using errcode = '28000';
  end if;
  if not exists (select 1 from team_members where user_id = v_user and team = v_team) then
    raise exception 'You are not a member of "%"', v_team using errcode = '42501';
  end if;

  -- The competition row itself survives an empty field, for the same reason a team
  -- survives its last member leaving: withdrawing for an afternoon is not the same
  -- as cancelling the competition.
  delete from team_competitions where team = v_team and competition = v_comp;

  return build_state();
end;
$$;

revoke all on function public.leave_competition(text, text) from anon, public;
grant execute on function public.leave_competition(text, text) to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- The hash must be unreachable. As an authenticated client this must ERROR:
--   select password_hash from public.teams;
-- while this must still work:
--   select name from public.teams;
