-- RESPONSE NAVIGATION SQL TEST (migration 0077, 2026-10-30) — against a database with every migration applied
-- (0077 applied twice by the runner before this file):
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/response-navigation-sql-test.sql
--
-- Proves, on real Postgres 16:
--   1. responses.nav exists exactly once, jsonb, nullable; the shape check exists exactly once
--   2. rows that predate the migration (and new rows that do not set it) stay null
--   3. a normal trail round-trips unchanged; a 1,000-page trail fits
--   4. the check rejects: an oversized list (2,001 ids), a non-object, a wrong version, a list that is not an array,
--      a current page that is not a string
-- One transaction, rolled back — safe to run twice.

begin;

-- 1. the column and the constraint, once each
do $$
declare n int; t text; nullable text;
begin
  select count(*), max(data_type), max(is_nullable) into n, t, nullable
    from information_schema.columns where table_schema = 'public' and table_name = 'responses' and column_name = 'nav';
  if n <> 1 or t <> 'jsonb' or nullable <> 'YES' then raise exception 'responses.nav: expected one nullable jsonb column, got % % %', n, t, nullable; end if;
  select count(*) into n from pg_constraint where conrelid = 'public.responses'::regclass and conname = 'responses_nav_shape';
  if n <> 1 then raise exception 'responses_nav_shape: expected 1 constraint, got %', n; end if;
  raise notice 'ok 1 — responses.nav (jsonb, nullable) and responses_nav_shape exist once';
end $$;

insert into public.customers (id, slug, name) values ('c0000000-0000-0000-0000-000000000077', 'nav77', 'Navigation 0077') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title)
  values ('c0000000-0000-0000-0000-000000000177', 'c0000000-0000-0000-0000-000000000077', 'N77', 'UPSC sections')
on conflict do nothing;
insert into public.survey_versions (id, survey_id, version, definition) values ('c0000000-0000-0000-0000-000000000277', 'c0000000-0000-0000-0000-000000000177', 1, '{}'::jsonb) on conflict do nothing;

-- 2. a row written the old way stays null
insert into public.responses (survey_id, version_id, session_id, status, is_test)
  values ('c0000000-0000-0000-0000-000000000177', 'c0000000-0000-0000-0000-000000000277', 'nav77-old-row-000000000000', 'in_progress', true);
do $$
begin
  if (select nav from public.responses where session_id = 'nav77-old-row-000000000000') is not null then raise exception 'a row that does not set nav must stay null'; end if;
  if exists (select 1 from public.responses where session_id <> 'nav77-old-row-000000000000' and survey_id = 'c0000000-0000-0000-0000-000000000177' and nav is not null) then raise exception 'unexpected nav'; end if;
  raise notice 'ok 2 — existing / new rows without a trail stay null';
end $$;

-- 3. a normal trail round-trips; a 1,000-page trail fits
update public.responses set nav = '{"v":1,"stack":["ph1","ph2"],"visited":["ph1","ph2","pp1"],"at":"pg1"}'::jsonb
  where session_id = 'nav77-old-row-000000000000';
do $$
declare got jsonb;
begin
  select nav into got from public.responses where session_id = 'nav77-old-row-000000000000';
  if got <> '{"v":1,"stack":["ph1","ph2"],"visited":["ph1","ph2","pp1"],"at":"pg1"}'::jsonb then raise exception 'round trip changed the trail: %', got; end if;
  update public.responses
     set nav = jsonb_build_object('v', 1,
       'stack',   (select jsonb_agg(format('p_%s@item_%s', lpad(i::text, 4, '0'), i % 20)) from generate_series(1, 1000) i),
       'visited', (select jsonb_agg(format('p_%s@item_%s', lpad(i::text, 4, '0'), i % 20)) from generate_series(1, 1000) i),
       'at', 'p_1000@item_0')
   where session_id = 'nav77-old-row-000000000000';
  select nav into got from public.responses where session_id = 'nav77-old-row-000000000000';
  if jsonb_array_length(got -> 'stack') <> 1000 then raise exception '1,000-page trail not stored'; end if;
  raise notice 'ok 3 — a trail round-trips unchanged; a 1,000-page trail fits (% bytes)', pg_column_size(got);
end $$;

-- 4. the check refuses what the runtime never writes
create or replace function pg_temp.refused(v jsonb) returns boolean language plpgsql as $$
begin
  begin
    update public.responses set nav = v where session_id = 'nav77-old-row-000000000000';
  exception when check_violation then return true;
  end;
  return false;
end $$;
do $$
begin
  if not pg_temp.refused(jsonb_build_object('v', 1, 'stack', (select jsonb_agg('p' || i) from generate_series(1, 2001) i))) then raise exception 'a 2,001-id trail was accepted'; end if;
  if not pg_temp.refused(jsonb_build_object('v', 1, 'visited', (select jsonb_agg('p' || i) from generate_series(1, 2001) i))) then raise exception 'a 2,001-id visited list was accepted'; end if;
  if not pg_temp.refused('["p1"]'::jsonb) then raise exception 'a non-object was accepted'; end if;
  if not pg_temp.refused('{"v":2,"stack":[]}'::jsonb) then raise exception 'version 2 was accepted'; end if;
  if not pg_temp.refused('{"stack":[]}'::jsonb) then raise exception 'an unversioned trail was accepted'; end if;
  if not pg_temp.refused('{"v":1,"stack":"p1"}'::jsonb) then raise exception 'a string stack was accepted'; end if;
  if not pg_temp.refused('{"v":1,"at":7}'::jsonb) then raise exception 'a numeric current page was accepted'; end if;
  if pg_temp.refused('{"v":1}'::jsonb) then raise exception 'an empty trail was refused'; end if;
  if pg_temp.refused(null) then raise exception 'null was refused'; end if;
  raise notice 'ok 4 — oversized lists (2,001), non-objects, wrong / missing version, non-array lists and a non-string page are refused; {v:1} and null accepted';
end $$;

rollback;
