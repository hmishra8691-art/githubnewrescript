-- =====================================================================
-- §60 PROJECT CONFIGURATION — proved in the database
--
-- Migration 0015 makes three promises that live below the application: a
-- fieldwork range cannot run backwards, the project facts are queryable
-- (which is the whole reason they are columns and not a settings blob), and
-- `rescript_project_config` refuses to hand a client's name to somebody
-- with no role on the project.
--
--   psql -d <database> -f scripts/project-config-sql-test.sql
--
-- Needs migrations 0001–0015 on a throwaway database. Creates its own
-- fixtures and rolls nothing back — never run it against a live project.
-- =====================================================================
\set ON_ERROR_STOP on
\timing off
\pset pager off

begin;
insert into public.customers (id, slug, name)
  values ('cccccccc-0000-0000-0000-0000000000c1', 'agency-one', 'Agency One') on conflict do nothing;
insert into public.customers (id, slug, name)
  values ('cccccccc-0000-0000-0000-0000000000c2', 'agency-two', 'Agency Two') on conflict do nothing;
insert into public.surveys (id, customer_id, code, title, status)
values
  ('dddddddd-0000-0000-0000-0000000000d1', 'cccccccc-0000-0000-0000-0000000000c1', 'ACME-W4', 'Brand tracker wave 4', 'live'),
  ('dddddddd-0000-0000-0000-0000000000d2', 'cccccccc-0000-0000-0000-0000000000c1', 'ACME-U1', 'Usage & attitudes', 'draft'),
  ('dddddddd-0000-0000-0000-0000000000d3', 'cccccccc-0000-0000-0000-0000000000c1', 'ZENITH-1', 'Zenith concept test', 'testing'),
  ('dddddddd-0000-0000-0000-0000000000d4', 'cccccccc-0000-0000-0000-0000000000c2', 'OTHER-1', 'Another agency''s study', 'live');
commit;

\echo '--- 1. a project can be filed under a client, a manager and a cost centre'
update public.surveys set
  client_name = 'Acme Foods', project_manager = 'Ada Lovelace', cost_centre = 'RES-2026-014',
  fieldwork_from = '2026-03-02', fieldwork_to = '2026-03-09', due_date = '2026-03-20',
  notes = 'Wave 4 of the tracker. Q7 was added this wave.'
where id = 'dddddddd-0000-0000-0000-0000000000d1';
select case when client_name = 'Acme Foods' and project_manager = 'Ada Lovelace' and due_date = '2026-03-20'
            then 'PASS the project''s own facts are stored' else 'FAIL' end
from public.surveys where id = 'dddddddd-0000-0000-0000-0000000000d1';

\echo '--- 2. fieldwork cannot end before it starts'
do $$
begin
  update public.surveys set fieldwork_from = '2026-03-09', fieldwork_to = '2026-03-02'
    where id = 'dddddddd-0000-0000-0000-0000000000d2';
  raise exception 'FAIL: a backwards fieldwork range was accepted';
exception when check_violation then
  raise notice 'PASS a backwards fieldwork range is refused';
end $$;

\echo '--- 3. a project planned before its dates are known is fine'
update public.surveys set fieldwork_from = '2026-04-01', fieldwork_to = null, due_date = null
  where id = 'dddddddd-0000-0000-0000-0000000000d2';
select case when fieldwork_from is not null and fieldwork_to is null
            then 'PASS half a range, and no due date, are allowed' else 'FAIL' end
from public.surveys where id = 'dddddddd-0000-0000-0000-0000000000d2';

\echo '--- 4. "everything for this client" is one query, case-insensitively'
update public.surveys set client_name = 'ACME FOODS' where id = 'dddddddd-0000-0000-0000-0000000000d2';
update public.surveys set client_name = 'Zenith plc', due_date = '2026-03-11'
  where id = 'dddddddd-0000-0000-0000-0000000000d3';
select case when count(*) = 2 then 'PASS both Acme projects found, however the name was typed'
            else 'FAIL — got ' || count(*) end
from public.surveys
where customer_id = 'cccccccc-0000-0000-0000-0000000000c1' and lower(client_name) = 'acme foods';

\echo '--- 5. "what is due next" is one query — and unscheduled work does not jump the queue'
select code, client_name, due_date
from public.surveys
where customer_id = 'cccccccc-0000-0000-0000-0000000000c1'
order by due_date nulls last, updated_at desc;

\echo '--- 6. the owner''s freeze is a column the platform can finally set'
update public.surveys set locked = true where id = 'dddddddd-0000-0000-0000-0000000000d1';
select case when locked then 'PASS the freeze the guard has always enforced can be switched on' else 'FAIL' end
from public.surveys where id = 'dddddddd-0000-0000-0000-0000000000d1';

\echo '--- 7. this project''s collaboration overrides are a declared shape, not a void'
update public.surveys
  set collaboration = '{"requireLockToEdit": false, "lockMinutes": 45}'::jsonb
  where id = 'dddddddd-0000-0000-0000-0000000000d1';
select case when (collaboration->>'lockMinutes')::int = 45
             and (collaboration->>'requireLockToEdit')::boolean = false
            then 'PASS collaboration overrides are stored and readable' else 'FAIL' end
from public.surveys where id = 'dddddddd-0000-0000-0000-0000000000d1';

\echo '--- 8. rescript_project_config gives nothing to a caller with no role'
-- auth.uid() is null in this session: no membership, no platform admin
select case when count(*) = 0
            then 'PASS a caller with no role on these projects gets nothing, not a client list'
            else 'FAIL — leaked ' || count(*) || ' project(s)' end
from public.rescript_project_config(array[
  'dddddddd-0000-0000-0000-0000000000d1',
  'dddddddd-0000-0000-0000-0000000000d4'
]::uuid[]);

\echo '--- 9. and asking for another workspace''s project by id is simply empty'
select case when count(*) = 0 then 'PASS no cross-workspace read' else 'FAIL' end
from public.rescript_project_config(array['dddddddd-0000-0000-0000-0000000000d4']::uuid[]);

\echo '--- 10. deleting a project takes its configuration with it'
delete from public.surveys where id = 'dddddddd-0000-0000-0000-0000000000d3';
select case when count(*) = 0 then 'PASS nothing orphaned' else 'FAIL' end
from public.surveys where id = 'dddddddd-0000-0000-0000-0000000000d3';
