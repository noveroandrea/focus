-- ─────────────────────────────────────────────────────────────────────────────
--  Red flags for whitelisted PROGRAMS, spending the same weekly budget
-- ─────────────────────────────────────────────────────────────────────────────
--  A participant may now object to "code" or "steam" exactly as they can object to
--  "youtube.com", and the same single weekly flag pays for either. One budget, two
--  kinds of target: user_flags is untouched by this migration precisely because it
--  already works for both — it counts how OFTEN you may object, never to what.
--
--  ── WHY PARALLEL TABLES AND NOT A `kind` COLUMN ─────────────────────────────
--  The obvious design is `domain_flags(kind, domain)` and `user_domains(user_id,
--  kind, domain)`. It was rejected for one specific reason, not for taste:
--
--    build_state()'s `domains` array is written STRAIGHT INTO
--    Settings.allowedDomains, which heartbeat.ts substring-matches against every
--    URL on every page load.
--
--  With a kind column, every read of user_domains needs `where kind = 'domain'`,
--  and the day one of them is forgotten a program identifier lands in the page
--  whitelist. That failure is silent and absurd: `code` as a whitelist entry
--  matches vscode.dev, qrcode.com, and any URL anywhere containing those four
--  letters, so the extension would start counting random browsing as work with no
--  visible cause. Separate tables make that class of bug unrepresentable rather
--  than merely unlikely, at the cost of some duplicated function bodies — a trade
--  this schema has made before (competition_members vs team_competitions).
--
--  ── NORMALISATION ───────────────────────────────────────────────────────────
--  A program identifier is matched EXACTLY by the extension, through
--  normaliseProgram() in src/extension/agent.ts: trim, lower-case, drop a trailing
--  ".exe" so a rule written as `Code.exe` still matches what Windows reports. That
--  normalisation is reproduced here as focus_program(), and everything that writes
--  or looks up a program goes through it. If the two ever disagree, `Code.exe` and
--  `code` become two registry rows that never join and a flagged program shows a
--  tally of 0 — the exact bug the lower-casing of user_domains was written to fix
--  (see 20260731130000_register_domains.sql).
--
--  ── THE CROSS-PLATFORM CAVEAT ───────────────────────────────────────────────
--  Program identifiers are platform-specific (`code` on Linux, `com.microsoft.
--  VSCode` on macOS, `code.exe` on Windows), while the sync model is "the server is
--  the source of truth, the client cache is overwritten by every reply". A user with
--  two machines of different OSes will therefore see each machine's list replaced by
--  the other's. That is deliberate and matches user_domains rather than inventing a
--  second rule: a union would make deletion impossible to propagate, which is worse
--  and much harder to explain. Foreign entries are inert — they simply never match
--  the local platform's identifiers.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── The normaliser ────────────────────────────────────────────────────────────
-- IMMUTABLE so it may be used in an index expression later if the registry ever
-- needs one; STRICT so a null in is a null out rather than an empty string.
create or replace function public.focus_program(p_raw text)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select regexp_replace(lower(btrim(p_raw)), '\.exe$', '');
$$;

comment on function public.focus_program is
  'Canonical form of a program identifier. Mirrors normaliseProgram() in src/extension/agent.ts — change both or neither.';

-- ── user_programs ─────────────────────────────────────────────────────────────
-- The user's program whitelist, mirrored from Settings.allowedPrograms. Full
-- replace on sync, exactly like user_domains, so there is no ordering column.
create table if not exists public.user_programs (
  user_id  uuid        not null references auth.users(id) on delete cascade,
  program  text        not null check (length(btrim(program)) > 0),
  added_at timestamptz not null default now(),
  primary key (user_id, program)
);

comment on table public.user_programs is
  'Per-user whitelist of foreground programs that count as work, mirrored from the extension settings.';

-- The index that makes the incremental registry sweep a range scan, not a seq scan.
create index if not exists user_programs_added_at_idx on public.user_programs (added_at);

alter table public.user_programs enable row level security;

drop policy if exists user_programs_own on public.user_programs;
create policy user_programs_own on public.user_programs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.user_programs from anon;
grant select, insert, update, delete on public.user_programs to authenticated;

