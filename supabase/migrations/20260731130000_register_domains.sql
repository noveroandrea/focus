-- ─────────────────────────────────────────────────────────────────────────────
--  domain_flags becomes a registry of every known domain, not only flagged ones
-- ─────────────────────────────────────────────────────────────────────────────
--  Until now a row appeared in domain_flags the first time somebody flagged it. So
--  a domain nobody had objected to did not exist server-side at all, and there was
--  no way to ask "what are people whitelisting?" without scanning user_domains and
--  reassembling it. Now every whitelisted domain gets a row with flag_count 0 the
--  moment it is whitelisted.
--
--  Two paths write it, and they cover different failure modes:
--
--    1. THE WRITE PATH — apply_score_delta registers each domain as it saves the
--       user's whitelist. Immediate, and the normal case.
--    2. THE SWEEP — grant_weekly_flags backfills anything missing from user_domains.
--       This is the safety net: a domain that arrived before this migration, or
--       through some future path that forgets to register, still turns up.
--
--  The sweep lives in the weekly-flag job because that is what was asked for, but
--  note that job runs every 5 minutes (each pass only grants to users whose own week
--  has turned). So in practice the backfill is continuous, not weekly — which is
--  strictly better and costs nothing: it is one DISTINCT over user_domains with
--  ON CONFLICT DO NOTHING, and at study scale that is a few hundred rows.
--
--  ── CASE ─────────────────────────────────────────────────────────────────────
--  domain_flags is keyed on the domain text, and flag_domain has always lower-cased
--  its argument. user_domains did not — it stored trim(d) as given. In practice the
--  extension lower-cases everything it sends, so the two agreed by luck. Registering
--  domains makes that luck load-bearing: "ArXiv.org" in user_domains and "arxiv.org"
--  in domain_flags would be two rows that never join, and the profile would show a
--  flag count of 0 for a domain that had been flagged.
--
--  So normalisation is made explicit: apply_score_delta lower-cases once, up front,
--  and uses that same normalised array for the delete, the insert and the
--  registration — one definition of the list, three uses, no chance of the delete
--  predicate disagreeing with what was inserted.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Normalise what is already stored ──────────────────────────────────────────
-- Collisions first: if a user somehow has both "ArXiv.org" and "arxiv.org", lowering
-- the first would violate the (user_id, domain) primary key. Drop the un-normalised
-- duplicate and keep the one already in the right shape.
delete from public.user_domains a
where a.domain <> lower(btrim(a.domain))
  and exists (
    select 1 from public.user_domains b
    where b.user_id = a.user_id and b.domain = lower(btrim(a.domain))
  );

update public.user_domains
set domain = lower(btrim(domain))
where domain <> lower(btrim(domain));

-- ── Backfill the registry from what exists today ──────────────────────────────
insert into public.domain_flags (domain)
select distinct lower(btrim(d.domain))
from public.user_domains d
where length(btrim(d.domain)) > 0
on conflict (domain) do nothing;

-- ── register_domains ──────────────────────────────────────────────────────────
-- SECURITY DEFINER because domain_flags grants nothing to `authenticated` — the
-- table is reachable only through functions, and this is one of them. It writes no
-- user-specific data and reads none, so it needs no authorization check: the worst a
-- caller can do is assert that a domain string exists, which registering a whitelist
-- entry does anyway.
create or replace function public.register_domains(p_domains text[])
returns void
language sql
security definer
set search_path = public
as $$
  insert into domain_flags (domain)
  select distinct lower(btrim(d))
  from unnest(coalesce(p_domains, '{}'::text[])) as d
  where length(btrim(d)) > 0 and length(btrim(d)) <= 253
  on conflict (domain) do nothing;
$$;

revoke all on function public.register_domains(text[]) from anon, public;
grant execute on function public.register_domains(text[]) to authenticated;

