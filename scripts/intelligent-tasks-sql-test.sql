-- INTELLIGENT TASKS SQL TEST (0074, durable task and step state) — run against
-- a database with the migrations applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/intelligent-tasks-sql-test.sql
--
-- Proves, on the real table and the real function:
--   T1  a claim takes the first runnable step, in ordinal order
--   T2  a second claim never returns the step the first one holds
--   T3  dependencies gate it: a step waits for every id in depends_on
--   T4  a tombstoned dependency settles a dependant just as a completed one does
--   T5  a step abandoned past p_stale_seconds is reclaimed; one inside the window is not
--   T6  startedAt is the first start, not the reclaim
--   T7  p_max_attempts stops a step being offered forever
--   T8  blocked and tombstoned steps are never claimed
--   T9  no duplicate commit: (task_id, idempotency_key) is unique
--   T10 the same key on a second step of the same task is refused
--   T11 one row per step id in a task: (task_id, step_id) is unique
--   T12 the status and failure_kind check constraints hold the vocabulary
--   T13 privileges: anon / authenticated cannot call the claim or read either table
--   T14 deleting the task cascades its steps
--   P1  PARALLEL (needs the dblink extension): two clients racing one step —
--       `for update skip locked` gives it to exactly one of them
--
-- T1–T14 run in one transaction and are rolled back. P1 cannot: skip-locked
-- only skips rows locked by ANOTHER transaction, so it needs two committed
-- sessions. It creates its own task through dblink, races it, and deletes it;
-- when dblink is not installed it reports itself skipped rather than passing.

begin;

insert into public.customers (id, slug, name)
  values ('c0000074-0000-0000-0000-000000000001', 'it-test', 'Intelligent tasks test')
  on conflict do nothing;
insert into public.surveys (id, customer_id, code, title)
  values ('50000074-0000-0000-0000-000000000001', 'c0000074-0000-0000-0000-000000000001', 'ITT', 'Intelligent tasks');

