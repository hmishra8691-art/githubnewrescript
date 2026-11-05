-- QUOTA HOLDS (migration 0089).
--
--   psql "$DB" -v ON_ERROR_STOP=1 -f scripts/quota-holds-sql-test.sql
--
-- One transaction, rolled back. The subject is the LEAK: a slot held on what the vendor claimed at the door,
-- for a respondent who finishes as somebody else. The cell that was held keeps a slot for ever and quietly
-- stops admitting people while it is nowhere near full.

begin;

\set cust '''b0000000-0000-0000-0000-0000000000b1'''
\set usr  '''b00000b1-0000-0000-0000-000000000001'''
\set srv  '''b0000000-0000-0000-0000-0000000001b1'''
\set proj '''b0000000-0000-0000-0000-0000000004b1'''

insert into auth.users (id, email) values (:usr, 'holds@example.test');
insert into public.customers (id, slug, name) values (:cust, 'holds', 'Holds');
insert into public.profiles (id, customer_id, email, full_name, role)
  values (:usr, :cust, 'holds@example.test', 'Researcher', 'researcher')
  on conflict (id) do update set customer_id = excluded.customer_id, role = excluded.role;
insert into public.surveys (id, customer_id, code, title, owner_id)
  values (:srv, :cust, 'HOLDS', 'Holds', :usr);
insert into public.recruitment_projects (id, customer_id, survey_id, required_completes, budget_amount, budget_currency, status)
  values (:proj, :cust, :srv, 1000, 10000, 'GBP', 'fielding');

select public.rescript_quota_sync(:proj, '[
  {"id":"g1","label":"Male","dimension":"gender","criteria":{"gender":"male"},"targetCompletes":10},
  {"id":"g2","label":"Female","dimension":"gender","criteria":{"gender":"female"},"targetCompletes":10},
  {"id":"a1","label":"18-34","dimension":"ageBand","criteria":{"ageBand":"18-34"},"targetCompletes":10},
  {"id":"t1","label":"Tiny","dimension":"region","criteria":{"region":"north"},"targetCompletes":1}
]'::jsonb);

/* ============================================================ 1. the mapping has somewhere to live */

do $$
begin
  if (select quota_mapping from public.recruitment_projects where id = 'b0000000-0000-0000-0000-0000000004b1')
     <> '{}'::jsonb then
    raise exception 'a project should start with no mapping declared';
  end if;

  update public.recruitment_projects
     set quota_mapping = '{"gender":{"criterion":"gender","values":{"m":"male","f":"female"}}}'::jsonb
   where id = 'b0000000-0000-0000-0000-0000000004b1';

  begin
    update public.recruitment_projects set quota_mapping = '[]'::jsonb
     where id = 'b0000000-0000-0000-0000-0000000004b1';
    raise exception 'a mapping that is not an object was accepted';
  exception when check_violation then null;
  end;

  raise notice 'PASS 1  quota_mapping holds an object and refuses anything else';
end $$;

/* ============================================================ 2. a hold reserves a slot in every matching cell */

do $$
declare v record;
begin
  select * into v from public.rescript_quota_hold_session(
    'b0000000-0000-0000-0000-0000000004b1', 'sess-male-18-34',
    '{"gender":"male","ageBand":"18-34"}'::jsonb);

  if not v.held then raise exception 'the first hold for a session should be taken'; end if;
  if v.cells <> 2 then raise exception 'a male 18-34 holds Male and 18-34 — held % cells', v.cells; end if;
  if (select in_progress from public.quota_progress where cell_id = 'g2') <> 0 then
    raise exception 'a male held a slot in Female';
  end if;
  raise notice 'PASS 2  a hold reserves a slot in every cell the claim matches, and no others';
end $$;

/* ============================================================ 3. a reload does not hold a second slot */

do $$
declare v record;
begin
  select * into v from public.rescript_quota_hold_session(
    'b0000000-0000-0000-0000-0000000004b1', 'sess-male-18-34',
    '{"gender":"male","ageBand":"18-34"}'::jsonb);

  if v.held then raise exception 'the same session held a slot twice'; end if;
  if (select in_progress from public.quota_progress where cell_id = 'g1') <> 1 then
    raise exception 'a reload inflated in_progress to %',
      (select in_progress from public.quota_progress where cell_id = 'g1');
  end if;
  raise notice 'PASS 3  a reload, a retry or a second tab holds nothing more';
end $$;

/* ============================================================ 4. in_progress closes a cell at the door */

do $$
declare v record;
begin
  perform public.rescript_quota_hold_session(
    'b0000000-0000-0000-0000-0000000004b1', 'sess-north', '{"region":"north"}'::jsonb);

  select * into v from public.rescript_quota_check(
    'b0000000-0000-0000-0000-0000000004b1', '{"region":"north"}'::jsonb);

  if v.admit then
    raise exception 'a cell of one with one person mid-survey admitted a second';
  end if;
  if not ('t1' = any (v.full_cells)) then raise exception 'the full cell was not named'; end if;
  raise notice 'PASS 4  somebody already answering closes the last slot — the overshoot 0088 was built to stop';
end $$;

