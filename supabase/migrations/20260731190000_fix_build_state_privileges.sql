-- ─────────────────────────────────────────────────────────────────────────────
--  BUG FIX — build_state could not read the two flag tables
-- ─────────────────────────────────────────────────────────────────────────────
--  SYMPTOM: every domain in your own Allowed Pages list showed 0 flags, while the
--  same domain showed its real tally on another participant's profile.
--
--  CAUSE: build_state() is SECURITY INVOKER — deliberately, so RLS confines it to
--  the caller — but two of the things it reads are server-side-only tables with
--  every privilege revoked from `authenticated`:
--
--    user_flags     revoked in 20260731090000_weekly_flags.sql
--    domain_flags   revoked in 20260730190000_member_profiles_and_flags.sql
--
--  Both revokes were right. The mistake was reading those tables from an INVOKER
--  function afterwards. Postgres checks table privileges regardless of RLS, so the
--  query raised `permission denied for table user_flags` — and because build_state
--  is the return value of apply_score_delta and get_state, THE ENTIRE SYNC CALL
--  FAILED. Not just the flag counts: scores, whitelist, day history and leaderboards
--  all stopped being written, since applyState() never ran on a failed request.
--
--  It looked like only a counter was wrong because everything else had a plausible
--  local copy to keep showing: scores update optimistically before any request,
--  and the boards render from their last successful cache. get_member_profile kept
--  working throughout because it is SECURITY DEFINER, which is exactly why the two
--  views disagreed about the same domain.
--
--  FIX: the same shape already used for build_teams() — a SECURITY DEFINER helper
--  with NO arguments that derives the caller from auth.uid(), so the privileged read
--  is confined to one small function instead of loosening the tables. Nothing new is
--  exposed: it returns only the caller's own flag budget and the tallies for domains
--  the caller has whitelisted.
--
--  LESSON, worth keeping: `revoke all … from authenticated` and SECURITY INVOKER are
--  incompatible. Anything a SECURITY INVOKER function reads must be grantable to the
--  caller; anything server-side-only has to arrive through a DEFINER helper.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.build_flags()
returns json
language sql
security definer            -- reads user_flags and domain_flags, both client-inaccessible
set search_path = public
as $$
  select json_build_object(
    -- The caller's own domains with their GLOBAL tally. Scoped through user_domains,
    -- so DEFINER buys access to the counter and not to anyone else's whitelist.
    'domains', coalesce(
      (select json_agg(json_build_object(
                'domain',     d.domain,
                'flag_count', coalesce(f.flag_count, 0)) order by d.domain)
       from user_domains d
       left join domain_flags f on f.domain = d.domain
       where d.user_id = auth.uid()),
      '[]'::json),

    -- coalesce(..., 1): a user with no row has never spent anything, so "available"
    -- is the truthful default — and flag_domain creates the row on the way past.
    'flag', json_build_object(
      'available', coalesce((select flag from user_flags where user_id = auth.uid()), 1) = 1
    )
  );
$$;

comment on function public.build_flags is
  'The caller''s own flag budget and domain tallies. SECURITY DEFINER with no arguments: the caller is auth.uid() and cannot be spoofed.';

revoke all on function public.build_flags() from anon, public;
grant execute on function public.build_flags() to authenticated;

-- ── build_state, reading both halves through helpers ──────────────────────────
-- Stays SECURITY INVOKER. Everything it now touches directly (summary, user_domains,
-- daily_scores) is granted to `authenticated`; everything that is not comes through
-- build_teams() or build_flags(), both DEFINER and both argument-free.
create or replace function public.build_state()
returns json
language sql
security invoker
set search_path = public
as $$
  with t as (select build_teams() as j),
       f as (select build_flags() as j)
  select json_build_object(
    'summary', (select to_json(s) from summary s where s.user_id = auth.uid()),

    -- The whitelist cache: strings, ordered. Drives whether heartbeat.ts activates
    -- on a page, so its shape must not change.
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
    'competitions', t.j -> 'competitions',
    'domain_flags', f.j -> 'domains',
    'flag',         f.j -> 'flag'
  )
  from t, f;
$$;

revoke all on function public.build_state() from anon, public;
grant execute on function public.build_state() to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- This is the call that was failing. As `authenticated` it must now return a full
-- payload rather than raise `permission denied for table user_flags`:
--
--   begin;
--   set local role authenticated;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<your-uuid>','role','authenticated')::text, true);
--   select jsonb_pretty((public.build_state()::jsonb) - 'days' - 'competitions');
--   rollback;
--
-- `set local role authenticated` is the part that matters — running it as postgres
-- would have succeeded all along and is precisely why this was missed.
--
-- Nothing else should read a client-inaccessible table from an INVOKER function.
-- This lists every INVOKER function in public, to check against by eye:
--
--   select p.proname
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and not p.prosecdef
--   order by p.proname;
