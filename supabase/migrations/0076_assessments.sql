-- 0076 — Assessments: the server-side score of a submitted paper, one row per session (2026-10-29, step 4A)
--
-- docs/ASSESSMENTS-2026-10-29.md (K4's 0075_assessments.sql, never applied anywhere, renumbered and reshaped:
-- 0075 is `0075_dashboard_counts_the_draft.sql`, already applied in production and untouchable).
--
-- A practice paper / quiz / knowledge test keeps its answer key in the stored survey and version only
-- (`question.assessment`); every respondent payload is stripped (runtime `lib/assessmentPayload.ts`). When a
-- paper is COMPLETED, the runtime's save route scores it against the server's definition
-- (packages/engine/src/assessment.ts `scoreAssessment`, deterministic) and upserts ONE row here per session:
--
--   assessment_results   session_id (the respondent's token, unique — a retried final save cannot duplicate),
--                        response_id, survey_id, version_id, is_test, result (the full AssessmentResult json:
--                        per question selected / correct / status / marks, totals, negative marks, percentage,
--                        pass, topic breakdown, weak areas, recommendations), key_fingerprint (the key it was
--                        scored against — /api/session/assessment re-scores when the key has changed since),
--                        score / max_score / percentage / passed (for sorting and the distribution),
--                        created_at / updated_at
--
-- Access: like the respondent-data tables of 0069 — roles that read responses may SELECT; anon, custom members,
-- vendors, interviewers and strangers see nothing; nobody but the service role writes (the runtime, behind the
-- session-token check). The result names the correct answers, which is what the respondent is shown AFTER
-- submitting; it is respondent data and is read like the responses it belongs to.
--
-- rescript_assessment_distribution(survey, test): the score distribution for the Studio (security invoker —
-- the caller's RLS applies), deleted responses excluded.
--
-- Re-runnable: `create … if not exists`, `drop … if exists` first, `create or replace`.
-- Undo (destroys stored scores; they can be recomputed from the answers):
--   drop function if exists public.rescript_assessment_distribution(uuid, boolean);
--   drop table if exists public.assessment_results;

create table if not exists public.assessment_results (
  id               uuid primary key default gen_random_uuid(),
  session_id       text not null unique references public.responses(session_id) on delete cascade,
  response_id      uuid not null references public.responses(id) on delete cascade,
  survey_id        uuid not null references public.surveys(id) on delete cascade,
  version_id       uuid references public.survey_versions(id) on delete set null,
  is_test          boolean not null default false,
  result           jsonb not null,
  key_fingerprint  text check (key_fingerprint is null or length(key_fingerprint) <= 64),
  score            numeric,
  max_score        numeric,
  percentage       numeric,
  passed           boolean,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'assessment_results_result_is_versioned_object') then
    alter table public.assessment_results add constraint assessment_results_result_is_versioned_object
      check (jsonb_typeof(result) = 'object' and (result ->> 'v') is not null);
  end if;
end $$;

create index if not exists assessment_results_survey_idx on public.assessment_results (survey_id, is_test, created_at desc);
create index if not exists assessment_results_response_idx on public.assessment_results (response_id);

drop trigger if exists assessment_results_touch on public.assessment_results;
create trigger assessment_results_touch before update on public.assessment_results
  for each row execute function public.touch_updated_at();

alter table public.assessment_results enable row level security;

drop policy if exists assessment_results_data_read on public.assessment_results;
create policy assessment_results_data_read on public.assessment_results for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );
-- no insert / update / delete policy: only the service role (which bypasses RLS) writes
revoke all on public.assessment_results from anon;
revoke insert, update, delete, truncate on public.assessment_results from authenticated;

comment on table public.assessment_results is
  'Assessments (0076): the server-side score of a completed paper, one row per session — scoreAssessment() in packages/engine/src/assessment.ts';

create or replace function public.rescript_assessment_distribution(p_survey uuid, p_test boolean default false)
returns table (bucket int, n bigint, mean_score numeric, pass_rate numeric)
language sql stable security invoker set search_path = public as $$
  select least(9, greatest(0, floor(coalesce(a.percentage, 0) / 10)))::int as bucket,
         count(*) as n,
         round(avg(a.score), 2) as mean_score,
         round(100.0 * avg(case when a.passed then 1 when a.passed is false then 0 end), 2) as pass_rate
  from public.assessment_results a
  join public.responses r on r.id = a.response_id
  where a.survey_id = p_survey and a.is_test = p_test and r.deleted_at is null and r.status = 'complete'
  group by 1 order by 1
$$;

revoke all on function public.rescript_assessment_distribution(uuid, boolean) from public, anon;
grant execute on function public.rescript_assessment_distribution(uuid, boolean) to authenticated, service_role;
