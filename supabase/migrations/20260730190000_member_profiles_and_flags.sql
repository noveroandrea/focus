-- ─────────────────────────────────────────────────────────────────────────────
--  Member profiles, and red flags on domains
-- ─────────────────────────────────────────────────────────────────────────────
--  Two new capabilities:
--
--    1. Tapping a participant on a leaderboard opens their profile — live / 7-day /
--       30-day scores, their day history, and their whitelisted domains.
--    2. Anyone can raise a red flag against a domain. The count is GLOBAL per
--       domain, not per participant: flagging youtube.com on one profile raises the
--       same counter you see on every other.
--
--  ── READ THIS BEFORE DEPLOYING ──────────────────────────────────────────────
--  Capability 1 is a real escalation of what participants see about each other.
--  Until now a teammate could see your SCORES. They can now see WHICH SITES YOU
--  WHITELIST, which is browsing data — it says where you work, which university,
--  which mail provider, which projects. supabase/README.md already flagged
--  user_domains as the most sensitive table in the schema; this exposes it to peers
--  rather than only to the researcher.
--
--  That has to be in the consent form, in those words. If it should not be, the fix
--  is to drop 'domains' from get_member_profile's payload — the profile still works
--  without it, and the flag tables can stay for the researcher's own use.
--  ────────────────────────────────────────────────────────────────────────────
--
--  ── THE PARAMETER ───────────────────────────────────────────────────────────
--  get_member_profile takes a user_id, which is the exact shape that caused the
--  vulnerability fixed in 20260729210000: a SECURITY DEFINER function with someone
--  else's id as an argument. It is safe HERE, and only because of the explicit
--  authorization check in its body — the caller must already be able to see that
--  participant through a shared team or competition. Remove that check and this
--  becomes a full dump of any user by id.
--
--  To keep that check honest, "who can I see" is now defined exactly ONCE, in
--  visible_teams(), and build_teams() is rebuilt to consume it. Two copies of a
--  security boundary is two things to keep in agreement; one is one.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══ The visibility boundary, defined once ═════════════════════════════════════
-- Every team whose members the caller may see: their own, plus every team sharing a
-- competition with one of theirs. SECURITY DEFINER because reaching the second group
-- means reading team_competitions rows for teams the caller is not in.
create or replace function public.visible_teams()
returns table (team text)
language sql
security definer
set search_path = public
as $$
  with me as (
    select auth.uid() as uid
  ),
  my_teams as (
    select tm.team from team_members tm, me where tm.user_id = me.uid
  ),
  my_comps as (
    select distinct tc.competition
    from team_competitions tc
    join my_teams t on t.team = tc.team
  ),
  comp_teams as (
    select tc.team
    from team_competitions tc
    join my_comps c on c.competition = tc.competition
  )
  select team from my_teams
  union
  select team from comp_teams;
$$;

comment on function public.visible_teams is
  'The single definition of which teams the caller may see members of. Everything that exposes one participant to another must go through this.';

revoke all on function public.visible_teams() from anon, public;
grant execute on function public.visible_teams() to authenticated;

