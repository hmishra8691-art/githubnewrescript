-- =====================================================================
-- 0018 — TEST CASES AND REGRESSION TESTING (§55, §56)
--
-- `runQualityCheck` answers "is this survey fit to field" from the definition
-- alone. It cannot answer the question a programmer actually has before a
-- release: does it still do what it did yesterday, for the twelve respondents
-- I care about — the 17-year-old who must be screened out, the non-user who
-- must skip the whole usage block, the respondent whose quota is full.
--
-- Every piece needed to answer that already existed. `simulateRespondent` is
-- a complete headless respondent; `survey_versions` keeps every definition.
-- Nobody had joined them, so the only way to check a change had not broken
-- path C was to click through path C.
--
-- WHY A TABLE AND NOT THE DEFINITION.
--
-- The obvious alternative is `def.testCases`, versioned with the survey and
-- carried in its export. Three reasons against, and the first is decisive:
--
--   1. Regression testing compares ACROSS versions. "Run the suite against
--      the version I am about to publish" is meaningless if the cases live
--      inside the version — whose cases, the old ones or the new?
--
--   2. A test case is QA data, not respondent-facing programming. In the
--      definition it would ride along in every runtime payload.
--
--   3. Runs have to be recorded over time — that IS the regression history —
--      and that needs a table whatever happens to the cases.
--
-- The platform's existing line holds: programming in the definition, data in
-- tables.
--
-- THE FOUR VERDICTS live in `packages/templates/src/testCases.ts`, tested
-- there, and are stored here as a CHECK. The one worth naming in SQL is
-- `changed`: an outcome that differs from the blessed baseline without
-- breaking a stated expectation. It is not a failure — it may be exactly the
-- change the programmer just made — and it is not a pass either, because
-- somebody has to say which.
-- =====================================================================

-- ---------------------------------------------------------------------
-- §55.1  A test case
-- ---------------------------------------------------------------------
create table if not exists public.survey_test_cases (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  name text not null,
  notes text,
  /*
   * Disabled rather than deleted: a case that is failing for a known reason
   * during a rebuild is worth keeping, and the alternative is that somebody
   * deletes it to get a green suite and never writes it again.
   */
  enabled boolean not null default true,
  /**
   * The input: answers by question id, embedded data, and the SEED.
   *
   * The seed matters more than it looks. Randomisation, option order and
   * design-version assignment are all seeded, so a case without one would
   * report a change on every run and the suite would be noise within a week.
   */
  input jsonb not null default '{"answers":{}}'::jsonb,
  /** Declared expectations — optional, and what turns a snapshot into a test. */
  expectations jsonb not null default '{}'::jsonb,
  /**
   * The blessed outcome. Null until somebody accepts a run as correct, which
   * is why a case with no baseline reports `pass` rather than green: nothing
   * has been proved about it yet, and saying so is more useful than a tick.
   */
  baseline jsonb,
  /** which definition the baseline was taken from — a stale baseline is a lie */
  baseline_version_id uuid references public.survey_versions(id) on delete set null,
  baseline_at timestamptz,
  baseline_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

/* one case per name per survey — a suite with two "screened out" cases is a suite nobody trusts */
create unique index if not exists survey_test_cases_name_key
  on public.survey_test_cases (survey_id, lower(name));
create index if not exists survey_test_cases_survey_idx
  on public.survey_test_cases (survey_id) where enabled;

drop trigger if exists survey_test_cases_touch on public.survey_test_cases;
create or replace function public.rescript_touch_test_case() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger survey_test_cases_touch before update on public.survey_test_cases
  for each row execute function public.rescript_touch_test_case();

-- ---------------------------------------------------------------------
-- §56.1  A run
-- ---------------------------------------------------------------------
create table if not exists public.survey_test_runs (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  test_case_id uuid references public.survey_test_cases(id) on delete cascade,
  /**
   * Which definition this ran against.
   *
   * Nullable on purpose: the common case is running the AUTOSAVED DRAFT,
   * which has no version row — and that is exactly when a programmer wants
   * the suite, before publishing. `version_label` records what it was in
   * words so a run stays readable after the version is gone.
   */
  version_id uuid references public.survey_versions(id) on delete set null,
  version_label text,
  /**
   * One id per "run the suite", so a regression run is a row set that can be
   * shown as one result rather than reassembled by timestamp.
   */
  batch_id uuid not null,
  verdict text not null check (verdict in ('pass', 'changed', 'fail', 'stale', 'error')),
  /* the fast "did anything change at all"; the evidence is `outcome` */
  fingerprint text,
  outcome jsonb,
  /** violated expectations, in the words the runner produced */
  failures jsonb not null default '[]'::jsonb,
  /** how it differs from the baseline */
  changes jsonb not null default '[]'::jsonb,
  duration_ms integer,
  run_at timestamptz not null default now(),
  run_by uuid references public.profiles(id) on delete set null
);

create index if not exists survey_test_runs_case_idx
  on public.survey_test_runs (test_case_id, run_at desc);
create index if not exists survey_test_runs_batch_idx
  on public.survey_test_runs (batch_id);
create index if not exists survey_test_runs_survey_idx
  on public.survey_test_runs (survey_id, run_at desc);

-- ---------------------------------------------------------------------
-- RLS
--
-- Enabled with a membership read policy, matching every other project-scoped
-- table since 0008 and satisfying `scripts/rls-audit-test.sql`: RLS on, and a
-- policy with a tenancy predicate rather than a table on the declared
-- deny-all list. Writes go through the service role behind `requireProject`,
-- as they do everywhere else.
-- ---------------------------------------------------------------------
alter table public.survey_test_cases enable row level security;
alter table public.survey_test_runs enable row level security;

drop policy if exists survey_test_cases_member_read on public.survey_test_cases;
create policy survey_test_cases_member_read on public.survey_test_cases
  for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) is not null
    or public.rescript_is_platform_admin(auth.uid())
  );

