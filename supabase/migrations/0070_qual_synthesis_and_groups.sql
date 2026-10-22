-- 0070 — qualitative synthesis, blind double-coding, highlights, transcript correction, auto-coding jobs,
--        and text-based AI-moderated group sessions (2026-10-22, engineer F2).
--
-- Builds on 0065 (qual_sessions / qual_transcripts / qual_codings / qual_events). Everything here is DATA a study
-- produces; the plan stays on the survey definition.
--
--   qual_syntheses             AI-written theme summaries, study insights — every version kept (regenerate and edit
--                              each insert a new version); the evidence fingerprint says when one went stale
--   qual_jobs                  chunked, resumable, idempotent jobs (auto-coding a source, transcribing a long
--                              recording in parts): key unique per survey, a cursor, progress, a lease
--   qual_coding_assignments    blind double-coding: two coders, the sampled segments, the codes in scope, who has
--                              submitted, the disagreement resolutions (history kept in the row and in qual_events)
--   qual_assignment_codings    each coder's PRIVATE coding of an assignment — no member policy at all: the blind is
--                              enforced by the routes, and RLS keeps a direct read from breaking it
--   qual_highlights            highlight reels: ordered excerpts with notes and a snapshot of each quote
--   qual_transcript_revisions  every correction of a transcript segment: before, after, what happened to each excerpt
--   qual_transcripts.revision  bumped on each correction (optimistic concurrency; part of the auto-coding key)
--   qual_group_sessions        a live text group session: the state (prompts, phase, clusters, follow-ups), the join
--                              code, the version, the source it became
--   qual_group_participants    who joined (a handle, never a name), a HASH of their participant token
--   qual_group_answers         one answer per participant per prompt
--   qual_group_votes           one rating per participant per answer (agree 1, disagree -1, pass 0)
--
-- Access: the Studio's routes decide (lib/qual/qualAccess.ts — the Data module), and write with the service role;
-- the runtime's group routes write participants' answers and votes with the service role after checking the
-- participant's token. RLS is the backstop: roles that read responses may SELECT what is not secret; nobody may
-- write; participant token hashes and blind codings have no member policy.
--
-- Re-runnable: `if not exists`, `drop … if exists` first. Does NOT alter the 0065 CHECK constraints on
-- qual_transcripts.source / format (a group session is stored as source 'import', format 'speaker',
-- meta.origin 'group_session'), so it composes with any other migration that widens them.
-- Undo (destroys this data):
--   drop table if exists public.qual_group_votes, public.qual_group_answers, public.qual_group_participants,
--     public.qual_group_sessions, public.qual_transcript_revisions, public.qual_highlights,
--     public.qual_assignment_codings, public.qual_coding_assignments, public.qual_jobs, public.qual_syntheses;
--   alter table public.qual_transcripts drop column if exists revision;

/* ------------------------------------------------------------ syntheses */

create table if not exists public.qual_syntheses (
  id           uuid primary key default gen_random_uuid(),
  survey_id    uuid not null references public.surveys(id) on delete cascade,
  kind         text not null check (kind in ('theme', 'insights')),
  -- the theme id for a theme summary; 'study' for the insights
  target       text not null check (length(target) between 1 and 80),
  version      integer not null check (version >= 1),
  -- 'ai' as generated, 'edited' once a person changed a claim (each claim keeps origin ai / edited / human)
  status       text not null default 'ai' check (status in ('ai', 'edited')),
  content      jsonb not null check (jsonb_typeof(content) = 'object'),
  fingerprint  text not null,
  provider     text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  unique (survey_id, kind, target, version)
);
create index if not exists qual_syntheses_latest_idx on public.qual_syntheses (survey_id, kind, target, version desc);

/* ------------------------------------------------------------ jobs */

create table if not exists public.qual_jobs (
  id           uuid primary key default gen_random_uuid(),
  survey_id    uuid not null references public.surveys(id) on delete cascade,
  kind         text not null check (kind in ('autocode', 'transcribe_long')),
  -- idempotency: 'autocode:<transcript>:r<revision>', 'stt:<media id>'
  key          text not null check (length(key) between 1 and 200),
  status       text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled', 'refused')),
  source_ids   jsonb not null default '[]'::jsonb check (jsonb_typeof(source_ids) = 'array'),
  settings     jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  progress     jsonb not null default '{}'::jsonb check (jsonb_typeof(progress) = 'object'),
  cursor       jsonb not null default '{}'::jsonb check (jsonb_typeof(cursor) = 'object'),
  error        text,
  lease_until  timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  finished_at  timestamptz,
  unique (survey_id, key)
);
create index if not exists qual_jobs_open_idx on public.qual_jobs (survey_id, status, created_at);
drop trigger if exists qual_jobs_touch on public.qual_jobs;
create trigger qual_jobs_touch before update on public.qual_jobs for each row execute function public.touch_updated_at();