-- ── The registry and its ledger ───────────────────────────────────────────────
-- Same shape and same rules as domain_flags / domain_flag_events: a GLOBAL registry
-- of every known program with a running tally, recomputed from an append-only
-- ledger rather than incremented, so the counter can never drift from the events
-- that justify it.
create table if not exists public.program_flags (
  program    text primary key check (length(btrim(program)) > 0),
  flag_count integer     not null default 0 check (flag_count >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.program_flag_events (
  id         bigserial   primary key,
  program    text        not null references public.program_flags(program) on delete cascade,
  user_id    uuid        not null references auth.users(id) on delete cascade,
  flagged_at timestamptz not null default now()
);

comment on table public.program_flags is
  'Global red-flag count per program. Written only by flag_program(); recomputed from program_flag_events, never incremented.';

create index if not exists program_flag_events_program_idx      on public.program_flag_events (program);
create index if not exists program_flag_events_user_idx         on public.program_flag_events (user_id);
-- The per-click "how many have I spent on this one?" query — see the ceiling below.
create index if not exists program_flag_events_program_user_idx on public.program_flag_events (program, user_id);

-- Reached exclusively through the SECURITY DEFINER functions below, so no client
-- gets table rights at all. RLS on with no policy is the deny-all backstop.
alter table public.program_flags       enable row level security;
alter table public.program_flag_events enable row level security;

revoke all on public.program_flags       from anon, authenticated;
revoke all on public.program_flag_events from anon, authenticated;

-- ── register_programs ─────────────────────────────────────────────────────────
-- SECURITY DEFINER for the same reason register_domains is: program_flags grants
-- nothing to `authenticated`. It writes no user-specific data and reads none, so it
-- needs no authorization check — the worst a caller can do is assert that a program
-- name exists, which whitelisting one does anyway.
create or replace function public.register_programs(p_programs text[])
returns void
language sql
security definer
set search_path = public
as $$
  insert into program_flags (program)
  select distinct focus_program(p)
  from unnest(coalesce(p_programs, '{}'::text[])) as p
  where length(focus_program(p)) > 0 and length(focus_program(p)) <= 128
  on conflict (program) do nothing;
$$;

revoke all on function public.register_programs(text[]) from anon, public;
grant execute on function public.register_programs(text[]) to authenticated;

-- ── flag_program ──────────────────────────────────────────────────────────────
-- flag_domain's twin, and deliberately a copy rather than a shared body: the two
-- write different tables and the duplication is ~20 lines, while a generic
-- "flag(kind, target)" would have to take the kind from the client and dispatch on
-- it, which is exactly the shape that lets a program be written into the domain
-- registry. Both limits are enforced here, and only one of them is new:
--
--   the weekly budget   how OFTEN one person may flag anything   (user_flags, SHARED
--                       with flag_domain — one flag a week, spend it on either kind)
--   the ceiling         how far one person may push ONE program  (3, ever)
--
-- The ceiling is per program and independent of the domain ceiling: three on
-- `youtube.com` and three on `steam` are six objections to six different things,
-- which is the reading the tally is collected for.
create or replace function public.flag_program(p_program text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  c_max_per_program constant integer := 3;   -- mirrors flag_domain's ceiling

  v_me    uuid    := auth.uid();
  v_prog  text    := focus_program(coalesce(p_program, ''));
  v_tz    text;
  v_mine  integer;
  v_count integer;
begin
  if v_me is null then
    raise exception 'flag_program: not authenticated' using errcode = '28000';
  end if;
  if v_prog is null or length(v_prog) = 0 or length(v_prog) > 128 then
    raise exception 'Not a program' using errcode = '22023';
  end if;

  -- Checked BEFORE the weekly flag is spent, so refusing never depends on
  -- transaction semantics to avoid costing the user their week.
  select count(*) into v_mine
  from program_flag_events
  where program = v_prog and user_id = v_me;

  if v_mine >= c_max_per_program then
    raise exception 'You have already flagged "%" % times, which is your limit for one program',
      v_prog, c_max_per_program using errcode = '23514';
  end if;

  select coalesce(timezone, 'UTC') into v_tz from user_summary where user_id = v_me;
  v_tz := coalesce(v_tz, 'UTC');

  insert into user_flags (user_id, flag, flag_week)
  values (v_me, 1, focus_week(now(), v_tz))
  on conflict (user_id) do nothing;

  -- The same `flag = 1` predicate flag_domain uses, and the same reason it is not a
  -- check-then-act race: it serialises a user against themselves, so two concurrent
  -- calls — even one of each kind — can never both reach the insert below.
  update user_flags
  set flag = 0, updated_at = now()
  where user_id = v_me and flag = 1;

  if not found then
    raise exception 'Your weekly red flag is already spent — you get another on Monday'
      using errcode = '55000';
  end if;

  insert into program_flags (program) values (v_prog) on conflict (program) do nothing;
  insert into program_flag_events (program, user_id) values (v_prog, v_me);

  update program_flags
  set flag_count = (select count(*) from program_flag_events where program = v_prog),
      updated_at = now()
  where program = v_prog
  returning flag_count into v_count;

  return json_build_object(
    'program',         v_prog,
    'flag_count',      v_count,
    'my_flags',        v_mine + 1,
    'max_per_program', c_max_per_program,
    'flag_available',  false                -- always: reaching here spent the week's
  );
end;
$$;

revoke all on function public.flag_program(text) from anon, public;
grant execute on function public.flag_program(text) to authenticated;

-- ── apply_score_delta: carry the program list too ─────────────────────────────
-- DROPPED and recreated rather than given a defaulted 5th parameter on top of the
-- 4-parameter version. PostgREST resolves an RPC by the set of named arguments it
-- was sent, so leaving both signatures in place would make the existing 4-argument
-- call ambiguous — "function is not unique" — for every client currently posting.
drop function if exists public.apply_score_delta(numeric, numeric, text, text[]);

create or replace function public.apply_score_delta(
  p_focus_delta      numeric default 0,
  p_distracted_delta numeric default 0,
  p_timezone         text    default 'UTC',
  p_domains          text[]  default null,  -- NULL = leave the page whitelist untouched
  p_programs         text[]  default null   -- NULL = leave the program whitelist untouched
)
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_tz       text := coalesce(nullif(trim(p_timezone), ''), 'UTC');
  v_domains  text[];
  v_programs text[];
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

  -- Page whitelist, only when the client is actually pushing one. NULL means "no
  -- edit", the case for nearly every call. An empty ARRAY is different and clears it.
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

    perform register_domains(v_domains);
  end if;

  -- Program whitelist. Identical rules, separate list, separate registry — see the
  -- header for why these are two tables and not one with a `kind`.
  if p_programs is not null then
    select coalesce(array_agg(distinct focus_program(p)), '{}'::text[])
    into v_programs
    from unnest(p_programs) as p
    where length(focus_program(p)) > 0;

    delete from user_programs
    where user_id = v_user and program <> all (v_programs);

    insert into user_programs (user_id, program)
    select v_user, p from unnest(v_programs) as p
    on conflict (user_id, program) do nothing;

    perform register_programs(v_programs);
  end if;

  return build_state();
end;
$$;

revoke all on function public.apply_score_delta(numeric, numeric, text, text[], text[]) from anon, public;
grant execute on function public.apply_score_delta(numeric, numeric, text, text[], text[]) to authenticated;

-- ── build_flags: the caller's own tallies, both kinds ─────────────────────────
create or replace function public.build_flags()
returns json
language sql
security definer            -- reads user_flags / *_flags, all client-inaccessible
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

    -- The same, for programs. LEFT JOIN for the same reason: a program whitelisted a
    -- moment ago may not have reached the registry yet if the registering write and
    -- this read interleave, and it must read as 0 rather than vanish from the list.
    'programs', coalesce(
      (select json_agg(json_build_object(
                'program',    p.program,
                'flag_count', coalesce(f.flag_count, 0)) order by p.program)
       from user_programs p
       left join program_flags f on f.program = p.program
       where p.user_id = auth.uid()),
      '[]'::json),

    -- coalesce(..., 1): a user with no row has never spent anything, so "available"
    -- is the truthful default — and either flag_* creates the row on the way past.
    'flag', json_build_object(
      'available', coalesce((select flag from user_flags where user_id = auth.uid()), 1) = 1
    )
  );
$$;

comment on function public.build_flags is
  'The caller''s own flag budget and per-target tallies, domains and programs. SECURITY DEFINER with no arguments: the caller is auth.uid() and cannot be spoofed.';

revoke all on function public.build_flags() from anon, public;
grant execute on function public.build_flags() to authenticated;

-- ── build_state: the program whitelist travels like the page one ──────────────
-- `programs` is a bare array for the same reason `domains` is: the extension writes
-- it straight into Settings.allowedPrograms, which is read synchronously while
-- deciding whether the foreground program counts. The tallies travel beside it in
-- `program_flags`, for display only.
create or replace function public.build_state()
returns json
language sql
security invoker
set search_path = public
as $$
  with f as (select build_flags() as j)
  select json_build_object(
    'summary', (select to_json(s) from summary s where s.user_id = auth.uid()),

    'domains', coalesce(
      (select json_agg(domain order by domain)
       from user_domains where user_id = auth.uid()),
      '[]'::json),

    'programs', coalesce(
      (select json_agg(program order by program)
       from user_programs where user_id = auth.uid()),
      '[]'::json),

    'my_teams', coalesce(
      (select json_agg(tm.team order by tm.team)
       from team_members tm where tm.user_id = auth.uid()),
      '[]'::json),

    -- Where you compete as yourself.
    'my_competitions', coalesce(
      (select json_agg(cm.competition order by cm.competition)
       from competition_members cm where cm.user_id = auth.uid()),
      '[]'::json),

    -- Where one of your teams competes. Separate array, so the popup can show the
    -- same competition twice — once per entry — which is what having two entries
    -- looks like.
    'my_team_competitions', coalesce(
      (select json_agg(json_build_object('competition', tc.competition, 'team', tc.team)
                       order by tc.competition, tc.team)
       from team_competitions tc
       join team_members tm on tm.team = tc.team
       where tm.user_id = auth.uid()),
      '[]'::json),

    'friend_requests', (select count(*) from friendships
                        where addressee = auth.uid() and status = 'pending'),

    'domain_flags',  f.j -> 'domains',
    'program_flags', f.j -> 'programs',
    'flag',          f.j -> 'flag'
  )
  from f;
$$;

revoke all on function public.build_state() from anon, public;
grant execute on function public.build_state() to authenticated;

-- ── get_member_profile: another participant's programs, and their tallies ─────
-- Still the one function that takes a user_id, and still safe only because of the
-- can_see_user() check below. Adding programs widens what a visible participant
-- discloses: their page whitelist was already the schema's most sensitive
-- peer-to-peer exposure, and the list of applications they work in belongs in the
-- same sentence of the consent form.
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

  -- THE authorization check, covering teams AND friends. See can_see_user.
  if not can_see_user(p_user) then
    raise exception 'That participant is not visible to you' using errcode = '42501';
  end if;

  return (
    select json_build_object(
      'user_id',      p_user,
      'display_name', coalesce(nullif(split_part(u.email, '@', 1), ''), 'participant'),
      'is_self',      p_user = v_me,

      'friend_status', case
        when p_user = v_me then 'self'
        when exists (select 1 from friendships f
                     where f.status = 'accepted'
                       and ((f.requester = v_me and f.addressee = p_user)
                         or (f.addressee = v_me and f.requester = p_user))) then 'friends'
        when exists (select 1 from friendships f
                     where f.requester = v_me and f.addressee = p_user) then 'sent'
        when exists (select 1 from friendships f
                     where f.addressee = v_me and f.requester = p_user) then 'received'
        else 'none' end,

      'live_focus',       coalesce(s.live_focus, 0),
      'live_distracted',  coalesce(s.live_distracted, 0),
      'avg7_focus',       coalesce(s.avg7_focus, 0),
      'avg7_distracted',  coalesce(s.avg7_distracted, 0),
      'avg30_focus',      coalesce(s.avg30_focus, 0),
      'avg30_distracted', coalesce(s.avg30_distracted, 0),

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

      'domains', coalesce((
        select json_agg(json_build_object(
                 'domain',     d.domain,
                 'flag_count', coalesce(f.flag_count, 0),
                 'my_flags',   (select count(*) from domain_flag_events w
                                where w.domain = d.domain and w.user_id = v_me)
               ) order by coalesce(f.flag_count, 0) desc, d.domain)
        from user_domains d
        left join domain_flags f on f.domain = d.domain
        where d.user_id = p_user), '[]'::json),

      -- Ordered the same way: loudest objection first, then alphabetically. `my_flags`
      -- is what greys the button at the ceiling without a second round trip.
      'programs', coalesce((
        select json_agg(json_build_object(
                 'program',    p.program,
                 'flag_count', coalesce(f.flag_count, 0),
                 'my_flags',   (select count(*) from program_flag_events w
                                where w.program = p.program and w.user_id = v_me)
               ) order by coalesce(f.flag_count, 0) desc, p.program)
        from user_programs p
        left join program_flags f on f.program = p.program
        where p.user_id = p_user), '[]'::json)
    )
    from auth.users u
    left join user_summary s on s.user_id = p_user
    where u.id = p_user
  );
end;
$$;

revoke all on function public.get_member_profile(uuid) from anon, public;
grant execute on function public.get_member_profile(uuid) to authenticated;

-- ── The registry sweeps ───────────────────────────────────────────────────────
-- Both halves of the safety net domains already have, for the same reasons: the
-- write path (apply_score_delta → register_programs) is the normal case, and these
-- catch anything that arrived before this migration or through some future path
-- that forgets to register.
create or replace function public.register_new_programs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Same rewind as the domain sweep: a row whose added_at was stamped at statement
  -- start but whose transaction committed later would otherwise fall into the gap
  -- between two passes and never be swept.
  c_overlap constant interval := interval '10 minutes';

  v_since timestamptz;
  v_now   timestamptz := now();
  v_count integer;
begin
  select ts into v_since from maintenance_state where key = 'program_registry_swept_at';
  v_since := coalesce(v_since, '-infinity'::timestamptz);

  insert into program_flags (program)
  select distinct focus_program(p.program)
  from user_programs p
  where p.added_at >= v_since
    and length(focus_program(p.program)) between 1 and 128
  on conflict (program) do nothing;

  get diagnostics v_count = row_count;

  insert into maintenance_state (key, ts)
  values ('program_registry_swept_at', v_now - c_overlap)
  on conflict (key) do update set ts = excluded.ts, updated_at = now();

  return v_count;
end;
$$;

revoke all on function public.register_new_programs() from anon, authenticated, public;

create or replace function public.register_all_programs()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into program_flags (program)
  select distinct focus_program(p.program)
  from user_programs p
  where length(focus_program(p.program)) between 1 and 128
  on conflict (program) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.register_all_programs() from anon, authenticated, public;

-- ── grant_weekly_flags: sweep both registries ─────────────────────────────────
-- Unchanged except for the second sweep. Still the */5 job, still bounded by the
-- same prefilter — see 20260731150000_scale_maintenance_jobs.sql for why UTC+14 is
-- a safe upper bound and why this cadence is a correctness property.
create or replace function public.grant_weekly_flags()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_wk date := focus_week(now() + interval '14 hours', 'UTC');
  v_count  integer;
begin
  -- Both incremental, both watermarked, both cheap: only rows added since the last
  -- pass. The program list is far smaller than the domain list, so this is the
  -- lesser half of an already-small job.
  perform register_new_domains();
  perform register_new_programs();

  with due as (
    select f.user_id,
           focus_week(now(), coalesce(s.timezone, 'UTC')) as wk
    from user_flags f
    left join user_summary s on s.user_id = f.user_id
    where f.flag_week < v_max_wk
  )
  update user_flags f
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

-- ── Schedule ──────────────────────────────────────────────────────────────────
-- The daily full backstop, two minutes after the domain one so the two never share
-- a tick. Unscheduled first so re-running this migration cannot stack duplicates.
select cron.unschedule('focus-program-registry')
where exists (select 1 from cron.job where jobname = 'focus-program-registry');

select cron.schedule('focus-program-registry', '19 3 * * *',
                     $cron$ select public.register_all_programs(); $cron$);

-- ── Verify ────────────────────────────────────────────────────────────────────
-- 1. The budget really is shared. The second call must raise 55000 whichever order
--    the two kinds are called in:
--
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<your-uuid>','role','authenticated')::text, true);
--   update public.user_flags set flag = 1 where user_id = '<your-uuid>';
--   select public.flag_program('steam');        -- ok, my_flags 1
--   select public.flag_domain('youtube.com');   -- ERROR 55000 — same week's flag
--   rollback;
--
-- 2. The ceilings are independent — three on a program does not block a domain:
--
--   (repeat flag_program('steam') three times, resetting the weekly flag between)
--   select public.flag_program('steam');        -- ERROR 23514 on the fourth
--
-- 3. Normalisation agrees with the extension:
--
--   select public.focus_program('  Code.EXE ');            -- 'code'
--   select public.focus_program('com.microsoft.VSCode');   -- 'com.microsoft.vscode'
--
-- 4. The whitelists stay separate. After posting both lists, neither array may
--    contain the other's entries — this is the failure the parallel tables exist to
--    make impossible:
--
--   select public.build_state()::jsonb -> 'domains';
--   select public.build_state()::jsonb -> 'programs';
