-- QUOTA MONITORING (migration 0088).
--
--   psql "$DB" -v ON_ERROR_STOP=1 -f scripts/quota-sql-test.sql
--
-- One transaction, rolled back. The interesting part is cell MEMBERSHIP: a respondent belongs to every cell
-- whose criteria are a subset of their attributes, so one complete counts into "Male" and into "Male 18–34"
-- at the same time, and into neither "Female" nor "Male 55+".

begin;

\set cust '''a0000000-0000-0000-0000-0000000000a1'''
\set usr  '''a00000a1-0000-0000-0000-000000000001'''
\set srv  '''a0000000-0000-0000-0000-0000000001a1'''
\set proj '''a0000000-0000-0000-0000-0000000004a1'''

insert into auth.users (id, email) values (:usr, 'quota@example.test');
insert into public.customers (id, slug, name) values (:cust, 'quota', 'Quota');
insert into public.profiles (id, customer_id, email, full_name, role)
  values (:usr, :cust, 'quota@example.test', 'Researcher', 'researcher')
  on conflict (id) do update set customer_id = excluded.customer_id, role = excluded.role;
insert into public.surveys (id, customer_id, code, title, owner_id)
  values (:srv, :cust, 'QUOTA', 'Quota', :usr);
insert into public.recruitment_projects (id, customer_id, survey_id, required_completes, budget_amount, budget_currency, status)
  values (:proj, :cust, :srv, 1000, 10000, 'GBP', 'fielding');

/* ============================================================ 1. the specification is written down */

do $$
declare v_rows integer;
begin
  select public.rescript_quota_sync('a0000000-0000-0000-0000-0000000004a1', '[
    {"id":"g1","label":"Male","dimension":"gender","criteria":{"gender":"male"},"targetCompletes":500},
    {"id":"g2","label":"Female","dimension":"gender","criteria":{"gender":"female"},"targetCompletes":500},
    {"id":"a1","label":"18-34","dimension":"ageBand","criteria":{"ageBand":"18-34"},"targetCompletes":400},
    {"id":"x1","label":"Male 18-34","dimension":"ageBand+gender","criteria":{"gender":"male","ageBand":"18-34"},"targetCompletes":200}
  ]'::jsonb) into v_rows;

  if (select count(*) from public.quota_progress where recruitment_project_id = 'a0000000-0000-0000-0000-0000000004a1') <> 4 then
    raise exception 'expected 4 cells';
  end if;
  raise notice 'PASS 1  four cells written, including one of the cross';
end $$;

/* ============================================================ 2. one complete counts into EVERY cell it matches */

do $$
declare v record;
begin
  select * into v from public.rescript_quota_record(
    'a0000000-0000-0000-0000-0000000004a1',
    '{"gender":"male","ageBand":"18-34","country":"GB"}'::jsonb);

  if v.counted <> 3 then
    raise exception 'a male 18-34 should count into Male, 18-34 and Male 18-34 — counted %', v.counted;
  end if;
  if (select accepted from public.quota_progress where cell_id = 'g2') <> 0 then
    raise exception 'it was counted into Female as well';
  end if;
  raise notice 'PASS 2  one complete counts into all three cells it belongs to, and no others';
end $$;

/* ============================================================ 3. extra attributes do not prevent a match */

do $$
begin
  perform public.rescript_quota_record(
    'a0000000-0000-0000-0000-0000000004a1',
    '{"gender":"female","ageBand":"55+","income":"high","city":"Leeds"}'::jsonb);

  if (select accepted from public.quota_progress where cell_id = 'g2') <> 1 then
    raise exception 'a respondent with more attributes than the cell asks for did not match it';
  end if;
  if (select accepted from public.quota_progress where cell_id = 'a1') <> 1 then
    raise exception 'the 18-34 cell was wrongly incremented by a 55+ respondent';
  end if;
  raise notice 'PASS 3  a cell matches on its OWN criteria; the respondent may have more';
end $$;

/* ============================================================ 4. the door closes when a cell is full */

