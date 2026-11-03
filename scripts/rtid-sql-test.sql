-- RESPONDENT TRUST ID SQL TEST (migration 0083) — run against a database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/rtid-sql-test.sql
--
-- Proves, on real Postgres:
--   1. five tables with RLS; identity_match_tokens has NO policy and no grant; the four functions are
--      service-role only; the live-participation index exists with its partial predicate
--   2. resolution: a new arrival mints a vendor_scoped identity; the same vendor id resolves deterministically;
--      a shared deterministic token links two vendors; circumstantial signals give a graded confidence that
--      never reaches 100; an identity only ever becomes more certain, never less
--   3. several trust ids answering one deterministic token are recorded as a merge candidate, not merged
--   4. reservation is atomic: the second arrival for one person in one project cannot take the place, and in
--      SHADOW mode is admitted anyway with would_block recorded — which is the false-positive measurement
--   5. settling is idempotent, moves the identity's counters, and a SHADOW row never moves them
--   6. the sweep returns expired reservations so a crashed browser does not lock someone out of a study
--      forever, and the RLS backstop holds
--
-- One transaction, rolled back.

begin;

/* ------------------------------------------------------------ fixtures */

insert into public.customers (id, slug, name) values
  ('c0000000-0000-0000-0000-000000000084', 'rx84', 'Trust ID 0083'),
  ('c0000000-0000-0000-0000-000000000085', 'other84', 'Another organisation')
on conflict do nothing;

insert into auth.users (id, email) values
  ('c0000084-0000-0000-0000-000000000001', 'owner@r84.test'),
  ('c0000084-0000-0000-0000-000000000002', 'stranger@r84.test')
on conflict do nothing;

insert into public.profiles (id, customer_id, email, full_name, role) values
  ('c0000084-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000084', 'owner@r84.test', 'Owner', 'programmer'),
  ('c0000084-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000085', 'stranger@r84.test', 'Stranger', 'programmer')
on conflict (id) do update set customer_id = excluded.customer_id, role = excluded.role;

insert into public.surveys (id, customer_id, code, title, owner_id)
values ('c0000000-0000-0000-0000-000000000184', 'c0000000-0000-0000-0000-000000000084', 'R84', 'Trust', 'c0000084-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;

-- two vendors: the same person will arrive from both
insert into public.panel_vendors (id, customer_id, slug, name) values
  ('c0000084-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000084', 'cint84', 'Cint'),
  ('c0000084-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-000000000084', 'dynata84', 'Dynata')
on conflict do nothing;

insert into public.vendor_integrations (id, customer_id, vendor_id, mode) values
  ('c0000084-0000-0000-0000-00000000001a', 'c0000000-0000-0000-0000-000000000084', 'c0000084-0000-0000-0000-00000000000a', 'manual'),
  ('c0000084-0000-0000-0000-00000000001b', 'c0000000-0000-0000-0000-000000000084', 'c0000084-0000-0000-0000-00000000000b', 'manual')
on conflict do nothing;

/* ------------------------------------------------------------ 1. structure */

do $$
declare n int; bad text;
begin
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relrowsecurity and c.relname in
      ('respondent_trust_ids', 'identity_match_tokens', 'vendor_participant_mappings', 'participation_ledger', 'identity_match_events');
  if n <> 5 then raise exception '1: expected 5 tables with RLS, found %', n; end if;

  -- the tokens are the sensitive table: RLS on and NO policy at all, the panel_secrets pattern
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'identity_match_tokens') then
    raise exception '1: identity_match_tokens has a policy — it must have none';
  end if;
  if exists (select 1 from information_schema.table_privileges
             where table_schema = 'public' and table_name = 'identity_match_tokens' and grantee in ('authenticated', 'anon')) then
    raise exception '1: identity_match_tokens is granted to a signed-in role';
  end if;

  select string_agg(policyname || '=' || cmd, ', ') into bad from pg_policies
    where schemaname = 'public' and cmd <> 'SELECT' and tablename in
      ('respondent_trust_ids', 'vendor_participant_mappings', 'participation_ledger', 'identity_match_events');
  if bad is not null then raise exception '1: non-SELECT policy present: %', bad; end if;

  -- the index that makes reservation atomic, with its partial predicate intact
  if not exists (select 1 from pg_indexes where schemaname = 'public'
                  and indexname = 'participation_ledger_live_uniq' and indexdef like '%WHERE%shadow%') then
    raise exception '1: the live-participation unique index is missing or not partial';
  end if;

  for bad in select unnest(array[
      'public.rescript_rtid_resolve(uuid, jsonb, uuid, text, uuid)',
      'public.rescript_rtid_reserve(uuid, uuid, uuid, uuid, text, integer)',
      'public.rescript_rtid_settle(uuid, text, uuid, text, text)',
      'public.rescript_rtid_sweep(integer)']) loop
    if has_function_privilege('authenticated', bad, 'execute') then
      raise exception '1: a signed-in user can call %', bad;
    end if;
  end loop;

  raise notice 'PASS 1 five tables with RLS, no policy on the tokens, the partial unique index, service-role functions';
