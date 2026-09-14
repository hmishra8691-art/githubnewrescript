-- ============================================================================
-- QUALITATIVE MEDIA DELIVERY — the guarantees that live in the database.
--
--   psql "$SUPABASE_DB_URL" -f scripts/media-delivery-sql-test.sql
--
-- Needs migrations 0001–0029. Runs inside a transaction and ROLLS BACK, so it
-- is safe against any database including a populated one — unlike
-- `scripts/mail-sql-test.sql`, which creates fixtures and leaves them.
--
-- What is proven here rather than in `packages/media`:
--
--   · discovery picks exactly the right responses, and no others — the test
--     ones, the unfinished uploads, the projects with delivery switched off
--     and the responses older than the retention window all stay out;
--   · one response can produce one delivery and only one, enforced by an
--     index rather than by a query being careful;
--   · the retry backoff is an instant that an unrelated write cannot reset;
--   · a run that dies mid-delivery does not strand the work;
--   · AND THE ONE THAT MATTERS MOST: deleting the recording leaves the
--     transcript, the answers and the response exactly where they were.
-- ============================================================================

begin;

create temp table t_out (n int generated always as identity, check_name text, pass boolean, detail text) on commit drop;
/*
 * `p_detail` is the message for a FAILURE — "claimed too soon", "stranded" —
 * so it is blanked on a pass. A test whose passing output reads like a list
 * of disasters is a test people learn to skim.
 */
create or replace function t_assert(p_name text, p_pass boolean, p_detail text default '') returns void
language sql as $$
  insert into t_out(check_name, pass, detail) values (p_name, p_pass, case when p_pass then '' else p_detail end);
$$;

do $$
declare
  v_cust uuid;
  v_on uuid; v_off uuid; v_von uuid; v_voff uuid;
  v_r_live uuid; v_r_test uuid; v_r_off uuid; v_r_partial uuid; v_did uuid;
  v_media uuid;
  v_n int; v_row record; v_claim record; v_answers jsonb;
