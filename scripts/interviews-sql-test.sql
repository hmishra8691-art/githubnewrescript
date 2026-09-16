-- INTERVIEWS + BILLING SUBJECT SQL TEST (migrations 0030, 0031)
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/interviews-sql-test.sql
--
-- Proves, in the database where it is enforced:
--   · a second product bills through the SAME wallet, ledger and rate card,
--     with its own per-project cap, and a survey's billing is unchanged;
--   · an idempotency key makes a retried charge free, which is what lets a job
--     queue retry at all;
--   · the cascade the dropped foreign key used to give us still happens;
--   · two runners racing for one job cannot both get it;
--   · a stale claim is reclaimable and an exhausted one is not;
--   · the retention and abandoned-upload sweeps find exactly what they should.
begin;

insert into public.customers (id, slug, name)
  values ('dddddddd-0000-0000-0000-000000000001', 'iv', 'Interview Test') on conflict do nothing;
insert into auth.users (id, email)
  values ('dddddddd-0000-0000-0000-00000000000a', 'hiring@example.test') on conflict do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
  values ('dddddddd-0000-0000-0000-00000000000a', 'dddddddd-0000-0000-0000-000000000001',
          'hiring@example.test', 'Hiring Manager', 'researcher')
  on conflict (id) do nothing;

/* a survey owned by the same person, so the two products can be compared */
insert into public.surveys (id, customer_id, code, title, owner_id) values
  ('dddddddd-0000-0000-0000-00000000000b', 'dddddddd-0000-0000-0000-000000000001',
   'SURV', 'A survey', 'dddddddd-0000-0000-0000-00000000000a')
  on conflict do nothing;

insert into public.interview_projects (id, customer_id, owner_id, code, name, retention_days)
  values ('dddddddd-0000-0000-0000-00000000000c', 'dddddddd-0000-0000-0000-000000000001',
          'dddddddd-0000-0000-0000-00000000000a', 'ENG24', 'Engineering hiring 2024', 30)
  on conflict do nothing;

create or replace function pg_temp.ev(
  p_kind text, p_subject uuid, p_wallet uuid, p_charge numeric, p_key text default null
) returns jsonb language sql as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'customerId', 'dddddddd-0000-0000-0000-000000000001',
    'surveyId', p_subject, 'subjectKind', p_kind, 'walletId', p_wallet,
    'eventType', 'VIDEO_PROCESSING_MINUTE', 'category', 'processing', 'environment', 'LIVE',
    'provider', 'rescript', 'service', 'media', 'model', 'test',
    'quantity', 1, 'unit', 'minute',
    'providerCost', p_charge / 2, 'infraCost', 0, 'paymentFee', 0, 'taxReserve', 0,
    'customerCharge', p_charge, 'grossProfit', p_charge / 2, 'netProfit', p_charge / 2,
    'marginPct', 50, 'idempotencyKey', p_key, 'metadata', '{"billable":true}'::jsonb))
$$;

do $$
declare
  cust uuid := 'dddddddd-0000-0000-0000-000000000001';
  own  uuid := 'dddddddd-0000-0000-0000-00000000000a';
  surv uuid := 'dddddddd-0000-0000-0000-00000000000b';
  proj uuid := 'dddddddd-0000-0000-0000-00000000000c';
  w public.project_wallets; w2 public.project_wallets;
  r jsonb; s jsonb; sp public.project_spending; before numeric; lines integer;