/* ============================================================ 5. a screen-out gives the slot back */

do $$
declare v_cells integer;
begin
  select public.rescript_quota_release_session('sess-north', 'screened') into v_cells;
  if v_cells <> 1 then raise exception 'the release touched % cells', v_cells; end if;
  if (select in_progress from public.quota_progress where cell_id = 't1') <> 0 then
    raise exception 'a screened-out respondent kept their slot';
  end if;
  if (select admit from public.rescript_quota_check(
        'b0000000-0000-0000-0000-0000000004b1', '{"region":"north"}'::jsonb)) is distinct from true then
    raise exception 'the cell stayed closed after the slot was given back';
  end if;
  if (select outcome from public.quota_holds where session_id = 'sess-north') <> 'screened' then
    raise exception 'the release did not record why';
  end if;
  raise notice 'PASS 5  a screen-out releases the slot and the cell admits again';
end $$;

/* ============================================================ 6. releasing twice does not invent slots */

do $$
begin
  if public.rescript_quota_release_session('sess-north', 'screened') <> 0 then
    raise exception 'an already-released hold was released again';
  end if;
  if public.rescript_quota_release_session('sess-never-existed', 'abandoned') <> 0 then
    raise exception 'a session that never held a slot released one';
  end if;
  if (select in_progress from public.quota_progress where cell_id = 't1') <> 0 then
    raise exception 'in_progress went negative';
  end if;
  raise notice 'PASS 6  release is idempotent — a retried save and a sweep cannot double-release';
end $$;

/* ============================================================ 7. THE LEAK: held as male, finished as female */

do $$
declare v record;
begin
  -- sess-male-18-34 is still holding Male and 18-34 from test 2. The screener says female.
  select * into v from public.rescript_quota_complete_session(
    'b0000000-0000-0000-0000-0000000004b1', 'sess-male-18-34',
    '{"gender":"female","ageBand":"18-34"}'::jsonb);

  if (select in_progress from public.quota_progress where cell_id = 'g1') <> 0 then
    raise exception 'Male kept a slot held by somebody who finished as a woman — in_progress %',
      (select in_progress from public.quota_progress where cell_id = 'g1');
  end if;
  if (select accepted from public.quota_progress where cell_id = 'g1') <> 0 then
    raise exception 'the vendor''s claim was counted instead of the survey''s answer';
  end if;
  if (select accepted from public.quota_progress where cell_id = 'g2') <> 1 then
    raise exception 'Female was not counted';
  end if;
  if (select accepted from public.quota_progress where cell_id = 'a1') <> 1 then
    raise exception '18-34 was not counted — the criteria they agreed on should still count';
  end if;
  if (select in_progress from public.quota_progress where cell_id = 'a1') <> 0 then
    raise exception '18-34 was held AND counted, and kept its hold';
  end if;
  if v.released <> 2 then raise exception 'the release touched % cells, not the 2 that were held', v.released; end if;
  if v.counted <> 2 then raise exception 'counted % cells, not Female and 18-34', v.counted; end if;
  if not v.corrected then raise exception 'the disagreement was not reported'; end if;
  raise notice 'PASS 7  the hold follows the claim, the count follows the survey, and no slot is stranded';
end $$;

/* ============================================================ 8. the disagreement is written down */

do $$
declare v_h public.quota_holds;
begin
  select * into v_h from public.quota_holds where session_id = 'sess-male-18-34';
  if v_h.released_at is null or v_h.outcome <> 'complete' then
    raise exception 'the completed hold was not closed';
  end if;
  if v_h.observed is null then raise exception 'what the survey observed was not kept'; end if;
  if jsonb_array_length(v_h.conflicts) <> 1 then
    raise exception 'the vendor''s mis-description was not recorded';
  end if;
  if v_h.conflicts->0->>'claimed' <> 'male' then raise exception 'the claim was not kept beside the answer'; end if;
  raise notice 'PASS 8  the claim, the answer and the disagreement are all on the row';
end $$;

/* ============================================================ 9. a complete with no hold still counts */

do $$
declare v record;
begin
  select * into v from public.rescript_quota_complete_session(
    'b0000000-0000-0000-0000-0000000004b1', 'sess-direct-link',
    '{"gender":"male"}'::jsonb);

  if v.counted <> 1 then raise exception 'an arrival that skipped the gateway was not counted'; end if;
  if v.released <> 0 then raise exception 'a session with no hold released %', v.released; end if;
  if v.corrected then raise exception 'nothing disagreed and something was reported'; end if;
  if (select in_progress from public.quota_progress where cell_id = 'g1') <> 0 then
    raise exception 'counting a complete with no hold stole somebody else''s slot';
  end if;
  raise notice 'PASS 9  a direct link, a test, a study that turned recruitment on mid-field: still counted';
end $$;

/* ============================================================ 10. an unresolvable claim holds nothing */

