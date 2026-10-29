-- INTELLIGENT TASKS SQL TEST (migration 0074_intelligent_tasks.sql, amended 2026-10-29) — against a database with
-- every migration applied, 0074 applied TWICE (it is re-runnable):
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/intelligent-tasks-sql-test.sql
--
-- Adapted from K's scripts/copilot-tasks-sql-test.sql (branch k-work-2026-10-25) to the BASE's tables: there is one
-- engine — intelligent_tasks / intelligent_steps — and no copilot_tasks / plans / events / calls. Proves, on real
-- Postgres 16:
--   1. the two tables exist with RLS on, exactly one policy each (deny-all for `public`), no grant to anon /
--      authenticated; the claim function is not executable by anon or authenticated; the 2026-10-29 columns are
--      there (tasks: summary, completion, planner, base; steps: kind, input, parallel_group, model_tier) with the
--      model_tier check
--   2. shapes: task and step statuses, task kinds, one row per (task, step_id), one row per (task, idempotency_key)
--      — the duplicate-delivery guard — and the survey cascade
--   3. the claim: `rescript_claim_intelligent_step` hands a runnable step out ONCE (status running, claimed_at set,
--      retry_count unchanged on a first claim); a second claim while leased gets the next runnable step or nothing;
--      a step whose dependency is not complete is not handed out; a `running` step left past the stale window is
--      RECLAIMED and the reclaim costs an attempt; a step at max attempts is never handed out; `retrying` is runnable;
--      `tombstoned` / `completed` / `blocked` / `failed` never are; a tombstoned dependency counts as met
--   4. commit idempotency, as the store does it: the commit is an UPDATE guarded on status <> 'completed' with the
--      idempotency key; a second delivery of the same key updates no row; a second ROW with the same key is refused
--      by the unique index; the totals recomputed from the rows are the same after a replay
--   5. revise / tombstone: a split tombstones the step and inserts children that depend on what it depended on; a
--      dependant rewired to the children waits for them; the claim order follows ordinal
--   6. RLS: a service-role connection (bypassrls) reads the rows; an `authenticated` user with a project membership
--      sees NOTHING in either table and cannot insert; `anon` likewise; the policy is `using (false)`
--
-- One transaction, rolled back.

begin;

insert into public.customers (id, slug, name) values ('c0000000-0000-0000-0000-000000000074', 'tasks74', 'Tasks 0074') on conflict do nothing;
insert into auth.users (id, email, raw_user_meta_data) values
  ('c0000074-0000-0000-0000-000000000001', 'owner@t74.test', '{"full_name":"Owner"}'::jsonb)
on conflict do nothing;
insert into public.profiles (id, customer_id, email, full_name, role)
select u.id, 'c0000000-0000-0000-0000-000000000074'::uuid, u.email, u.email, 'programmer'
  from auth.users u where u.email = 'owner@t74.test'
on conflict (id) do update set customer_id = excluded.customer_id;
insert into public.surveys (id, customer_id, code, title, owner_id)
  values ('c0000000-0000-0000-0000-000000000174', 'c0000000-0000-0000-0000-000000000074', 'T74', 'Tasks project', 'c0000074-0000-0000-0000-000000000001')
on conflict (id) do update set owner_id = excluded.owner_id;
insert into public.project_members (survey_id, user_id, role, added_by, permissions) values
  ('c0000000-0000-0000-0000-000000000174', 'c0000074-0000-0000-0000-000000000001', 'editor', 'c0000074-0000-0000-0000-000000000001', null)
on conflict (survey_id, user_id) do update set role = excluded.role, permissions = excluded.permissions, revoked_at = null, expires_at = null;