-- ── apply_score_delta: normalise once, then delete / insert / register ────────
create or replace function public.apply_score_delta(
  p_focus_delta      numeric default 0,
  p_distracted_delta numeric default 0,
  p_timezone         text    default 'UTC',
  p_domains          text[]  default null   -- NULL = leave the whitelist untouched
)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_tz      text := coalesce(nullif(trim(p_timezone), ''), 'UTC');
  v_domains text[];
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

  insert into user_summary (user_id, live_day, timezone)
  values (v_user, focus_day(now(), v_tz), v_tz)
  on conflict (user_id) do update set timezone = excluded.timezone;

  -- SECURITY INVOKER, and user_flags grants nothing to `authenticated` — so this has
  -- to go through the DEFINER helper rather than writing the table directly.
  perform ensure_weekly_flag(v_tz);

  -- NO rollover here. Ending a day belongs to the cron job alone.
  update user_summary set
    live_focus      = live_focus      + greatest(coalesce(p_focus_delta, 0), 0),
    live_distracted = live_distracted + least(coalesce(p_distracted_delta, 0), 0),
    updated_at      = now()
  where user_id = v_user;

  -- Whitelist, only when the client is actually pushing one. NULL means "no edit",
  -- the case for nearly every call. An empty ARRAY is different and does clear it.
  if p_domains is not null then
    -- Normalised ONCE, then used for all three operations below. Deleting against
    -- the raw input while inserting the lower-cased form would make every mixed-case
    -- domain churn: deleted and re-added on every single post.
    select coalesce(array_agg(distinct lower(btrim(d))), '{}'::text[])
    into v_domains
    from unnest(p_domains) as d
    where length(btrim(d)) > 0;

    -- `<> all ('{}')` is true for every row, so an empty array clears the list —
    -- which is the documented meaning of an empty array, as distinct from NULL.
    delete from user_domains
    where user_id = v_user and domain <> all (v_domains);

    insert into user_domains (user_id, domain)
    select v_user, d from unnest(v_domains) as d
    on conflict (user_id, domain) do nothing;

    -- The registry. Every domain someone whitelists now exists server-side with a
    -- flag_count of 0, so it can be listed, counted and flagged without anyone
    -- having had to object to it first.
    perform register_domains(v_domains);
  end if;

  return build_state();
end;
$$;

revoke all on function public.apply_score_delta(numeric, numeric, text, text[]) from anon, public;
grant execute on function public.apply_score_delta(numeric, numeric, text, text[]) to authenticated;

-- ── grant_weekly_flags: sweep for unregistered domains ────────────────────────
create or replace function public.grant_weekly_flags()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- The safety net described in the header. Unconditional rather than gated on
  -- "somebody's week turned": gating would make it fire in bursts and buy nothing,
  -- since the work is a DISTINCT plus ON CONFLICT DO NOTHING either way.
  insert into domain_flags (domain)
  select distinct lower(btrim(d.domain))
  from user_domains d
  where length(btrim(d.domain)) > 0
  on conflict (domain) do nothing;

  with due as (
    select f.user_id,
           focus_week(now(), coalesce(s.timezone, 'UTC')) as wk
    from user_flags f
    left join user_summary s on s.user_id = f.user_id
  )
  update user_flags f
  -- SET to 1, never f.flag + 1. An unspent flag expires with its week; that is the
  -- whole point of the budget and the reason `flag` is constrained to 0 or 1.
  set flag       = 1,
      flag_week  = due.wk,
      updated_at = now()
  from due
  where due.user_id = f.user_id
    and due.wk > f.flag_week;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.grant_weekly_flags() from anon, authenticated, public;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- Every whitelisted domain should now have a registry row:
--
--   select count(*) as unregistered
--   from (select distinct lower(btrim(domain)) as d from public.user_domains) u
--   left join public.domain_flags f on f.domain = u.d
--   where f.domain is null;                       -- must be 0
--
-- And nothing should be stored un-normalised:
--
--   select count(*) from public.user_domains
--   where domain <> lower(btrim(domain));         -- must be 0