end $$;

/* ------------------------------------------------------------ 2. resolution */

do $$
declare r record; v_first uuid; v_same uuid; v_probable uuid;
begin
  -- a person arrives from Cint with nothing but the vendor's id and a device fingerprint
  select * into r from public.rescript_rtid_resolve(
    'c0000000-0000-0000-0000-000000000084',
    '[{"kind":"device","token":"dev-aaaaaaaaaaaaaaaa","strength":"probabilistic","key_id":"k1"}]'::jsonb,
    'c0000084-0000-0000-0000-00000000001a', 'CINT-PID-1', 'c0000000-0000-0000-0000-000000000184');
  if not r.minted then raise exception '2: a first arrival did not mint an identity'; end if;
  if r.resolution <> 'vendor_scoped' or r.confidence <> 0 then
    raise exception '2: a first arrival claimed %/%', r.resolution, r.confidence;
  end if;
  if r.trust_id !~ '^rtid_[a-z0-9]{16,40}$' then raise exception '2: malformed handle %', r.trust_id; end if;
  v_first := r.trust_uuid;

  -- the same Cint id again: deterministic, and the same identity
  select * into r from public.rescript_rtid_resolve(
    'c0000000-0000-0000-0000-000000000084', '[]'::jsonb,
    'c0000084-0000-0000-0000-00000000001a', 'CINT-PID-1', 'c0000000-0000-0000-0000-000000000184');
  if r.minted then raise exception '2: a known vendor id minted a second identity'; end if;
  if r.trust_uuid <> v_first then raise exception '2: the same vendor id resolved to a different identity'; end if;
  if r.resolution <> 'deterministic' or r.confidence <> 100 then
    raise exception '2: a known vendor id gave %/%', r.resolution, r.confidence;
  end if;
  if (select entries from public.vendor_participant_mappings
       where integration_id = 'c0000084-0000-0000-0000-00000000001a' and participant_id = 'CINT-PID-1') <> 2 then
    raise exception '2: the vendor mapping did not count the second entry';
  end if;

  /*
   * The SAME DEVICE arrives from Dynata under a different vendor id. One circumstantial signal is 55, which is
   * BELOW the adoption threshold (0084), so this must NOT become the same person: a household behind one
   * router is two people, and merging them would refuse the second as a duplicate of the first. A separate
   * identity is created and the resemblance is recorded for a reviewer.
   */
  select * into r from public.rescript_rtid_resolve(
    'c0000000-0000-0000-0000-000000000084',
    '[{"kind":"device","token":"dev-aaaaaaaaaaaaaaaa","strength":"probabilistic","key_id":"k1"}]'::jsonb,
    'c0000084-0000-0000-0000-00000000001b', 'DYNATA-PSID-9', 'c0000000-0000-0000-0000-000000000184');
  if r.trust_uuid = v_first then
    raise exception '2: one shared device merged two people — a household on one router is two people';
  end if;
  if not r.minted then raise exception '2: the second person did not get their own identity'; end if;
  if r.merge_candidates <> 1 then raise exception '2: the resemblance was not recorded for a reviewer'; end if;
  if not exists (select 1 from public.identity_match_events
                  where trust_id = r.trust_uuid and kind = 'merge_candidate' and confidence = 55) then
    raise exception '2: the 55%% resemblance was not recorded with its confidence';
  end if;
  v_probable := r.trust_uuid;

  /*
   * Three agreeing signals reach 88, at or above the threshold, and DO adopt. That is the same bar
   * `decideAdmission` requires before it will act on a match: evidence that cannot license a refusal cannot
   * license an identity either.
   */
  -- give the first identity a network and a behavioural token, through its own deterministic vendor id
  perform public.rescript_rtid_resolve('c0000000-0000-0000-0000-000000000084',
    '[{"kind":"network","token":"net-bbbbbbbbbbbbbbbb","strength":"probabilistic","key_id":"k1"},
      {"kind":"behaviour","token":"beh-ffffffffffffffff","strength":"probabilistic","key_id":"k1"}]'::jsonb,
    'c0000084-0000-0000-0000-00000000001a', 'CINT-PID-1', null);

  select * into r from public.rescript_rtid_resolve(
    'c0000000-0000-0000-0000-000000000084',
    '[{"kind":"device","token":"dev-aaaaaaaaaaaaaaaa","strength":"probabilistic","key_id":"k1"},
      {"kind":"network","token":"net-bbbbbbbbbbbbbbbb","strength":"probabilistic","key_id":"k1"},
      {"kind":"behaviour","token":"beh-ffffffffffffffff","strength":"probabilistic","key_id":"k1"}]'::jsonb,
    null, null, 'c0000000-0000-0000-0000-000000000184');
  if r.trust_uuid <> v_first then raise exception '2: three agreeing signals did not reach the known identity'; end if;
  if r.resolution <> 'probabilistic' then raise exception '2: a circumstantial match claimed %', r.resolution; end if;
  if r.confidence <> 88 then raise exception '2: three agreeing signals scored %, expected 88', r.confidence; end if;
  if r.confidence >= 100 then raise exception '2: circumstantial evidence reached proof'; end if;
  if r.minted then raise exception '2: an adoptable match still minted a new identity'; end if;

  -- a probabilistic token is NOT unique per network: both identities legitimately hold the shared device token
  if (select count(*) from public.identity_match_tokens
       where customer_id = 'c0000000-0000-0000-0000-000000000084' and kind = 'device'
         and token = 'dev-aaaaaaaaaaaaaaaa') < 2 then
    raise exception '2: a shared device could not be recorded against both identities';
  end if;

  -- a DIFFERENT person, linked to a third vendor arrival by a shared e-mail token: deterministic
  select * into r from public.rescript_rtid_resolve(
    'c0000000-0000-0000-0000-000000000084',
    '[{"kind":"email","token":"eml-cccccccccccccccc","strength":"deterministic","key_id":"k1"}]'::jsonb,
    'c0000084-0000-0000-0000-00000000001a', 'CINT-PID-2', 'c0000000-0000-0000-0000-000000000184');
  v_same := r.trust_uuid;
  if v_same = v_first then raise exception '2: an unrelated person resolved to the first identity'; end if;

  select * into r from public.rescript_rtid_resolve(
    'c0000000-0000-0000-0000-000000000084',
    '[{"kind":"email","token":"eml-cccccccccccccccc","strength":"deterministic","key_id":"k1"}]'::jsonb,
    'c0000084-0000-0000-0000-00000000001b', 'DYNATA-PSID-7', 'c0000000-0000-0000-0000-000000000184');
  if r.trust_uuid <> v_same then raise exception '2: a shared e-mail token did not link two vendors'; end if;
  if r.resolution <> 'deterministic' or r.confidence <> 100 then
    raise exception '2: a shared deterministic token gave %/%', r.resolution, r.confidence;
  end if;

  -- an identity only ever becomes MORE certain: the first one is deterministic now and a later weak match
  -- must not drag it back down
  select * into r from public.rescript_rtid_resolve(
    'c0000000-0000-0000-0000-000000000084',
    '[{"kind":"device","token":"dev-cccccccccccccccc","strength":"probabilistic","key_id":"k1"}]'::jsonb,
    'c0000084-0000-0000-0000-00000000001b', 'DYNATA-PSID-7', 'c0000000-0000-0000-0000-000000000184');
  if r.resolution <> 'deterministic' or r.confidence <> 100 then
    raise exception '2: a settled identity was downgraded to %/%', r.resolution, r.confidence;
  end if;

  raise notice 'PASS 2 resolution: minted, deterministic on vendor id and shared token, graded circumstantial evidence, never downgraded';