/* ------------------------------------------------------------ blind double-coding */

create table if not exists public.qual_coding_assignments (
  id           uuid primary key default gen_random_uuid(),
  survey_id    uuid not null references public.surveys(id) on delete cascade,
  name         text not null check (length(name) between 1 and 200),
  -- a user id, or 'ai'
  coder_a      text not null check (length(coder_a) between 1 and 80),
  coder_b      text not null check (length(coder_b) between 1 and 80),
  units        jsonb not null check (jsonb_typeof(units) = 'array'),
  overlap_pct  integer not null check (overlap_pct between 1 and 100),
  seed         bigint not null,
  code_ids     jsonb not null check (jsonb_typeof(code_ids) = 'array'),
  status       text not null default 'coding' check (status in ('coding', 'review', 'merged', 'cancelled')),
  -- { "<coder>": "<submitted at>" }
  submitted    jsonb not null default '{}'::jsonb check (jsonb_typeof(submitted) = 'object'),
  resolutions  jsonb not null default '[]'::jsonb check (jsonb_typeof(resolutions) = 'array'),
  version      integer not null default 0 check (version >= 0),
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (coder_a <> coder_b)
);
create index if not exists qual_coding_assignments_survey_idx on public.qual_coding_assignments (survey_id, created_at desc);
drop trigger if exists qual_coding_assignments_touch on public.qual_coding_assignments;
create trigger qual_coding_assignments_touch before update on public.qual_coding_assignments for each row execute function public.touch_updated_at();

create table if not exists public.qual_assignment_codings (
  assignment_id uuid not null references public.qual_coding_assignments(id) on delete cascade,
  survey_id     uuid not null references public.surveys(id) on delete cascade,
  coder         text not null check (length(coder) between 1 and 80),
  excerpts      jsonb not null default '[]'::jsonb check (jsonb_typeof(excerpts) = 'array'),
  version       integer not null default 0 check (version >= 0),
  updated_at    timestamptz not null default now(),
  primary key (assignment_id, coder)
);

/* ------------------------------------------------------------ highlights */

create table if not exists public.qual_highlights (
  id           uuid primary key default gen_random_uuid(),
  survey_id    uuid not null references public.surveys(id) on delete cascade,
  name         text not null check (length(name) between 1 and 120),
  description  text,
  -- [{ excerptId, note?, snapshot: { quote, sourceId, segmentId, speaker?, group?, start?, end?, charStart, charEnd, codeId } }]
  items        jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  version      integer not null default 0 check (version >= 0),
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists qual_highlights_survey_idx on public.qual_highlights (survey_id, created_at);
drop trigger if exists qual_highlights_touch on public.qual_highlights;
create trigger qual_highlights_touch before update on public.qual_highlights for each row execute function public.touch_updated_at();

/* ------------------------------------------------------------ transcript correction */

alter table public.qual_transcripts add column if not exists revision integer not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'qual_transcripts_revision_check') then
    alter table public.qual_transcripts add constraint qual_transcripts_revision_check check (revision >= 0);
  end if;
end $$;

create table if not exists public.qual_transcript_revisions (
  id            bigint generated always as identity primary key,
  survey_id     uuid not null references public.surveys(id) on delete cascade,
  transcript_id uuid not null references public.qual_transcripts(id) on delete cascade,
  revision      integer not null check (revision >= 1),
  segment_id    text not null,
  before_text   text not null,
  after_text    text not null,
  -- what happened to each excerpt on the segment: unchanged / shifted / reanchored / invalid
  outcomes      jsonb not null default '[]'::jsonb check (jsonb_typeof(outcomes) = 'array'),
  actor         uuid,
  actor_label   text,
  created_at    timestamptz not null default now(),
  unique (transcript_id, revision)
);
create index if not exists qual_transcript_revisions_idx on public.qual_transcript_revisions (survey_id, transcript_id, revision desc);

/* ------------------------------------------------------------ group sessions */

