-- RESPONSE SAVE SEQUENCE SQL TEST (migration 0078, 2026-10-30) — against a database with every migration applied
-- (0078 applied twice by the runner before this file):
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/response-save-seq-sql-test.sql
--
-- Proves, on real Postgres 16:
--   1. responses.save_seq exists exactly once, bigint, not null, default 0; the non-negative check exists once
--   2. a row written the old way gets 0
--   3. the save route's conditional update (`where save_seq < $seq`) applies a newer save and refuses an older or
--      equal one (zero rows changed), so an older snapshot can never overwrite a newer one
--   4. a negative value is rejected
-- One transaction, rolled back — safe to run twice.

begin;

do $$
declare n int; t text; nullable text; dflt text;
begin
  select count(*), max(data_type), max(is_nullable), max(column_default) into n, t, nullable, dflt
    from information_schema.columns where table_schema = 'public' and table_name = 'responses' and column_name = 'save_seq';
  if n <> 1 or t <> 'bigint' or nullable <> 'NO' or dflt <> '0' then raise exception 'responses.save_seq: expected one bigint not null default 0, got % % % %', n, t, nullable, dflt; end if;
  select count(*) into n from pg_constraint where conrelid = 'public.responses'::regclass and conname = 'responses_save_seq_nonneg';
  if n <> 1 then raise exception 'responses_save_seq_nonneg: expected 1 constraint, got %', n; end if;
  raise notice 'ok 1 — responses.save_seq (bigint not null default 0) and responses_save_seq_nonneg exist once';
end $$;

insert into public.customers (id, slug, name) values ('c0000000-0000-0000-0000-000000000078', 'seq78', 'Save order 0078') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title)
  values ('c0000000-0000-0000-0000-000000000178', 'c0000000-0000-0000-0000-000000000078', 'S78', 'Save order')
on conflict do nothing;
insert into public.survey_versions (id, survey_id, version, definition) values ('c0000000-0000-0000-0000-000000000278', 'c0000000-0000-0000-0000-000000000178', 1, '{}'::jsonb) on conflict do nothing;

insert into public.responses (survey_id, version_id, session_id, status, is_test)
  values ('c0000000-0000-0000-0000-000000000178', 'c0000000-0000-0000-0000-000000000278', 'seq78-row-0000000000000000', 'in_progress', true);
do $$
begin
  if (select save_seq from public.responses where session_id = 'seq78-row-0000000000000000') <> 0 then raise exception 'a row that does not set save_seq must be 0'; end if;
  raise notice 'ok 2 — a row written without save_seq starts at 0';
end $$;

-- 3. the route's compare-and-swap, in the order the race delivers: seq 2 (newer) lands first, seq 1 (older) late
do $$
declare n int;
begin
  update public.responses set step_index = 2, save_seq = 2 where session_id = 'seq78-row-0000000000000000' and status = 'in_progress' and save_seq < 2;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'the newer save (seq 2) must apply, changed %', n; end if;
  update public.responses set step_index = 1, save_seq = 1 where session_id = 'seq78-row-0000000000000000' and status = 'in_progress' and save_seq < 1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'the older save (seq 1) must not apply, changed %', n; end if;
  update public.responses set step_index = 9, save_seq = 2 where session_id = 'seq78-row-0000000000000000' and status = 'in_progress' and save_seq < 2;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a repeated seq must not apply twice, changed %', n; end if;
  if (select step_index from public.responses where session_id = 'seq78-row-0000000000000000') <> 2 then raise exception 'the newer snapshot must survive'; end if;
  update public.responses set step_index = 3, save_seq = 3 where session_id = 'seq78-row-0000000000000000' and status = 'in_progress' and save_seq < 3;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'seq 3 must apply, changed %', n; end if;
  raise notice 'ok 3 — newer applies, older and equal are refused (0 rows), the newer snapshot survives';
end $$;

do $$
begin
  begin
    update public.responses set save_seq = -1 where session_id = 'seq78-row-0000000000000000';
    raise exception 'a negative save_seq must be rejected';
  exception when check_violation then null;
  end;
  raise notice 'ok 4 — a negative save_seq is rejected';
end $$;

rollback;
