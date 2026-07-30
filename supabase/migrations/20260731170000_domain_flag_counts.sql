-- ─────────────────────────────────────────────────────────────────────────────
--  Flag tallies for your own whitelist
-- ─────────────────────────────────────────────────────────────────────────────
--  The Allowed Pages list in the popup shows how many red flags each of your own
--  domains has collected. build_state already sent `domains`, but as a bare array of
--  strings.
--
--  That array is deliberately LEFT ALONE. It is not a display list — the extension
--  writes it straight into Settings.allowedDomains, which heartbeat.ts reads
--  synchronously on every page load to decide whether to activate at all. Changing
--  its shape to carry counts would ripple into the one code path that has to work
--  offline, instantly, before any request could return.
--
--  So the tallies travel alongside, in their own key. Same data, two shapes, each
--  serving the consumer that needs it — cheaper than teaching the whitelist cache
--  about a field it will never use.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.build_state()
returns json
language sql
security invoker
set search_path = public
as $$
  with t as (select build_teams() as j)
  select json_build_object(
    'summary', (select to_json(s) from summary s where s.user_id = auth.uid()),

    -- The whitelist cache. Strings, ordered, unchanged — see the header.
    'domains', coalesce(
      (select json_agg(domain order by domain)
       from user_domains where user_id = auth.uid()),
      '[]'::json),

    -- The same domains with their GLOBAL flag tally, for display only. LEFT JOIN
    -- rather than INNER: a domain whitelisted a moment ago may not have reached
    -- domain_flags yet if the registering write and this read interleave, and it
    -- should read as 0 rather than vanish from your own list.
    'domain_flags', coalesce(
      (select json_agg(json_build_object(
                'domain',     d.domain,
                'flag_count', coalesce(f.flag_count, 0)) order by d.domain)
       from user_domains d
       left join domain_flags f on f.domain = d.domain
       where d.user_id = auth.uid()),
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
    'flag', json_build_object(
      'available', coalesce((select flag from user_flags where user_id = auth.uid()), 1) = 1
    )
  )
  from t;
$$;

revoke all on function public.build_state() from anon, public;
grant execute on function public.build_state() to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<your-uuid>','role','authenticated')::text, true);
--   select jsonb_pretty((public.build_state()::jsonb) -> 'domain_flags');
--   commit;
--
-- Every entry in 'domains' must appear in 'domain_flags' with a count.
