-- =====================================================================
-- 0012 — WHERE A RESPONDENT CAME FROM, AND WHAT A VERSION IS
--
-- Two things the gap audit found that could not be fixed in application
-- code, because both are facts the DATABASE has to hold.
--
-- §23  SAMPLE SOURCES. `responses.source` already exists and means
--      "runtime | import | manual" — how the row got here, not who supplied
--      the person. There was therefore no supplier dimension anywhere in
--      the platform, which makes supplier tracking, source-level reporting
--      and sample blending structurally impossible rather than merely
--      unbuilt: you cannot report on a column that does not exist, and you
--      cannot retrofit it onto rows already collected.
--
-- §42  VERSION IMMUTABILITY. `survey_versions` was append-only by
--      CONVENTION: nothing prevented an UPDATE, and "an immutable published
--      version" was a promise the schema did not keep. A deployed link is
--      pinned to a version id, so a mutable version row means a live survey
--      can change under its respondents with no version number moving and
--      nothing in the audit log.
--
-- Both are additive. Existing rows keep every value they have; every new
-- column is nullable; no existing function or policy changes behaviour.
-- =====================================================================

-- ---------------------------------------------------------------------
-- §23.1  Declared sources for a survey
--
-- A source is DECLARED so that fieldwork can be reported against a target
-- ("Cint: 400 of 600") and so a typo in an invitation URL is visible as an
-- undeclared source rather than silently becoming its own supplier. The
-- declaration is optional: an unexpected code is still recorded on the
-- response (see §23.2), because losing the provenance of a real interview
-- to protect a list is the wrong trade.
-- ---------------------------------------------------------------------
create table if not exists public.sample_sources (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  -- what arrives in the URL: short, stable, case-insensitive in practice
  code text not null,
  label text not null,
  -- how many completes this source is contracted to deliver, for fieldwork
  target_completes integer,
  -- what the supplier charges per complete, if the team tracks it here
  cost_per_complete numeric(10, 2),
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  constraint sample_sources_code_not_blank check (length(trim(code)) > 0),
  constraint sample_sources_target_sane check (target_completes is null or target_completes >= 0)
);

-- one declaration per code per survey; lower() so "Cint" and "cint" are
-- the same supplier rather than two rows in a fieldwork report
create unique index if not exists sample_sources_survey_code_key
  on public.sample_sources (survey_id, lower(code));

create index if not exists sample_sources_survey_idx
  on public.sample_sources (survey_id);

comment on table public.sample_sources is
  'Declared sample sources (panel, supplier, channel) for one survey, with fieldwork targets. Optional: responses record their source whether or not it is declared here.';

-- ---------------------------------------------------------------------
-- §23.2  The source on the response
--
-- Deliberately TEXT and not a foreign key. A respondent arriving with
-- `?src=nosuchpanel` is a real interview with a provenance problem, and a
-- foreign key would either reject the row (losing the interview) or force
-- the runtime to create supplier rows from URL parameters (letting anyone
-- with the link invent suppliers). Text records what actually happened;
-- the join to `sample_sources` is a left join, and an unmatched value is
-- reportable as exactly that.
--
-- `sample_source_respondent` is the supplier's OWN id for the person —
-- what a reconciliation query needs when a panel asks which of their
-- respondents completed.
-- ---------------------------------------------------------------------
alter table public.responses
  add column if not exists sample_source text,
  add column if not exists sample_source_respondent text;

comment on column public.responses.sample_source is
  'Which sample source supplied this respondent, captured from the invitation URL at session start. Free text: an undeclared source is recorded, not rejected. Distinct from responses.source, which is how the ROW arrived (runtime/import/manual).';
comment on column public.responses.sample_source_respondent is
  'The supplier''s own identifier for this respondent, for reconciliation.';

-- fieldwork reads "by source, by status, within an environment"
create index if not exists responses_survey_source_idx
  on public.responses (survey_id, is_test, sample_source)
  where deleted_at is null;