begin
  /* ============ 1. one wallet funds both products ============ */

  w  := public.rescript_billing_subject_wallet_for(cust, 'interview', proj, true, 0);
  assert w.id is not null, 'an interview project resolves a wallet';
  assert w.user_id = own, 'and it is the OWNER''s personal wallet';
  assert w.survey_id is null, 'not a project wallet of its own';

  w2 := public.rescript_billing_wallet_for(cust, surv, true, 0);
  assert w2.id = w.id,
    'the same person''s survey and interview project share one wallet — that is the point of 0025';

  perform public.rescript_billing_credit(w.id, 100, 'credit', 'deposit', 'Top-up', own, null, null, null, 0);
  assert (select balance from public.project_wallets where id = w.id) = 100;

  /* ============ 2. the interview project has its own cap ============ */

  sp := public.rescript_billing_set_subject_spending('interview', proj, cust, 'budget', 5);
  assert sp.subject_kind = 'interview', 'the policy knows what kind of thing it is for';
  assert sp.subject_id = proj;
  assert sp.budget_limit = 5;

  r := public.rescript_billing_reserve(w.id, cust, proj, own, 'VIDEO_PROCESSING_MINUTE', 'LIVE', 2, 4, 0, 30, 'interview');
  assert (r->>'ok')::boolean, 'within the cap it may spend';
  perform public.rescript_billing_settle((r->'reservation'->>'id')::uuid, pg_temp.ev('interview', proj, w.id, 4), 0);

  r := public.rescript_billing_reserve(w.id, cust, proj, own, 'VIDEO_PROCESSING_MINUTE', 'LIVE', 2, 4, 0, 30, 'interview');
  assert not (r->>'ok')::boolean, 'past the cap it is refused';
  assert (r->>'reason') = 'project_limit',
    'and the reason names the project, not the wallet: ' || coalesce(r->>'reason', 'null');
  assert (select balance from public.project_wallets where id = w.id) = 96,
    'the wallet lost only what was actually spent';

  /* the SURVEY is untouched by the interview project's cap */
  r := public.rescript_billing_reserve(w.id, cust, surv, own, 'AI_REQUEST', 'LIVE', 5, 10, 0, 30);
  assert (r->>'ok')::boolean,
    'a survey on the same wallet is not frozen by an interview project reaching its limit';
  perform public.rescript_billing_release((r->'reservation'->>'id')::uuid, 'released');

  /* and the two policies are separate rows that cannot collide */
  perform public.rescript_billing_set_spending(surv, cust, 'budget', 50);
  assert (select count(*) from public.project_spending
           where subject_id in (surv, proj)) = 2,
    'two subjects, two policies';
  assert (select budget_limit from public.project_spending
           where subject_kind = 'interview' and subject_id = proj) = 5,
    'the interview cap was not overwritten by the survey one';

  /* ============ 3. a reservation carries its subject kind home ============ */

  r := public.rescript_billing_reserve(w.id, cust, proj, own, 'VIDEO_PROCESSING_MINUTE', 'LIVE', 1, 1, -100, 30, 'interview');
  assert (r->>'ok')::boolean, 'with overdraft room the frozen project is still capped…';
  assert (r->'reservation'->>'subject_kind') = 'interview',
    'the hold records what kind of subject it is for';
  perform public.rescript_billing_release((r->'reservation'->>'id')::uuid, 'released');
  assert (select reserved from public.project_spending
           where subject_kind = 'interview' and subject_id = proj) = 0,
    'and releasing it credits the INTERVIEW policy, not a survey with the same id';

  /* ============ 4. idempotency: a retried charge is free ============ */

  before := (select balance from public.project_wallets where id = w.id);
  s := public.rescript_billing_record(pg_temp.ev('interview', proj, w.id, 3, 'job-42'), 0);
  assert (select balance from public.project_wallets where id = w.id) = before - 3,
    'the first charge debits';
  s := public.rescript_billing_record(pg_temp.ev('interview', proj, w.id, 3, 'job-42'), 0);
  assert (select balance from public.project_wallets where id = w.id) = before - 3,
    'the SAME key charges nothing the second time — this is what lets a job retry';
  assert (select count(*) from public.usage_events where idempotency_key = 'job-42') = 1,
    'and writes no second event';
  select count(*) into lines from public.wallet_ledger
   where usage_event_id = (select id from public.usage_events where idempotency_key = 'job-42');
  assert lines = 1, 'nor a second ledger line';

  /* a different key is a different charge, as it must be */
  s := public.rescript_billing_record(pg_temp.ev('interview', proj, w.id, 3, 'job-43'), 0);
  assert (select balance from public.project_wallets where id = w.id) = before - 6,
    'a different key is a different piece of work';

  /* an event with no key behaves exactly as it always did */
  before := (select balance from public.project_wallets where id = w.id);
  perform public.rescript_billing_record(pg_temp.ev('interview', proj, w.id, 2), 0);
  perform public.rescript_billing_record(pg_temp.ev('interview', proj, w.id, 2), 0);
  assert (select balance from public.project_wallets where id = w.id) = before - 4,
    'unkeyed charges are not deduplicated — nothing that did not ask for it is changed';

  raise notice 'INTERVIEW BILLING: all assertions passed';
end $$;

/* ============ 5. the cascade the foreign key used to give us ============ */