-- ============================================== 1. tables, RLS, policies, privileges, the 2026-10-29 columns
do $$
declare t text; n int; c text; f text := 'public.rescript_claim_intelligent_step(uuid, integer, integer)';
begin
  foreach t in array array['intelligent_tasks', 'intelligent_steps'] loop
    assert to_regclass('public.' || t) is not null, t || ' exists';
    assert (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass), t || ' has RLS on';
    select count(*) into n from pg_policy where polrelid = ('public.' || t)::regclass;
    assert n = 1, t || ' has exactly one policy, got ' || n;
    assert (select pg_get_expr(polqual, polrelid) from pg_policy where polrelid = ('public.' || t)::regclass) = 'false', t || ': the policy is using (false)';
    assert not has_table_privilege('anon', 'public.' || t, 'select'), t || ': no select for anon';
    assert not has_table_privilege('authenticated', 'public.' || t, 'select'), t || ': no select for authenticated';
    assert not has_table_privilege('authenticated', 'public.' || t, 'insert'), t || ': no insert for authenticated';
  end loop;
  assert not has_function_privilege('anon', f, 'execute'), 'the claim is not for anon';
  assert not has_function_privilege('authenticated', f, 'execute'), 'the claim is not for authenticated';
  foreach c in array array['summary', 'completion', 'planner', 'base', 'blocked_reason', 'blocked_message', 'blocked_at', 'extra_charge'] loop
    assert exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'intelligent_tasks' and column_name = c), 'intelligent_tasks.' || c;
  end loop;
  foreach c in array array['kind', 'input', 'parallel_group', 'model_tier', 'depends_on', 'idempotency_key', 'claimed_at'] loop
    assert exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'intelligent_steps' and column_name = c), 'intelligent_steps.' || c;
  end loop;
  select count(*) into n from pg_indexes where schemaname = 'public' and tablename = 'intelligent_steps' and indexname in ('intelligent_steps_step_key', 'intelligent_steps_idem_key', 'intelligent_steps_task_idx', 'intelligent_steps_open_idx');
  assert n = 4, 'the four step indexes exist once each (applied twice), got ' || n;
  select count(*) into n from pg_trigger where tgrelid = 'public.intelligent_steps'::regclass and tgname = 'intelligent_steps_touch';
  assert n = 1, 'one touch trigger on steps after two applies';
  select count(*) into n from pg_trigger where tgrelid = 'public.intelligent_tasks'::regclass and tgname = 'intelligent_tasks_touch';
  assert n = 1, 'one touch trigger on tasks after two applies';
  raise notice 'PASS 1 tables, RLS, policies, privileges, columns';
end $$;

-- ============================================== 2. shapes
do $$
declare sid uuid := 'c0000000-0000-0000-0000-000000000174'; tid uuid; ok boolean;
begin
  insert into public.intelligent_tasks (survey_id, customer_id, created_by, kind, request, status, deliverable, summary, completion, planner, base)
    values (sid, 'c0000000-0000-0000-0000-000000000074', 'c0000074-0000-0000-0000-000000000001', 'survey_build', '100 UPSC questions', 'pending', '{"kind":"survey_build"}',
            '{"topic":"General Studies","questions":100}', '["questions>=100","unique_codes"]', 'generation', '{"questions":[]}')
    returning id into tid;
  ok := false; begin insert into public.intelligent_tasks (survey_id, status) values (sid, 'done'); exception when check_violation then ok := true; end; assert ok, 'unknown task status refused';
  ok := false; begin insert into public.intelligent_tasks (survey_id, kind) values (sid, 'poem'); exception when check_violation then ok := true; end; assert ok, 'unknown task kind refused';
  insert into public.intelligent_steps (task_id, step_id, ordinal, kind, title, input, parallel_group, model_tier, idempotency_key, batch_size) values
    (tid, 'outline', 0, 'gen.outline', 'Outline', '{"units":1}', null, 'standard', sid::text || ':outline:h0', 1),
    (tid, 'b1', 1, 'gen.batch', 'Questions 1–20', '{"units":20,"range":{"from":1,"to":20}}', 'g1', 'standard', sid::text || ':b1:h1', 20),
    (tid, 'b2', 2, 'gen.batch', 'Questions 21–40', '{"units":20,"range":{"from":21,"to":40}}', 'g1', 'standard', sid::text || ':b2:h2', 20),
    (tid, 'check', 3, 'gen.validate', 'Final check', '{}', null, 'small', sid::text || ':check:h3', null);
  update public.intelligent_steps set depends_on = '{outline}' where task_id = tid and step_id in ('b1', 'b2');
  update public.intelligent_steps set depends_on = '{b1,b2}' where task_id = tid and step_id = 'check';
  ok := false; begin insert into public.intelligent_steps (task_id, step_id, idempotency_key) values (tid, 'b1', 'x'); exception when unique_violation then ok := true; end; assert ok, 'one row per (task, step_id)';
  ok := false; begin insert into public.intelligent_steps (task_id, step_id, idempotency_key) values (tid, 'b9', sid::text || ':b1:h1'); exception when unique_violation then ok := true; end; assert ok, 'one row per (task, idempotency_key): the duplicate-delivery guard';
  ok := false; begin insert into public.intelligent_steps (task_id, step_id, idempotency_key, status) values (tid, 'b9', 'k9', 'done'); exception when check_violation then ok := true; end; assert ok, 'unknown step status refused';
  ok := false; begin insert into public.intelligent_steps (task_id, step_id, idempotency_key, model_tier) values (tid, 'b9', 'k9', 'huge'); exception when check_violation then ok := true; end; assert ok, 'unknown model tier refused';
  ok := false; begin insert into public.intelligent_steps (task_id, step_id, idempotency_key, failure_kind) values (tid, 'b9', 'k9', 'cosmic'); exception when check_violation then ok := true; end; assert ok, 'unknown failure kind refused';
  raise notice 'PASS 2 shapes';
