-- ═══════════════════════════════════════════════════════════════════════════════
--  DEMO SEED — fake participants, scores, teams and competitions
-- ═══════════════════════════════════════════════════════════════════════════════
--  NOT A MIGRATION, and deliberately not in supabase/migrations/: the GitHub
--  integration applies that folder to production on every push. This file only ever
--  runs when you paste it into the SQL editor yourself.
--
--  Run it as the SQL editor's default role (postgres). That bypasses RLS, which is
--  the only reason it can write rows belonging to users other than you.
--
--  WHAT IT BUILDS — the exact shape of your own example:
--
--      math_students    you + ada + bruno          ─┐
--      psycho_students  carla + dario + elif       ─┴─ competition: uni_cup
--      physics_students fatima + gio                   (no competition)
--
--  So the extension will show three sections: Personal, math_students, uni_cup.
--  physics_students is there on purpose as a NEGATIVE control: you are not in it and
--  it shares no competition with you, so build_teams() must never show it. If it
--  ever appears in the popup, the visibility boundary is broken.
--
--  IT ADDS YOUR REAL ACCOUNT to math_students. That is not incidental — without it
--  you would see nothing at all, because build_teams() only ever returns teams you
--  are a member of.
--
--  YOUR OWN SCORES ARE NOT TOUCHED unless you set c_seed_my_scores := true below.
--
--  Section 7 undoes everything. Read it before you run section 1.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ═══ 1–5. Build it ═════════════════════════════════════════════════════════════
do $seed$
declare
  -- ─── EDIT THESE ─────────────────────────────────────────────────────────────
  c_my_email        text    := 'andrea9roa9@gmail.com';  -- YOUR account. Must exist.
  c_timezone        text    := 'Europe/Rome';            -- drives the 01:00 boundary
  c_days            int     := 35;                       -- days of history per fake user
  c_seed_my_scores  boolean := false;                    -- true = overwrite YOUR scores too
  -- ────────────────────────────────────────────────────────────────────────────

  v_me    uuid;
  v_uid   uuid;
  v_live  date;
  v_day   date;
  v_focus numeric;
  v_dist  numeric;
  i       int;
  fake    record;
  member  record;
begin
  -- Your account, looked up by email rather than a pasted UUID so this stays correct
  -- if you ever sign in with a different one.
  select id into v_me from auth.users where email = c_my_email;
  if v_me is null then
    raise exception
      'No auth.users row for "%". Sign in through the extension once, then re-run.',
      c_my_email;
  end if;

  v_live := public.focus_day(now(), c_timezone);
  raise notice 'Seeding against focus-day % (timezone %)', v_live, c_timezone;

  -- ═══ 1. Fake participants ═══════════════════════════════════════════════════
  -- @example.com is reserved by RFC 2606 and can never reach a real inbox, so no
  -- stray password-reset mail can ever be delivered to a stranger.
  --
  -- These rows are display fixtures: encrypted_password is not a valid bcrypt hash,
  -- so NOBODY CAN SIGN IN AS THEM. There are no auth.identities rows either, which
  -- is what a real Google sign-in would create. If you want a fake account you can
  -- actually log into, do it through the Supabase dashboard's "Add user" instead.
  --
  -- `skill` shapes the numbers so the leaderboard has an obvious, checkable order:
  -- higher skill means more focus and less distraction.
  for fake in
    select * from (values
      ('ada@example.com',     0.95),
      ('bruno@example.com',   0.70),
      ('carla@example.com',   0.88),
      ('dario@example.com',   0.55),
      ('elif@example.com',    0.78),
      ('fatima@example.com',  0.62),
      ('gio@example.com',     0.40)
    ) as t(email, skill)
  loop
    select id into v_uid from auth.users where email = fake.email;

    if v_uid is null then
      v_uid := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email,
        encrypted_password, email_confirmed_at,
        created_at, updated_at,
        raw_app_meta_data, raw_user_meta_data,
        -- Empty strings, not NULL: GoTrue scans these into Go strings and a NULL
        -- makes the admin user list blow up.
        confirmation_token, recovery_token, email_change_token_new, email_change
      ) values (
        '00000000-0000-0000-0000-000000000000',
        v_uid, 'authenticated', 'authenticated', fake.email,
        'seed-only-not-a-valid-bcrypt-hash', now(),
        now() - (c_days || ' days')::interval, now(),
        '{"provider":"google","providers":["google"]}'::jsonb, '{}'::jsonb,
        '', '', '', ''
      );
      raise notice '  created % (%)', fake.email, v_uid;
    end if;

    -- ═══ 2. Live score ════════════════════════════════════════════════════════
    insert into public.user_summary (user_id, live_focus, live_distracted, live_day, timezone)
    values (
      v_uid,
      round((30 + random() * 50) * fake.skill),
      -round((4 + random() * 20) * (1.4 - fake.skill)),
      v_live,
      c_timezone
    )
    on conflict (user_id) do update set
      live_focus      = excluded.live_focus,
      live_distracted = excluded.live_distracted,
      live_day        = excluded.live_day,
      timezone        = excluded.timezone,
      updated_at      = now();

    -- ═══ 3. Daily history ═════════════════════════════════════════════════════
    -- Strictly BEFORE live_day: a row on live_day would be a completed day that is
    -- also still running, and refresh_rollup would exclude it from d1..d3 while the
    -- popup's charts counted it. Sundays are skipped so the "gaps shift the window
    -- instead of punching zeros into it" behaviour actually gets exercised.
    for i in 1..c_days loop
      v_day := v_live - i;
      continue when extract(dow from v_day)::int = 0;

      v_focus := round((40 + random() * 60) * fake.skill);
      v_dist  := -round((5 + random() * 25) * (1.4 - fake.skill));

      insert into public.daily_scores (user_id, day, focus_score, distracted_score)
      values (v_uid, v_day, v_focus, v_dist)
      on conflict (user_id, day) do update set
        focus_score      = excluded.focus_score,
        distracted_score = excluded.distracted_score,
        updated_at       = now();
    end loop;

    -- d1..d3 and the two averages are DERIVED. Computing them here by hand would let
    -- them contradict daily_scores; this is the same function the rollover uses.
    perform public.refresh_rollup(v_uid);

    -- A whitelist, so user_domains isn't empty when you look at the research export.
    insert into public.user_domains (user_id, domain)
    select v_uid, d
    from unnest(array['arxiv.org', 'overleaf.com', 'scholar.google.com', 'wikipedia.org']) as d
    on conflict (user_id, domain) do nothing;
  end loop;

  -- Optionally give your own account the same treatment.
  if c_seed_my_scores then
    insert into public.user_summary (user_id, live_focus, live_distracted, live_day, timezone)
    values (v_me, 55, -12, v_live, c_timezone)
    on conflict (user_id) do update set
      live_focus = excluded.live_focus, live_distracted = excluded.live_distracted,
      live_day = excluded.live_day, timezone = excluded.timezone, updated_at = now();

    for i in 1..c_days loop
      v_day := v_live - i;
      continue when extract(dow from v_day)::int = 0;
      insert into public.daily_scores (user_id, day, focus_score, distracted_score)
      values (v_me, v_day, round(45 + random() * 55), -round(6 + random() * 18))
      on conflict (user_id, day) do update set
        focus_score = excluded.focus_score,
        distracted_score = excluded.distracted_score,
        updated_at = now();
    end loop;
    perform public.refresh_rollup(v_me);
    raise notice '  seeded YOUR scores as well';
  end if;

  -- ═══ 4. Teams ═════════════════════════════════════════════════════════════════
  insert into public.teams (name, created_by) values
    ('math_students',    v_me),
    ('psycho_students',  (select id from auth.users where email = 'carla@example.com')),
    ('physics_students', (select id from auth.users where email = 'fatima@example.com'))
  on conflict (name) do nothing;

  -- Memberships. The (user_id, team) primary key makes a re-run idempotent for free.
  for member in
    select * from (values
      (c_my_email,            'math_students'),
      ('ada@example.com',     'math_students'),
      ('bruno@example.com',   'math_students'),
      ('carla@example.com',   'psycho_students'),
      ('dario@example.com',   'psycho_students'),
      ('elif@example.com',    'psycho_students'),
      ('fatima@example.com',  'physics_students'),
      ('gio@example.com',     'physics_students')
    ) as t(email, team)
  loop
    insert into public.team_members (user_id, team)
    select u.id, member.team from auth.users u where u.email = member.email
    on conflict (user_id, team) do nothing;
  end loop;

  -- ═══ 5. Competition ═══════════════════════════════════════════════════════════
  insert into public.competitions (name, created_by) values ('uni_cup', v_me)
  on conflict (name) do nothing;

  insert into public.team_competitions (team, competition, added_by) values
    ('math_students',   'uni_cup', v_me),
    ('psycho_students', 'uni_cup', (select id from auth.users where email = 'carla@example.com'))
  on conflict (team, competition) do nothing;
  -- physics_students is deliberately left out — see the header.

  raise notice 'Done. Reload the extension popup.';