do $$
declare gone integer;
begin
  insert into public.surveys (id, customer_id, code, title)
    values ('dddddddd-0000-0000-0000-00000000000d', 'dddddddd-0000-0000-0000-000000000001', 'TMP', 'Temp');
  perform public.rescript_billing_set_spending(
    'dddddddd-0000-0000-0000-00000000000d', 'dddddddd-0000-0000-0000-000000000001', 'budget', 9);
  assert (select count(*) from public.project_spending
           where subject_id = 'dddddddd-0000-0000-0000-00000000000d') = 1;
  delete from public.surveys where id = 'dddddddd-0000-0000-0000-00000000000d';
  select count(*) into gone from public.project_spending
   where subject_id = 'dddddddd-0000-0000-0000-00000000000d';
  assert gone = 0, 'deleting a survey still takes its spending policy with it';

  insert into public.interview_projects (id, customer_id, code, name)
    values ('dddddddd-0000-0000-0000-00000000000e', 'dddddddd-0000-0000-0000-000000000001', 'TMP', 'Temp');
  perform public.rescript_billing_set_subject_spending(
    'interview', 'dddddddd-0000-0000-0000-00000000000e', 'dddddddd-0000-0000-0000-000000000001', 'budget', 9);
  delete from public.interview_projects where id = 'dddddddd-0000-0000-0000-00000000000e';
  select count(*) into gone from public.project_spending
   where subject_id = 'dddddddd-0000-0000-0000-00000000000e';
  assert gone = 0, 'and so does deleting an interview project';

  raise notice 'CASCADE: all assertions passed';
end $$;

/* ============ 6. the job queue ============ */

do $$
declare
  cust uuid := 'dddddddd-0000-0000-0000-000000000001';
  proj uuid := 'dddddddd-0000-0000-0000-00000000000c';
  a public.interview_jobs; b public.interview_jobs; j public.interview_jobs;
  iv uuid;
begin
  insert into public.interviews (id, project_id, customer_id, token_hash, token_prefix)
    values (gen_random_uuid(), proj, cust, 'hash-1', 'abc12') returning id into iv;

  insert into public.interview_jobs (customer_id, project_id, interview_id, kind, subject_id, idempotency_key)
    values (cust, proj, iv, 'transcription', iv, 'tx-1');

  a := public.rescript_interview_claim_job('transcription');
  assert a.id is not null, 'a queued job is claimable';
  assert a.status = 'running' and a.attempts = 1, 'and is marked running once';

  b := public.rescript_interview_claim_job('transcription');
  assert b.id is null, 'a second runner gets nothing — skip locked is what stops double billing';

  /* a job of another kind is not taken by this runner */
  insert into public.interview_jobs (customer_id, project_id, interview_id, kind, subject_id)
    values (cust, proj, iv, 'analysis', iv);
  b := public.rescript_interview_claim_job('transcription');
  assert b.id is null, 'and a runner only claims its own kind';
  b := public.rescript_interview_claim_job('analysis');
  assert b.id is not null, 'while the analysis runner gets the analysis';

  /* a stale claim is reclaimable — a serverless function that was killed */
  update public.interview_jobs set claimed_at = now() - interval '20 minutes' where id = a.id;
  j := public.rescript_interview_claim_job('transcription', 300);
  assert j.id = a.id, 'a job abandoned mid-flight is picked up again';
  assert j.attempts = 2, 'and the attempt is counted';

  /* an exhausted job stops being claimed, so nobody pays a provider for ever */
  update public.interview_jobs set attempts = max_attempts, status = 'failed' where id = a.id;
  j := public.rescript_interview_claim_job('transcription');
  assert j.id is null, 'a job that has used its attempts is not claimed again';

  /* a failure with attempts left comes back when the caller says so */
  update public.interview_jobs set attempts = 1 where id = a.id;
  j := public.rescript_interview_finish_job(a.id, 'failed', 'provider timeout', now() + interval '10 minutes');
  assert j.status = 'failed' and j.error = 'provider timeout';
  assert j.claimed_at is null, 'a finished job is not still claimed';
  j := public.rescript_interview_claim_job('transcription');
  assert j.id is null, 'and it is not claimable before its run_after';
  update public.interview_jobs set run_after = now() - interval '1 second' where id = a.id;
  j := public.rescript_interview_claim_job('transcription');
  assert j.id = a.id, 'once the backoff has passed, it is';

  /* one key, one job */
  begin
    insert into public.interview_jobs (customer_id, project_id, interview_id, kind, idempotency_key)
      values (cust, proj, iv, 'transcription', 'tx-1');
    assert false, 'a duplicate idempotency key must be refused';
  exception when unique_violation then null;
  end;

  raise notice 'JOB QUEUE: all assertions passed';
end $$;

/* ============ 7. the sweeps ============ */

do $$
declare
  cust uuid := 'dddddddd-0000-0000-0000-000000000001';
  proj uuid := 'dddddddd-0000-0000-0000-00000000000c';
  iv uuid; q uuid; resp uuid; n integer; bytes bigint;