end $$;

-- ============================================== 3. the claim: once, in order, dependencies, reclaim after the window, max attempts
do $$
declare
  sid uuid := 'c0000000-0000-0000-0000-000000000174'; tid uuid; r record; n int; claimed_at0 timestamptz;
begin
  select id into tid from public.intelligent_tasks where survey_id = sid and request = '100 UPSC questions';
  -- the only runnable step is the outline: b1/b2 depend on it, check depends on them
  select * into r from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert r.step_id = 'outline' and r.status = 'running' and r.retry_count = 0 and r.claimed_at is not null, 'the outline is claimed first: running, attempt not counted on a first claim';
  claimed_at0 := r.claimed_at;
  select count(*) into n from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert n = 0, 'while the outline is leased nothing else is runnable (its dependants wait) and it is not handed out twice';
  -- the worker died: past the stale window the step is reclaimed, and the reclaim costs an attempt
  update public.intelligent_steps set claimed_at = now() - interval '181 seconds' where task_id = tid and step_id = 'outline';
  select * into r from public.rescript_claim_intelligent_step(tid, 180, 3);
  -- (now() is fixed for the transaction, so "fresh" means: no longer the backdated time)
  assert r.step_id = 'outline' and r.retry_count = 1 and r.claimed_at = claimed_at0 and r.claimed_at > now() - interval '180 seconds', 'reclaimed after the window: attempt 1 counted, a fresh claim time';
  -- a reclaim inside the window does not happen
  select count(*) into n from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert n = 0, 'inside the window a running step is left to its holder';
  -- the outline completes (as the store commits: update guarded on status, with the key)
  update public.intelligent_steps set status = 'completed', output = '{"actions":[]}', claimed_at = null, finished_at = now(), idempotency_key = sid::text || ':outline:h0', tokens_in = 100, tokens_out = 50, charge = 0.01
    where task_id = tid and step_id = 'outline' and status <> 'completed';
  -- now b1 then b2 (ordinal order); two slices arriving together get different steps
  select * into r from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert r.step_id = 'b1', 'b1 is next by ordinal';
  select * into r from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert r.step_id = 'b2', 'a second slice gets b2, never b1 again';
  select count(*) into n from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert n = 0, 'check waits for b1 and b2';
  -- a step at max attempts is never handed out again, even stale
  update public.intelligent_steps set claimed_at = now() - interval '1 hour', retry_count = 3 where task_id = tid and step_id = 'b2';
  select count(*) into n from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert n = 0, 'b2 at max attempts (3) is not reclaimed; b1 is inside its window';
  update public.intelligent_steps set retry_count = 2 where task_id = tid and step_id = 'b2';
  select * into r from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert r.step_id = 'b2' and r.retry_count = 3, 'one attempt left: reclaimed, now at 3';
  -- `retrying` is runnable; blocked / failed / tombstoned are not
  update public.intelligent_steps set status = 'retrying', claimed_at = null, retry_count = 1 where task_id = tid and step_id = 'b2';
  update public.intelligent_steps set status = 'blocked', claimed_at = null where task_id = tid and step_id = 'b1';
  select * into r from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert r.step_id = 'b2' and r.status = 'running' and r.retry_count = 1, 'a retrying step is claimed (no attempt added: it was not running)';
  select count(*) into n from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert n = 0, 'a blocked step is never handed out';
  update public.intelligent_steps set status = 'failed', claimed_at = null where task_id = tid and step_id = 'b1';
  select count(*) into n from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert n = 0, 'nor a failed one';
  raise notice 'PASS 3 the claim: once, in order, dependencies, reclaim after the window, max attempts';
end $$;