end $$;

/* ------------------------------------------------------------ 3. merge candidates, not merges */

do $$
declare r record; v_a uuid; v_b uuid; n int;
begin
  -- two identities reached independently, then a token that belongs to both
  select trust_uuid into v_a from public.rescript_rtid_resolve('c0000000-0000-0000-0000-000000000084',
    '[{"kind":"device","token":"dev-dddddddddddddddd","strength":"probabilistic","key_id":"k1"}]'::jsonb,
    'c0000084-0000-0000-0000-00000000001a', 'CINT-PID-3', null);
  select trust_uuid into v_b from public.rescript_rtid_resolve('c0000000-0000-0000-0000-000000000084',
    '[{"kind":"device","token":"dev-eeeeeeeeeeeeeeee","strength":"probabilistic","key_id":"k1"}]'::jsonb,
    'c0000084-0000-0000-0000-00000000001a', 'CINT-PID-4', null);
  if v_a = v_b then raise exception '3: two unrelated arrivals collapsed into one identity'; end if;

  -- give each a deterministic token, then present both at once
  insert into public.identity_match_tokens (customer_id, trust_id, kind, token, key_id, strength)
    values ('c0000000-0000-0000-0000-000000000084', v_a, 'external_id', 'ext-aaaa000000000000', 'k1', 'deterministic'),
           ('c0000000-0000-0000-0000-000000000084', v_b, 'external_id', 'ext-bbbb000000000000', 'k1', 'deterministic');

  select * into r from public.rescript_rtid_resolve('c0000000-0000-0000-0000-000000000084',
    '[{"kind":"external_id","token":"ext-aaaa000000000000","strength":"deterministic","key_id":"k1"},
      {"kind":"external_id","token":"ext-bbbb000000000000","strength":"deterministic","key_id":"k1"}]'::jsonb,
    null, null, 'c0000000-0000-0000-0000-000000000184');
  if r.merge_candidates <> 2 then raise exception '3: expected 2 merge candidates, got %', r.merge_candidates; end if;
  if r.trust_uuid not in (v_a, v_b) then raise exception '3: the resolution picked neither candidate'; end if;

  -- and NOTHING was merged: both identities still exist, with their own tokens
  select count(*) into n from public.respondent_trust_ids where id in (v_a, v_b);
  if n <> 2 then raise exception '3: an identity was destroyed by a merge candidate'; end if;
  select count(*) into n from public.identity_match_events
    where kind = 'merge_candidate' and customer_id = 'c0000000-0000-0000-0000-000000000084';
  if n < 1 then raise exception '3: the merge candidate was not recorded for a human to decide'; end if;

  raise notice 'PASS 3 several identities answering one token are recorded as a candidate, never silently merged';