do $$
declare v record;
begin
  select * into v from public.rescript_quota_hold_session(
    'b0000000-0000-0000-0000-0000000004b1', 'sess-unknown', '{}'::jsonb);

  if not v.held then raise exception 'the hold row should exist even when it reserves nothing'; end if;
  if v.cells <> 0 then raise exception 'an empty claim held % cells', v.cells; end if;
  if (select admit from public.rescript_quota_check(
        'b0000000-0000-0000-0000-0000000004b1', '{}'::jsonb)) is distinct from true then
    raise exception 'a respondent whose attributes could not be resolved was turned away';
  end if;
  raise notice 'PASS 10 a mapping gap admits and reserves nothing — it never turns valid sample away';
end $$;

/* ============================================================ 11. record no longer guesses about holds */

do $$
declare v_before integer; v_after integer;
begin
  perform public.rescript_quota_hold_session(
    'b0000000-0000-0000-0000-0000000004b1', 'sess-other-person', '{"gender":"male"}'::jsonb);
  select in_progress into v_before from public.quota_progress where cell_id = 'g1';

  -- somebody ELSE completing as male, with no hold of their own
  perform public.rescript_quota_record('b0000000-0000-0000-0000-0000000004b1', '{"gender":"male"}'::jsonb);
  select in_progress into v_after from public.quota_progress where cell_id = 'g1';

  if v_after <> v_before then
    raise exception 'rescript_quota_record took a slot it had not held: % -> %', v_before, v_after;
  end if;
  raise notice 'PASS 11 record counts and does not touch in_progress — 0088 assumed held cells were counted cells';
end $$;

/* ============================================================ 12. turned away is counted, not lost */

do $$
begin
  perform public.rescript_quota_hold_session(
    'b0000000-0000-0000-0000-0000000004b1', 'sess-full-north', '{"region":"north"}'::jsonb);
  perform public.rescript_quota_record('b0000000-0000-0000-0000-0000000004b1', '{"region":"north"}'::jsonb);

  if (select admit from public.rescript_quota_check(
        'b0000000-0000-0000-0000-0000000004b1', '{"region":"north"}'::jsonb)) then
    raise exception 'a filled cell of one still admitted';
  end if;
  if public.rescript_quota_turned_away('b0000000-0000-0000-0000-0000000004b1', array['t1']) <> 1 then
    raise exception 'the refusal was not counted';
  end if;
  if (select turned_away from public.quota_progress where cell_id = 't1') <> 1 then
    raise exception 'turned_away did not move — the number that justifies widening a quota';
  end if;
  raise notice 'PASS 12 somebody turned away at a full cell is counted, not discarded';
end $$;

/* ============================================================ 13. the sweep releases a batch in one statement */

do $$
declare v_released integer;
begin
  update public.quota_progress set in_progress = 0, accepted = 0, turned_away = 0
   where recruitment_project_id = 'b0000000-0000-0000-0000-0000000004b1';
  delete from public.quota_holds where recruitment_project_id = 'b0000000-0000-0000-0000-0000000004b1';

  -- four people walked away: three claiming male, one claiming female. All four matched Male-or-Female; three
  -- of them also matched 18-34. If the release counted CLAIMS per cell rather than per row, Male would get
  -- one slot back instead of three.
  perform public.rescript_quota_hold_session('b0000000-0000-0000-0000-0000000004b1', 'gone-1', '{"gender":"male","ageBand":"18-34"}'::jsonb);
  perform public.rescript_quota_hold_session('b0000000-0000-0000-0000-0000000004b1', 'gone-2', '{"gender":"male","ageBand":"18-34"}'::jsonb);
  perform public.rescript_quota_hold_session('b0000000-0000-0000-0000-0000000004b1', 'gone-3', '{"gender":"male"}'::jsonb);
  perform public.rescript_quota_hold_session('b0000000-0000-0000-0000-0000000004b1', 'gone-4', '{"gender":"female","ageBand":"18-34"}'::jsonb);

  if (select in_progress from public.quota_progress where cell_id = 'g1') <> 3 then
    raise exception 'three males should be holding Male, found %',
      (select in_progress from public.quota_progress where cell_id = 'g1');
  end if;

  select public.rescript_quota_release_abandoned(array['gone-1','gone-2','gone-3','gone-4']) into v_released;
  if v_released <> 4 then raise exception 'released % holds, not 4', v_released; end if;

  if (select in_progress from public.quota_progress where cell_id = 'g1') <> 0 then
    raise exception 'Male kept % slots after every holder was swept up',
      (select in_progress from public.quota_progress where cell_id = 'g1');
  end if;
  if (select in_progress from public.quota_progress where cell_id = 'a1') <> 0 then
    raise exception '18-34 kept % slots — three different claims matched it',
      (select in_progress from public.quota_progress where cell_id = 'a1');
  end if;
  if (select in_progress from public.quota_progress where cell_id = 'g2') <> 0 then
    raise exception 'Female kept a slot';
  end if;
  if (select count(*) from public.quota_holds where outcome = 'abandoned') <> 4 then
    raise exception 'the sweep did not say why the holds ended';
  end if;
  if public.rescript_quota_release_abandoned(array['gone-1','gone-2']) <> 0 then
    raise exception 'a second sweep released holds that were already given back';
  end if;
  raise notice 'PASS 13 the sweep gives every abandoned slot back, counted per cell and not per claim';
end $$;

rollback;
