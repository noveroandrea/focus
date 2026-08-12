-- ─────────────────────────────────────────────────────────────────────────────
--  Pairing a phone with a desktop, and nothing more
-- ─────────────────────────────────────────────────────────────────────────────
--  The phone nudge is sent by the user's own browser straight to the push service
--  (see src/extension/push.ts for why the VAPID keypair is generated per install
--  rather than held centrally). But the two halves of the pairing never meet: the
--  PHONE creates the subscription, and the DESKTOP has to end up holding it, and
--  they share no channel. A QR gets a URL from one to the other; this table is how
--  the answer gets back.
--
--  ── IT IS A COURIER, NOT A STORE ────────────────────────────────────────────
--  A row lives from "show me a QR" to "the desktop collected it", with a ten-minute
--  ceiling. take_pairing DELETES the row it returns. After pairing, this table knows
--  nothing about the user, and no push ever touches this database — which is the
--  whole point: the timing of idle nudges is a record of when someone drifts, and it
--  stays on their own machines.
--
--  ── WHY anon MAY WRITE HERE ─────────────────────────────────────────────────
--  The phone is not signed in. It has scanned a QR and that is all it has, so the
--  nonce IS the credential: 128 bits from gen_random_bytes, single-use, ten minutes.
--  claim_pairing is therefore the one function in this schema granted to `anon`, and
--  it is written to do exactly one thing — fill in the subscription on a row that is
--  fresh, unclaimed, and whose nonce the caller already knew. It cannot read a row,
--  cannot list rows, cannot learn a user_id, and cannot overwrite a claim that has
--  already happened. Guessing a nonce is guessing a 128-bit secret inside a
--  ten-minute window.
--
--  ── WHAT A SUBSCRIPTION IS ──────────────────────────────────────────────────
--  `{endpoint, keys:{p256dh, auth}}` — the push service's URL for that device plus
--  the two secrets that encrypt payloads end-to-end for it. Anyone holding it can
--  send that phone notifications, which is precisely why it is deleted on collection
--  rather than kept "in case the desktop asks again".
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.push_pairings (
  nonce        text        primary key check (length(nonce) between 16 and 128),
  user_id      uuid        not null references auth.users(id) on delete cascade,
  -- NULL until the phone answers. That is also the "unclaimed" test.
  subscription jsonb,
  -- Which phone the user said it was, carried through only so the desktop can label
  -- the row it shows. Never used for a decision.
  platform     text        check (platform is null or platform in ('android', 'ios', 'other')),
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz
);

comment on table public.push_pairings is
  'Ten-minute courier carrying a phone push subscription back to the desktop that showed the QR. Rows are deleted on collection; nothing here survives pairing.';

create index if not exists push_pairings_user_idx    on public.push_pairings (user_id);
create index if not exists push_pairings_created_idx on public.push_pairings (created_at);

-- Reached only through the three functions below — no client gets table rights, and
-- RLS with no policy is the deny-all backstop if a GRANT is ever added by accident.
alter table public.push_pairings enable row level security;
revoke all on public.push_pairings from anon, authenticated;

-- ── How long a QR is good for ─────────────────────────────────────────────────
-- Long enough to find your phone, unlock it, scan, and (on iOS) work through Add to
-- Home Screen; short enough that a nonce photographed over someone's shoulder is
-- worthless by the time it could be used. Ten minutes is the compromise, and the
-- popup counts it down so an expiry never looks like a failure.
create or replace function public.pairing_ttl()
returns interval
language sql
immutable
as $$ select interval '10 minutes' $$;

-- ── create_pairing ────────────────────────────────────────────────────────────
-- Hand the caller a fresh nonce to put in a QR.
--
-- Deletes the caller's own outstanding rows first: a user who opened the pairing
-- panel three times should not leave three live nonces behind, each of which is a
-- way into their notifications. Also sweeps globally expired rows on the way past —
-- this table is tiny by construction (one row per pairing attempt, ten minutes) and
-- that keeps it that way without a cron job of its own.
create or replace function public.create_pairing()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_nonce text;
begin
  if v_me is null then
    raise exception 'create_pairing: not authenticated' using errcode = '28000';
  end if;

  delete from push_pairings where user_id = v_me;
  delete from push_pairings where created_at < now() - pairing_ttl();

  v_nonce := encode(gen_random_bytes(16), 'hex');
  insert into push_pairings (nonce, user_id) values (v_nonce, v_me);
  return v_nonce;
