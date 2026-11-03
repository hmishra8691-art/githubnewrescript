-- ADMISSION GATEWAY SQL TEST (migration 0084) — run against a database with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/admission-sql-test.sql
--
-- Proves, on real Postgres:
--   1. four tables with RLS; survey_access_tokens has NO policy and no grant (a token hash is a credential);
--      the four functions are service-role only; `decision` has no value meaning "refused because risky"
--   2. issuing: the decision, the token and the case are written together; a case is opened only when asked,
--      and one participation never accumulates more than one open case however often the gateway is reloaded
--   3. redemption is SINGLE USE: a replay is refused as already_used, an expired token as expired, a token for
--      another survey as unknown — three different answers because they need three different next steps
--   4. the counts behind the density rules: identities are DISTINCT trust ids, not arrivals, so one person
--      reloading twenty times does not manufacture the signal the rule looks for
--   5. review: clearing a case releases the complete for billing AND reduces the identity's standing risk, so
--      one false positive does not follow a respondent for ever; upholding quarantines; appeal is recorded
--   6. the RLS backstop, and cascade from the survey
--
-- One transaction, rolled back. (Concurrency — two simultaneous redemptions of one token — cannot be shown in
-- one transaction and is covered by scripts/admission-concurrency.sh.)

begin;

/* ------------------------------------------------------------ fixtures */

insert into public.customers (id, slug, name) values
  ('c0000000-0000-0000-0000-000000000086', 'rx86', 'Admission 0084'),
  ('c0000000-0000-0000-0000-000000000087', 'other86', 'Another organisation')
on conflict do nothing;

insert into auth.users (id, email) values
  ('c0000086-0000-0000-0000-000000000001', 'owner@r86.test'),
  ('c0000086-0000-0000-0000-000000000002', 'stranger@r86.test')
on conflict do nothing;

insert into public.profiles (id, customer_id, email, full_name, role) values
  ('c0000086-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000086', 'owner@r86.test', 'Owner', 'programmer'),
  ('c0000086-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000087', 'stranger@r86.test', 'Stranger', 'programmer')
on conflict (id) do update set customer_id = excluded.customer_id, role = excluded.role;

insert into public.surveys (id, customer_id, code, title, owner_id) values
  ('c0000000-0000-0000-0000-000000000186', 'c0000000-0000-0000-0000-000000000086', 'R86', 'Admission', 'c0000086-0000-0000-0000-000000000001'),
  ('c0000000-0000-0000-0000-000000000187', 'c0000000-0000-0000-0000-000000000086', 'R87', 'Other study', 'c0000086-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;

insert into public.respondent_trust_ids (id, customer_id, trust_id, risk_score) values
  ('c0000086-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000086', 'rtid_admission00000001', 0)
on conflict do nothing;

insert into public.participation_ledger (id, customer_id, survey_id, trust_id, state) values
  ('c0000086-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-000000000086',
   'c0000000-0000-0000-0000-000000000186', 'c0000086-0000-0000-0000-00000000000a', 'reserved')
on conflict do nothing;

/* ------------------------------------------------------------ 1. structure */

do $$
declare n int; bad text;
begin
  select count(*) into n from pg_class c join pg_namespace s on s.oid = c.relnamespace
    where s.nspname = 'public' and c.relrowsecurity and c.relname in
      ('network_reputation', 'admission_decisions', 'survey_access_tokens', 'fraud_cases');
  if n <> 4 then raise exception '1: expected 4 tables with RLS, found %', n; end if;

  -- a token hash is a credential: no policy, no grant, the service role only
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'survey_access_tokens') then
    raise exception '1: survey_access_tokens has a policy — it must have none';
  end if;
  if exists (select 1 from information_schema.table_privileges
             where table_schema = 'public' and table_name = 'survey_access_tokens' and grantee in ('authenticated', 'anon')) then
    raise exception '1: survey_access_tokens is granted to a signed-in role';
  end if;

  select string_agg(policyname || '=' || cmd, ', ') into bad from pg_policies
    where schemaname = 'public' and cmd <> 'SELECT'
      and tablename in ('network_reputation', 'admission_decisions', 'fraud_cases');
  if bad is not null then raise exception '1: non-SELECT policy present: %', bad; end if;

  /*
   * The central promise of this phase, as a constraint: there is no decision meaning "refused because the risk
   * score was high". If somebody later adds one, this fails.
   */
  -- every constraint name on this table contains "decision", so narrow to CHECK constraints on that column
  select string_agg(pg_get_constraintdef(oid), ' ') into bad from pg_constraint
    where conrelid = 'public.admission_decisions'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ~ 'decision';
  if bad is null then raise exception '1: the decision vocabulary is not constrained at all'; end if;
  if bad ~* 'blocked|refused_risk|rejected_risk|fraud_block' then
    raise exception '1: a decision value means "refused on risk": %', bad;
  end if;

  for bad in select unnest(array[
      'public.rescript_admission_redeem(text, uuid, text, text)',
      'public.rescript_network_seen(uuid, text, uuid)',
      'public.rescript_fraud_resolve(uuid, text, uuid, text)']) loop
    if has_function_privilege('authenticated', bad, 'execute') then
      raise exception '1: a signed-in user can call %', bad;
    end if;
  end loop;

  raise notice 'PASS 1 four tables with RLS, no policy on the tokens, service-role functions, no refuse-on-risk decision';