end $$;

/* ------------------------------------------------------------ 4. atomic reservation and shadow mode */

do $$
declare r record; v_trust uuid; v_other uuid; v_first uuid; n int;
begin
  select trust_uuid into v_trust from public.rescript_rtid_resolve('c0000000-0000-0000-0000-000000000084',
    '[]'::jsonb, 'c0000084-0000-0000-0000-00000000001a', 'CINT-RESERVE-1', null);
  select trust_uuid into v_other from public.rescript_rtid_resolve('c0000000-0000-0000-0000-000000000084',
    '[]'::jsonb, 'c0000084-0000-0000-0000-00000000001a', 'CINT-RESERVE-2', null);

  -- the first arrival takes the place
  select * into r from public.rescript_rtid_reserve('c0000000-0000-0000-0000-000000000084',
    'c0000000-0000-0000-0000-000000000184', v_trust, 'c0000084-0000-0000-0000-00000000001a', 'enforce', 3600);
  if not r.reserved or r.would_block then raise exception '4: the first arrival was refused'; end if;
  v_first := r.ledger_id;

  -- somebody else is unaffected
  select * into r from public.rescript_rtid_reserve('c0000000-0000-0000-0000-000000000084',
    'c0000000-0000-0000-0000-000000000184', v_other, 'c0000084-0000-0000-0000-00000000001a', 'enforce', 3600);
  if not r.reserved then raise exception '4: a different person was refused'; end if;

  -- the SAME person again, in enforce mode: refused, and told what holds the place
  select * into r from public.rescript_rtid_reserve('c0000000-0000-0000-0000-000000000084',
    'c0000000-0000-0000-0000-000000000184', v_trust, 'c0000084-0000-0000-0000-00000000001b', 'enforce', 3600);
  if r.reserved then raise exception '4: the same person reserved the same project twice'; end if;
  if not r.would_block or r.held_state <> 'reserved' then
    raise exception '4: the refusal did not say what holds the place (% / %)', r.would_block, r.held_state;
  end if;

  -- and in SHADOW mode: admitted anyway, with the fact that it would have been refused recorded
  select * into r from public.rescript_rtid_reserve('c0000000-0000-0000-0000-000000000084',
    'c0000000-0000-0000-0000-000000000184', v_trust, 'c0000084-0000-0000-0000-00000000001b', 'shadow', 3600);
  if not r.reserved then raise exception '4: shadow mode refused somebody — it must refuse nobody'; end if;
  if not r.would_block then raise exception '4: shadow mode did not record what it would have blocked'; end if;
  if not (select shadow from public.participation_ledger where id = r.ledger_id) then
    raise exception '4: the shadow admission was written as a real participation';
  end if;

  -- the shadow row is outside the uniqueness index, so the real one still holds the place
  select count(*) into n from public.participation_ledger
    where survey_id = 'c0000000-0000-0000-0000-000000000184' and trust_id = v_trust and not shadow;
  if n <> 1 then raise exception '4: % live participations for one person in one project', n; end if;

  -- counting these IS the false-positive exposure, which is the point of shadow mode
  select count(*) into n from public.identity_match_events
    where survey_id = 'c0000000-0000-0000-0000-000000000184' and kind = 'duplicate' and would_block and shadow;
  if n < 1 then raise exception '4: the shadow block was not recorded as measurable'; end if;

  -- "off" writes no ledger row at all
  select * into r from public.rescript_rtid_reserve('c0000000-0000-0000-0000-000000000084',
    'c0000000-0000-0000-0000-000000000184', v_trust, null, 'off', 3600);
  if not r.reserved or r.ledger_id is not null then raise exception '4: "off" wrote a ledger row'; end if;

  raise notice 'PASS 4 one live participation per person per project; enforce refuses and explains; shadow admits and measures';
