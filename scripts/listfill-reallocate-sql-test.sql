-- LIST FILL RE-ALLOCATION SQL TEST (0061) — run against a database with the
-- migrations applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/listfill-reallocate-sql-test.sql
--
-- Proves, on the real functions:
--   R1  first allocation + idempotent repeat (0007 contract unchanged)
--   R2  Back + changed source: the dropped item's slot is given back, the kept
--       item keeps its slot, the new item is claimed — counters == allocations
--   R3  an unchanged re-allocation writes nothing
--   R4  a dropped item whose cap is full frees room for the next respondent
--   R5  a kept code the session does NOT hold is not granted (keeping is not claiming)
--   R6  count shrinks → the extra kept items are released
--   R7  0007 leak: release-all then a fresh claim records its row and moves
--       the counter exactly once (before 0061: counter +1 per call, no row)
--   R8  restore of a deleted response does not resurrect a 'changed' claim
--   R9  recount agrees with the incremental counters after all of the above
--
-- One transaction, rolled back.

begin;

insert into public.customers (id, slug, name) values ('c0000061-0000-0000-0000-000000000001', 'lf-realloc', 'LF realloc') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title) values ('50000061-0000-0000-0000-000000000001', 'c0000061-0000-0000-0000-000000000001', 'LFR', 'LF realloc');
insert into public.survey_versions (id, survey_id, version, definition) values ('5e000061-0000-0000-0000-000000000001', '50000061-0000-0000-0000-000000000001', 1, '{}'::jsonb);

create temp table t_ok (n serial, name text);

create or replace function pg_temp.counts(p_list text) returns jsonb language sql as $$
  select coalesce(jsonb_object_agg(option_code, allocated_count order by option_code), '{}'::jsonb)
  from public.listfill_counts where survey_id = '50000061-0000-0000-0000-000000000001' and is_test = false and list_fill_id = p_list and allocated_count > 0
$$;
create or replace function pg_temp.held(p_session text, p_list text) returns text language sql as $$
  select coalesce(string_agg(option_code, ',' order by slot), '') from public.listfill_allocations
  where session_id = p_session and list_fill_id = p_list and released_at is null
$$;
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin
  if not p_ok then raise exception 'FAIL %: %', p_name, p_detail; end if;
  insert into t_ok (name) values (p_name);
  raise notice 'ok   %', p_name;
end $$;

do $$
declare
  s uuid := '50000061-0000-0000-0000-000000000001';
  got text;
  n integer;
  c jsonb;