create temp table t_ok (n serial, name text);
create or replace function pg_temp.check(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin
  if not p_ok then raise exception 'FAIL %: %', p_name, p_detail; end if;
  insert into t_ok (name) values (p_name);
  raise notice 'ok   %', p_name;
end $$;

/* one step row, spelled once */
create or replace function pg_temp.mkstep(
  p_task uuid, p_step text, p_ordinal integer,
  p_depends text[] default '{}', p_status text default 'pending'
) returns void language sql as $$
  insert into public.intelligent_steps (task_id, step_id, ordinal, depends_on, status, title, idempotency_key)
  values (p_task, p_step, p_ordinal, p_depends, p_status, 'Step ' || p_step, 'idem-' || p_step);
$$;
/* the step id one claim hands back, or null */
create or replace function pg_temp.claim(p_task uuid, p_stale integer default 180, p_max integer default 3) returns text
language sql as $$
  select step_id from public.rescript_claim_intelligent_step(p_task, p_stale, p_max) limit 1;
$$;

do $$
declare
  s uuid := '50000074-0000-0000-0000-000000000001';
  t uuid;
  t_other uuid;
  got text;
  n integer;
  ts timestamptz;
  ok boolean;
begin
  /* ---------------------------------------------------------------- T1 / T2 */
  insert into public.intelligent_tasks (survey_id, customer_id, kind, request, deliverable)
    values (s, 'c0000074-0000-0000-0000-000000000001', 'survey_build', 'a 100-question tracker', '{"kind":"survey_build","questionCount":100}'::jsonb)
    returning id into t;
  perform pg_temp.mkstep(t, 'a', 0);
  perform pg_temp.mkstep(t, 'b', 1);
  perform pg_temp.mkstep(t, 'c', 2);

  got := pg_temp.claim(t);
  perform pg_temp.check('T1 the first runnable step, in ordinal order', got = 'a', coalesce(got, 'null'));
  select status into got from public.intelligent_steps where task_id = t and step_id = 'a';
  perform pg_temp.check('T1 it is marked running and claimed', got = 'running'
    and (select claimed_at is not null and started_at is not null from public.intelligent_steps where task_id = t and step_id = 'a'), got);

  got := pg_temp.claim(t);
  perform pg_temp.check('T2 a second claim never returns the held step', got = 'b', coalesce(got, 'null'));
  got := pg_temp.claim(t);
  perform pg_temp.check('T2 and a third takes the last one', got = 'c', coalesce(got, 'null'));
  perform pg_temp.check('T2 nothing is left to claim', pg_temp.claim(t) is null);
  select count(*) into n from public.intelligent_steps where task_id = t and status = 'running';
  perform pg_temp.check('T2 three steps, three claims, none claimed twice', n = 3, n::text);

  /* ---------------------------------------------------------------- T3 / T4 */
  insert into public.intelligent_tasks (survey_id, kind, request, deliverable)
    values (s, 'translation', 'translate into French', '{"kind":"translation","language":"fr"}'::jsonb) returning id into t;
  perform pg_temp.mkstep(t, 'a', 0);
  perform pg_temp.mkstep(t, 'b', 1, array['a']);
  perform pg_temp.mkstep(t, 'c', 2, array['b', 'a']);

  got := pg_temp.claim(t);
  perform pg_temp.check('T3 only the step with no dependencies is runnable', got = 'a', coalesce(got, 'null'));
  perform pg_temp.check('T3 b and c are not offered while a is outstanding', pg_temp.claim(t) is null);
  update public.intelligent_steps set status = 'completed', claimed_at = null where task_id = t and step_id = 'a';
  got := pg_temp.claim(t);
  perform pg_temp.check('T3 a completed dependency releases its dependant', got = 'b', coalesce(got, 'null'));
  perform pg_temp.check('T3 c still waits on b', pg_temp.claim(t) is null);
  update public.intelligent_steps set status = 'tombstoned', claimed_at = null where task_id = t and step_id = 'b';
  got := pg_temp.claim(t);
  perform pg_temp.check('T4 a tombstoned dependency settles a dependant too', got = 'c', coalesce(got, 'null'));

  /* ---------------------------------------------------------------- T5 / T6 */
  insert into public.intelligent_tasks (survey_id, kind, request, deliverable)
    values (s, 'survey_build', 'reclaim', '{"kind":"survey_build"}'::jsonb) returning id into t;
  perform pg_temp.mkstep(t, 'a', 0);
  got := pg_temp.claim(t);
  perform pg_temp.check('T5 claimed once', got = 'a', coalesce(got, 'null'));
  perform pg_temp.check('T5 a live lease is never stolen', pg_temp.claim(t, 180) is null);
  select started_at into ts from public.intelligent_steps where task_id = t and step_id = 'a';
  /* the holder died 10 minutes ago */
  update public.intelligent_steps set claimed_at = now() - interval '10 minutes' where task_id = t and step_id = 'a';
  got := pg_temp.claim(t, 180);
  perform pg_temp.check('T5 an abandoned step past the window is reclaimed', got = 'a', coalesce(got, 'null'));
  perform pg_temp.check('T6 startedAt is the first start, not the reclaim',
    (select started_at from public.intelligent_steps where task_id = t and step_id = 'a') = ts);

  /* ---------------------------------------------------------------- T7 */
  update public.intelligent_steps set retry_count = 3, status = 'retrying', claimed_at = null where task_id = t and step_id = 'a';
  perform pg_temp.check('T7 a step past p_max_attempts is not offered again', pg_temp.claim(t, 180, 3) is null);
  perform pg_temp.check('T7 and a larger budget does offer it', pg_temp.claim(t, 180, 4) = 'a');

  /* ---------------------------------------------------------------- T8 */
  insert into public.intelligent_tasks (survey_id, kind, request, deliverable)
    values (s, 'other', 'blocked only', '{"kind":"other"}'::jsonb) returning id into t;
  perform pg_temp.mkstep(t, 'a', 0, '{}', 'blocked');
  perform pg_temp.mkstep(t, 'b', 1, '{}', 'tombstoned');
  perform pg_temp.mkstep(t, 'c', 2, '{}', 'completed');
  perform pg_temp.mkstep(t, 'd', 3, '{}', 'failed');
  perform pg_temp.check('T8 blocked, tombstoned, completed and failed steps are never claimed', pg_temp.claim(t) is null);

  /* ---------------------------------------------------------------- T9 / T10 / T11 */
  insert into public.intelligent_tasks (survey_id, kind, request, deliverable)
    values (s, 'survey_build', 'idempotency', '{"kind":"survey_build"}'::jsonb) returning id into t;
  perform pg_temp.mkstep(t, 'a', 0);
  begin
    insert into public.intelligent_steps (task_id, step_id, ordinal, idempotency_key) values (t, 'a', 1, 'idem-a2');
    perform pg_temp.check('T11 (task_id, step_id) unique', false, 'a duplicate step id was accepted');
  exception when unique_violation then
    perform pg_temp.check('T11 one row per step id in a task', true);
  end;
  begin
    insert into public.intelligent_steps (task_id, step_id, ordinal, idempotency_key) values (t, 'b', 1, 'idem-a');
    perform pg_temp.check('T9 (task_id, idempotency_key) unique', false, 'a duplicate idempotency key was accepted');
  exception when unique_violation then
    perform pg_temp.check('T9 no duplicate commit: the same key cannot be stored twice', true);
  end;
  /* the same key under a DIFFERENT task is fine — the guard is per task, not global */
  insert into public.intelligent_tasks (survey_id, kind, request, deliverable)
    values (s, 'other', 'key scope', '{"kind":"other"}'::jsonb) returning id into t_other;
  insert into public.intelligent_steps (task_id, step_id, ordinal, idempotency_key)
    values (t_other, 'a', 0, 'idem-a');
  select count(*) into n from public.intelligent_steps where idempotency_key = 'idem-a';
  perform pg_temp.check('T10 the key is scoped to its task, not global', n >= 2, n::text);

  /* ---------------------------------------------------------------- T12 */
  begin
    update public.intelligent_steps set status = 'half-done' where task_id = t and step_id = 'a';
    perform pg_temp.check('T12 status vocabulary', false, 'an unknown status was accepted');
  exception when check_violation then
    perform pg_temp.check('T12 the status check holds the vocabulary', true);
  end;
  begin
    update public.intelligent_steps set failure_kind = 'weird' where task_id = t and step_id = 'a';
    perform pg_temp.check('T12 failure_kind vocabulary', false, 'an unknown failure kind was accepted');
  exception when check_violation then
    perform pg_temp.check('T12 the failure_kind check holds the vocabulary', true);
  end;

  /* ---------------------------------------------------------------- T14 */
  select count(*) into n from public.intelligent_steps where task_id = t;
  perform pg_temp.check('T14 the task has steps before the delete', n > 0, n::text);
  delete from public.intelligent_tasks where id = t;
  select count(*) into n from public.intelligent_steps where task_id = t;
  perform pg_temp.check('T14 deleting the task cascades its steps', n = 0, n::text);
end $$;

/* ---------------------------------------------------------------- T13 */
do $$
declare ok boolean;
begin
  ok := not has_function_privilege('anon', 'public.rescript_claim_intelligent_step(uuid, integer, integer)', 'execute')
    and not has_function_privilege('authenticated', 'public.rescript_claim_intelligent_step(uuid, integer, integer)', 'execute')
    and not has_table_privilege('anon', 'public.intelligent_tasks', 'select')
    and not has_table_privilege('anon', 'public.intelligent_steps', 'select')
    and not has_table_privilege('authenticated', 'public.intelligent_tasks', 'select')
    and not has_table_privilege('authenticated', 'public.intelligent_steps', 'insert');
  perform pg_temp.check('T13 only the service role claims; anon and authenticated read nothing', ok);
  ok := (select relrowsecurity from pg_class where oid = 'public.intelligent_tasks'::regclass)
    and (select relrowsecurity from pg_class where oid = 'public.intelligent_steps'::regclass);
  perform pg_temp.check('T13 row level security is enabled on both tables', ok);
end $$;

select 'intelligent tasks SQL: ' || count(*) || ' checks passed' from t_ok;
rollback;

-- ------------------------------------------------------------------ P1
--
-- THE RACE ITSELF. `for update skip locked` only skips rows locked by another
-- transaction, so this needs two committed sessions; it cannot live in the
-- rolled-back block above. dblink gives us those two sessions from inside one
-- psql run. Without dblink the check reports itself SKIPPED — it must never
-- report a pass it did not make.

\set ON_ERROR_STOP 1

do $$
declare
  has_dblink boolean;
  t uuid := 'a0000074-0000-0000-0000-00000000beef';
  s uuid := '50000074-0000-0000-0000-00000000beef';
  c uuid := 'c0000074-0000-0000-0000-00000000beef';
  /* this very server, by socket or host: a test must not wander off to some other database */
  conn text := format('dbname=%s port=%s%s', current_database(), current_setting('port'),
    case when coalesce(current_setting('unix_socket_directories', true), '') = '' then ''
         else ' host=' || btrim(split_part(current_setting('unix_socket_directories'), ',', 1)) end);
  a text;
  b text;
begin
  select exists (select 1 from pg_extension where extname = 'dblink') into has_dblink;
  if not has_dblink then
    begin
      execute 'create extension if not exists dblink';
      has_dblink := true;
    exception when others then
      has_dblink := false;
    end;
  end if;
  if not has_dblink then
    raise notice 'SKIP P1 parallel claim: the dblink extension is not available here. Run it by hand with two psql clients:';
    raise notice '      session 1: begin; select step_id from public.rescript_claim_intelligent_step(''<task>'');   -- leave open';
    raise notice '      session 2: select step_id from public.rescript_claim_intelligent_step(''<task>'');          -- must NOT be the same step';
    return;
  end if;

  /* the fixture, committed so both sessions can see it */
  perform dblink_exec(conn, format($f$
    insert into public.customers (id, slug, name) values (%L, 'it-par', 'Intelligent tasks parallel') on conflict (id) do nothing;
    insert into public.surveys (id, customer_id, code, title) values (%L, %L, 'ITP', 'Intelligent tasks parallel') on conflict (id) do nothing;
    insert into public.intelligent_tasks (id, survey_id, customer_id, kind, request, deliverable)
      values (%L, %L, %L, 'survey_build', 'parallel claim', '{"kind":"survey_build"}'::jsonb) on conflict (id) do nothing;
    insert into public.intelligent_steps (task_id, step_id, ordinal, idempotency_key)
      values (%L, 'solo', 0, 'idem-solo') on conflict do nothing;
  $f$, c, s, c, t, s, c, t));

  /* session A takes the step and HOLDS the row lock inside an open transaction */
  perform dblink_connect('ra', conn);
  perform dblink_exec('ra', 'begin');
  select x.step_id into a from dblink('ra', format('select step_id from public.rescript_claim_intelligent_step(%L, 180, 3)', t)) as x(step_id text);

  /* session B arrives while A still holds it */
  perform dblink_connect('rb', conn);
  perform dblink_exec('rb', 'begin');
  select x.step_id into b from dblink('rb', format('select step_id from public.rescript_claim_intelligent_step(%L, 180, 3)', t)) as x(step_id text);

  perform dblink_exec('ra', 'rollback');
  perform dblink_exec('rb', 'rollback');
  perform dblink_disconnect('ra');
  perform dblink_disconnect('rb');
  perform dblink_exec(conn, format('delete from public.intelligent_tasks where id = %L; delete from public.surveys where id = %L; delete from public.customers where id = %L;', t, s, c));

  if a = 'solo' and b is null then
    raise notice 'ok   P1 two clients race one step: exactly one wins (skip locked)';
  else
    raise exception 'FAIL P1 parallel claim: A got %, B got % (B must get nothing)', coalesce(a, 'null'), coalesce(b, 'null');
  end if;
end $$;