-- ============================================== 4. commit idempotency
do $$
declare sid uuid := 'c0000000-0000-0000-0000-000000000174'; tid uuid; n int; ok boolean; total numeric; key text;
begin
  select id into tid from public.intelligent_tasks where survey_id = sid and request = '100 UPSC questions';
  key := sid::text || ':b2:h2';
  update public.intelligent_steps set status = 'running' where task_id = tid and step_id = 'b2';
  -- first delivery: the store's commit statement
  update public.intelligent_steps set status = 'completed', output = '{"actions":[{"op":"create_question"}]}', validation_status = 'valid', idempotency_key = key,
         tokens_in = 1000, tokens_out = 400, charge = 0.05, claimed_at = null, failure_kind = null, failure_message = null, finished_at = now()
   where task_id = tid and step_id = 'b2' and status <> 'completed';
  get diagnostics n = row_count; assert n = 1, 'the first delivery commits one row';
  -- second delivery of the same key: updates nothing, the stored output stands
  update public.intelligent_steps set status = 'completed', output = '{"actions":[]}', idempotency_key = key, tokens_in = 9999, charge = 9
   where task_id = tid and step_id = 'b2' and status <> 'completed';
  get diagnostics n = row_count; assert n = 0, 'a second delivery updates no row';
  assert (select tokens_in from public.intelligent_steps where task_id = tid and step_id = 'b2') = 1000, 'the first output and usage stand';
  -- a second ROW with the same key cannot exist (the other half of the guard)
  ok := false; begin insert into public.intelligent_steps (task_id, step_id, idempotency_key) values (tid, 'b2-again', key); exception when unique_violation then ok := true; end; assert ok, 'a second row with the committed key is refused';
  -- the totals recomputed from the rows: the same after a replay
  select coalesce(sum(charge), 0) into total from public.intelligent_steps where task_id = tid;
  update public.intelligent_tasks set charge = total + extra_charge where id = tid;
  assert (select charge from public.intelligent_tasks where id = tid) = 0.06, 'charge = 0.01 (outline) + 0.05 (b2), got ' || (select charge from public.intelligent_tasks where id = tid);
  update public.intelligent_tasks set extra_charge = 0.004 where id = tid;
  select coalesce(sum(charge), 0) into total from public.intelligent_steps where task_id = tid;
  update public.intelligent_tasks set charge = total + extra_charge where id = tid;
  assert (select charge from public.intelligent_tasks where id = tid) = 0.064, 'the turn''s own spend is the visible remainder (audit M7)';
  assert (select updated_at from public.intelligent_tasks where id = tid) >= (select created_at from public.intelligent_tasks where id = tid), 'touch trigger keeps updated_at';
  raise notice 'PASS 4 commit idempotency';
end $$;

-- ============================================== 5. revise / tombstone: a split, dependants rewired
do $$
declare sid uuid := 'c0000000-0000-0000-0000-000000000174'; tid uuid; r record; n int;
begin
  select id into tid from public.intelligent_tasks where survey_id = sid and request = '100 UPSC questions';
  -- b1 failed on an output limit: the planner splits it — b1 tombstoned, b1a / b1b inserted with b1's dependsOn, check rewired
  update public.intelligent_steps set status = 'tombstoned', claimed_at = null where task_id = tid and step_id = 'b1';
  insert into public.intelligent_steps (task_id, step_id, plan_version, ordinal, depends_on, kind, title, input, idempotency_key, batch_size) values
    (tid, 'b1a', 2, 1, '{outline}', 'gen.batch', 'Questions 1–10', '{"units":10,"range":{"from":1,"to":10}}', sid::text || ':b1a:h4', 10),
    (tid, 'b1b', 2, 1, '{outline}', 'gen.batch', 'Questions 11–20', '{"units":10,"range":{"from":11,"to":20}}', sid::text || ':b1b:h5', 10);
  update public.intelligent_steps set depends_on = '{b1a,b1b,b2}', plan_version = 2 where task_id = tid and step_id = 'check';
  update public.intelligent_tasks set plan_version = 2 where id = tid;
  -- the claim skips the tombstone, hands out the children in order, and check waits for them
  select * into r from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert r.step_id = 'b1a', 'the first child is claimed, not the tombstone (got ' || r.step_id || ')';
  select * into r from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert r.step_id = 'b1b', 'then the second child';
  select count(*) into n from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert n = 0, 'check waits for b1a and b1b (b2 is complete)';
  update public.intelligent_steps set status = 'completed', claimed_at = null, finished_at = now() where task_id = tid and step_id in ('b1a', 'b1b');
  select * into r from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert r.step_id = 'check', 'check runs once every dependency is complete';
  -- a tombstoned dependency counts as met: a dependant of a tombstone whose replacement was dropped from the plan is not stuck
  update public.intelligent_steps set status = 'completed', claimed_at = null where task_id = tid and step_id = 'check';
  insert into public.intelligent_steps (task_id, step_id, plan_version, ordinal, depends_on, kind, idempotency_key) values (tid, 'repair', 2, 9, '{b1}', 'gen.repair', sid::text || ':repair:h6');
  select * into r from public.rescript_claim_intelligent_step(tid, 180, 3);
  assert r.step_id = 'repair', 'a dependency that is tombstoned is met';
  select count(*) into n from public.intelligent_steps where task_id = tid and status = 'tombstoned';
  assert n = 1, 'the tombstone stays as history';
  raise notice 'PASS 5 revise / tombstone';
