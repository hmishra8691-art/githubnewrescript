-- DOUBLE-SUBMIT SQL TEST (Y11) — run against a database with the migrations
-- applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/double-submit-sql-test.sql
--
-- Y11. Two clicks on Next, 50 ms apart, both finalised the same interview: a
-- quota cell incremented by two, the List Fill claim confirmed twice, and two
-- billable SURVEY_RESPONSE events for one respondent.
--
-- The save route's UPDATE always carried `where status = 'in_progress'`. What
-- it did not do was look at whether the update had matched anything — both
-- requests read `in_progress` before either wrote, both passed the guard, and
-- both ran the finalisation block afterwards. The fix reads the result: the
-- request that actually performed the transition gets a row back, and only
-- that request does the work that costs money.
--
-- This proves the guarantee the fix stands on, in the database, on the real
-- schema: a conditional UPDATE ... RETURNING is a CLAIM, and exactly one of
-- two concurrent claimants can win it. If that were not true — if someone
-- later "simplified" the predicate away — the application-level check would
-- be checking nothing.
--
-- Everything runs in one transaction and rolls back.

begin;

insert into public.customers (id, slug, name)
  values ('c0000011-0000-0000-0000-000000000001', 'dbl', 'Double Submit')
on conflict do nothing;

insert into auth.users (id, email, raw_user_meta_data)
  values ('a0000011-0000-0000-0000-000000000001', 'owner@dbl.test', '{"full_name":"Owner"}'::jsonb)
on conflict do nothing;

update public.profiles
   set customer_id = 'c0000011-0000-0000-0000-000000000001'
 where id = 'a0000011-0000-0000-0000-000000000001';

insert into public.surveys (id, customer_id, owner_id, code, title, status, created_by)
values ('50000110-0000-0000-0000-000000000001', 'c0000011-0000-0000-0000-000000000001',
        'a0000011-0000-0000-0000-000000000001', 'DBL', 'Double submit', 'live',
        'a0000011-0000-0000-0000-000000000001')
on conflict do nothing;

insert into public.survey_versions (id, survey_id, version, definition, created_by)
values ('5e000110-0000-0000-0000-000000000001', '50000110-0000-0000-0000-000000000001', 1, '{}'::jsonb,
        'a0000011-0000-0000-0000-000000000001')
on conflict do nothing;

insert into public.responses (survey_id, version_id, session_id, status)
values ('50000110-0000-0000-0000-000000000001', '5e000110-0000-0000-0000-000000000001',
        'dbl-session-0000000000000001', 'in_progress');

do $$
declare
  first_claim  uuid;
  second_claim uuid;
  final_status text;
begin
  /*
   * CLICK ONE. The conditional update matches, so it returns the row: this
   * request is the one that finalised the interview, and it is the one that
   * may increment the quota and meter the response.
   */
  update public.responses
     set status = 'complete', completed_at = now()
   where session_id = 'dbl-session-0000000000000001'
     and status = 'in_progress'
  returning id into first_claim;

  if first_claim is null then
    raise exception 'the first submit did not claim the response — the predicate is wrong';
  end if;

  /*
   * CLICK TWO, arriving after the first has written. Same statement. It must
   * match NOTHING, because the row is no longer in_progress.
   *
   * This is the assertion the bug failed: the old code ran this same update,
   * ignored that it had changed nothing, and carried on to bill.
   */
  update public.responses
     set status = 'complete', completed_at = now()
   where session_id = 'dbl-session-0000000000000001'
     and status = 'in_progress'
  returning id into second_claim;

  if second_claim is not null then
    raise exception 'the second submit ALSO claimed the response — it would bill twice';
  end if;

  /* and the interview is complete exactly once, not corrupted by the loser */
  select status into final_status
    from public.responses where session_id = 'dbl-session-0000000000000001';
  if final_status <> 'complete' then
    raise exception 'the response should be complete, got %', final_status;
  end if;

  if (select count(*) from public.responses
       where session_id = 'dbl-session-0000000000000001') <> 1 then
    raise exception 'the retry created a second response row';
  end if;

  raise notice 'PASS — only one submit can finalise an interview';
end $$;

/*
 * The same thing for a SCREEN-OUT, because the route's predicate is on
 * `in_progress` and not on the destination status: a respondent who screens
 * out and whose client retries must not be counted twice either, even though
 * a screen-out is not itself billable.
 */
insert into public.responses (survey_id, version_id, session_id, status)
values ('50000110-0000-0000-0000-000000000001', '5e000110-0000-0000-0000-000000000001',
        'dbl-session-0000000000000002', 'in_progress');

do $$
declare a uuid; b uuid;
begin
  update public.responses set status = 'screened'
   where session_id = 'dbl-session-0000000000000002' and status = 'in_progress'
  returning id into a;

  update public.responses set status = 'complete'
   where session_id = 'dbl-session-0000000000000002' and status = 'in_progress'
  returning id into b;

  if a is null then raise exception 'the screen-out did not claim'; end if;
  if b is not null then
    raise exception 'a finalised screen-out was re-finalised as a complete — that is a billable event created from nothing';
  end if;
  raise notice 'PASS — a finalised response cannot be re-finalised as something else';
end $$;

rollback;