end $$;

/* ------------------------------------------------------------ 2. issuing */

do $$
declare r record; n int;
begin
  -- a clean arrival: decision and token, no case
  select * into r from public.rescript_admission_issue(
    'c0000000-0000-0000-0000-000000000086', 'c0000000-0000-0000-0000-000000000186',
    'c0000086-0000-0000-0000-00000000000a', 'c0000086-0000-0000-0000-00000000000b', null,
    'admitted', 4, 'low', '{}', '{}'::jsonb, 'deterministic', 'net-cleancleanclean01',
    repeat('a', 64), 900, false, 42, false);
  if r.decision_id is null or r.token_id is null then raise exception '2: a clean arrival got no decision or token'; end if;
  if r.case_id is not null then raise exception '2: a clean arrival opened a review case'; end if;
  if r.expires_at <= now() then raise exception '2: the token was issued already expired'; end if;
  if (select decided_in_ms from public.admission_decisions where id = r.decision_id) <> 42 then
    raise exception '2: the decision latency was not recorded';
  end if;

  -- a risky arrival: still admitted, and a case opened
  select * into r from public.rescript_admission_issue(
    'c0000000-0000-0000-0000-000000000086', 'c0000000-0000-0000-0000-000000000186',
    'c0000086-0000-0000-0000-00000000000a', 'c0000086-0000-0000-0000-00000000000b', null,
    'admitted_flagged', 62, 'high', '{device.webdriver,network.datacenter}',
    '{"note":"automation reported"}'::jsonb, 'deterministic', 'net-riskyriskyrisky1',
    repeat('b', 64), 900, false, 51, true);
  if r.case_id is null then raise exception '2: a high-risk arrival opened no case'; end if;
  if (select decision from public.admission_decisions where id = r.decision_id) <> 'admitted_flagged' then
    raise exception '2: a high-risk arrival was not admitted';
  end if;
  -- and the identity's standing risk rose
  if (select risk_score from public.respondent_trust_ids where id = 'c0000086-0000-0000-0000-00000000000a') <> 62 then
    raise exception '2: the identity''s standing risk was not raised';
  end if;

  -- reloading the gateway must not pile up the queue: one open case per participation
  perform public.rescript_admission_issue(
    'c0000000-0000-0000-0000-000000000086', 'c0000000-0000-0000-0000-000000000186',
    'c0000086-0000-0000-0000-00000000000a', 'c0000086-0000-0000-0000-00000000000b', null,
    'admitted_flagged', 62, 'high', '{device.webdriver}', '{}'::jsonb, 'deterministic', 'net-riskyriskyrisky1',
    repeat('c', 64), 900, false, 48, true);
  select count(*) into n from public.fraud_cases
    where ledger_id = 'c0000086-0000-0000-0000-00000000000b' and status = 'open';
  if n <> 1 then raise exception '2: % open cases for one participation', n; end if;

  raise notice 'PASS 2 issuing writes the decision, the token and (only when asked) one case per participation';