end $$;

-- ============================================== 6. RLS: service role reads, authenticated and anon see nothing
create temp table t74_seen (who text, tasks int, steps int, inserted boolean) on commit drop;
grant insert, select on t74_seen to authenticated, anon;
grant usage on schema public to authenticated, anon;
-- a plain-Postgres shim for the test: GRANT so that it is the policy, not the missing grant, that refuses — production keeps the revoke too
grant select, insert on public.intelligent_tasks, public.intelligent_steps to authenticated, anon;
do $$
declare sid uuid := 'c0000000-0000-0000-0000-000000000174'; nt int; ns int; ins boolean; who text;
begin
  -- the project's own editor, authenticated
  perform set_config('request.jwt.claim.sub', 'c0000074-0000-0000-0000-000000000001', true);
  perform set_config('request.jwt.claims', '{"sub":"c0000074-0000-0000-0000-000000000001","role":"authenticated"}', true);
  foreach who in array array['authenticated', 'anon'] loop
    execute 'set local role ' || who;
    select count(*) into nt from public.intelligent_tasks where survey_id = sid;
    select count(*) into ns from public.intelligent_steps s join public.intelligent_tasks t on t.id = s.task_id where t.survey_id = sid;
    ins := true;
    begin
      insert into public.intelligent_tasks (survey_id, request) values (sid, 'smuggled');
    exception when insufficient_privilege or check_violation then ins := false;
    end;
    execute 'reset role';
    insert into t74_seen values (who, nt, ns, ins);
  end loop;
end $$;
revoke select, insert on public.intelligent_tasks, public.intelligent_steps from authenticated, anon;
do $$
declare sid uuid := 'c0000000-0000-0000-0000-000000000174';
begin
  assert (select tasks from t74_seen where who = 'authenticated') = 0, 'an authenticated project editor sees no task';
  assert (select steps from t74_seen where who = 'authenticated') = 0, 'and no step';
  assert (select inserted from t74_seen where who = 'authenticated') = false, 'and cannot insert one';
  assert (select tasks + steps from t74_seen where who = 'anon') = 0 and (select inserted from t74_seen where who = 'anon') = false, 'anon likewise';
  assert (select count(*) from public.intelligent_tasks where survey_id = sid) = 1, 'the superuser (bypassrls, as the service role) reads the task';
  assert (select count(*) from public.intelligent_steps s join public.intelligent_tasks t on t.id = s.task_id where t.survey_id = sid) = 7, 'and its seven step rows (4 planned, 2 children, 1 repair)';
  assert (select count(*) from public.intelligent_tasks where request = 'smuggled') = 0, 'nothing was smuggled in';
  raise notice 'PASS 6 RLS: service role only';
end $$;

-- ============================================== 7. cascades
do $$
declare sid uuid := 'c0000000-0000-0000-0000-000000000174'; tid uuid;
begin
  select id into tid from public.intelligent_tasks where survey_id = sid and request = '100 UPSC questions';
  delete from public.intelligent_tasks where id = tid;
  assert (select count(*) from public.intelligent_steps where task_id = tid) = 0, 'steps go with the task';
  insert into public.intelligent_tasks (survey_id, request) values (sid, 'another');
  delete from public.surveys where id = sid;
  assert (select count(*) from public.intelligent_tasks where survey_id = sid) = 0, 'deleting the survey removes its tasks';
  raise notice 'PASS 7 cascades';
end $$;

rollback;
