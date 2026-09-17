-- 0035_interview_flow.sql
--
-- WHAT A QUESTION CAN BE, AND WHEN IT IS ASKED.
--
-- Three things the Interview Studio brief asks for turn out to already exist
-- on the survey side of this platform: a condition language with thirty-eight
-- operators and arbitrary nesting, skip and branch logic, and seeded
-- randomization with pick-N-of-M. `packages/engine` implements all of it and
-- `apps/interviews` depended on none of it. This migration gives the interview
-- tables the columns needed to store what that engine consumes, so that the
-- interviews app can ADOPT the engine rather than grow a second logic system —
-- which is the one thing this project's standing rule forbids.
--
-- ## The shapes are the engine's, verbatim
--
-- `visible_if` is a `Condition` from `@rescript/schema` — the same JSON the
-- survey builder writes and the same JSON `evaluateCondition` reads. `skip_logic`
-- is an array of `SkipRule`. Nothing here is interview-specific, and that is the
-- point: a condition authored here could be pasted into a survey and mean the
-- same thing. Validation happens in the application against the zod schemas;
-- the database keeps them as jsonb and checks only that they are objects or
-- arrays, because a check constraint that re-implemented the condition grammar
-- would be a third copy of it.
--
-- ## Kinds
--
-- `interview_questions.kind` gains `long_text`, `single_choice` and
-- `multi_choice`. The three original values were accepted and never sent by
-- the builder, and the runtime never branched on them; that is fixed in the
-- application alongside this. `options` holds the choices for the two choice
-- kinds as `[{ code, label }]` — the survey `Option` shape, trimmed — so a
-- condition can reference an option code the way it does everywhere else.
--
-- ## Structured answers
--
-- `interview_responses.answer_text` has held typed answers and transcripts
-- since 0030. A choice answer is not text: `answer_value` is jsonb holding a
-- code, an array of codes, or whatever a future kind produces, and
-- `answer_kind` records which kind produced it so that a reader does not have
-- to consult the question to interpret the row. Both are what the engine's
-- `ResponseState.answers` is built from at runtime.
--
-- ## Proof of watching
--
-- The brief requires that a respondent watch the interviewer's question video
-- before answering. `prompt_watched_at` is set by the server when the browser
-- reports the video ended, and `/api/candidate/finish` refuses while any
-- required answer's prompt has not been watched. A gate that only disabled a
-- button in the browser would be a gate somebody could call the API behind.
--
-- ## `selection` gets its shape
--
-- `interview_projects.selection` was created in 0030 "to carry the draw
-- configuration" and has never been read by a single line of code. It now
-- holds `{ pools: [{ id, draw, randomize }], randomizePools }` — exactly the
-- `PoolSpec[]` that `drawSequence` in `packages/interviews` has accepted since
-- Phase 1, whose randomize flags the one call site omitted.

begin;

/* --------------------------------------------------------------- questions */

alter table public.interview_questions drop constraint if exists interview_questions_kind_check;
alter table public.interview_questions
  add constraint interview_questions_kind_check check (kind in (
    'video', 'audio', 'text', 'long_text', 'single_choice', 'multi_choice'
  ));

alter table public.interview_questions
  add column if not exists options jsonb not null default '[]'::jsonb,
  add column if not exists visible_if jsonb,
  add column if not exists skip_logic jsonb not null default '[]'::jsonb;

alter table public.interview_questions drop constraint if exists interview_questions_options_shape;
alter table public.interview_questions
  add constraint interview_questions_options_shape check (jsonb_typeof(options) = 'array');

alter table public.interview_questions drop constraint if exists interview_questions_visible_if_shape;
alter table public.interview_questions
  add constraint interview_questions_visible_if_shape
  check (visible_if is null or jsonb_typeof(visible_if) = 'object');

alter table public.interview_questions drop constraint if exists interview_questions_skip_logic_shape;
alter table public.interview_questions
  add constraint interview_questions_skip_logic_shape check (jsonb_typeof(skip_logic) = 'array');

comment on column public.interview_questions.options is
  'Choices for single_choice / multi_choice, as [{code, label}] — the survey Option shape, so a Condition can reference a code.';
comment on column public.interview_questions.visible_if is
  'A @rescript/schema Condition. Null means always shown. Evaluated by @rescript/engine, never re-implemented here.';
comment on column public.interview_questions.skip_logic is
  'An array of @rescript/schema SkipRule, evaluated after the question is answered.';

/* --------------------------------------------------------------- responses */

alter table public.interview_responses
  add column if not exists answer_value jsonb,
  add column if not exists answer_kind text,
  add column if not exists prompt_watched_at timestamptz,
  /*
   * Why a response was skipped, when it was. `optional` is the candidate's
   * choice; `logic` means a condition hid it and the candidate never saw it.
   * They are different facts about the interview and a reviewer reading
   * "skipped" deserves to know which.
   */
  add column if not exists skip_reason text;

alter table public.interview_responses drop constraint if exists interview_responses_answer_kind_check;
alter table public.interview_responses
  add constraint interview_responses_answer_kind_check check (answer_kind is null or answer_kind in (
    'video', 'audio', 'text', 'long_text', 'single_choice', 'multi_choice'
  ));

alter table public.interview_responses drop constraint if exists interview_responses_skip_reason_check;
alter table public.interview_responses
  add constraint interview_responses_skip_reason_check
  check (skip_reason is null or skip_reason in ('optional', 'logic'));

comment on column public.interview_responses.prompt_watched_at is
  'Set server-side when the browser reports the interviewer''s prompt video ended. finish refuses while a required answer''s prompt is unwatched.';

/* ---------------------------------------------------------------- projects */

alter table public.interview_projects drop constraint if exists interview_projects_selection_shape;
alter table public.interview_projects
  add constraint interview_projects_selection_shape check (jsonb_typeof(selection) = 'object');

comment on column public.interview_projects.selection is
  '{ pools: [{ id, draw, randomize }], randomizePools } — the PoolSpec[] that drawSequence consumes. Empty object means positional order.';

/* ------------------------------------------------------------------ pools */

/* the pool table has existed since 0030 with no write path; give it what the
   builder needs to describe a pool without touching the questions in it */
alter table public.interview_pools
  add column if not exists description text not null default '';

commit;
