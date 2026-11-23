-- 0115 — THE OBSERVER ROOM OF AN AI INTERVIEW (Level 5 roadmap Q5, 2026-11-22). Needs 0069.
--
--   ai_interview_observer_notes   what the research team does while watching one AI interview live, never shown to
--                                 the participant:
--                                   chat      a private message to the other observers
--                                   marker    a moment marked in the interview, tied to the turn it was made at
--                                   question  a question for the AI moderator: queued → asked (at moderator turn
--                                             asked_seq) or refused (refused_reason) or withdrawn by the team
--                                 Written by the Studio (chat, markers, questions) and by the runtime (a question
--                                 asked or refused), both through the service role after their own checks.
--
-- Additive. Row-level security on, no policy (service role only).
--
-- Rollback:
--   drop table if exists public.ai_interview_observer_notes;

create table if not exists public.ai_interview_observer_notes (
  id             uuid primary key default gen_random_uuid(),
  survey_id      uuid not null references public.surveys(id) on delete cascade,
  study_id       uuid not null references public.ai_interview_studies(id) on delete cascade,
  session_id     uuid not null references public.ai_interview_sessions(id) on delete cascade,
  kind           text not null check (kind in ('chat', 'marker', 'question')),
  body           text not null check (char_length(body) between 1 and 1000),
  turn_seq       integer check (turn_seq is null or turn_seq >= 0),
  offset_ms      integer check (offset_ms is null or offset_ms >= 0),
  status         text check (status is null or status in ('queued', 'asked', 'refused', 'withdrawn')),
  asked_seq      integer,
  refused_reason text check (refused_reason is null or char_length(refused_reason) <= 300),
  author_id      uuid,
  author_label   text check (author_label is null or char_length(author_label) <= 200),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (kind = 'question' or status is null),
  check (kind <> 'question' or status is not null)
);
create index if not exists ai_interview_observer_notes_session_idx on public.ai_interview_observer_notes (session_id, created_at);
create index if not exists ai_interview_observer_notes_queued_idx on public.ai_interview_observer_notes (session_id, created_at) where kind = 'question' and status = 'queued';
alter table public.ai_interview_observer_notes enable row level security;

insert into public.schema_marks (migration, note) values ('0115', 'ai_interview_observer_notes: the observer room of an AI interview')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
