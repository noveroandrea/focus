-- ─────────────────────────────────────────────────────────────────────────────
--  A per-user ceiling of 3 flags on any one domain
-- ─────────────────────────────────────────────────────────────────────────────
--  Two limits now sit on top of each other, and they do different jobs:
--
--    the weekly budget   how OFTEN one person can flag anything    (1 per week)
--    this ceiling        how far one person can push ONE domain    (3, ever)
--
--  Without the ceiling, a participant who spent every weekly flag on the same site
--  could reach 30 on it in a year on their own, and the tally would read as thirty
--  people objecting rather than one person objecting thirty times. Capping the
--  per-person contribution makes a high count mean BREADTH of objection, which is
--  the only reading worth collecting.
--
--  Other users are unaffected: each of them still has their own three. A domain's
--  total is therefore bounded by 3 × participants, not by anyone's persistence.
--
--  NO RACE TO GUARD. Counting existing rows and then inserting would normally be a
--  check-then-act window, but the weekly budget closes it: the single
--  `update user_flags ... where flag = 1` below serialises a user against themselves,
--  so two concurrent calls can never both reach the insert. One wins the flag, the
--  other raises and rolls back.
--
--  To change the ceiling, edit the literal in flag_domain AND the mirrored constant
--  in src/extension/popup/Popup.tsx — the server is authoritative, the client copy
--  only greys the button early.
-- ─────────────────────────────────────────────────────────────────────────────

-- Counting a user's flags on one domain is now a per-click query, so give it the
-- composite index rather than making it lean on the single-column ones.
create index if not exists domain_flag_events_domain_user_idx
  on public.domain_flag_events (domain, user_id);

create or replace function public.flag_domain(p_domain text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  c_max_per_domain constant integer := 3;   -- see the header before changing

  v_me    uuid    := auth.uid();
  v_dom   text    := lower(btrim(coalesce(p_domain, '')));
  v_tz    text;
  v_mine  integer;
  v_count integer;
begin
  if v_me is null then
    raise exception 'flag_domain: not authenticated' using errcode = '28000';
  end if;
  if length(v_dom) = 0 or length(v_dom) > 253 then
    raise exception 'Not a domain' using errcode = '22023';
  end if;

  -- The ceiling is checked BEFORE the weekly flag is spent. A raise would roll the
  -- spend back either way, but refusing first means the failure never depends on
  -- transaction semantics to avoid costing the user their week.
  select count(*) into v_mine
  from domain_flag_events
  where domain = v_dom and user_id = v_me;

  if v_mine >= c_max_per_domain then
    raise exception 'You have already flagged "%" % times, which is your limit for one domain',
      v_dom, c_max_per_domain using errcode = '23514';
  end if;

  select coalesce(timezone, 'UTC') into v_tz from user_summary where user_id = v_me;
  v_tz := coalesce(v_tz, 'UTC');

  -- A user who has never posted has no row yet; first contact starts them with a
  -- flag for the current week rather than making them wait for a Monday.
  insert into user_flags (user_id, flag, flag_week)
  values (v_me, 1, focus_week(now(), v_tz))
  on conflict (user_id) do nothing;

  -- The `flag = 1` predicate IS the check, and is also what serialises a user
  -- against themselves — see the header. Two clicks racing can only match this row
  -- once, so neither the budget nor the ceiling can be exceeded by concurrency.
  update user_flags
  set flag = 0, updated_at = now()
  where user_id = v_me and flag = 1;

  if not found then
    raise exception 'Your weekly red flag is already spent — you get another on Monday'
      using errcode = '55000';
  end if;

  insert into domain_flags (domain) values (v_dom) on conflict (domain) do nothing;
  insert into domain_flag_events (domain, user_id) values (v_dom, v_me);

  update domain_flags
  set flag_count = (select count(*) from domain_flag_events where domain = v_dom),
      updated_at = now()
  where domain = v_dom
  returning flag_count into v_count;

  return json_build_object(
    'domain',         v_dom,
    'flag_count',     v_count,
    -- The caller's own tally after this flag, so the client can grey the button at
    -- the ceiling without re-fetching the profile.
    'my_flags',       v_mine + 1,
    'max_per_domain', c_max_per_domain,
    'flag_available', false                 -- always: reaching here spent the week's
  );
end;
$$;

revoke all on function public.flag_domain(text) from anon, public;
grant execute on function public.flag_domain(text) to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- Four flags on one domain across four weeks: the fourth must raise 23514, while a
-- different domain in that same week still works.
--
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<your-uuid>','role','authenticated')::text, true);
--   -- reset the weekly budget between calls to simulate a new week:
--   update public.user_flags set flag = 1 where user_id = '<your-uuid>';
--   select public.flag_domain('youtube.com');   -- my_flags 1
--   update public.user_flags set flag = 1 where user_id = '<your-uuid>';
--   select public.flag_domain('youtube.com');   -- my_flags 2
--   update public.user_flags set flag = 1 where user_id = '<your-uuid>';
--   select public.flag_domain('youtube.com');   -- my_flags 3
--   update public.user_flags set flag = 1 where user_id = '<your-uuid>';
--   select public.flag_domain('youtube.com');   -- ERROR 23514
--   rollback;
