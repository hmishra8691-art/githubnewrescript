-- ============================================================================
-- Survey Project Dashboard
--
-- Two things:
--   1. the survey lifecycle gains `paused` and `archived`
--   2. one function returns every statistic the dashboard shows, for every
--      survey, in a single round trip
--
-- The dashboard must stay fast with thousands of projects, and the naive
-- version of this — fetch each survey's definition JSON and count in the app —
-- transfers megabytes to count integers. Counting where the data already is
-- keeps the payload to one small row per survey.
-- ============================================================================

-- ------------------------------------------------------------- 1. lifecycle
-- draft → testing → live, with paused/closed/archived as end states.
alter table public.surveys drop constraint if exists surveys_status_check;
alter table public.surveys
  add constraint surveys_status_check
  check (status in ('draft', 'testing', 'live', 'paused', 'closed', 'archived'));

-- ------------------------------------------------------------- 2. indexes
-- The stats function counts responses per survey and finds the most recent
-- one; both want the survey_id leading. `responses_survey_idx` already covers
-- (survey_id, status), this adds the test/live split and the recency lookup.
create index if not exists responses_survey_test_idx
  on public.responses (survey_id, is_test);
create index if not exists responses_survey_recent_idx
  on public.responses (survey_id, started_at desc);
create index if not exists survey_versions_survey_idx
  on public.survey_versions (survey_id, created_at desc);

-- --------------------------------------------------- 3. question counting
-- A "question" is what a respondent is asked. That excludes:
--   • page breaks and other flow nodes — they live in `definition.flow`,
--     never in `definition.questions`, so they are already out
--   • display-only and derived elements: html blocks, hidden variables,
--     calculated variables and embedded data captures
--   • anything not placed on a page, which can never be shown
create or replace function public.rescript_question_count(def jsonb)
returns int
language sql
immutable
parallel safe
as $$
  with placed as (
    -- every question id referenced by a page node, at any nesting depth
    select jsonb_array_elements_text(node -> 'questionIds') as qid
    from (
      select jsonb_path_query(def -> 'flow', '$.**?(@.type == "page")') as node
    ) pages
    where node ? 'questionIds'
  )
  select coalesce(count(*), 0)::int
  from jsonb_array_elements(coalesce(def -> 'questions', '[]'::jsonb)) q
  where q ->> 'type' not in ('html', 'hidden', 'calculated', 'embedded_data')
    and (
      -- a survey with no flow yet still reports its questions rather than 0
      not exists (select 1 from placed)
      or (q ->> 'id') in (select qid from placed)
    );
$$;

comment on function public.rescript_question_count(jsonb) is
  'Respondent-facing question count for a survey definition: excludes flow nodes, display-only/derived elements and questions not placed on a page.';

-- ------------------------------------------------------ 4. dashboard stats
-- One row per survey, everything the listing page needs.
--
-- `contributor_ids` is the union of everyone who created the survey, saved a
-- version of it, or acted on it in the audit log — distinct users, not edits.
-- Studio auth is not wired yet, so these columns are NULL today and the
-- function returns an empty array; it starts counting the moment sign-in
-- lands, with no change here.
create or replace function public.survey_dashboard_stats()
returns table (
  survey_id uuid,
  question_count int,
  response_count int,
  test_response_count int,
  live_response_count int,
  complete_count int,
  last_response_at timestamptz,
  contributor_ids uuid[],
  version_count int
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id as survey_id,
    coalesce(public.rescript_question_count(v.definition), 0) as question_count,
    coalesce(r.total, 0)::int as response_count,
    coalesce(r.test_total, 0)::int as test_response_count,
    coalesce(r.live_total, 0)::int as live_response_count,
    coalesce(r.complete_total, 0)::int as complete_count,
    r.last_at as last_response_at,
    coalesce(c.ids, array[]::uuid[]) as contributor_ids,
    coalesce(vc.n, 0)::int as version_count
  from public.surveys s
  left join public.survey_versions v on v.id = s.current_version_id
  left join lateral (
    select
      count(*) as total,
      count(*) filter (where x.is_test) as test_total,
      count(*) filter (where not x.is_test) as live_total,
      count(*) filter (where x.status = 'complete') as complete_total,
      max(x.started_at) as last_at
    from public.responses x
    where x.survey_id = s.id
  ) r on true
  left join lateral (
    select array_agg(distinct uid) as ids
    from (
      select s.created_by as uid
      union
      select sv.created_by from public.survey_versions sv where sv.survey_id = s.id
      union
      select al.user_id from public.audit_logs al where al.entity_id = s.id::text
    ) u
    where uid is not null
  ) c on true
  left join lateral (
    select count(*) as n from public.survey_versions sv2 where sv2.survey_id = s.id
  ) vc on true;
$$;

comment on function public.survey_dashboard_stats() is
  'Per-survey dashboard statistics in one round trip. Contributor ids are distinct users, never edit counts.';

-- The Studio calls this with the service-role key from server routes only;
-- responses carry no anon/authenticated read policies, and this function does
-- not expose row contents — only counts.
revoke all on function public.survey_dashboard_stats() from anon;
