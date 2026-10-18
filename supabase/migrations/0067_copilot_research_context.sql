-- 0067 — Intelligent Mode: the structured research context of a long brief (§3, 2026-10-18).
--
-- A pasted brief (up to 60,000 characters) is read whole once, by the plan
-- stage; the staged item calls then get a structured research context
-- (objectives, hypotheses with their exact wording, population and quotas,
-- methodology, questionnaire structure, ids, constraints, analysis,
-- reporting, progress — lines copied verbatim) instead of the whole brief.
-- This table keeps that context per survey AND owner (the organisation, else
-- the person), with the brief it was derived from (so exact passages can be
-- retrieved after a reload), its version, status (fresh / stale — stale when
-- the survey's research design changed after it was made) and the measured
-- totals of the workflow (calls, tokens, retries, latency, charge).
--
-- Re-runnable. Until it is applied the Studio keeps the context in the
-- server's memory (said once in the log), exactly as before for the other
-- copilot stores. Written by the service role only; members of the project
-- may read their organisation's row.

create table if not exists public.copilot_research_context (
  survey_id uuid not null,
  owner_key text not null check (char_length(owner_key) between 1 and 200),
  version integer not null default 1,
  status text not null default 'fresh' check (status in ('fresh', 'stale')),
  context jsonb not null,
  brief text not null default '' check (char_length(brief) <= 60000),
  brief_sha256 text not null default '',
  workflow jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (survey_id, owner_key)
);

comment on table public.copilot_research_context is 'Intelligent Mode: the structured research context derived from a long brief, per survey and owner (organisation, else user), with the brief, version, status and the workflow''s measured AI totals.';

alter table public.copilot_research_context enable row level security;
drop policy if exists copilot_research_context_member_read on public.copilot_research_context;
create policy copilot_research_context_member_read on public.copilot_research_context for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) is not null
    or public.rescript_is_platform_admin(auth.uid())
  );
grant select on public.copilot_research_context to authenticated;

-- the survey foreign key, added NOT VALID (an inline reference to surveys waits on its lock), as in 0047
alter table public.copilot_research_context drop constraint if exists copilot_research_context_survey_id_fkey;
alter table public.copilot_research_context add constraint copilot_research_context_survey_id_fkey foreign key (survey_id) references public.surveys(id) on delete cascade not valid;
