-- =====================================================================
-- INTELLIGENT COPILOT — THE RESEARCH STORE
--
-- Research material a researcher uploads into Intelligent mode — papers,
-- industry reports, client briefs, methodology notes, questionnaires — kept
-- per project so the copilot can draw on it in every later session without
-- the documents being uploaded, or sent to the model, again.
--
--   copilot_documents   one row per uploaded document: its name, format,
--                       page count, whether pages were OCR'd, and the
--                       model's structured summary (objectives, hypotheses,
--                       constructs, scales, findings, demographics, gaps,
--                       methodology) — computed ONCE, at upload
--   copilot_chunks      the document's text as ~1,200-character passages,
--                       each with its page and heading, optionally with an
--                       embedding. A request retrieves the few passages it
--                       needs; whole documents are never re-sent.
--
-- Survey-scoped: a study's literature belongs to the study, and is removed
-- with it. Read by project members (the Research panel lists them); written
-- only through the API on the service role, gated on the caller's project
-- permission and metered for the OCR and summary work.
--
-- SAFE TO APPLY AT ANY TIME. Until it runs, the copilot keeps uploaded
-- documents in the server's memory for the session and says so.
-- =====================================================================

create table if not exists public.copilot_documents (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete cascade,
  /* the short name passages are cited by ("k3x9q#4"): unique within the survey */
  ref text not null,
  name text not null,
  format text not null,
  kind text,
  pages integer not null default 0,
  chars integer not null default 0,
  ocr_pages integer not null default 0,
  summary jsonb,
  warnings jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint copilot_documents_name_not_blank check (length(trim(name)) > 0)
);
create index if not exists copilot_documents_survey_idx on public.copilot_documents (survey_id, created_at);
create unique index if not exists copilot_documents_ref_key on public.copilot_documents (survey_id, ref);

create table if not exists public.copilot_chunks (
  document_id uuid not null references public.copilot_documents(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  seq integer not null,
  page integer not null default 1,
  heading text,
  kind text not null default 'text',
  text text not null,
  embedding jsonb,
  primary key (document_id, seq)
);
create index if not exists copilot_chunks_survey_idx on public.copilot_chunks (survey_id);

comment on table public.copilot_documents is
  'Research documents uploaded into Intelligent mode for one survey, with the model''s structured summary computed once at upload.';
comment on table public.copilot_chunks is
  'Passages of a copilot research document (page, heading, text, optional embedding) — what retrieval selects for a request.';

alter table public.copilot_documents enable row level security;
alter table public.copilot_chunks enable row level security;

drop policy if exists copilot_documents_member_read on public.copilot_documents;
create policy copilot_documents_member_read on public.copilot_documents
  for select to authenticated
  using (public.rescript_project_role(auth.uid(), survey_id) is not null or public.rescript_is_platform_admin(auth.uid()));

drop policy if exists copilot_chunks_member_read on public.copilot_chunks;
create policy copilot_chunks_member_read on public.copilot_chunks
  for select to authenticated
  using (public.rescript_project_role(auth.uid(), survey_id) is not null or public.rescript_is_platform_admin(auth.uid()));

grant select on public.copilot_documents to authenticated;
grant select on public.copilot_chunks to authenticated;
