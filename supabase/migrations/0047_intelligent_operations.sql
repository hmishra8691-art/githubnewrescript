-- 0047 — Intelligent Mode operation history (Intelligent Mode upgrade, Phase 5).
--
-- Every Intelligent Mode operation, one row each: what the researcher said,
-- how it was read (the engine, the model, the grammar, a fix from a review),
-- what was detected and targeted, what was proposed, applied, excluded and
-- refused, the warnings, the engine operations performed, the model calls
-- made (and what they cost), the survey before and after, and the status —
-- from proposed or answered, through applied, to saved or not saved,
-- cancelled, reverted. An applied operation carries the survey's AI change
-- number (`change_n`, one sequence per survey, assigned when it is applied).
--
-- The history used to live in the page: it was gone on reload, its numbering
-- restarted at #001 (so the audit log's rows for one survey collided), and it
-- said "applied" before the draft was saved. The audit log keeps its
-- `survey.ai_changed` row per applied change; this table is the operation's
-- own record, which the History tab reads back.

create table if not exists public.intelligent_operations (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  change_n integer,
  prompt text not null default '',
  source text not null default 'engine' check (source in ('engine', 'model', 'grammar', 'fix', 'import', 'context')),
  intent jsonb not null default '{}'::jsonb,
  detected jsonb not null default '[]'::jsonb,
  targets text[] not null default '{}',
  proposed jsonb not null default '[]'::jsonb,
  applied jsonb not null default '[]'::jsonb,
  excluded jsonb not null default '[]'::jsonb,
  failed jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  engine_ops jsonb not null default '[]'::jsonb,
  api_calls jsonb not null default '[]'::jsonb,
  before jsonb,
  after jsonb,
  status text not null default 'proposed' check (status in ('proposed', 'answered', 'refused', 'clarify', 'failed', 'cancelled', 'applied', 'saved', 'save_failed', 'reverted')),
  status_detail text,
  saved_revision integer,
  constraint intelligent_operations_prompt_len check (char_length(prompt) <= 4000)
);
create index if not exists intelligent_operations_survey_idx on public.intelligent_operations (survey_id, created_at desc);
create unique index if not exists intelligent_operations_change_n_key on public.intelligent_operations (survey_id, change_n) where change_n is not null;

comment on table public.intelligent_operations is 'Every Intelligent Mode operation on a survey: prompt, interpretation, proposed / applied / excluded / failed changes, engine operations, model calls, before and after, status. Read back by the History tab.';

alter table public.intelligent_operations enable row level security;
drop policy if exists intelligent_operations_member_read on public.intelligent_operations;
create policy intelligent_operations_member_read on public.intelligent_operations for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) is not null
    or public.rescript_is_platform_admin(auth.uid())
  );
grant select on public.intelligent_operations to authenticated;

-- the survey foreign key is added NOT VALID and validated separately (an inline reference to surveys waits on its lock)
alter table public.intelligent_operations drop constraint if exists intelligent_operations_survey_id_fkey;
alter table public.intelligent_operations add constraint intelligent_operations_survey_id_fkey foreign key (survey_id) references public.surveys(id) on delete cascade not valid;
alter table public.intelligent_operations validate constraint intelligent_operations_survey_id_fkey;