end
$seed$;


-- ═══ 6. Verify ═════════════════════════════════════════════════════════════════

-- 6a. Who is where.
select t.name                         as team,
       coalesce(tc.competition, '—')  as competition,
       u.email,
       s.live_focus,
       s.live_distracted,
       s.live_focus + s.live_distracted as net,
       s.avg7_focus,
       s.avg30_focus
from public.teams t
left join public.team_competitions tc on tc.team = t.name
join public.team_members m            on m.team = t.name
join auth.users u                     on u.id = m.user_id
left join public.user_summary s       on s.user_id = m.user_id
order by t.name, net desc nulls last;

-- 6b. THE REAL TEST: exactly what the extension will render, for you.
--     set_config with is_local = true is transaction-scoped, so the BEGIN/COMMIT is
--     load-bearing — auth.uid() reads 'sub' out of this claim.
begin;
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  (select id from auth.users where email = 'andrea9roa9@gmail.com'),
    'role', 'authenticated'
  )::text,
  true
);
select jsonb_pretty(public.build_teams()::jsonb);
commit;

-- Expect: "teams" holds math_students only; "competitions" holds uni_cup with two
-- teams. physics_students must appear NOWHERE — if it does, the boundary leaks.


-- ═══ 7. Teardown ═══════════════════════════════════════════════════════════════
-- Removes every seeded row and leaves your real account untouched. Deleting the
-- auth.users rows cascades to user_summary, daily_scores, user_domains and
-- team_members, so the fake participants take their data with them.
--
-- Uncomment to run.
--
-- delete from public.team_competitions where competition = 'uni_cup';
-- delete from public.competitions       where name = 'uni_cup';
-- delete from public.team_members       where team in ('math_students','psycho_students','physics_students');
-- delete from public.teams              where name in ('math_students','psycho_students','physics_students');
-- delete from auth.users where email in (
--   'ada@example.com','bruno@example.com','carla@example.com','dario@example.com',
--   'elif@example.com','fatima@example.com','gio@example.com'
-- );
--
-- If you set c_seed_my_scores := true, this also clears the history it gave you:
-- delete from public.daily_scores where user_id = (select id from auth.users where email = 'andrea9roa9@gmail.com');