create table if not exists public.qual_group_sessions (
  id              uuid primary key default gen_random_uuid(),
  survey_id       uuid not null references public.surveys(id) on delete cascade,
  title           text not null check (length(title) between 1 and 200),
  -- the participants' link carries it; random, 24+ characters
  join_code       text not null unique check (length(join_code) between 16 and 80),
  status          text not null default 'draft' check (status in ('draft', 'live', 'closed')),
  -- GroupSession (packages/analytics qual/groups.ts): prompts, phase, current, clusters, follow-ups, settings
  state           jsonb not null check (jsonb_typeof(state) = 'object'),
  version         integer not null default 0 check (version >= 0),
  -- one AI step at a time (clustering, a follow-up)
  lease_until     timestamptz,
  transcript_id   uuid references public.qual_transcripts(id) on delete set null,
  qual_session_id uuid references public.qual_sessions(id) on delete set null,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists qual_group_sessions_survey_idx on public.qual_group_sessions (survey_id, created_at desc);
drop trigger if exists qual_group_sessions_touch on public.qual_group_sessions;
create trigger qual_group_sessions_touch before update on public.qual_group_sessions for each row execute function public.touch_updated_at();

create table if not exists public.qual_group_participants (
  id               uuid primary key default gen_random_uuid(),
  group_session_id uuid not null references public.qual_group_sessions(id) on delete cascade,
  survey_id        uuid not null references public.surveys(id) on delete cascade,
  handle           text not null check (handle ~ '^P[0-9]{1,4}$'),
  -- sha-256 of the participant's token; the token itself is only ever in the participant's browser
  token_hash       text not null unique check (length(token_hash) = 64),
  segment          text check (segment is null or length(segment) <= 120),
  consent_at       timestamptz not null,
  joined_at        timestamptz not null default now(),
  last_seen_at     timestamptz,
  unique (group_session_id, handle)
);

create table if not exists public.qual_group_answers (
  id               uuid primary key default gen_random_uuid(),
  group_session_id uuid not null references public.qual_group_sessions(id) on delete cascade,
  survey_id        uuid not null references public.surveys(id) on delete cascade,
  prompt_id        text not null check (length(prompt_id) between 1 and 40),
  participant_id   uuid not null references public.qual_group_participants(id) on delete cascade,
  text             text not null check (length(text) between 1 and 1500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (group_session_id, prompt_id, participant_id)
);
create index if not exists qual_group_answers_prompt_idx on public.qual_group_answers (group_session_id, prompt_id, created_at);

create table if not exists public.qual_group_votes (
  answer_id        uuid not null references public.qual_group_answers(id) on delete cascade,
  voter_id         uuid not null references public.qual_group_participants(id) on delete cascade,
  group_session_id uuid not null references public.qual_group_sessions(id) on delete cascade,
  survey_id        uuid not null references public.surveys(id) on delete cascade,
  vote             smallint not null check (vote in (-1, 0, 1)),
  created_at       timestamptz not null default now(),
  primary key (answer_id, voter_id)
);
create index if not exists qual_group_votes_session_idx on public.qual_group_votes (group_session_id);

/* ------------------------------------------------------------ RLS: the backstop */

alter table public.qual_syntheses            enable row level security;
alter table public.qual_jobs                 enable row level security;
alter table public.qual_coding_assignments   enable row level security;
alter table public.qual_assignment_codings   enable row level security;
alter table public.qual_highlights           enable row level security;
alter table public.qual_transcript_revisions enable row level security;
alter table public.qual_group_sessions       enable row level security;
alter table public.qual_group_participants   enable row level security;
alter table public.qual_group_answers        enable row level security;
alter table public.qual_group_votes          enable row level security;

-- the same roles as 0065 (those whose capability table holds `responses.read`); `custom` fails closed
do $$
declare t text;
begin
  foreach t in array array['qual_syntheses', 'qual_jobs', 'qual_coding_assignments', 'qual_highlights', 'qual_transcript_revisions', 'qual_group_sessions', 'qual_group_answers', 'qual_group_votes'] loop
    execute format('drop policy if exists %I on public.%I', t || '_data_read', t);
    execute format($p$create policy %I on public.%I for select to authenticated using (
      public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
      or public.rescript_is_platform_admin(auth.uid()))$p$, t || '_data_read', t);
  end loop;
end $$;
-- qual_assignment_codings (blind) and qual_group_participants (token hashes): no member policy — service role only

comment on table public.qual_syntheses is 'AI-written qualitative synthesis (theme summaries, study insights), every version kept; claims cite excerpt ids; stale when the evidence fingerprint changes.';
comment on table public.qual_assignment_codings is 'Blind double-coding: each coder''s private coding. No member policy: the routes reveal it only when both coders have submitted.';
comment on table public.qual_group_participants is 'Participants of text group sessions: a handle and a hash of their token, never a name. Service role only.';
