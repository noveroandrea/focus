-- ─────────────────────────────────────────────────────────────────────────────
--  Friends
-- ─────────────────────────────────────────────────────────────────────────────
--  A second way to see other participants, alongside teams: a mutual, per-person
--  link that both sides have to agree to. The Friends section renders exactly like a
--  team board — live / 7-day / 30-day, same plots — but its membership is your
--  accepted friendships.
--
--  ── ONE ROW PER REQUEST, NOT PER FRIENDSHIP ─────────────────────────────────
--  friendships is directional: (requester, addressee) with a status. Friendship
--  itself is symmetric once accepted, so every read has to look both ways — but a
--  REQUEST is inherently one-directional, and storing it as such is what makes
--  "pending in" and "pending out" different states instead of one ambiguous row.
--  The composite primary key stops A asking B twice; the reverse direction is
--  handled explicitly (see send_friend_request), because B asking A while A→B is
--  already pending is not a duplicate — it is agreement, and it accepts.
--
--  ── THE VISIBILITY BOUNDARY GROWS ───────────────────────────────────────────
--  Until now "who may see whom" was visible_teams() alone. Friends add a second
--  route, so the rule moves up into can_see_user(), and get_member_profile switches
--  to it. That keeps the property the earlier migrations fought for: ONE definition,
--  so the thing that authorizes and the things that display cannot disagree.
--
--  ── USER SEARCH IS A DISCLOSURE, AND IS FENCED ──────────────────────────────
--  Adding a friend needs a way to find them, which means letting any signed-in user
--  query other users. That is unavoidable for the feature and worth naming:
--
--    • minimum 3 characters, so nobody can pass '' and enumerate the study;
--    • at most 10 results;
--    • matches the email's LOCAL PART only — you cannot search '@unipd.it' and
--      harvest an institution;
--    • returns the local part and the id, NEVER the full email.
--
--  So a searcher learns "someone called andrea9roa9 exists" and nothing more until
--  that person accepts. Put it in the consent form alongside the profile disclosure.
--
--  Friends lists are small — tens, not thousands — so this board is ranked live
--  rather than materialised. The 1-minute rank tables exist because competitions
--  reach 10,000; sorting 30 friends per request is cheaper than maintaining a fourth
--  table for them.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.friendships (
  requester    uuid        not null references auth.users(id) on delete cascade,
  addressee    uuid        not null references auth.users(id) on delete cascade,
  status       text        not null default 'pending' check (status in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  primary key (requester, addressee),
  constraint friendships_no_self check (requester <> addressee)
);

comment on table public.friendships is
  'Directional friend requests; symmetric once status = accepted. Read both ways.';

-- The primary key covers (requester, …); the addressee direction needs its own index
-- because every "who has asked me?" and every friend lookup travels it.
create index if not exists friendships_addressee_idx on public.friendships (addressee, status);
create index if not exists friendships_requester_idx on public.friendships (requester, status);

alter table public.friendships enable row level security;

-- You may read any row you are part of — that is your outgoing requests, your
-- incoming ones, and your friendships. Writes go through the functions below, which
-- have to enforce rules RLS cannot express (accepting a reverse-pending request).
drop policy if exists friendships_own on public.friendships;
create policy friendships_own on public.friendships
  for select to authenticated
  using (requester = auth.uid() or addressee = auth.uid());

revoke all on public.friendships from anon;
grant select on public.friendships to authenticated;

-- ── The visibility boundary, now with two routes ──────────────────────────────
-- Replaces the bare visible_teams() check that get_member_profile used to inline.
-- STABLE, not IMMUTABLE: it reads tables.
create or replace function public.can_see_user(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- Yourself, always.
    p_user = auth.uid()
    -- Anyone in a team you can see: yours, or one sharing a competition with yours.
    or exists (
      select 1 from team_members m
      join visible_teams() v on v.team = m.team
      where m.user_id = p_user)
    -- An accepted friend, in either direction. `status = 'accepted'` is what makes a
    -- pending request show nothing: asking to see someone is not permission to.
    or exists (
      select 1 from friendships f
      where f.status = 'accepted'
        and ((f.requester = auth.uid() and f.addressee = p_user)
          or (f.addressee = auth.uid() and f.requester = p_user)));
$$;

comment on function public.can_see_user is
  'The single definition of whether the caller may see another participant''s data. Everything that exposes one user to another goes through this.';

revoke all on function public.can_see_user(uuid) from anon, public;
grant execute on function public.can_see_user(uuid) to authenticated;

-- ── Searching for someone to add ──────────────────────────────────────────────
create or replace function public.search_users(p_query text, p_limit int default 10)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_q     text := lower(btrim(coalesce(p_query, '')));
  v_limit int  := least(greatest(coalesce(p_limit, 10), 1), 10);
begin
  if v_me is null then
    raise exception 'search_users: not authenticated' using errcode = '28000';
  end if;
  -- The fence. Without a minimum the empty string returns the study.
  if length(v_q) < 3 then
    return '[]'::json;
  end if;

  return coalesce((
    select json_agg(json_build_object(
             'user_id',      t.id,
             'display_name', t.local_part,
             -- What the caller can do about this person, so the button can say it
             -- rather than making them find out by pressing it.
             'status', case
               when exists (select 1 from friendships f
                            where f.status = 'accepted'
                              and ((f.requester = v_me and f.addressee = t.id)
                                or (f.addressee = v_me and f.requester = t.id)))
                 then 'friends'
               when exists (select 1 from friendships f
                            where f.requester = v_me and f.addressee = t.id) then 'sent'
               when exists (select 1 from friendships f
                            where f.addressee = v_me and f.requester = t.id) then 'received'
               else 'none' end
           ) order by t.local_part)
    from (
      select u.id, split_part(u.email, '@', 1) as local_part
      from auth.users u
      where u.id <> v_me
        and u.email is not null
        -- Local part only: '@unipd.it' must not harvest an institution.
        and split_part(lower(u.email), '@', 1) like '%' || v_q || '%'
      order by split_part(lower(u.email), '@', 1)
      limit v_limit
    ) t), '[]'::json);
end;
$$;

revoke all on function public.search_users(text, int) from anon, public;
grant execute on function public.search_users(text, int) to authenticated;

-- ── Sending, answering, ending ────────────────────────────────────────────────
create or replace function public.send_friend_request(p_user uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'send_friend_request: not authenticated' using errcode = '28000';
  end if;
  if p_user is null or p_user = v_me then
    raise exception 'You cannot add yourself' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'No such participant' using errcode = '23503';
  end if;

  -- They already asked you: this is agreement, not a second request. Accepting the
  -- existing row rather than creating a mirrored one keeps a friendship exactly one
  -- row, whichever order the two people happened to press the button in.
  update friendships
  set status = 'accepted', responded_at = now()
  where requester = p_user and addressee = v_me and status = 'pending';
  if found then
    return json_build_object('status', 'friends');
  end if;

  insert into friendships (requester, addressee)
  values (v_me, p_user)
  on conflict (requester, addressee) do nothing;

  return json_build_object(
    'status',
    (select case when status = 'accepted' then 'friends' else 'sent' end
     from friendships where requester = v_me and addressee = p_user));
end;
$$;

revoke all on function public.send_friend_request(uuid) from anon, public;
grant execute on function public.send_friend_request(uuid) to authenticated;

create or replace function public.respond_friend_request(p_requester uuid, p_accept boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'respond_friend_request: not authenticated' using errcode = '28000';
  end if;

  if p_accept then
    -- `addressee = v_me` is what stops anyone accepting on someone else's behalf.
    -- SECURITY DEFINER bypasses RLS, so this predicate is the whole control.
    update friendships
    set status = 'accepted', responded_at = now()
    where requester = p_requester and addressee = v_me and status = 'pending';
    if not found then
      raise exception 'No pending request from that participant' using errcode = '23503';
    end if;
    return json_build_object('status', 'friends');
  end if;

  -- Declining deletes rather than marking, so the requester may ask again later. A
  -- permanent "declined" row would be a block, which is a different feature.
  delete from friendships
  where requester = p_requester and addressee = v_me and status = 'pending';
  return json_build_object('status', 'none');
end;
$$;

revoke all on function public.respond_friend_request(uuid, boolean) from anon, public;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;

create or replace function public.remove_friend(p_user uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then
    raise exception 'remove_friend: not authenticated' using errcode = '28000';
  end if;

  -- Either direction: the row could have been created by either person.
  delete from friendships
  where (requester = v_me and addressee = p_user)
     or (requester = p_user and addressee = v_me);

  return json_build_object('status', 'none');
end;
$$;

revoke all on function public.remove_friend(uuid) from anon, public;
grant execute on function public.remove_friend(uuid) to authenticated;

-- ── The friends board ─────────────────────────────────────────────────────────
-- Same shape as get_team_board, plus the incoming requests, so opening the section
-- is one round trip rather than two.
create or replace function public.get_friends_board(
  p_metric text default 'live',
  p_limit  int  default 20
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_metric text := clamp_metric(p_metric);
  v_limit  int  := clamp_board_limit(p_limit);
begin
  if v_me is null then
    raise exception 'get_friends_board: not authenticated' using errcode = '28000';
  end if;

  return (
    with friend_ids as (
      -- Accepted only, both directions, plus yourself: a ranking you are absent from
      -- is not a comparison.
      select case when f.requester = v_me then f.addressee else f.requester end as user_id
      from friendships f
      where f.status = 'accepted' and (f.requester = v_me or f.addressee = v_me)
      union
      select v_me
    ),
    scores as (
      select fi.user_id,
             coalesce(nullif(split_part(u.email, '@', 1), ''), 'participant') as display_name,
             coalesce(s.live_focus, 0)::numeric       as live_focus,
             coalesce(s.live_distracted, 0)::numeric  as live_distracted,
             coalesce(s.avg7_focus, 0)::numeric       as avg7_focus,
             coalesce(s.avg7_distracted, 0)::numeric  as avg7_distracted,
             coalesce(s.avg30_focus, 0)::numeric      as avg30_focus,
             coalesce(s.avg30_distracted, 0)::numeric as avg30_distracted,
             case v_metric
               when 'avg7'  then coalesce(s.avg7_focus, 0)  + coalesce(s.avg7_distracted, 0)
               when 'avg30' then coalesce(s.avg30_focus, 0) + coalesce(s.avg30_distracted, 0)
               else              coalesce(s.live_focus, 0)  + coalesce(s.live_distracted, 0)
             end as net
      from friend_ids fi
      left join user_summary s on s.user_id = fi.user_id
      left join auth.users   u on u.id      = fi.user_id
    ),
    ranked as (select *, rank() over (order by net desc) as rnk from scores)
    select json_build_object(
      'metric',       v_metric,
      'member_count', (select count(*) from scores),
      'my_rank',      (select rnk from ranked where user_id = v_me),
      'members', coalesce((
        select json_agg(json_build_object(
                 'user_id',          r.user_id,
                 'display_name',     r.display_name,
                 'is_self',          r.user_id = v_me,
                 'rank',             r.rnk,
                 'live_focus',       r.live_focus,
                 'live_distracted',  r.live_distracted,
                 'avg7_focus',       r.avg7_focus,
                 'avg7_distracted',  r.avg7_distracted,
                 'avg30_focus',      r.avg30_focus,
                 'avg30_distracted', r.avg30_distracted
               ) order by r.rnk)
        from (select * from ranked where rnk <= v_limit
              union
              select * from ranked where user_id = v_me) r), '[]'::json),

      -- Waiting on you. Carried here so the section is one call.
      'requests', coalesce((
        select json_agg(json_build_object(
                 'user_id',      f.requester,
                 'display_name', coalesce(nullif(split_part(u.email, '@', 1), ''), 'participant'),
                 'created_at',   f.created_at
               ) order by f.created_at)
        from friendships f
        join auth.users u on u.id = f.requester
        where f.addressee = v_me and f.status = 'pending'), '[]'::json)
    )
  );
end;
$$;

revoke all on function public.get_friends_board(text, int) from anon, public;
grant execute on function public.get_friends_board(text, int) to authenticated;

-- ── get_member_profile: authorize through can_see_user ────────────────────────
-- Also reports the caller's friendship state with the person being viewed, so the
-- profile can offer the right button without a second call.
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

  -- THE authorization check, now covering teams AND friends. See can_see_user.
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

-- ── build_state: how many requests are waiting ────────────────────────────────
-- One indexed count, so the Friends pill can carry a badge without its own call.
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

    -- Readable as INVOKER: the friendships RLS policy already scopes the caller to
    -- rows they are part of.
    'friend_requests', (select count(*) from friendships
                        where addressee = auth.uid() and status = 'pending'),

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
--
--   select public.search_users('ad');        -- '[]' — under the 3-char floor
--   select public.search_users('ada');       -- matches, no full emails in the output
--   select public.get_friends_board('live'); -- you alone until someone accepts
--
--   -- A pending request must NOT grant visibility:
--   select public.can_see_user('<a-stranger-you-have-asked>');   -- false
--   rollback;
