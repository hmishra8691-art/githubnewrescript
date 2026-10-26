-- ============================================================================
-- The project list counts the DRAFT, not the last version cut
--
-- `survey_dashboard_stats` has counted questions from the current version
-- since 0002:
--
--     coalesce(public.rescript_question_count(v.definition), 0)
--     left join public.survey_versions v on v.id = s.current_version_id
--
-- 0003 then made `surveys.draft_definition` the Studio's source of truth for
-- work in progress, and this function was never told. A survey whose version
-- was cut at creation — before any question existed — and whose questions
-- have lived in the draft ever since therefore reports 0 questions on the
-- project list, however many it holds. Observed on this database:
--
--     code              draft  version  shown
--     SURVEY_MVBIC49K      28       28     28   (version cut after building)
--     SURVEY_MVC854FY      29        0      0   <- 29 questions, reported as 0
--     SURVEY_MVFRLIR5      21        0      0   <- 21 questions, reported as 0
--
-- A researcher who has just built a 29-question questionnaire and sees a 0
-- beside its name has every reason to think the work was lost.
--
-- `coalesce(s.draft_definition, v.definition)` is the rule 0003 already
-- documented for that column: "NULL means the draft equals
-- current_version_id's definition." The draft when there is one, the current
-- version otherwise. Nothing else in the function changes — response, test,
-- live and complete counts come from `responses` and were always right, and
-- `version_count` still counts version rows.
--
-- Note this is the count of what the RESEARCHER is editing, which is what the
-- project list is for. It can legitimately exceed what respondents are being
-- served while a draft sits ahead of the published version; the card's status
-- badge and response counts are what describe fieldwork.
-- ============================================================================

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
language sql stable security definer set search_path = public as $$
  select
    s.id as survey_id,
    -- the draft is what the programmer is editing; the version is the fallback
    coalesce(public.rescript_question_count(coalesce(s.draft_definition, v.definition)), 0) as question_count,
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
    where x.survey_id = s.id and x.deleted_at is null
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
  'Project-list statistics. Questions are counted from surveys.draft_definition when one exists, else from the current version — the draft is the Studio''s source of truth (0003), and counting the version alone reported 0 for any survey built after its version was cut.';

-- `create or replace` keeps existing privileges; re-stated so a replay on a
-- fresh database that has run 0026 ends in the same place.
revoke all on function public.survey_dashboard_stats() from public, anon, authenticated;
