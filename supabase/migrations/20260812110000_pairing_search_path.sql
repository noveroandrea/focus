-- ─────────────────────────────────────────────────────────────────────────────
--  create_pairing could not see gen_random_bytes
-- ─────────────────────────────────────────────────────────────────────────────
--  20260812100000 declared create_pairing with `set search_path = public` and then
--  called `gen_random_bytes(16)` unqualified. On Supabase that function does not
--  live in public: pgcrypto is installed into the **extensions** schema, so the call
--  resolved to nothing and every pairing attempt failed with
--
--      ERROR: function gen_random_bytes(integer) does not exist
--
--  which surfaced in the popup as "the server refused the request" — the pairing
--  panel could never get past its first step.
--
--  This is the same trap 20260730160000_team_passwords.sql already documented for
--  crypt()/gen_salt(), and it has the same fix: put **both** schemas on the
--  function's search_path and leave the call unqualified. That resolves on Supabase
--  (pgcrypto in `extensions`) and on a plain PostgreSQL install (pgcrypto in
--  `public`) without the migration having to know which it is talking to — and a
--  schema named in search_path that does not exist is ignored rather than an error,
--  so naming both is always safe.
--
--  `extensions.gen_random_bytes(...)` would have been the other option and is worse:
--  it hard-codes the Supabase layout into a file that also has to run against a local
--  database, which is exactly where this bug was hidden. The local instance used for
--  testing had pgcrypto in `public`, so the broken version passed there and failed
--  only in production.
--
--  Nothing else in the pairing migration touches an extension: claim_pairing and
--  take_pairing use jsonb built-ins only, and focus_program uses regexp_replace.
--  This is the one function that needed it.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.create_pairing()
returns text
language plpgsql
security definer
set search_path = public, extensions   -- unqualified gen_random_bytes resolves in either
as $$
declare
  v_me    uuid := auth.uid();
  v_nonce text;
begin
  if v_me is null then
    raise exception 'create_pairing: not authenticated' using errcode = '28000';
  end if;

  -- The caller's own outstanding rows first: a user who opened the pairing panel
  -- three times should not leave three live nonces behind, each of which is a way
  -- into their notifications. Then anything globally expired, which keeps this table
  -- empty by construction without a cron job of its own.
  delete from push_pairings where user_id = v_me;
  delete from push_pairings where created_at < now() - pairing_ttl();

  v_nonce := encode(gen_random_bytes(16), 'hex');
  insert into push_pairings (nonce, user_id) values (v_nonce, v_me);
  return v_nonce;
end;
$$;

revoke all on function public.create_pairing() from anon, public;
grant execute on function public.create_pairing() to authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- As a signed-in user, this must return 32 hex characters rather than raising:
--
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object('sub','<your-uuid>','role','authenticated')::text, true);
--   select public.create_pairing();          -- e.g. 9f2c...  (32 chars)
--   select count(*) from public.push_pairings where user_id = '<your-uuid>';  -- 1
--   rollback;
--
-- And the schema really is the point — this is what was failing:
--
--   select extnamespace::regnamespace from pg_extension where extname = 'pgcrypto';
--   -- Supabase: extensions      local default: public
