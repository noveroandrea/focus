-- ─────────────────────────────────────────────────────────────────────────────
--  SECURITY FIX — SECURITY DEFINER functions were callable with any user_id
-- ─────────────────────────────────────────────────────────────────────────────
--  Postgres grants EXECUTE on a new function to PUBLIC by default. Four functions
--  were created SECURITY DEFINER (so they run as the owner, bypassing RLS) while
--  taking a user_id as a PARAMETER, and none of them had that default revoked.
--  Any signed-in user — and anon — could therefore call them for somebody else:
--
--    build_state(uuid)     CRITICAL. Returned another user's entire state: live
--                          score, 7/30-day averages, whitelisted domains and 30
--                          days of history. A complete RLS bypass, read-only but
--                          total, for any UUID the caller could guess or observe.
--    roll_forward(uuid)    Could force another user's day to end early, banking
--                          their in-progress score and zeroing the live one.
--    refresh_rollup(uuid)  Unauthorised write to another user's summary row.
--                          Recomputes correct values, so the damage is limited to
--                          being a write path that should not exist.
--    roll_forward_due()    Could trigger the rollover sweep at will.
--
--  RLS on the tables was never the problem and was correct throughout. SECURITY
--  DEFINER is specifically the mechanism for stepping around it, which is why
--  these functions needed grants and did not have them.
--
--  THE FIX, in two parts:
--
--  1. build_state stops taking a user_id at all. It reads auth.uid() itself and is
--     now SECURITY INVOKER, so RLS applies and it is structurally incapable of
--     returning another user's rows — not merely forbidden by a grant. Fixing the
--     signature rather than only the privileges means a future `grant execute ...
--     to authenticated` cannot silently reopen the hole.
--
--  2. The three cross-user maintenance functions stay SECURITY DEFINER, because
--     the cron job legitimately has to write across every user, but EXECUTE is
--     revoked from anon, authenticated and PUBLIC. Only the postgres/service_role
--     identity that runs pg_cron can reach them. Nothing in an invoker context
--     calls them: roll_forward_due → roll_forward → refresh_rollup all run inside
--     the owner's context, and apply_score_delta no longer triggers a rollover.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. build_state: own data only, by construction ────────────────────────────
-- Dropped rather than replaced because the signature changes. The two callers are
-- recreated below, since their bodies reference the old one.
drop function if exists public.build_state(uuid);

create or replace function public.build_state()
returns json
language sql
security invoker              -- RLS applies; auth.uid() is the only user reachable
set search_path = public
as $$
  -- The explicit user_id predicates are redundant under RLS and kept deliberately:
  -- if a policy is ever loosened, these still scope every read to the caller.
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
      '[]'::json)
  );
$$;

comment on function public.build_state is
  'The caller''s own full state. SECURITY INVOKER: cannot read another user''s rows.';

revoke all on function public.build_state() from anon, public;
grant execute on function public.build_state() to authenticated;

-- ── 2. get_state: unchanged behaviour, new build_state signature ───────────────
create or replace function public.get_state(p_timezone text default 'UTC')
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'get_state: not authenticated' using errcode = '28000';
  end if;
  return build_state();
end;
$$;

revoke all on function public.get_state(text) from anon, public;
grant execute on function public.get_state(text) to authenticated;

-- ── 3. apply_score_delta: unchanged behaviour, new build_state signature ───────
create or replace function public.apply_score_delta(
  p_focus_delta      numeric default 0,
  p_distracted_delta numeric default 0,
  p_timezone         text    default 'UTC',
  p_domains          text[]  default null   -- NULL = leave the whitelist untouched
)
returns json
language plpgsql
security invoker            -- RLS applies: a caller can only ever affect their own row
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_tz   text := coalesce(nullif(trim(p_timezone), ''), 'UTC');
begin
  if v_user is null then
    raise exception 'apply_score_delta: not authenticated' using errcode = '28000';
  end if;

  -- Fall back to UTC on an unparseable zone rather than letting focus_day() error:
  -- a bad timezone should cost the user an accurate day boundary, not their score.
  begin
    perform now() at time zone v_tz;
  exception when others then
    v_tz := 'UTC';
  end;

  -- First contact creates the row, dated to the focus-day the user is currently in
  -- (not epoch), so nothing is banked for days before signup.
  insert into user_summary (user_id, live_day, timezone)
  values (v_user, focus_day(now(), v_tz), v_tz)
  on conflict (user_id) do update set timezone = excluded.timezone;

  -- NO rollover here. Ending a day belongs to the cron job alone; this function
  -- only ever adds to the live score, so exactly one place decides when a day ends
  -- and a POST landing at the same moment as the schedule needs no reasoning about.
  update user_summary set
    live_focus      = live_focus      + greatest(coalesce(p_focus_delta, 0), 0),
    live_distracted = live_distracted + least(coalesce(p_distracted_delta, 0), 0),
    updated_at      = now()
  where user_id = v_user;

  -- Whitelist, only when the client is actually pushing one. NULL means "no edit",
  -- the case for nearly every call: a score delta must not blank the whitelist by
  -- having nothing to say about it. An empty ARRAY is different and does clear it.
  if p_domains is not null then
    delete from user_domains
    where user_id = v_user and domain <> all (p_domains);

    insert into user_domains (user_id, domain)
    select v_user, trim(d)
    from unnest(p_domains) as d
    where length(trim(d)) > 0
    on conflict (user_id, domain) do nothing;
  end if;

  return build_state();
end;
$$;

revoke all on function public.apply_score_delta(numeric, numeric, text, text[]) from anon, public;
grant execute on function public.apply_score_delta(numeric, numeric, text, text[]) to authenticated;

-- ── 4. Lock down the cross-user maintenance functions ─────────────────────────
-- These must stay SECURITY DEFINER: pg_cron has to write across every user's rows.
-- Revoking EXECUTE from anon/authenticated/PUBLIC leaves them reachable only by the
-- privileged identity that runs the schedule.
revoke all on function public.refresh_rollup(uuid)  from anon, authenticated, public;
revoke all on function public.roll_forward(uuid)    from anon, authenticated, public;
revoke all on function public.roll_forward_due()    from anon, authenticated, public;

-- focus_day() is deliberately left executable: it is IMMUTABLE, touches no table,
-- and apply_score_delta needs it while running as the calling user.
revoke all on function public.focus_day(timestamptz, text) from anon;
grant execute on function public.focus_day(timestamptz, text) to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- After applying, this should show EXECUTE for authenticated ONLY on
-- apply_score_delta, get_state, build_state and focus_day:
--
--   select p.proname,
--          p.prosecdef as security_definer,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_call
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public'
--   order by p.proname;
--
-- And this must now fail with "permission denied" instead of returning data:
--   select public.build_state('<some-other-user-uuid>'::uuid);
