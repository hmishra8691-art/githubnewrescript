/* ============================================================================
 * 0033 — PARTICIPANTS, AGAINST A REAL DATABASE
 *
 *   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/interview-participants-sql-test.sql
 *
 * The centre of this file is §21 of the brief: three recordings in one
 * interview, each with a DIFFERENT set of interviewers, and each keeping its
 * own list. That is the property the whole migration exists for, and it is the
 * one a per-interview participant list would silently fail.
 *
 * Everything else here is a way the list could be wrong without being empty:
 * the same colleague added twice under two spellings, a person from another
 * project appearing in a list they have no business in, and a diarization
 * mapping thrown away by an unrelated edit.
 *
 * Runs in a transaction and rolls back.
 * ==========================================================================*/

begin;

do $$
declare
  cust uuid; cust2 uuid; owner_id uuid;
  proj uuid; proj2 uuid;
  iv uuid; q1 uuid;
  rahul uuid; priya uuid; amit uuid; respondent uuid; outsider uuid;
  rec1 uuid; rec2 uuid; rec3 uuid;
  n integer; nm text; got uuid;
begin
  /* ------------------------------------------------------------ fixtures */
  insert into public.customers (slug, name) values ('qual-study', 'Qualitative Study')
    returning id into cust;
  insert into public.customers (slug, name) values ('other-co', 'Other Co')
    returning id into cust2;

  owner_id := gen_random_uuid();
  insert into auth.users (id, email) values (owner_id, 'lead@study.invalid');
  insert into public.profiles (id, customer_id, email, full_name, role, user_code, status)
    values (owner_id, cust, 'lead@study.invalid', 'Study Lead', 'programmer', 'LEAD0001', 'active')
    on conflict (id) do update
      set customer_id = excluded.customer_id, full_name = excluded.full_name,
          role = excluded.role, user_code = excluded.user_code, status = excluded.status;

  insert into public.interview_projects (customer_id, owner_id, code, name)
    values (cust, owner_id, 'qual-study', 'Qualitative Study') returning id into proj;
  insert into public.interview_projects (customer_id, code, name)
    values (cust2, 'other-study', 'Other Study') returning id into proj2;

  insert into public.interview_questions (project_id, code, prompt)
    values (proj, 'Q1', 'Tell us about your morning.') returning id into q1;

  insert into public.interviews
    (project_id, customer_id, candidate_name, token_hash, token_prefix)
    values (proj, cust, 'Respondent 001', repeat('r', 64), 'resp0001')
    returning id into iv;

  /* ============================ 1. THE RESPONDENT IS MIRRORED AUTOMATICALLY */

  select id, display_name into respondent, nm
    from public.interview_people where interview_id = iv and derived;
  assert respondent is not null, 'inserting an interview creates its respondent person row';
  assert nm = 'Respondent 001', format('the mirrored name follows candidate_name, got %s', nm);

  /* and it follows an edit rather than drifting from it */
  update public.interviews set candidate_name = 'Respondent 001 (renamed)' where id = iv;
  select display_name into nm from public.interview_people where id = respondent;
  assert nm = 'Respondent 001 (renamed)', format('the mirror follows a rename, got %s', nm);

  /* one mirror, not one per edit */
  select count(*) into n from public.interview_people where interview_id = iv and derived;
  assert n = 1, format('exactly one derived row per interview, got %s', n);

  /* ================================================= 2. THE INTERVIEWERS */

  insert into public.interview_people (customer_id, project_id, display_name, email, kind, user_id)
    values (cust, proj, 'Rahul Sharma', 'rahul@study.invalid', 'interviewer', owner_id)
    returning id into rahul;
  insert into public.interview_people (customer_id, project_id, display_name, email, kind)
    values (cust, proj, 'Priya Patel', 'priya@study.invalid', 'interviewer')
    returning id into priya;
  insert into public.interview_people (customer_id, project_id, display_name, email, kind)
    values (cust, proj, 'Amit Kumar', 'amit@study.invalid', 'interviewer')
    returning id into amit;

  /* ---- the same person must not arrive twice ---- */

  begin
    insert into public.interview_people (customer_id, project_id, display_name, user_id)
      values (cust, proj, 'R. Sharma', owner_id);
    assert false, 'the same Rescript account must not be addable twice to one project';
  exception when unique_violation then null;
  end;

  begin
    insert into public.interview_people (customer_id, project_id, display_name, email)
      values (cust, proj, 'PRIYA PATEL', '  PRIYA@STUDY.INVALID ');
    assert false, 'the same email in a different case must not be addable twice';
  exception when unique_violation then null;
  end;

  /* somebody with neither an account nor an email is not deduplicable, and that is fine */
  insert into public.interview_people (customer_id, project_id, display_name)
    values (cust, proj, 'Freelance Moderator');
  insert into public.interview_people (customer_id, project_id, display_name)
    values (cust, proj, 'Freelance Moderator');

  /* ================== 3. §21 — THREE RECORDINGS, THREE PARTICIPANT LISTS */

  insert into public.interview_media
    (customer_id, project_id, interview_id, question_id, kind, storage_key, upload_status)
    values (cust, proj, iv, q1, 'session_video', 'k/rec1', 'stored') returning id into rec1;
  insert into public.interview_media
    (customer_id, project_id, interview_id, question_id, kind, storage_key, upload_status)
    values (cust, proj, iv, q1, 'session_video', 'k/rec2', 'stored') returning id into rec2;
  insert into public.interview_media
    (customer_id, project_id, interview_id, question_id, kind, storage_key, upload_status)
    values (cust, proj, iv, q1, 'session_video', 'k/rec3', 'stored') returning id into rec3;

  n := public.rescript_interview_set_participants(
    rec1, array[rahul, priya, respondent],
    array['interviewer', 'interviewer', 'respondent'], owner_id);
  assert n = 3, format('recording 1 has three participants, got %s', n);

  n := public.rescript_interview_set_participants(
    rec2, array[rahul, respondent], array['interviewer', 'respondent'], owner_id);
  assert n = 2, format('recording 2 has two participants, got %s', n);

  n := public.rescript_interview_set_participants(
    rec3, array[amit, respondent], array['interviewer', 'respondent'], owner_id);
  assert n = 2, format('recording 3 has two participants, got %s', n);

  /*
   * THE ASSERTION THE MIGRATION EXISTS FOR. Each recording keeps its OWN list
   * — a participant list held at the interview level would give all three the
   * same answer here, and all three would be wrong for two of them.
   */
  select count(*) into n from public.interview_media_participants
   where media_id = rec1 and person_id = priya;
  assert n = 1, 'Priya is in recording 1';

  select count(*) into n from public.interview_media_participants
   where media_id = rec2 and person_id = priya;
  assert n = 0, 'Priya is NOT in recording 2 — lists are per recording, not per interview';

  select count(*) into n from public.interview_media_participants
   where media_id = rec3 and person_id = rahul;
  assert n = 0, 'Rahul is NOT in recording 3';

  select count(*) into n from public.interview_media_participants
   where media_id = rec3 and person_id = amit;
  assert n = 1, 'Amit is in recording 3, and only recording 3';

  /* the respondent is in all three, because they were */
  select count(*) into n from public.interview_media_participants
   where person_id = respondent;
  assert n = 3, format('the respondent is in all three recordings, got %s', n);

  /* ---- and the reverse question answers correctly ---- */
  select count(*) into n from public.rescript_interview_person_recordings(rahul);
  assert n = 2, format('Rahul appears in two recordings, got %s', n);
  select count(*) into n from public.rescript_interview_person_recordings(amit);
  assert n = 1, format('Amit appears in one recording, got %s', n);

  /* ---- reading one recording back, interviewers first ---- */
  select role into nm from public.rescript_interview_recording_participants(rec1) limit 1;
  assert nm = 'interviewer', format('interviewers are listed first, got %s', nm);

  /* ======================================= 4. EDITING A LIST IS A REPLACEMENT */

  n := public.rescript_interview_set_participants(
    rec1, array[rahul, respondent], array['interviewer', 'respondent'], owner_id);
  assert n = 2, format('the edited list replaces rather than appends, got %s', n);
  select count(*) into n from public.interview_media_participants
   where media_id = rec1 and person_id = priya;
  assert n = 0, 'Priya was removed by the replacement';

  /* an empty list is a legal answer — nobody has said who was there yet */
  n := public.rescript_interview_set_participants(rec2, null, null, owner_id);
  assert n = 0, 'a null list clears the participants';
  select count(*) into n from public.interview_media_participants where media_id = rec2;
  assert n = 0, 'and the rows are gone';
  /* put it back for later sections */
  perform public.rescript_interview_set_participants(
    rec2, array[rahul, respondent], array['interviewer', 'respondent'], owner_id);

  /* ============================= 5. A SPEAKER MAPPING SURVIVES AN UNRELATED EDIT */

  assert public.rescript_interview_map_speaker(rec1, rahul, 'Speaker 1', owner_id),
    'a speaker label can be mapped to a participant';
  assert public.rescript_interview_map_speaker(rec1, respondent, 'Speaker 2', owner_id),
    'and to another';

  /* somebody adds Priya back. That must not discard who Speaker 1 is. */
  perform public.rescript_interview_set_participants(
    rec1, array[rahul, priya, respondent],
    array['interviewer', 'interviewer', 'respondent'], owner_id);

  select speaker_label into nm from public.interview_media_participants
   where media_id = rec1 and person_id = rahul;
  assert nm = 'Speaker 1',
    format('editing the list must not throw away a confirmed mapping, got %s', nm);

  select speaker_label into nm from public.interview_media_participants
   where media_id = rec1 and person_id = priya;
  assert nm is null, 'a newly added participant has no mapping — uncertainty is preserved';

  /* withdrawing a guess clears who confirmed it too */
  assert public.rescript_interview_map_speaker(rec1, rahul, null, owner_id), 'a mapping can be withdrawn';
  select count(*) into n from public.interview_media_participants
   where media_id = rec1 and person_id = rahul
     and speaker_label is null and confirmed_by is null and confirmed_at is null;
  assert n = 1, 'withdrawing a mapping clears the label and its attribution together';

  /* mapping somebody who is not on the recording changes nothing and says so */
  assert not public.rescript_interview_map_speaker(rec2, amit, 'Speaker 9', owner_id),
    'a person who is not in the recording cannot be given one of its voices';

  /* ================================ 6. A PERSON CANNOT CROSS A PROJECT BOUNDARY */

  insert into public.interview_people (customer_id, project_id, display_name)
    values (cust2, proj2, 'Someone Else') returning id into outsider;

  begin
    perform public.rescript_interview_set_participants(
      rec1, array[rahul, outsider], array['interviewer', 'observer'], owner_id);
    assert false, 'a person from another project must not be addable to this recording';
  exception when others then null;
  end;

  /* and the refusal left the list alone */
  select count(*) into n from public.interview_media_participants where media_id = rec1;
  assert n = 3, format('a refused edit changes nothing, got %s participants', n);

  /* a person who does not exist at all */
  begin
    perform public.rescript_interview_set_participants(
      rec1, array[gen_random_uuid()], array['interviewer'], owner_id);
    assert false, 'an unknown person must be refused';
  exception when others then null;
  end;

  /* mismatched arrays are a caller bug, not a silent truncation */
  begin
    perform public.rescript_interview_set_participants(
      rec1, array[rahul, priya], array['interviewer'], owner_id);
    assert false, 'every participant needs a role';
  exception when others then null;
  end;

  /* ==================================== 7. DELETION CASCADES THE RIGHT WAY */

  delete from public.interview_media where id = rec3;
  select count(*) into n from public.interview_media_participants where media_id = rec3;
  assert n = 0, 'deleting a recording takes its participant list';
  select count(*) into n from public.interview_people where id = amit;
  assert n = 1, 'but NOT the person — Amit still exists for other recordings';

  /* removing a person removes them from the recordings they were in */
  delete from public.interview_people where id = priya;
  select count(*) into n from public.interview_media_participants where person_id = priya;
  assert n = 0, 'deleting a person removes their presences';
  select count(*) into n from public.interview_media_participants where media_id = rec1;
  assert n = 2, 'and leaves everybody else in place';

  /* deleting the interview takes its mirrored respondent */
  delete from public.interviews where id = iv;
  select count(*) into n from public.interview_people where id = respondent;
  assert n = 0, 'the mirrored respondent goes with its interview';

  raise notice 'interview participants: all assertions passed';
end $$;

/* ----------------------------------------------------------- permissions */

do $$
declare bad text;
begin
  select string_agg(p.proname, ', ') into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'rescript_interview_recording_participants',
       'rescript_interview_set_participants',
       'rescript_interview_map_speaker',
       'rescript_interview_person_recordings',
       'rescript_interview_mirror_respondent')
     and (has_function_privilege('anon', p.oid, 'execute')
       or has_function_privilege('authenticated', p.oid, 'execute'));
  assert bad is null, format('callable by an untrusted role: %s', bad);

  assert not has_table_privilege('anon', 'public.interview_people', 'select'),
    'anon must not read the people on a project';
  assert not has_table_privilege('authenticated', 'public.interview_media_participants', 'select'),
    'authenticated must not read participant lists directly';
  assert (select relrowsecurity from pg_class where oid = 'public.interview_people'::regclass),
    'RLS is enabled on interview_people';
  assert (select relrowsecurity from pg_class where oid = 'public.interview_media_participants'::regclass),
    'RLS is enabled on interview_media_participants';

  raise notice 'interview participants: permissions are locked down';
end $$;

rollback;
