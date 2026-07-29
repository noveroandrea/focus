-- ─────────────────────────────────────────────────────────────────────────────
--  Focus — the write path and the read path
-- ─────────────────────────────────────────────────────────────────────────────
--  The extension talks to exactly two endpoints:
--
--    POST /rest/v1/rpc/apply_score_delta   send a score delta, get everything back
--    GET  /rest/v1/summary                 read-only: the same payload, no write
--
--  apply_score_delta is the only writer of live scores. It is one round trip and
--  atomic: the row is locked, any overdue day is banked, the delta is applied, and
--  the refreshed summary is returned. A delta of (0, 0) is therefore also the
--  "just tell me the current numbers" call the extension makes at browser start
--  and at the start of a day — no special endpoint needed.
--
--  Deltas, not absolutes, on purpose: two devices can both post +1 without either
--  overwriting the other, and a retry that arrives late still lands correctly. The
--  cost is that a duplicate POST double-counts, so the client must only retry a
--  request it knows did not land (see sync.ts).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── refresh_rollup ────────────────────────────────────────────────────────────
-- Recompute the five denormalised slots (d1..d3, avg7, avg30) for one user from
-- daily_scores. Called only from the rollover, because every value it writes
-- describes COMPLETED days and so is constant within a focus-day.
--
-- The averages match the extension's windowAvg() exactly: complete days ending
-- yesterday, and only days actually RECORDED count toward the mean. A day the
-- machine never came on is absent, not a zero — averaging zeros in would make a
-- holiday look like a failure.
create or replace function public.refresh_rollup(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live_day date;
  v_d        record;
  v_a7       record;
  v_a30      record;
begin
  select live_day into v_live_day from user_summary where user_id = p_user;
  if v_live_day is null then
    return;
  end if;

  -- The three most recent recorded days, newest first. Deliberately "most recent
  -- recorded" rather than live_day-1/-2/-3, so gaps (PC switched off) shift the
  -- window instead of punching zeros into it.
  select
    coalesce(max(case when rn = 1 then focus_score      end), 0) as d1_f,
    coalesce(max(case when rn = 1 then distracted_score end), 0) as d1_d,
    coalesce(max(case when rn = 2 then focus_score      end), 0) as d2_f,
    coalesce(max(case when rn = 2 then distracted_score end), 0) as d2_d,
    coalesce(max(case when rn = 3 then focus_score      end), 0) as d3_f,
    coalesce(max(case when rn = 3 then distracted_score end), 0) as d3_d
  into v_d
  from (
    select focus_score, distracted_score,
           row_number() over (order by day desc) as rn
    from daily_scores
    where user_id = p_user and day < v_live_day
    order by day desc
    limit 3
  ) t;

  -- avg over [live_day - 7, live_day - 1] — seven calendar days ending yesterday.
  select coalesce(avg(focus_score), 0)      as f,
         coalesce(avg(distracted_score), 0) as d
  into v_a7
  from daily_scores
  where user_id = p_user
    and day between v_live_day - 7 and v_live_day - 1;

  -- avg over [live_day - 30, live_day - 1].
  select coalesce(avg(focus_score), 0)      as f,
         coalesce(avg(distracted_score), 0) as d
  into v_a30
  from daily_scores
  where user_id = p_user
    and day between v_live_day - 30 and v_live_day - 1;

  update user_summary set
    d1_focus = v_d.d1_f, d1_distracted = v_d.d1_d,
    d2_focus = v_d.d2_f, d2_distracted = v_d.d2_d,
    d3_focus = v_d.d3_f, d3_distracted = v_d.d3_d,
    avg7_focus  = round(v_a7.f, 2),  avg7_distracted  = round(v_a7.d, 2),
    avg30_focus = round(v_a30.f, 2), avg30_distracted = round(v_a30.d, 2),
    updated_at = now()
  where user_id = p_user;
end;
$$;

-- ── roll_forward ──────────────────────────────────────────────────────────────
-- Bank the live score into daily_scores and reset it, if its focus-day is over.
--
-- Idempotent and date-driven, NOT a timer: it asks "is live_day still today?" and
-- does nothing if so. That is what lets the same function serve both the 01:00
-- cron job and the lazy check inside apply_score_delta — whichever runs first wins
-- and the other becomes a no-op. It also means a user whose browser was closed at
-- 01:00 is rolled over correctly the moment they come back, and a machine left off
-- for a week banks one day rather than seven empty ones.
create or replace function public.roll_forward(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   user_summary;
  v_today date;
begin
  -- FOR UPDATE: the cron job and a concurrent POST must not both bank the same day.
  select * into v_row from user_summary where user_id = p_user for update;
  if not found then
    return false;
  end if;

  v_today := focus_day(now(), v_row.timezone);
  if v_row.live_day >= v_today then
    return false; -- still the same focus-day; nothing to bank
  end if;

  -- Only write a row if something was actually earned. An empty day stays absent
  -- so it is excluded from the averages rather than counted as a zero.
  if v_row.live_focus <> 0 or v_row.live_distracted <> 0 then
    insert into daily_scores (user_id, day, focus_score, distracted_score)
    values (p_user, v_row.live_day, v_row.live_focus, v_row.live_distracted)
    on conflict (user_id, day) do update
      set focus_score      = excluded.focus_score,
          distracted_score = excluded.distracted_score,
          updated_at       = now();
  end if;

  update user_summary
  set live_focus = 0, live_distracted = 0, live_day = v_today, updated_at = now()
  where user_id = p_user;

  perform refresh_rollup(p_user);
  return true;
end;
$$;

-- ── roll_forward_due ──────────────────────────────────────────────────────────
-- The cron entry point: roll over every user whose focus-day has ended. Because
-- focus_day() already encodes the 01:00 boundary, "ended" is simply live_day <
-- today-in-their-timezone — no hour arithmetic here, and users in every timezone
-- are handled by the same hourly pass.
create or replace function public.roll_forward_due()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid;
  v_count integer := 0;
begin
  for v_user in
    select user_id from user_summary
    where live_day < focus_day(now(), timezone)
  loop
    if roll_forward(v_user) then
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

-- ── summary (read API) ────────────────────────────────────────────────────────
-- What the extension GETs. A view rather than the raw table so the wire format is
-- stable if the storage layout changes, and so `stale` can be derived: it is true
-- when the live score belongs to a focus-day that has already ended, i.e. the
-- numbers are pre-rollover. The client uses that to know a (0,0) POST is needed
-- before trusting the live figure.
create or replace view public.summary
with (security_invoker = true) as
select
  s.user_id,
  s.live_focus,
  s.live_distracted,
  s.live_day,
  s.d1_focus,  s.d1_distracted,
  s.d2_focus,  s.d2_distracted,
  s.d3_focus,  s.d3_distracted,
  s.avg7_focus,  s.avg7_distracted,
  s.avg30_focus, s.avg30_distracted,
  s.timezone,
  s.updated_at,
  (s.live_day < public.focus_day(now(), s.timezone)) as stale
from public.user_summary s;

comment on view public.summary is
  'Read API for the extension: live score, last 3 days, 7d/30d averages, plus a stale flag.';

grant select on public.summary to authenticated;
revoke all on public.summary from anon;

-- ── apply_score_delta ─────────────────────────────────────────────────────────
-- The extension's single write endpoint.
--
--   p_focus_delta       points earned since the last successful post (>= 0)
--   p_distracted_delta  points lost since the last successful post (<= 0)
--   p_timezone          IANA zone, so the 01:00 boundary is the user's own
--
-- Returns the whole summary as json, so a score update and a read are the same
-- round trip. The deltas are clamped to their legal sign here rather than trusted:
-- the client is the only caller today, but the invariant belongs to the database.
create or replace function public.apply_score_delta(
  p_focus_delta      numeric default 0,
  p_distracted_delta numeric default 0,
  p_timezone         text    default 'UTC'
)
returns json
language plpgsql
security invoker            -- RLS applies: a caller can only ever affect their own row
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_tz   text := coalesce(nullif(trim(p_timezone), ''), 'UTC');
  v_out  json;
begin
  if v_user is null then
    raise exception 'apply_score_delta: not authenticated' using errcode = '28000';
  end if;

  -- Reject an unknown timezone rather than silently banking days at the wrong
  -- hour: focus_day() would fall back to a zone the user never chose.
  begin
    perform now() at time zone v_tz;
  exception when others then
    v_tz := 'UTC';
  end;

  -- First contact for this user creates their row, dated to the focus-day they
  -- are currently in (not epoch), so nothing is banked for days before signup.
  insert into user_summary (user_id, live_day, timezone)
  values (v_user, focus_day(now(), v_tz), v_tz)
  on conflict (user_id) do update set timezone = excluded.timezone;

  -- Bank an overdue day BEFORE applying the delta, so points earned after 01:00
  -- land on the new day rather than being added to the day being closed.
  perform roll_forward(v_user);

  update user_summary set
    live_focus      = live_focus      + greatest(coalesce(p_focus_delta, 0), 0),
    live_distracted = live_distracted + least(coalesce(p_distracted_delta, 0), 0),
    updated_at      = now()
  where user_id = v_user;

  select to_json(s) into v_out from summary s where s.user_id = v_user;
  return v_out;
end;
$$;

-- Only a signed-in user may call it; anon has no business writing scores.
revoke all on function public.apply_score_delta(numeric, numeric, text) from anon, public;
grant execute on function public.apply_score_delta(numeric, numeric, text) to authenticated;

-- ── sync_domains ──────────────────────────────────────────────────────────────
-- Mirror the extension's whitelist. The extension owns the list, so this is a full
-- replace inside one transaction rather than a diff — a removed domain must
-- actually disappear, and a partial update would leave the server disagreeing with
-- the UI the user is looking at.
create or replace function public.sync_domains(p_domains text[])
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'sync_domains: not authenticated' using errcode = '28000';
  end if;

  delete from user_domains
  where user_id = v_user
    and domain <> all (coalesce(p_domains, '{}'));

  insert into user_domains (user_id, domain)
  select v_user, trim(d)
  from unnest(coalesce(p_domains, '{}')) as d
  where length(trim(d)) > 0
  on conflict (user_id, domain) do nothing;

  return (select count(*) from user_domains where user_id = v_user);
end;
$$;

revoke all on function public.sync_domains(text[]) from anon, public;
grant execute on function public.sync_domains(text[]) to authenticated;