begin
  select id into v_cust from public.customers order by created_at limit 1;

  /* ---------------------------------------------------------- fixtures */

  insert into public.surveys (customer_id, code, title, status, media_delivery_email, media_delivery_enabled)
  values (v_cust, 'ZZTEST_DELIV_ON', 'Delivery On', 'draft', 'researcher@example.com', true) returning id into v_on;
  insert into public.survey_versions (survey_id, version, definition)
  values (v_on, '1.0', '{"meta":{"id":"x","title":"t"}}'::jsonb) returning id into v_von;

  insert into public.surveys (customer_id, code, title, status)
  values (v_cust, 'ZZTEST_DELIV_OFF', 'Delivery Off', 'draft') returning id into v_off;
  insert into public.survey_versions (survey_id, version, definition)
  values (v_off, '1.0', '{"meta":{"id":"y","title":"t"}}'::jsonb) returning id into v_voff;

  /* a complete, live response with two stored recordings AND a transcript
     already merged into its answers, which is the state the sweep meets */
  insert into public.responses (survey_id, version_id, session_id, status, is_test, completed_at, respondent_code, answers)
  values (v_on, v_von, 'zzsess_live', 'complete', false, now() - interval '5 minutes', 'R-0001',
          '{"q_iv": {"transcript": {"text": "I mostly drink it in the morning.", "source": "provider"}, "seconds": 31}}'::jsonb)
  returning id into v_r_live;

  insert into public.media_objects (customer_id, survey_id, response_id, session_id, question_id, kind, bucket, path, status, bytes, original_filename, answer_key)
  values (v_cust, v_on, v_r_live, 'zzsess_live', 'q_iv', 'answer_audio', 'rescript-uploads', 'zzsess_live/q_iv/1-a.webm', 'stored', 1000, 'a.webm', 'q_iv')
  returning id into v_media;
  insert into public.media_objects (customer_id, survey_id, response_id, session_id, question_id, kind, bucket, path, status, bytes, original_filename, answer_key)
  values (v_cust, v_on, v_r_live, 'zzsess_live', 'q_up', 'answer_upload', 'rescript-uploads', 'zzsess_live/q_up/2-b.mp4', 'stored', 2000, 'b.mp4', 'q_up');

  insert into public.media_transcripts (media_id, survey_id, status, text)
  values (v_media, v_on, 'completed', 'I mostly drink it in the morning.');

  insert into public.responses (survey_id, version_id, session_id, status, is_test, completed_at, answers)
  values (v_on, v_von, 'zzsess_test', 'complete', true, now() - interval '5 minutes', '{}'::jsonb) returning id into v_r_test;
  insert into public.media_objects (customer_id, survey_id, response_id, session_id, kind, bucket, path, status)
  values (v_cust, v_on, v_r_test, 'zzsess_test', 'answer_audio', 'rescript-uploads', 'zzsess_test/x.webm', 'stored');

  insert into public.responses (survey_id, version_id, session_id, status, is_test, completed_at, answers)
  values (v_off, v_voff, 'zzsess_off', 'complete', false, now() - interval '5 minutes', '{}'::jsonb) returning id into v_r_off;
  insert into public.media_objects (customer_id, survey_id, response_id, session_id, kind, bucket, path, status)
  values (v_cust, v_off, v_r_off, 'zzsess_off', 'answer_audio', 'rescript-uploads', 'zzsess_off/x.webm', 'stored');

  insert into public.responses (survey_id, version_id, session_id, status, is_test, completed_at, answers)
  values (v_on, v_von, 'zzsess_pending', 'complete', false, now() - interval '5 minutes', '{}'::jsonb) returning id into v_r_partial;
  insert into public.media_objects (customer_id, survey_id, response_id, session_id, kind, bucket, path, status)
  values (v_cust, v_on, v_r_partial, 'zzsess_pending', 'answer_audio', 'rescript-uploads', 'zzsess_pending/x.webm', 'pending');

  /* --------------------------------------------------------- discovery */

  select count(*) into v_n from public.rescript_media_deliveries_due(50, 48) d where d.survey_id = v_on;
  perform t_assert('discovery finds the one deliverable response', v_n = 1, format('found %s', v_n));

  select * into v_row from public.rescript_media_deliveries_due(50, 48) d where d.survey_id = v_on;
  perform t_assert('it is the live response, not the test one', v_row.session_id = 'zzsess_live', v_row.session_id);
  perform t_assert('it counts both recordings', v_row.media_count = 2, format('%s', v_row.media_count));
  perform t_assert('it carries the configured address', v_row.recipient_email = 'researcher@example.com', v_row.recipient_email);
  perform t_assert('it labels the respondent by their code', v_row.respondent_label = 'R-0001', coalesce(v_row.respondent_label, 'null'));

  select count(*) into v_n from public.rescript_media_deliveries_due(50, 48) d where d.session_id = 'zzsess_off';
  perform t_assert('a project with delivery off is never discovered', v_n = 0, format('%s', v_n));

  select count(*) into v_n from public.rescript_media_deliveries_due(50, 48) d where d.session_id = 'zzsess_pending';
  perform t_assert('an upload that never finished is not delivered', v_n = 0, format('%s', v_n));

  update public.responses set completed_at = now() - interval '10 days' where id = v_r_live;
  select count(*) into v_n from public.rescript_media_deliveries_due(50, 48) d where d.survey_id = v_on;
  perform t_assert('a response older than the retention window is left alone', v_n = 0, format('%s', v_n));
  update public.responses set completed_at = now() - interval '5 minutes' where id = v_r_live;

  /* ------------------------------------------ one delivery per response */

  insert into public.media_deliveries (customer_id, survey_id, response_id, session_id, recipient_email)
  values (v_cust, v_on, v_r_live, 'zzsess_live', 'researcher@example.com') returning id into v_did;

  select count(*) into v_n from public.rescript_media_deliveries_due(50, 48) d where d.survey_id = v_on;
  perform t_assert('once opened, the response is no longer discovered', v_n = 0, format('%s', v_n));

  begin
    insert into public.media_deliveries (customer_id, survey_id, response_id, session_id, recipient_email)
    values (v_cust, v_on, v_r_live, 'zzsess_live', 'researcher@example.com');
    perform t_assert('a second delivery for the same response is refused', false, 'the insert succeeded');
  exception when unique_violation then
    perform t_assert('a second delivery for the same response is refused', true, 'unique_violation');
  end;

  /* ------------------------------------------------------- the claim */

  select * into v_claim from public.rescript_claim_media_delivery(v_did);
  perform t_assert('a pending delivery can be claimed', v_claim.id is not null, '');
  perform t_assert('claiming counts an attempt', v_claim.attempts = 1, format('%s', v_claim.attempts));

  select * into v_claim from public.rescript_claim_media_delivery(v_did);
  perform t_assert('a delivery already being processed is not claimed twice', v_claim.id is null, 'claimed again');

  update public.media_deliveries set status = 'failed', attempts = 1, retry_after = now() + interval '10 minutes' where id = v_did;
  select * into v_claim from public.rescript_claim_media_delivery(v_did);
  perform t_assert('a failed delivery waits out its backoff', v_claim.id is null, 'claimed too soon');

  /*
   * The reason `retry_after` is a column rather than `updated_at + delay`:
   * the touch trigger rewrites `updated_at` on every write, so a backoff
   * derived from it is reset by anything that happens to touch the row.
   */
  update public.media_deliveries set error = 'a note written by something else' where id = v_did;
  select * into v_claim from public.rescript_claim_media_delivery(v_did);
  perform t_assert('an unrelated write does not restart the backoff', v_claim.id is null, 'the wait was reset');

  update public.media_deliveries set retry_after = now() - interval '1 second' where id = v_did;
  select * into v_claim from public.rescript_claim_media_delivery(v_did);
  perform t_assert('once the backoff has passed it is retried', v_claim.id is not null, 'not retried');
  perform t_assert('and the retry counts as an attempt', v_claim.attempts = 2, format('%s', v_claim.attempts));

  update public.media_deliveries set status = 'failed', attempts = 5, retry_after = now() - interval '1 day' where id = v_did;
  select * into v_claim from public.rescript_claim_media_delivery(v_did);
  perform t_assert('the attempt budget ends it', v_claim.id is null, 'retried past the budget');

  update public.media_deliveries set status = 'pending', attempts = 0, retry_after = null, error = null where id = v_did;
  select * into v_claim from public.rescript_claim_media_delivery(v_did);
  perform t_assert('a human retry puts it straight back in the queue', v_claim.id is not null, 'still stuck');

  update public.media_deliveries set status = 'processing', claimed_at = now() - interval '1 hour', attempts = 1 where id = v_did;
  select * into v_claim from public.rescript_claim_media_delivery(v_did, 300, 5);
  perform t_assert('a run that died mid-delivery does not strand it', v_claim.id is not null, 'stranded');

  /* ---------------------------------------------------------- expiry */

  update public.media_deliveries
  set status = 'sent', expires_at = now() + interval '1 hour', attempts = 1,
      manifest = '[{"mediaId":"x","bucket":"b","path":"p","fileName":"f.webm"}]'::jsonb
  where id = v_did;
  select count(*) into v_n from public.rescript_media_deliveries_expiring(50) e where e.id = v_did;
  perform t_assert('a live link is not expired early', v_n = 0, format('%s', v_n));

  update public.media_deliveries set expires_at = now() - interval '1 minute' where id = v_did;
  select count(*) into v_n from public.rescript_media_deliveries_expiring(50) e where e.id = v_did;
  perform t_assert('an overdue link IS picked up', v_n = 1, format('%s', v_n));

  update public.media_deliveries set status = 'deleted' where id = v_did;
  select count(*) into v_n from public.rescript_media_deliveries_expiring(50) e where e.id = v_did;
  perform t_assert('an already-deleted delivery is not swept again', v_n = 0, format('%s', v_n));

  /* ================================================================= *
   * DELETING THE RECORDING DOES NOT DELETE THE RESEARCH.
   *
   * This is the guarantee the whole feature rests on. `removeMedia` drops
   * the `media_objects` row, which cascades to `media_transcripts` — so the
   * transcription JOB goes. The transcript itself does not, because by
   * migration 0028 it is the answer value inside `responses.answers`.
   * ================================================================= */

  delete from public.media_objects where session_id = 'zzsess_live';

  select answers into v_answers from public.responses where id = v_r_live;
  perform t_assert('THE TRANSCRIPT SURVIVES THE DELETION',
    v_answers #>> '{q_iv,transcript,text}' = 'I mostly drink it in the morning.',
    coalesce(v_answers #>> '{q_iv,transcript,text}', 'GONE'));

  select count(*) into v_n from public.responses where id = v_r_live and status = 'complete';
  perform t_assert('the response is still a complete response', v_n = 1, format('%s', v_n));

  select count(*) into v_n from public.media_transcripts where media_id = v_media;
  perform t_assert('the transcription job is gone, as it should be', v_n = 0, format('%s', v_n));

  select count(*) into v_n from public.media_deliveries where id = v_did;
  perform t_assert('the delivery record outlives the media it delivered', v_n = 1, format('%s', v_n));

  select manifest into v_answers from public.media_deliveries where id = v_did;
  perform t_assert('and still says what was in the package',
    jsonb_array_length(v_answers) = 1, v_answers::text);

  /* --------------------------------------------------- the settings */

  begin
    update public.surveys set media_delivery_email = null where id = v_on;
    perform t_assert('delivery cannot stay on without an address', false, 'the update succeeded');
  exception when check_violation then
    perform t_assert('delivery cannot stay on without an address', true, 'check_violation');
  end;

  select count(*) into v_n from public.rescript_media_delivery_status(v_on);
  perform t_assert('the Studio can list this project''s deliveries', v_n = 1, format('%s', v_n));

  begin
    insert into public.mail_deliveries (customer_id, survey_id, kind, to_email, subject, status)
    values (v_cust, v_on, 'media_delivery', 'researcher@example.com', 'x', 'sent');
    perform t_assert('media_delivery is an allowed kind of mail', true, '');
  exception when check_violation then
    perform t_assert('media_delivery is an allowed kind of mail', false, 'the kind was rejected');
  end;

  /* --------------------------------------------------- least privilege */

  select count(*) into v_n
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'media_deliveries'
    and grantee in ('anon', 'authenticated', 'PUBLIC');
  perform t_assert('media_deliveries is unreachable with the anon key', v_n = 0, format('%s grant(s)', v_n));
end $$;

select
  case when bool_and(pass) then 'ALL CHECKS PASSED' else format('%s FAILURE(S)', count(*) filter (where not pass)) end as summary
from t_out;

select n, check_name, case when pass then 'ok' else 'FAIL' end as result, detail from t_out order by n;

rollback;