do $$
declare v record;
begin
  update public.quota_progress set accepted = target
   where recruitment_project_id = 'a0000000-0000-0000-0000-0000000004a1' and cell_id = 'g1';

  select * into v from public.rescript_quota_check(
    'a0000000-0000-0000-0000-0000000004a1', '{"gender":"male","ageBand":"18-34"}'::jsonb);
  if v.admit then raise exception 'a respondent was admitted into a full cell'; end if;
  if not ('g1' = any (v.full_cells)) then raise exception 'the full cell was not named'; end if;

  select * into v from public.rescript_quota_check(
    'a0000000-0000-0000-0000-0000000004a1', '{"gender":"female","ageBand":"18-34"}'::jsonb);
  if not v.admit then raise exception 'a female respondent was refused because the MALE cell is full'; end if;
  raise notice 'PASS 4  a full cell closes its own door and nobody else''s';
end $$;

/* ============================================================ 5. people mid-survey count against the target */

do $$
declare v record;
begin
  update public.quota_progress set accepted = 0, in_progress = 0
   where recruitment_project_id = 'a0000000-0000-0000-0000-0000000004a1';
  update public.quota_progress set accepted = 495, target = 500
   where recruitment_project_id = 'a0000000-0000-0000-0000-0000000004a1' and cell_id = 'g1';

  -- twenty people already answering
  for i in 1..20 loop
    perform public.rescript_quota_hold('a0000000-0000-0000-0000-0000000004a1', '{"gender":"male"}'::jsonb);
  end loop;

  select * into v from public.rescript_quota_check(
    'a0000000-0000-0000-0000-0000000004a1', '{"gender":"male"}'::jsonb);
  if v.admit then
    raise exception 'admitted a 516th male: 495 counted plus 20 mid-survey already exceeds 500';
  end if;
  raise notice 'PASS 5  people mid-survey hold their slot, so a cell is not oversold by the correctly admitted';
end $$;

/* ============================================================ 6. over-recruitment is recorded, not refused */

do $$
declare v record;
begin
  update public.quota_progress set accepted = 500, target = 500, in_progress = 0
   where recruitment_project_id = 'a0000000-0000-0000-0000-0000000004a1' and cell_id = 'g1';

  select * into v from public.rescript_quota_record(
    'a0000000-0000-0000-0000-0000000004a1', '{"gender":"male"}'::jsonb);

  if (select accepted from public.quota_progress where cell_id = 'g1') <> 501 then
    raise exception 'a finished respondent was not recorded — the data is lost and the incentive still owed';
  end if;
  if not ('g1' = any (v.overshot)) then raise exception 'the overshoot was not reported'; end if;
  raise notice 'PASS 6  a complete that overshoots is counted and flagged, never discarded';
end $$;

/* ============================================================ 7. editing a target keeps what was counted */

do $$
begin
  update public.quota_progress set accepted = 300
   where recruitment_project_id = 'a0000000-0000-0000-0000-0000000004a1' and cell_id = 'g1';

  perform public.rescript_quota_sync('a0000000-0000-0000-0000-0000000004a1', '[
    {"id":"g1","label":"Male","dimension":"gender","criteria":{"gender":"male"},"targetCompletes":600}
  ]'::jsonb);

  if (select accepted from public.quota_progress where cell_id = 'g1') <> 300 then
    raise exception 'raising a target un-recruited the people already counted';
  end if;
  if (select target from public.quota_progress where cell_id = 'g1') <> 600 then
    raise exception 'the new target was not applied';
  end if;
  if (select count(*) from public.quota_progress where recruitment_project_id = 'a0000000-0000-0000-0000-0000000004a1') <> 1 then
    raise exception 'cells removed from the specification are still being tracked';
  end if;
  raise notice 'PASS 7  a changed target keeps its count; a removed cell stops being tracked';
end $$;

/* ============================================================ 8. a cell with no target admits everybody */

do $$
declare v record;
begin
  perform public.rescript_quota_sync('a0000000-0000-0000-0000-0000000004a1', '[
    {"id":"n1","label":"Unlimited","dimension":"gender","criteria":{"gender":"male"},"targetCompletes":0}
  ]'::jsonb);

  select * into v from public.rescript_quota_check('a0000000-0000-0000-0000-0000000004a1', '{"gender":"male"}'::jsonb);
  if not v.admit then raise exception 'a cell with no target turned somebody away'; end if;
  raise notice 'PASS 8  a cell with no target constrains nobody';
end $$;

rollback;