begin
  insert into public.interviews (id, project_id, customer_id, token_hash, token_prefix, status, completed_at)
    values (gen_random_uuid(), proj, cust, 'hash-2', 'def34', 'completed', now() - interval '40 days')
    returning id into iv;
  insert into public.interview_questions (id, project_id, code, prompt)
    values (gen_random_uuid(), proj, 'Q1', 'Tell us about a project') returning id into q;
  insert into public.interview_responses (id, interview_id, project_id, customer_id, question_id)
    values (gen_random_uuid(), iv, proj, cust, q) returning id into resp;

  insert into public.interview_media
    (customer_id, project_id, interview_id, response_id, question_id, kind, storage_key,
     upload_status, file_size)
    values (cust, proj, iv, resp, q, 'answer_video',
            'organizations/x/interviews/y/responses/z/recording.webm', 'stored', 36000000);

  /* retention: the project keeps 30 days, this interview finished 40 days ago */
  select count(*) into n from public.rescript_interview_retention_due(50) where interview_id = iv;
  assert n = 1, 'an interview past its retention window is due';

  update public.interviews set media_purged_at = now() where id = iv;
  select count(*) into n from public.rescript_interview_retention_due(50) where interview_id = iv;
  assert n = 0, 'and is not due again once its media has gone';

  /* the storage cap reads only what is actually stored */
  select public.rescript_interview_storage_bytes(proj) into bytes;
  assert bytes = 36000000, 'stored bytes are counted: ' || bytes;

  insert into public.interview_media
    (customer_id, project_id, interview_id, response_id, kind, storage_key, upload_status, file_size, created_at)
    values (cust, proj, iv, resp, 'answer_audio',
            'organizations/x/interviews/y/responses/z/abandoned.webm', 'pending', 999,
            now() - interval '4 hours');
  select public.rescript_interview_storage_bytes(proj) into bytes;
  assert bytes = 36000000, 'a pending upload is not storage anybody is charged for';

  select count(*) into n from public.rescript_interview_abandoned_uploads(120, 100);
  assert n = 1, 'a two-hour-old pending row is an upload nobody finished';
  select count(*) into n from public.rescript_interview_abandoned_uploads(600, 100);
  assert n = 0, 'and is not abandoned yet under a longer window';

  /* one response holds one live answer per question */
  begin
    insert into public.interview_responses (interview_id, project_id, customer_id, question_id)
      values (iv, proj, cust, q);
    assert false, 'a second answer to the same question must be refused';
  exception when unique_violation then null;
  end;

  /* duplicate protection: one client token means one object */
  update public.interview_media set client_token = 'take-1'
   where response_id = resp and kind = 'answer_video';
  begin
    insert into public.interview_media
      (customer_id, project_id, interview_id, response_id, kind, storage_key, client_token)
      values (cust, proj, iv, resp, 'answer_video', 'organizations/x/dup.webm', 'take-1');
    assert false, 'the same take uploaded twice must be refused';
  exception when unique_violation then null;
  end;

  raise notice 'SWEEPS: all assertions passed';
end $$;

/* ============ 8. the transcript claim ============ */

do $$
declare
  cust uuid := 'dddddddd-0000-0000-0000-000000000001';
  proj uuid := 'dddddddd-0000-0000-0000-00000000000c';
  m uuid; t public.interview_transcripts; t2 public.interview_transcripts;
begin
  insert into public.interview_media (customer_id, project_id, kind, storage_key, upload_status)
    values (cust, proj, 'answer_audio', 'organizations/x/t.webm', 'stored') returning id into m;
  insert into public.interview_transcripts (media_id, project_id) values (m, proj);

  t := public.rescript_interview_claim_transcript(m);
  assert t.id is not null and t.status = 'processing' and t.attempts = 1;
  t2 := public.rescript_interview_claim_transcript(m);
  assert t2.id is null, 'a second runner cannot claim the same clip and bill for it twice';

  update public.interview_transcripts set claimed_at = now() - interval '10 minutes' where id = t.id;
  t2 := public.rescript_interview_claim_transcript(m, 300);
  assert t2.id = t.id and t2.attempts = 2, 'a stale claim is reclaimable';

  update public.interview_transcripts set attempts = 3, status = 'failed' where id = t.id;
  t2 := public.rescript_interview_claim_transcript(m);
  assert t2.id is null,
    'three failures is enough — automatic re-driving stops paying for an unreadable clip';

  raise notice 'TRANSCRIPT CLAIM: all assertions passed';
end $$;

/* ============ 9. nothing here is reachable without the service role ======= */

do $$
declare n integer;
begin
  select count(*) into n
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relname like 'interview%' and c.relkind = 'r'
     and not c.relrowsecurity;
  assert n = 0, n || ' interview table(s) have RLS switched off';

  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'rescript_interview%'
     and has_function_privilege('anon', p.oid, 'execute');
  assert n = 0, n || ' interview function(s) are callable with the anon key';

  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname like 'rescript_billing_subject%'
     and has_function_privilege('anon', p.oid, 'execute');
  assert n = 0, n || ' new billing function(s) are callable with the anon key';

  raise notice 'PERMISSIONS: all assertions passed';
end $$;

rollback;