drop policy if exists survey_test_runs_member_read on public.survey_test_runs;
create policy survey_test_runs_member_read on public.survey_test_runs
  for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) is not null
    or public.rescript_is_platform_admin(auth.uid())
  );

-- ---------------------------------------------------------------------
-- The suite's state, in one query
-- ---------------------------------------------------------------------
/**
 * WHERE EVERY CASE STANDS.
 *
 * One row per case with its latest run, so the panel is one call rather than
 * one per case. `EXISTS`-free but written with a lateral join for the same
 * reason the fieldwork functions use `EXISTS` over `LEFT JOIN`: the run table
 * has many rows per case and a plain join would multiply the case list by its
 * history.
 *
 * A case with no run at all comes back with a null verdict rather than being
 * omitted — "never run" is the state that most needs showing, and a suite
 * that quietly lists only the cases it has results for is how a case gets
 * forgotten.
 */
create or replace function public.rescript_test_suite(p_survey uuid)
returns table (
  test_case_id uuid,
  name text,
  enabled boolean,
  has_baseline boolean,
  baseline_at timestamptz,
  last_verdict text,
  last_run_at timestamptz,
  last_version_label text,
  last_failures jsonb,
  last_changes jsonb,
  run_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id,
    c.name,
    c.enabled,
    c.baseline is not null,
    c.baseline_at,
    r.verdict,
    r.run_at,
    r.version_label,
    coalesce(r.failures, '[]'::jsonb),
    coalesce(r.changes, '[]'::jsonb),
    (select count(*) from public.survey_test_runs x where x.test_case_id = c.id)
  from public.survey_test_cases c
  left join lateral (
    select verdict, run_at, version_label, failures, changes
    from public.survey_test_runs r2
    where r2.test_case_id = c.id
    order by r2.run_at desc
    limit 1
  ) r on true
  where c.survey_id = p_survey
    and (
      public.rescript_project_role(auth.uid(), p_survey) is not null
      or public.rescript_is_platform_admin(auth.uid())
      /* the service role has no auth.uid(); the route has already authorized */
      or auth.uid() is null
    )
  order by c.enabled desc, lower(c.name);
$$;

comment on function public.rescript_test_suite(uuid) is
  'One row per test case with its latest run (§55, §56). A case that has never run comes back with a null verdict rather than being omitted.';

revoke all on function public.rescript_test_suite(uuid) from public;
grant execute on function public.rescript_test_suite(uuid) to authenticated, service_role;