end $$;

/* ------------------------------------------------------------ 5. settling */

do $$
declare r record; v_trust uuid; v_ledger uuid; v_shadow uuid; v_before int;
begin
  select trust_uuid into v_trust from public.rescript_rtid_resolve('c0000000-0000-0000-0000-000000000084',
    '[]'::jsonb, 'c0000084-0000-0000-0000-00000000001a', 'CINT-SETTLE-1', null);
  select ledger_id into v_ledger from public.rescript_rtid_reserve('c0000000-0000-0000-0000-000000000084',
    'c0000000-0000-0000-0000-000000000184', v_trust, 'c0000084-0000-0000-0000-00000000001a', 'enforce', 3600);

  select completions into v_before from public.respondent_trust_ids where id = v_trust;
  select * into r from public.rescript_rtid_settle(v_ledger, 'completed', null, 'complete', 'sess-1');
  if not r.settled or r.state <> 'completed' then raise exception '5: settling failed (%, %)', r.settled, r.state; end if;
  if (select completions from public.respondent_trust_ids where id = v_trust) <> v_before + 1 then
    raise exception '5: a completion did not move the identity''s counter';
  end if;

  -- settling again changes nothing: a repeated callback must not double-count
  select * into r from public.rescript_rtid_settle(v_ledger, 'completed', null, 'complete', null);
  if r.settled then raise exception '5: a terminal participation was settled twice'; end if;
  if (select completions from public.respondent_trust_ids where id = v_trust) <> v_before + 1 then
    raise exception '5: a repeated settle double-counted the completion';
  end if;

  -- a completed participation still holds the place: the person cannot come back for a second complete
  select * into r from public.rescript_rtid_reserve('c0000000-0000-0000-0000-000000000084',
    'c0000000-0000-0000-0000-000000000184', v_trust, 'c0000084-0000-0000-0000-00000000001b', 'enforce', 3600);
  if r.reserved then raise exception '5: somebody who already completed was admitted again'; end if;
  if r.held_state <> 'completed' then raise exception '5: the refusal said % not completed', r.held_state; end if;

  -- a SHADOW row is an observation: settling it must not move a real counter
  select ledger_id into v_shadow from public.rescript_rtid_reserve('c0000000-0000-0000-0000-000000000084',
    'c0000000-0000-0000-0000-000000000184', v_trust, 'c0000084-0000-0000-0000-00000000001b', 'shadow', 3600);
  select completions into v_before from public.respondent_trust_ids where id = v_trust;
  perform public.rescript_rtid_settle(v_shadow, 'completed', null, 'complete', 'sess-shadow');
  if (select completions from public.respondent_trust_ids where id = v_trust) <> v_before then
    raise exception '5: a shadow observation moved a real completion counter';
  end if;

  raise notice 'PASS 5 settling is idempotent, moves the identity''s counters, and a shadow row never does';