end $$;

/* ------------------------------------------------------------ 3. redemption is single use */

do $$
declare r record;
begin
  select * into r from public.rescript_admission_redeem(repeat('a', 64), 'c0000000-0000-0000-0000-000000000186', 'sess-1', null);
  if not r.ok or r.reason <> 'redeemed' then raise exception '3: a fresh token was refused (%)', r.reason; end if;
  if r.trust_id <> 'c0000086-0000-0000-0000-00000000000a' then raise exception '3: redemption returned the wrong identity'; end if;
  if (select redeemed_session from public.survey_access_tokens where token_hash = repeat('a', 64)) <> 'sess-1' then
    raise exception '3: the redeeming session was not recorded';
  end if;

  -- the replay. Copied from a redirect, shared, retried by a script — all the same thing.
  select * into r from public.rescript_admission_redeem(repeat('a', 64), 'c0000000-0000-0000-0000-000000000186', 'sess-2', null);
  if r.ok then raise exception '3: a token was redeemed twice'; end if;
  if r.reason <> 'already_used' then raise exception '3: a replay said "%" instead of already_used', r.reason; end if;
  if (select redeemed_session from public.survey_access_tokens where token_hash = repeat('a', 64)) <> 'sess-1' then
    raise exception '3: a refused replay overwrote the original redemption';
  end if;

  -- a token for another study is unknown here, not merely refused: it must not leak that it exists
  select * into r from public.rescript_admission_redeem(repeat('b', 64), 'c0000000-0000-0000-0000-000000000187', 'sess-3', null);
  if r.ok or r.reason <> 'unknown' then raise exception '3: a token worked for the wrong survey (%)', r.reason; end if;
  -- and it still works for its own
  select * into r from public.rescript_admission_redeem(repeat('b', 64), 'c0000000-0000-0000-0000-000000000186', 'sess-4', null);
  if not r.ok then raise exception '3: the cross-survey attempt consumed the token'; end if;

  -- expiry is checked in the same statement as the redemption, so nothing slips through a read-then-write gap
  -- a token issued an hour ago that lapsed a minute ago. Both timestamps move: the window constraint
  -- (expires_at > issued_at) correctly refuses a token that expired before it was issued.
  update public.survey_access_tokens
     set issued_at = now() - interval '1 hour', expires_at = now() - interval '1 minute'
   where token_hash = repeat('c', 64);
  select * into r from public.rescript_admission_redeem(repeat('c', 64), 'c0000000-0000-0000-0000-000000000186', 'sess-5', null);
  if r.ok or r.reason <> 'expired' then raise exception '3: an expired token gave "%"', r.reason; end if;

  -- a token nobody issued
  select * into r from public.rescript_admission_redeem(repeat('f', 64), 'c0000000-0000-0000-0000-000000000186', 'sess-6', null);
  if r.ok or r.reason <> 'unknown' then raise exception '3: an invented token gave "%"', r.reason; end if;

  raise notice 'PASS 3 redemption is single use; replay, expiry, wrong survey and invention each say why';
end $$;

/* ------------------------------------------------------------ 4. the density counts */