-- ═══ Domain flags ══════════════════════════════════════════════════════════════
-- domain_flags is the table asked for: domain as the key, a running total of flags.
--
-- domain_flag_voters is not in the brief and is here on purpose. Without it the
-- counter is whatever the fastest finger says — holding the button down adds a
-- hundred flags — and a number like that cannot be used as study data. Keying it
-- (domain, user_id) makes one flag per person per domain a property of the schema,
-- the same trick team_members already uses, and it makes un-flagging possible.
create table if not exists public.domain_flags (
  domain     text primary key check (length(btrim(domain)) > 0),
  flag_count integer     not null default 0 check (flag_count >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.domain_flag_voters (
  domain     text        not null references public.domain_flags(domain) on delete cascade,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  flagged_at timestamptz not null default now(),
  primary key (domain, user_id)
);

comment on table public.domain_flags is
  'Global red-flag count per domain. Written only by flag_domain(); recomputed from domain_flag_voters, never incremented.';

-- Both tables are reached exclusively through the SECURITY DEFINER functions below,
-- so no client gets direct table rights at all. RLS on with no policy is a deny-all
-- backstop in case a future GRANT is added by accident.
alter table public.domain_flags       enable row level security;
alter table public.domain_flag_voters enable row level security;

revoke all on public.domain_flags       from anon, authenticated;
revoke all on public.domain_flag_voters from anon, authenticated;

-- ── flag_domain ───────────────────────────────────────────────────────────────
-- A toggle, not an increment: tapping the flag again withdraws yours. The count is
-- then RECOUNTED from the voter rows rather than adjusted, so it can never drift
-- away from the votes that justify it — a lost response or a double-tap costs
-- nothing.
create or replace function public.flag_domain(p_domain text)
returns json
language plpgsql
security definer            -- writes a shared counter no client may touch directly
set search_path = public
as $$
declare
  v_me    uuid    := auth.uid();
  v_dom   text    := lower(btrim(coalesce(p_domain, '')));
  v_mine  boolean;
  v_count integer;
begin
  if v_me is null then
    raise exception 'flag_domain: not authenticated' using errcode = '28000';
  end if;
  if length(v_dom) = 0 or length(v_dom) > 253 then
    raise exception 'Not a domain' using errcode = '22023';
  end if;

  insert into domain_flags (domain) values (v_dom) on conflict (domain) do nothing;

  delete from domain_flag_voters where domain = v_dom and user_id = v_me;
  if found then
    v_mine := false;                                    -- withdrew an existing flag
  else
    insert into domain_flag_voters (domain, user_id) values (v_dom, v_me);
    v_mine := true;
  end if;

  update domain_flags
  set flag_count = (select count(*) from domain_flag_voters where domain = v_dom),
      updated_at = now()
  where domain = v_dom
  returning flag_count into v_count;

  return json_build_object('domain', v_dom, 'flag_count', v_count, 'flagged_by_me', v_mine);
end;
$$;

revoke all on function public.flag_domain(text) from anon, public;
grant execute on function public.flag_domain(text) to authenticated;

-- ── get_member_profile ────────────────────────────────────────────────────────
-- See the parameter note in the header. The authorization check is the whole
-- security of this function.
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

      -- Same 30-day window and same shape as build_state's 'days', so the client
      -- renders both through one code path.
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

      -- Most-flagged first: the point of the flags is to surface the domains people
      -- object to, so the list should lead with them.
      'domains', coalesce((
        select json_agg(json_build_object(
                 'domain',        d.domain,
                 'flag_count',    coalesce(f.flag_count, 0),
                 'flagged_by_me', exists (
                    select 1 from domain_flag_voters w
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

-- ═══ build_teams, rebuilt on visible_teams() ═══════════════════════════════════
-- Identical to the previous version except that the `visible` CTE now calls
-- visible_teams() instead of restating the rule. That is the whole point of this
-- rewrite: get_member_profile authorizes against the same definition build_teams
-- displays, so the two cannot drift into disagreeing about who you may see.
create or replace function public.build_teams()
returns json
language sql
security definer
set search_path = public
as $$
  with me as (
    select auth.uid() as uid
  ),
  my_teams as (
    select tm.team from team_members tm, me where tm.user_id = me.uid
  ),
  my_comps as (
    select distinct tc.competition
    from team_competitions tc
    join my_teams t on t.team = tc.team
  ),
  comp_teams as (
    select tc.competition, tc.team
    from team_competitions tc
    join my_comps c on c.competition = tc.competition
  ),
  visible as (
    select team from visible_teams()
  ),
  scores as (
    select v.team,
           m.user_id,
           coalesce(nullif(split_part(u.email, '@', 1), ''), 'participant') as display_name,
           (m.user_id = (select uid from me)) as is_self,
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

revoke all on function public.build_teams() from anon, public;
grant execute on function public.build_teams() to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- Impersonate yourself, then try to read someone you share nothing with. The second
-- call MUST raise, not return rows:
--
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object('sub', '<your-uuid>', 'role', 'authenticated')::text, true);
--   select public.get_member_profile('<a-teammate-uuid>');   -- returns a profile
--   select public.get_member_profile('<a-stranger-uuid>');   -- must ERROR 42501
--   commit;
