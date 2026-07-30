-- ─────────────────────────────────────────────────────────────────────────────
--  Competition passwords — closing the self-service route into a competition
-- ─────────────────────────────────────────────────────────────────────────────
--  Teams got a password in 20260730160000, which stopped a stranger joining one by
--  guessing its name. It left the other way in wide open:
--
--    1. create a team, with your own password — nobody else needs to agree;
--    2. enroll it into "uni_cup", which needed only the NAME;
--    3. you now share a competition with every team in it, so visible_teams()
--       genuinely returns them, and get_member_profile hands over their scores,
--       day history and whitelisted domains.
--
--  Nothing there was a bug: the server authorized correctly, against a membership
--  rule that anyone could satisfy unilaterally. This migration makes step 2 need a
--  shared secret, so the set of people you can see is one somebody let you into.
--
--  Exactly the team pattern, for the same reasons:
--    • bcrypt in competitions.password_hash;
--    • the hash withheld from clients by column-level GRANT, not by RLS — RLS
--      filters ROWS and cannot hide a COLUMN;
--    • enroll_team therefore becomes SECURITY DEFINER, since it has to read the
--      column nobody else can, and keeps the safe shape: no user_id parameter,
--      caller from auth.uid(), EXECUTE revoked from anon and PUBLIC.
--
--  DELIBERATELY NOT PASSWORDED: leave_competition. Withdrawing your own team needs
--  no secret — you already had to be a member of that team to be in it at all, and
--  demanding the password to leave would strand a team whose organiser forgot it.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto with schema extensions;

-- ── The column ────────────────────────────────────────────────────────────────
alter table public.competitions add column if not exists password_hash text;

-- Competitions created before this migration have none. NULL must not come to mean
-- "no password required" — that is the hole this migration exists to close — so they
-- are backfilled with a known one and the column is made NOT NULL. Tell anyone
-- already enrolled that theirs is now `changeme`, or delete the rows and recreate.
update public.competitions
set password_hash = extensions.crypt('changeme', extensions.gen_salt('bf'))
where password_hash is null;

alter table public.competitions alter column password_hash set not null;

comment on column public.competitions.password_hash is
  'bcrypt. Never selectable by anon or authenticated — see the column grants below.';

-- ── Hide the hash from every client ───────────────────────────────────────────
revoke select on public.competitions from anon, authenticated;
grant select (name, created_by, created_at) on public.competitions to authenticated;

-- ── enroll_team, now with a password ──────────────────────────────────────────
-- The signature gains a fourth argument, so the old function is dropped rather than
-- replaced: leaving it in place would keep the passwordless overload callable and
-- change nothing.
drop function if exists public.enroll_team(text, text, boolean);

create or replace function public.enroll_team(
  p_team        text,
  p_competition text,
  p_create      boolean default false,
  p_password    text    default ''
)
returns json
language plpgsql
security definer                        -- reads competitions.password_hash
set search_path = public, extensions    -- unqualified crypt() resolves in either schema
as $$
declare
  v_user uuid := auth.uid();
  v_team text := lower(btrim(coalesce(p_team, '')));
  v_comp text := lower(btrim(coalesce(p_competition, '')));
  v_pw   text := coalesce(p_password, '');
  v_hash text;
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

  -- RLS is bypassed under SECURITY DEFINER, so this predicate is now the ONLY thing
  -- confining the write to a team the caller belongs to. It was belt-and-braces
  -- before; it is load-bearing now. Do not remove it.
  if not exists (select 1 from team_members where user_id = v_user and team = v_team) then
    raise exception 'You are not a member of "%"', v_team using errcode = '42501';
  end if;

  select password_hash into v_hash from competitions where name = v_comp;

  if p_create then
    -- password_hash is NOT NULL on every row, so "found a hash" and "it exists" are
    -- the same test.
    if v_hash is not null then
      raise exception 'Competition "%" already exists — join it instead', v_comp using errcode = '23505';
    end if;
    insert into competitions (name, created_by, password_hash)
    values (v_comp, v_user, crypt(v_pw, gen_salt('bf')));
  else
    if v_hash is null then
      raise exception 'No competition called "%" — create it instead', v_comp using errcode = '23503';
    end if;
    -- crypt(candidate, stored_hash) re-derives with the stored salt and cost: a
    -- bcrypt comparison, not a string equality on secrets.
    if v_hash <> crypt(v_pw, v_hash) then
      raise exception 'Wrong password for competition "%"', v_comp using errcode = '28P01';
    end if;
  end if;

  insert into team_competitions (team, competition, added_by)
  values (v_team, v_comp, v_user)
  on conflict (team, competition) do nothing;

  -- build_state() is SECURITY INVOKER but inherits THIS function's privileges when
  -- called from here, so it runs with RLS bypassed. Safe only because every read in
  -- it carries an explicit `user_id = auth.uid()` predicate — those are load-bearing.
  return build_state();
end;
$$;

revoke all on function public.enroll_team(text, text, boolean, text) from anon, public;
grant execute on function public.enroll_team(text, text, boolean, text) to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- As an authenticated client this must ERROR:
--   select password_hash from public.competitions;
-- while this must still work:
--   select name from public.competitions;
--
-- And the attack in the header must now fail at step 2: enrolling a fresh team into
-- an existing competition without its password raises 28P01.