do $$
declare r record; n int;
begin
  insert into public.identity_match_tokens (customer_id, trust_id, kind, token, key_id, strength) values
    ('c0000000-0000-0000-0000-000000000086', 'c0000086-0000-0000-0000-00000000000a', 'network', 'net-sharedsharedshar', 'k1', 'probabilistic')
  on conflict do nothing;

  -- one person arriving twenty times is ONE identity. Counting arrivals would manufacture the density signal.
  for n in 1..20 loop
    perform public.rescript_network_seen('c0000000-0000-0000-0000-000000000086', 'net-sharedsharedshar', 'c0000086-0000-0000-0000-00000000000a');
  end loop;
  select * into r from public.rescript_network_seen('c0000000-0000-0000-0000-000000000086', 'net-sharedsharedshar', null);
  if r.identities <> 1 then raise exception '4: twenty arrivals by one person counted as % identities', r.identities; end if;
  if (select arrivals from public.network_reputation
       where customer_id = 'c0000000-0000-0000-0000-000000000086' and network_token = 'net-sharedsharedshar') < 21 then
    raise exception '4: the arrivals were not counted separately from the identities';
  end if;

  -- a second person on the same network is a second identity
  insert into public.respondent_trust_ids (id, customer_id, trust_id) values
    ('c0000086-0000-0000-0000-00000000000c', 'c0000000-0000-0000-0000-000000000086', 'rtid_admission00000002') on conflict do nothing;
  insert into public.identity_match_tokens (customer_id, trust_id, kind, token, key_id, strength) values
    ('c0000000-0000-0000-0000-000000000086', 'c0000086-0000-0000-0000-00000000000c', 'network', 'net-sharedsharedshar', 'k1', 'probabilistic')
  on conflict do nothing;
  select * into r from public.rescript_network_seen('c0000000-0000-0000-0000-000000000086', 'net-sharedsharedshar', null);
  if r.identities <> 2 then raise exception '4: two people on one network counted as % identities', r.identities; end if;

  -- an unknown network reports nothing rather than claiming it is clean
  select * into r from public.rescript_network_seen('c0000000-0000-0000-0000-000000000086', 'net-brandnewnetwork1', null);
  if r.identities <> 0 then raise exception '4: a new network already had identities'; end if;
  if r.datacenter or r.tor then raise exception '4: an unchecked network claimed a reputation'; end if;
  if r.provider_risk is not null then raise exception '4: an unchecked network invented a provider risk'; end if;

  raise notice 'PASS 4 identities are distinct people, arrivals are arrivals, and an unchecked network claims nothing';
end $$;

/* ------------------------------------------------------------ 5. review, clearing and appeal */

do $$
declare r record; v_case uuid; v_risk numeric;
begin
  select id into v_case from public.fraud_cases
    where ledger_id = 'c0000086-0000-0000-0000-00000000000b' and status = 'open' limit 1;
  if v_case is null then raise exception '5: no open case to review'; end if;
  if not (select holds_payment from public.fraud_cases where id = v_case) then
    raise exception '5: an open case does not hold the complete from billing';
  end if;

  -- CLEARED: a false positive. The complete becomes billable…
  select * into r from public.rescript_fraud_resolve(v_case, 'cleared', 'c0000086-0000-0000-0000-000000000001', 'shared office address');
  if not r.resolved or r.status <> 'cleared' then raise exception '5: clearing failed'; end if;
  if (select holds_payment from public.fraud_cases where id = v_case) then
    raise exception '5: a cleared case still holds payment';
  end if;
  -- …and the identity's standing risk comes back down, or one false positive follows them for ever
  select risk_score into v_risk from public.respondent_trust_ids where id = 'c0000086-0000-0000-0000-00000000000a';
  if v_risk <> 0 then raise exception '5: a cleared case left the identity at risk %', v_risk; end if;

  -- resolving a resolved case changes nothing
  select * into r from public.rescript_fraud_resolve(v_case, 'upheld', null, null);
  if r.resolved then raise exception '5: a resolved case was resolved again'; end if;
  if (select status from public.fraud_cases where id = v_case) <> 'cleared' then
    raise exception '5: a second resolution overwrote the first';
  end if;

  -- UPHELD: the identity is quarantined and the complete stays held
  insert into public.fraud_cases (id, customer_id, survey_id, trust_id, risk_score, reasons)
    values ('c0000086-0000-0000-0000-00000000000d', 'c0000000-0000-0000-0000-000000000086',
            'c0000000-0000-0000-0000-000000000186', 'c0000086-0000-0000-0000-00000000000c', 70, '{device.webdriver}');
  perform public.rescript_fraud_resolve('c0000086-0000-0000-0000-00000000000d', 'upheld', 'c0000086-0000-0000-0000-000000000001', 'headless browser');
  if (select status from public.respondent_trust_ids where id = 'c0000086-0000-0000-0000-00000000000c') <> 'quarantined' then
    raise exception '5: an upheld case did not quarantine the identity';
  end if;
  if not (select holds_payment from public.fraud_cases where id = 'c0000086-0000-0000-0000-00000000000d') then
    raise exception '5: an upheld case released the payment';
  end if;

  -- APPEAL: §20's false-positive mechanism. An upheld case without one is an accusation with no answer to it.
  insert into public.fraud_cases (id, customer_id, survey_id, trust_id, risk_score)
    values ('c0000086-0000-0000-0000-00000000000e', 'c0000000-0000-0000-0000-000000000086',
            'c0000000-0000-0000-0000-000000000186', 'c0000086-0000-0000-0000-00000000000c', 55);
  select * into r from public.rescript_fraud_resolve('c0000086-0000-0000-0000-00000000000e', 'appealed', null, 'respondent says it is a shared family tablet');
  if not r.resolved or r.status <> 'appealed' then raise exception '5: the appeal was not recorded'; end if;
  if (select appealed_at from public.fraud_cases where id = 'c0000086-0000-0000-0000-00000000000e') is null then
    raise exception '5: the appeal has no timestamp';
  end if;
  -- an appealed case is still open for a human, and can then be cleared
  select * into r from public.rescript_fraud_resolve('c0000086-0000-0000-0000-00000000000e', 'cleared', 'c0000086-0000-0000-0000-000000000001', 'accepted');
  if not r.resolved then raise exception '5: an appealed case could not then be cleared'; end if;

  raise notice 'PASS 5 clearing releases payment and lowers standing risk; upholding quarantines; appeals are recorded and answerable';