end $$;

/* ------------------------------------------------------------ 6. the sweep, and RLS */

do $$
declare r record; v_trust uuid; v_ledger uuid; n int;
begin
  select trust_uuid into v_trust from public.rescript_rtid_resolve('c0000000-0000-0000-0000-000000000084',
    '[]'::jsonb, 'c0000084-0000-0000-0000-00000000001a', 'CINT-SWEEP-1', null);
  select ledger_id into v_ledger from public.rescript_rtid_reserve('c0000000-0000-0000-0000-000000000084',
    'c0000000-0000-0000-0000-000000000184', v_trust, 'c0000084-0000-0000-0000-00000000001a', 'enforce', 3600);

  -- their browser died on the consent page an hour ago
  update public.participation_ledger set expires_at = now() - interval '5 minutes' where id = v_ledger;
  if public.rescript_rtid_sweep(100) < 1 then raise exception '6: the sweep released nothing'; end if;
  if (select state from public.participation_ledger where id = v_ledger) <> 'expired' then
    raise exception '6: the stale reservation was not expired';
  end if;

  -- and they can now get back in, rather than being refused as a duplicate of themselves
  select * into r from public.rescript_rtid_reserve('c0000000-0000-0000-0000-000000000084',
    'c0000000-0000-0000-0000-000000000184', v_trust, 'c0000084-0000-0000-0000-00000000001a', 'enforce', 3600);
  if not r.reserved then raise exception '6: a swept reservation still locks the person out'; end if;

  raise notice 'PASS 6a the sweep releases stale reservations and the person can return';
end $$;

grant select on public.respondent_trust_ids, public.vendor_participant_mappings,
  public.participation_ledger, public.identity_match_events to authenticated;

do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', 'c0000084-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select count(*) into n from public.respondent_trust_ids;
  if n < 1 then raise exception '6: a member reads none of its own identities'; end if;
  begin
    perform token from public.identity_match_tokens limit 1;
    raise exception '6: a member read a match token';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.respondent_trust_ids (customer_id, trust_id) values ('c0000000-0000-0000-0000-000000000084', 'rtid_0123456789abcdef');
    raise exception '6: a member wrote an identity';
  exception when insufficient_privilege then null; end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'c0000084-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select count(*) into n from public.respondent_trust_ids;
  if n <> 0 then raise exception '6: another organisation read % identities', n; end if;
  select count(*) into n from public.participation_ledger;
  if n <> 0 then raise exception '6: another organisation read % participations', n; end if;
  reset role;

  raise notice 'PASS 6b RLS: members read their own identities and never a token; another organisation reads nothing';
end $$;

rollback;