end;
$$;

revoke all on function public.create_pairing() from anon, public;
grant execute on function public.create_pairing() to authenticated;

-- ── claim_pairing ─────────────────────────────────────────────────────────────
-- Called by the PHONE, which is not signed in. See the header for why the nonce is
-- an acceptable credential and what this function is prevented from doing.
--
-- Returns a plain boolean: true if the subscription was recorded, false if the nonce
-- was unknown, expired or already claimed. The three are deliberately not
-- distinguished — the phone can only say "that link has expired, start again on your
-- computer", which is the same remedy for all three.
create or replace function public.claim_pairing(
  p_nonce        text,
  p_subscription jsonb,
  p_platform     text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_endpoint text := p_subscription ->> 'endpoint';
  v_p256dh   text := p_subscription -> 'keys' ->> 'p256dh';
  v_auth     text := p_subscription -> 'keys' ->> 'auth';
begin
  -- Shape check before the write. An unauthenticated caller may put a row's contents
  -- here, so "it parses as a push subscription" is the only thing standing between
  -- this column and arbitrary JSON of arbitrary size.
  if v_endpoint is null or v_p256dh is null or v_auth is null then
    return false;
  end if;
  if length(v_endpoint) > 1000 or length(v_p256dh) > 256 or length(v_auth) > 256 then
    return false;
  end if;
  if v_endpoint !~ '^https://' then
    return false;
  end if;

  update push_pairings
  set subscription = jsonb_build_object(
        'endpoint', v_endpoint,
        'keys', jsonb_build_object('p256dh', v_p256dh, 'auth', v_auth)),
      platform     = case when p_platform in ('android', 'ios', 'other') then p_platform end,
      claimed_at   = now()
  where nonce        = p_nonce
    and subscription is null                        -- single use
    and created_at   > now() - pairing_ttl();       -- and still fresh

  return found;
end;
$$;

-- The one function in this schema `anon` may call, and the header says why.
revoke all on function public.claim_pairing(text, jsonb, text) from public;
grant execute on function public.claim_pairing(text, jsonb, text) to anon, authenticated;

-- ── take_pairing ──────────────────────────────────────────────────────────────
-- Called by the DESKTOP, polling while the QR is on screen. Returns the subscription
-- and deletes the row in the same statement, so the courier forgets it the moment it
-- has been delivered — and a second caller (another window, a retry) gets null rather
-- than a copy.
--
-- `user_id = auth.uid()` is load-bearing, not decoration: this is SECURITY DEFINER,
-- so without it, knowing any nonce would hand over that pairing.
create or replace function public.take_pairing(p_nonce text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_sub jsonb;
begin
  if v_me is null then
    raise exception 'take_pairing: not authenticated' using errcode = '28000';
  end if;

  delete from push_pairings
  where nonce = p_nonce
    and user_id = v_me
    and subscription is not null
  returning subscription into v_sub;

  return v_sub;   -- null while the phone has not answered yet
end;
$$;

revoke all on function public.take_pairing(text) from anon, public;
grant execute on function public.take_pairing(text) to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- 1. The happy path, both halves:
--
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<your-uuid>','role','authenticated')::text, true);
--   select public.create_pairing() as nonce \gset
--   -- as the phone (anon):
--   select public.claim_pairing(:'nonce',
--     '{"endpoint":"https://fcm.googleapis.com/fcm/send/x","keys":{"p256dh":"a","auth":"b"}}'::jsonb,
--     'android');                                  -- true
--   select public.take_pairing(:'nonce');          -- the subscription
--   select public.take_pairing(:'nonce');          -- null: the row is gone
--   rollback;
--
-- 2. Single use — a second claim on the same nonce must be false:
--   select public.claim_pairing(:'nonce', '{...}'::jsonb, 'ios');   -- false
--
-- 3. Someone else's nonce yields nothing, even though the function is DEFINER:
--   (sign in as another user, then) select public.take_pairing(:'nonce');  -- null
--
-- 4. Garbage is refused rather than stored:
--   select public.claim_pairing(:'nonce', '{"endpoint":"http://evil"}'::jsonb, null); -- false