end $$;

/* ------------------------------------------------------------ 6. RLS and cascade */

grant select on public.network_reputation, public.admission_decisions, public.fraud_cases to authenticated;

do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub', 'c0000086-0000-0000-0000-000000000001', true);
  set local role authenticated;
  select count(*) into n from public.admission_decisions;
  if n < 1 then raise exception '6: a member reads none of its own admission decisions'; end if;
  select count(*) into n from public.fraud_cases;
  if n < 1 then raise exception '6: a member reads none of its own cases'; end if;
  begin
    perform token_hash from public.survey_access_tokens limit 1;
    raise exception '6: a member read a token hash';
  exception when insufficient_privilege then null; end;
  begin
    update public.fraud_cases set status = 'cleared' where id = 'c0000086-0000-0000-0000-00000000000d';
    raise exception '6: a member resolved a case directly';
  exception when insufficient_privilege then null; end;
  reset role;

  perform set_config('request.jwt.claim.sub', 'c0000086-0000-0000-0000-000000000002', true);
  set local role authenticated;
  select count(*) into n from public.fraud_cases;
  if n <> 0 then raise exception '6: another organisation read % cases', n; end if;
  select count(*) into n from public.admission_decisions;
  if n <> 0 then raise exception '6: another organisation read % decisions', n; end if;
  reset role;

  delete from public.surveys where id = 'c0000000-0000-0000-0000-000000000186';
  select count(*) into n from public.admission_decisions where survey_id = 'c0000000-0000-0000-0000-000000000186';
  if n <> 0 then raise exception '6: % decisions outlived the survey', n; end if;
  select count(*) into n from public.survey_access_tokens where survey_id = 'c0000000-0000-0000-0000-000000000186';
  if n <> 0 then raise exception '6: % tokens outlived the survey', n; end if;
  -- the network's reputation belongs to the ORGANISATION and survives any one study
  select count(*) into n from public.network_reputation where customer_id = 'c0000000-0000-0000-0000-000000000086';
  if n < 1 then raise exception '6: the network reputation was destroyed with the study'; end if;

  raise notice 'PASS 6 RLS holds, no member reads a token hash, decisions and tokens cascade, reputation does not';
end $$;

rollback;
