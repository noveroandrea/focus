-- ─────────────────────────────────────────────────────────────────────────────
--  Day history on demand — the last thing riding along on every post
-- ─────────────────────────────────────────────────────────────────────────────
--  After the board split, 30 days of completed scores were ~66% of what remained in
--  build_state: about 2.2 KB of a 3.4 KB payload. It changes ONCE A DAY, at the
--  01:00 rollover, and was being sent every 60 seconds.
--
--  It now has its own call, made when the Personal section is on screen — the only
--  place that draws it. The routine check-in drops to roughly 1.1 KB raw / 0.3 KB on
--  the wire, which is summary + whitelist + flag tallies + section names, all of
--  which genuinely can change between one minute and the next.
--
--  THE FULL SHAPE, now that every read is scoped to what a view actually needs:
--
--    build_state             every check-in   own live score, whitelist + tallies,
--                                             flag budget, team/competition NAMES
--    get_my_days             Personal open    own 30 completed days
--    get_team_board(t)       team open        members' live / 7d / 30d only
--    get_competition_board(c) comp open       team totals + members' live / 7d / 30d
--    get_member_profile(u)   member clicked   that member's scores, days AND domains
--
--  Nothing carries a day history or a whitelist except the two calls that display
--  one, so the expensive fields travel exactly as often as somebody looks at them.
--
--  get_my_days is SECURITY INVOKER: daily_scores is granted to `authenticated` and
--  its RLS policy already pins it to the owner, so there is no privilege to borrow.
--  (Contrast build_flags, which had to be DEFINER because its tables are revoked —
--  see 20260731190000.)
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.get_my_days()
returns json
language sql
security invoker
set search_path = public
as $$
  -- Same 30-day window and same shape build_state used to return, so the client
  -- renders it through the code path it already had.
  select coalesce(
    (select json_agg(json_build_object(
              'day', day,
              'focus_score', focus_score,
              'distracted_score', distracted_score) order by day desc)
     from (select day, focus_score, distracted_score
           from daily_scores
           where user_id = auth.uid()
           order by day desc
           limit 30) recent),
    '[]'::json);
$$;

comment on function public.get_my_days is
  'The caller''s 30 most recent completed focus-days. Fetched when the history is displayed, not on every check-in.';

revoke all on function public.get_my_days() from anon, public;
grant execute on function public.get_my_days() to authenticated;

-- ── build_state without the history ───────────────────────────────────────────
create or replace function public.build_state()
returns json
language sql
security invoker
set search_path = public
as $$
  with f as (select build_flags() as j)
  select json_build_object(
    -- Everything left here can genuinely differ from one minute to the next.
    'summary', (select to_json(s) from summary s where s.user_id = auth.uid()),

    'domains', coalesce(
      (select json_agg(domain order by domain)
       from user_domains where user_id = auth.uid()),
      '[]'::json),

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

-- ── Verify ────────────────────────────────────────────────────────────────────
--   begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<your-uuid>','role','authenticated')::text, true);
--   select length(public.build_state()::text) as routine_bytes;   -- expect ~1 KB
--   select json_array_length(public.get_my_days())  as days;      -- expect up to 30
--   rollback;