-- ---------------------------------------------------------------------
-- §23.3  Supplier performance in one query
--
-- The counts existed and nothing aggregated them, so every fieldwork
-- figure would have been a separate round trip per source per status. One
-- function, one scan: completes, partials, screen-outs, quota-fulls, the
-- incidence a supplier is judged on, and the median duration that shows
-- whether a source is sending people who are actually engaging.
--
-- `p_is_test` is a parameter with no default on purpose: the platform's
-- rule is that environment is never assumed (see 0006).
-- ---------------------------------------------------------------------
create or replace function public.rescript_source_stats(
  p_survey uuid,
  p_is_test boolean
)
returns table (
  sample_source text,
  declared boolean,
  label text,
  target_completes integer,
  starts bigint,
  completes bigint,
  partials bigint,
  screened bigint,
  quota_full bigint,
  terminated bigint,
  -- of everyone who finished the screener, how many qualified
  incidence numeric,
  -- of everyone who started, how many finished
  completion_rate numeric,
  median_seconds numeric,
  first_response timestamptz,
  last_response timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with rows as (
    select
      coalesce(nullif(trim(r.sample_source), ''), '(none)') as src,
      r.status,
      r.started_at,
      r.completed_at,
      case
        when r.completed_at is not null and r.started_at is not null
        then extract(epoch from (r.completed_at - r.started_at))
      end as secs
    from public.responses r
    where r.survey_id = p_survey
      and r.is_test = p_is_test
      and r.deleted_at is null
  )
  select
    rows.src as sample_source,
    (s.id is not null) as declared,
    coalesce(s.label, rows.src) as label,
    s.target_completes,
    count(*) as starts,
    count(*) filter (where rows.status = 'complete') as completes,
    count(*) filter (where rows.status = 'in_progress') as partials,
    count(*) filter (where rows.status = 'screened') as screened,
    count(*) filter (where rows.status = 'quota_full') as quota_full,
    count(*) filter (where rows.status = 'terminated') as terminated,
    case
      when count(*) filter (where rows.status in ('complete', 'screened', 'quota_full', 'terminated')) = 0 then null
      else round(
        (count(*) filter (where rows.status = 'complete'))::numeric
        / count(*) filter (where rows.status in ('complete', 'screened', 'quota_full', 'terminated')) * 100, 1)
    end as incidence,
    case when count(*) = 0 then null
         else round((count(*) filter (where rows.status = 'complete'))::numeric / count(*) * 100, 1)
    end as completion_rate,
    round(percentile_cont(0.5) within group (order by rows.secs)::numeric, 0) as median_seconds,
    min(rows.started_at) as first_response,
    max(rows.started_at) as last_response
  from rows
  left join public.sample_sources s
    on s.survey_id = p_survey and lower(s.code) = lower(rows.src)
  group by rows.src, s.id, s.label, s.target_completes
  order by completes desc, starts desc, rows.src;
$$;

comment on function public.rescript_source_stats(uuid, boolean) is
  'Fieldwork by sample source for one survey and environment: starts, completes, partials, screen-outs, incidence, completion rate and median duration. Undeclared sources appear with declared = false.';

-- ---------------------------------------------------------------------
-- §23.4  Access
--
-- Same shape as every other per-survey table since 0008: RLS on, members
-- read, and the service role (which every API route uses) is unaffected.
-- Writes go through the application, which gates them on survey.edit.
-- ---------------------------------------------------------------------
alter table public.sample_sources enable row level security;

drop policy if exists sample_sources_member_read on public.sample_sources;
create policy sample_sources_member_read on public.sample_sources
  for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) is not null
    or public.rescript_is_platform_admin(auth.uid())
  );

grant select on public.sample_sources to authenticated;
grant execute on function public.rescript_source_stats(uuid, boolean) to authenticated, service_role;

-- =====================================================================
-- §42  A VERSION IS A SNAPSHOT, AND THE DATABASE NOW SAYS SO
--
-- What is frozen: the SNAPSHOT — survey_id, version, definition, created_at,
-- created_by. Nothing may rewrite what was published.
--
-- What is not: `label` and `notes`. Those are a human's description OF the
-- snapshot ("sent to legal", "the one with the typo"), not the snapshot, and
-- freezing them would mean a mislabelled version stays mislabelled for ever.
-- Distinguishing the two is the whole point — "no writes at all" would be
-- easier to write and worse to live with.
--
-- Deletes are allowed for exactly one case, which the application already
-- relies on: a snapshot nothing ever adopted. `versions/route.ts` inserts a
-- row, then calls `rescript_finalize_version` under a revision guard; when
-- that guard refuses (another editor moved first) the inserted row is an
-- orphan and is removed. A blanket ban would leave those orphans in the
-- version panel for ever. A version that a survey points at, that a
-- deployment serves, or that any response was collected against cannot be
-- deleted at all.
-- =====================================================================
create or replace function public.rescript_versions_are_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pointed boolean;
  v_deployed boolean;
  v_answered boolean;
begin
  if tg_op = 'UPDATE' then
    if new.survey_id is distinct from old.survey_id
       or new.version is distinct from old.version
       or new.definition::text is distinct from old.definition::text
       or new.created_at is distinct from old.created_at
       or new.created_by is distinct from old.created_by then
      raise exception
        'version % of this survey is published and cannot be changed. Cut a new version instead — a deployed link is pinned to this snapshot, and respondents may already have answered it.',
        old.version
        using errcode = 'restrict_violation',
              hint = 'Only the label and notes of a published version may be edited.';
    end if;
    return new;
  end if;

  -- DELETE
  select exists (select 1 from public.surveys s where s.current_version_id = old.id) into v_pointed;
  select exists (select 1 from public.deployments d where d.version_id = old.id) into v_deployed;
  select exists (select 1 from public.responses r where r.version_id = old.id) into v_answered;

  if v_pointed or v_deployed or v_answered then
    raise exception
      'version % cannot be deleted: it is %.',
      old.version,
      case
        when v_answered then 'the version respondents answered'
        when v_deployed then 'served by a deployed link'
        else 'the survey''s current version'
      end
      using errcode = 'restrict_violation',
            hint = 'Only a snapshot that was never adopted can be removed.';
  end if;
  return old;
end;
$$;

comment on function public.rescript_versions_are_immutable() is
  'Freezes the content of a published version (survey_id, version, definition, created_at, created_by) while leaving label and notes editable, and permits deleting only a snapshot no survey, deployment or response refers to.';

drop trigger if exists survey_versions_immutable on public.survey_versions;
create trigger survey_versions_immutable
  before update or delete on public.survey_versions
  for each row execute function public.rescript_versions_are_immutable();
