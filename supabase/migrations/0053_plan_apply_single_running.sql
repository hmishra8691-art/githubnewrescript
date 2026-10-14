-- 0053 — the apply lock becomes a constraint (audit P-11).
--
-- "A running row younger than two minutes is the lock" was a check followed by
-- an insert: two simultaneous applies could both pass the check. A partial
-- unique index makes the database the arbiter — one "running" row per survey.
-- A row left "running" by a crashed apply would then block the survey for
-- good, so the application ages such rows to "failed" before it inserts
-- (analysisPlanCore.beginApply), and this migration clears any that exist now.

update public.analytics_plan_applies
   set status = 'failed', error = coalesce(error, 'This apply did not finish — it was interrupted.'), finished_at = coalesce(finished_at, now())
 where status = 'running' and started_at < now() - interval '2 minutes';

-- if two live "running" rows somehow exist, keep the newest
update public.analytics_plan_applies a
   set status = 'failed', error = coalesce(error, 'Superseded by a newer apply.'), finished_at = coalesce(finished_at, now())
 where status = 'running'
   and exists (select 1 from public.analytics_plan_applies b where b.survey_id = a.survey_id and b.status = 'running' and b.started_at > a.started_at);

create unique index if not exists analytics_plan_applies_one_running
  on public.analytics_plan_applies (survey_id) where status = 'running';