begin
  /* R1 */
  select string_agg(option_code, ',' order by slot_no) into got from public.rescript_allocate_listfill(s, false, 'lf', 'sess-r1-000000000001', '[{"code":"A","maximum":2},{"code":"B"},{"code":"C"}]', 2, false, 'v1');
  perform pg_temp.check('R1 first allocation claims A,B', got = 'A,B', got);
  select string_agg(option_code || ':' || reused, ',' order by slot_no) into got from public.rescript_allocate_listfill(s, false, 'lf', 'sess-r1-000000000001', '[{"code":"C"}]', 2, false, 'v1');
  perform pg_temp.check('R1 a repeat returns the same items, reused', got = 'A:true,B:true', got);
  c := pg_temp.counts('lf');
  perform pg_temp.check('R1 counters A=1 B=1', c = '{"A":1,"B":1}'::jsonb, c::text);

  /* R2: the respondent went Back and de-selected A; B still qualifies, C is next */
  select string_agg(option_code || ':' || reused, ',' order by slot_no) into got
    from public.rescript_reallocate_listfill(s, false, 'lf', 'sess-r1-000000000001', '["B"]', '[{"code":"C"}]', 2, false, 'v1');
  perform pg_temp.check('R2 B kept (reused), C claimed', got = 'B:true,C:false', got);
  c := pg_temp.counts('lf');
  perform pg_temp.check('R2 A given back: counters B=1 C=1', c = '{"B":1,"C":1}'::jsonb, c::text);
  select count(*) into n from public.listfill_allocations where session_id = 'sess-r1-000000000001' and release_reason = 'changed' and option_code = 'A';
  perform pg_temp.check('R2 the replaced claim is kept as audit, reason changed', n = 1, n::text);

  /* R3 */
  select count(*) into n from public.listfill_allocations where session_id = 'sess-r1-000000000001';
  perform public.rescript_reallocate_listfill(s, false, 'lf', 'sess-r1-000000000001', '["B","C"]', '[{"code":"A","maximum":2}]', 2, false, 'v1');
  perform pg_temp.check('R3 unchanged: no row written',
    (select count(*) from public.listfill_allocations where session_id = 'sess-r1-000000000001') = n
    and pg_temp.held('sess-r1-000000000001', 'lf') = 'B,C', pg_temp.held('sess-r1-000000000001', 'lf'));

  /* R4: X has a cap of 1; r4a holds it, r4b cannot get it; r4a changes its mind; r4b now can */
  perform public.rescript_allocate_listfill(s, false, 'cap', 'sess-r4a-00000000001', '[{"code":"X","maximum":1},{"code":"Y"}]', 1, false, 'v1');
  select string_agg(option_code, ',') into got from public.rescript_allocate_listfill(s, false, 'cap', 'sess-r4b-00000000001', '[{"code":"X","maximum":1}]', 1, false, 'v1');
  perform pg_temp.check('R4 X full: the second respondent gets nothing', got is null, coalesce(got, 'null'));
  perform public.rescript_reallocate_listfill(s, false, 'cap', 'sess-r4a-00000000001', '[]', '[{"code":"Y"}]', 1, false, 'v1');
  select string_agg(option_code, ',') into got from public.rescript_reallocate_listfill(s, false, 'cap', 'sess-r4b-00000000001', '[]', '[{"code":"X","maximum":1}]', 1, false, 'v1');
  perform pg_temp.check('R4 after the release X is claimable again', got = 'X', coalesce(got, 'null'));
  c := pg_temp.counts('cap');
  perform pg_temp.check('R4 counters X=1 Y=1', c = '{"X":1,"Y":1}'::jsonb, c::text);

  /* R5 */
  select string_agg(option_code || ':' || reused, ',' order by slot_no) into got
    from public.rescript_reallocate_listfill(s, false, 'k5', 'sess-r5-000000000001', '["Z"]', '[{"code":"Q","maximum":5}]', 1, false, 'v1');
  perform pg_temp.check('R5 a kept code not held is not granted', got = 'Q:false', got);
  perform pg_temp.check('R5 no counter for Z', not (pg_temp.counts('k5') ? 'Z'), pg_temp.counts('k5')::text);

  /* R6 */
  perform public.rescript_allocate_listfill(s, false, 'k6', 'sess-r6-000000000001', '[{"code":"A"},{"code":"B"},{"code":"C"}]', 3, false, 'v1');
  select string_agg(option_code, ',' order by slot_no) into got
    from public.rescript_reallocate_listfill(s, false, 'k6', 'sess-r6-000000000001', '["A","B","C"]', '[]', 2, false, 'v1');
  perform pg_temp.check('R6 count 3 → 2 keeps the first two', got = 'A,B', got);
  c := pg_temp.counts('k6');
  perform pg_temp.check('R6 C given back', c = '{"A":1,"B":1}'::jsonb, c::text);

  /* R7: the 0007 leak */
  perform public.rescript_allocate_listfill(s, false, 'k7', 'sess-r7-000000000001', '[{"code":"A"}]', 1, false, 'v1');
  perform public.rescript_release_listfill(s, 'sess-r7-000000000001');
  perform public.rescript_allocate_listfill(s, false, 'k7', 'sess-r7-000000000001', '[{"code":"B"}]', 1, false, 'v1');
  select string_agg(option_code || ':' || reused, ',') into got from public.rescript_allocate_listfill(s, false, 'k7', 'sess-r7-000000000001', '[{"code":"B"}]', 1, false, 'v1');
  perform pg_temp.check('R7 after a release the new claim is recorded (repeat is reused)', got = 'B:true', got);
  c := pg_temp.counts('k7');
  perform pg_temp.check('R7 the counter moved once, not per call', c = '{"B":1}'::jsonb, c::text);
end $$;

/* R8: deleted → restored response keeps the replacement, not the replaced claim */
insert into public.responses (survey_id, version_id, session_id, status)
values ('50000061-0000-0000-0000-000000000001', '5e000061-0000-0000-0000-000000000001', 'sess-r1-000000000001', 'in_progress');
update public.responses set deleted_at = now() where session_id = 'sess-r1-000000000001';
select pg_temp.check('R8 deletion releases B,C', pg_temp.held('sess-r1-000000000001', 'lf') = '', pg_temp.held('sess-r1-000000000001', 'lf'));
update public.responses set deleted_at = null where session_id = 'sess-r1-000000000001';
select pg_temp.check('R8 restore brings back B,C and not the replaced A', pg_temp.held('sess-r1-000000000001', 'lf') = 'B,C', pg_temp.held('sess-r1-000000000001', 'lf'));

/* R9 */
create temp table t_before as select list_fill_id, option_code, allocated_count from public.listfill_counts where survey_id = '50000061-0000-0000-0000-000000000001' and allocated_count > 0;
select public.rescript_recount_listfill('50000061-0000-0000-0000-000000000001', false);
select pg_temp.check('R9 recount agrees with the incremental counters',
  not exists (
    (select list_fill_id, option_code, allocated_count from t_before
     except select list_fill_id, option_code, allocated_count from public.listfill_counts where survey_id = '50000061-0000-0000-0000-000000000001' and allocated_count > 0)
    union all
    (select list_fill_id, option_code, allocated_count from public.listfill_counts where survey_id = '50000061-0000-0000-0000-000000000001' and allocated_count > 0
     except select list_fill_id, option_code, allocated_count from t_before)));

select count(*) || ' checks passed' as result from t_ok;
rollback;
