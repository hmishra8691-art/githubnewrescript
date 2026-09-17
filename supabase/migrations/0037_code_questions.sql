-- 0037_code_questions.sql
--
-- A QUESTION ANSWERED IN CODE.
--
-- Phase 6 of the Interview Studio plan, and the one piece of the brief with no
-- precedent anywhere in the repository: an editor. Everything else about a
-- code question is a widening of what Phases 2–3 built. `kind = 'code'` joins
-- the list the flow engine already walks; the answer is text, stored where a
-- typed answer is stored (`answer_text`), with the language the candidate
-- wrote it in beside it in `answer_value` so a reviewer sees Python
-- highlighted as Python and the analysis knows what it is reading.
--
-- ## Per-question settings
--
-- `interview_questions` never had a `settings` column — the authoring notes
-- mention one, the projects table has one, but a question's own knobs were
-- always columns (`max_seconds`, `max_retries`, …). A code question needs a
-- small structured bundle — language, whether the candidate may change it,
-- starter code, a size ceiling — that does not want to be four more columns
-- used by one kind. `settings jsonb` is added generically; the `code` key is
-- the first occupant and the shape is checked in
-- `packages/interviews/src/code.ts`, not here, so it can grow without a
-- migration each time.
--
-- Additive; nothing existing changes meaning.

begin;

alter table public.interview_questions
  add column if not exists settings jsonb not null default '{}'::jsonb;

comment on column public.interview_questions.settings is
  'Per-kind settings. code: { language, allowLanguageChoice, starter, maxChars }. Shape checked in @rescript/interviews code.ts.';

alter table public.interview_questions drop constraint if exists interview_questions_kind_check;
alter table public.interview_questions
  add constraint interview_questions_kind_check check (kind in (
    'video', 'audio', 'text', 'long_text', 'single_choice', 'multi_choice', 'code'
  ));

alter table public.interview_responses drop constraint if exists interview_responses_answer_kind_check;
alter table public.interview_responses
  add constraint interview_responses_answer_kind_check check (answer_kind is null or answer_kind in (
    'video', 'audio', 'text', 'long_text', 'single_choice', 'multi_choice', 'code'
  ));

commit;
