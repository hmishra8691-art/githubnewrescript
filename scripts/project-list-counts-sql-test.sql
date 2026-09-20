-- PROJECT LIST COUNTS SQL TEST (migration 0043) — run against a database with
-- the migrations applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/project-list-counts-sql-test.sql
--
-- Y10. `rescript_my_projects.response_count` had no `is_test` predicate, so
-- the project list reported a week of the team's own testing as delivered
-- data. The fix splits the number the way every other count in the product
-- already splits it.
--
-- What this proves, on one project carrying all four kinds of row:
--
--   1. `response_count` is LIVE responses only
--   2. `test_response_count` is the preview ones, counted and not hidden
--   3. soft-deleted rows stay out of BOTH (the old predicate that was right)
--   4. a project with nothing but test data reads zero, which is the whole
--      point of the fix
--
-- Everything runs in one transaction and rolls back.

begin;

insert into public.customers (id, slug, name)
  values ('c0000043-0000-0000-0000-000000000001', 'counts', 'Project List Counts')
on conflict do nothing;

insert into auth.users (id, email, raw_user_meta_data)
  values ('a0000043-0000-0000-0000-000000000001', 'owner@counts.test', '{"full_name":"Counts Owner"}'::jsonb)
on conflict do nothing;

update public.profiles
   set customer_id = 'c0000043-0000-0000-0000-000000000001'
 where id = 'a0000043-0000-0000-0000-000000000001';

insert into public.surveys (id, customer_id, owner_id, code, title, status, created_by)
values
  ('50000043-0000-0000-0000-000000000001', 'c0000043-0000-0000-0000-000000000001',
   'a0000043-0000-0000-0000-000000000001', 'MIXED', 'Mixed traffic', 'live',
   'a0000043-0000-0000-0000-000000000001'),
  ('50000043-0000-0000-0000-000000000002', 'c0000043-0000-0000-0000-000000000001',
   'a0000043-0000-0000-0000-000000000001', 'TESTONLY', 'Only ever tested', 'testing',
   'a0000043-0000-0000-0000-000000000001')
on conflict do nothing;

insert into public.survey_versions (id, survey_id, version, definition, created_by)
values
  ('5e000043-0000-0000-0000-000000000001', '50000043-0000-0000-0000-000000000001', 1, '{}'::jsonb,
   'a0000043-0000-0000-0000-000000000001'),
  ('5e000043-0000-0000-0000-000000000002', '50000043-0000-0000-0000-000000000002', 1, '{}'::jsonb,
   'a0000043-0000-0000-0000-000000000001')
on conflict do nothing;

update public.surveys set current_version_id = '5e000043-0000-0000-0000-000000000001'
 where id = '50000043-0000-0000-0000-000000000001';
update public.surveys set current_version_id = '5e000043-0000-0000-0000-000000000002'
 where id = '50000043-0000-0000-0000-000000000002';

/* MIXED: 3 live, 2 test, 1 soft-deleted live, 1 soft-deleted test */
insert into public.responses (survey_id, version_id, session_id, status, is_test, deleted_at)
values
  ('50000043-0000-0000-0000-000000000001', '5e000043-0000-0000-0000-000000000001', 'live-1', 'complete',    false, null),
  ('50000043-0000-0000-0000-000000000001', '5e000043-0000-0000-0000-000000000001', 'live-2', 'complete',    false, null),
  ('50000043-0000-0000-0000-000000000001', '5e000043-0000-0000-0000-000000000001', 'live-3', 'in_progress', false, null),
  ('50000043-0000-0000-0000-000000000001', '5e000043-0000-0000-0000-000000000001', 'test-1', 'complete',    true,  null),
  ('50000043-0000-0000-0000-000000000001', '5e000043-0000-0000-0000-000000000001', 'test-2', 'screened',    true,  null),
  ('50000043-0000-0000-0000-000000000001', '5e000043-0000-0000-0000-000000000001', 'gone-1', 'complete',    false, now()),
  ('50000043-0000-0000-0000-000000000001', '5e000043-0000-0000-0000-000000000001', 'gone-2', 'complete',    true,  now());

/* TESTONLY: nothing but preview traffic */
insert into public.responses (survey_id, version_id, session_id, status, is_test)
values
  ('50000043-0000-0000-0000-000000000002', '5e000043-0000-0000-0000-000000000002', 'only-1', 'complete', true),
  ('50000043-0000-0000-0000-000000000002', '5e000043-0000-0000-0000-000000000002', 'only-2', 'complete', true),
  ('50000043-0000-0000-0000-000000000002', '5e000043-0000-0000-0000-000000000002', 'only-3', 'complete', true);

do $$
declare live_n integer; test_n integer;
begin
  select p.response_count, p.test_response_count into live_n, test_n
    from public.rescript_my_projects('a0000043-0000-0000-0000-000000000001', 180) p
   where p.code = 'MIXED';

  if live_n is null then
    raise exception 'the project list did not return the MIXED project at all';
  end if;

  /* 1 + 3: three live rows, and the soft-deleted live row is not one of them */
  if live_n <> 3 then
    raise exception 'response_count should be 3 live responses, got %', live_n;
  end if;

  /* 2 + 3: two test rows, and the soft-deleted test row is not one of them */
  if test_n <> 2 then
    raise exception 'test_response_count should be 2, got %', test_n;
  end if;

  /* This is the assertion the old function failed: it returned 5. */
  if live_n = 5 then
    raise exception 'response_count is still counting test responses as real';
  end if;

  select p.response_count, p.test_response_count into live_n, test_n
    from public.rescript_my_projects('a0000043-0000-0000-0000-000000000001', 180) p
   where p.code = 'TESTONLY';

  /* 4: a project that has never been in field reports no data, and says why */
  if live_n <> 0 then
    raise exception 'a project with only test data should report 0 responses, got %', live_n;
  end if;
  if test_n <> 3 then
    raise exception 'the test responses should still be visible as test, got %', test_n;
  end if;

  raise notice 'PASS — project list counts live and test separately';
end $$;

rollback;
