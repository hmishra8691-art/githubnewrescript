-- 0065 — qualitative research: sessions, recordings, transcripts, coding (2026-10-18).
--
-- The PLAN of a moderated interview or focus-group study (objectives, guide,
-- screening, consent, segments, session plan) lives on the survey definition
-- (`definition.qualStudy`), versioned with it. What the study PRODUCES is data
-- and lives here:
--
--   qual_sessions     one row per interview / group: date, moderator, participants and
--                     their segments, consent captured, notes, observations, status, and
--                     the recording (a media_objects row of kind 'qual_recording')
--   qual_transcripts  an imported (.txt/.vtt/.srt/.docx/"Speaker: text"), transcribed (STT)
--                     or snapshotted (open-ended answers) source, cut into segments that keep
--                     speaker ids and timestamps; the speaker map (role, segment)
--   qual_codings      ONE row per survey: the codebook (codes, themes, relationships) and the
--                     excerpts (evidence links: source, segment, speaker, time, exact span,
--                     quote, coder, ai_suggested / human_reviewed / rejected), versioned for
--                     optimistic concurrency between two coders
--   qual_events       the append-only history: who did what, when (coding, review, imports,
--                     transcription, recording playback)
--
-- Access: transcripts are respondents' own words — the Data module decides. The Studio's
-- routes are the enforcement point (`responses.read` to read, redacted unless the member
-- holds `responses.read_pii`; `responses.manage` to add sources; `analytics.edit` to code;
-- `responses.read_pii` to play a recording). RLS is the backstop for anything else: members
-- whose ROLE reads responses may SELECT; custom-permission members, vendors and interviewers
-- may not (fails closed — the routes decide custom permissions); nobody writes except the
-- service role.
--
-- Re-runnable: every object is `if not exists` / `drop … if exists` first. Never edited once
-- applied. Undo (destroys qualitative data):
--   drop table if exists public.qual_events, public.qual_codings, public.qual_transcripts, public.qual_sessions;
--   and restore media_objects_kind_check without 'qual_recording' (after deleting those rows).

/* ------------------------------------------------------------ the recording kind */

alter table public.media_objects drop constraint if exists media_objects_kind_check;
alter table public.media_objects
  add constraint media_objects_kind_check check (kind in (
    'question_video', 'question_audio', 'answer_audio', 'answer_upload', 'localization_audio', 'survey_asset',
    'qual_recording'
  ));

/* ------------------------------------------------------------ sessions */

create table if not exists public.qual_sessions (
  id                 uuid primary key default gen_random_uuid(),
  survey_id          uuid not null references public.surveys(id) on delete cascade,
  kind               text not null default 'interview' check (kind in ('interview', 'focus_group')),
  title              text not null check (length(title) between 1 and 200),
  scheduled_at       timestamptz,
  moderator          text,
  -- [{ "id": "p1", "label": "P1", "segment": "Recent switchers" }] — labels, never required to be names
  participants       jsonb not null default '[]'::jsonb check (jsonb_typeof(participants) = 'array'),
  -- { "captured": true, "recording": true, "method": "verbal on recording", "at": "…", "note": "…" }
  consent            jsonb not null default '{}'::jsonb check (jsonb_typeof(consent) = 'object'),
  notes              text,
  -- [{ "at": "00:12:30", "text": "hesitated before answering" }]
  observations       jsonb not null default '[]'::jsonb check (jsonb_typeof(observations) = 'array'),
  status             text not null default 'planned' check (status in ('planned', 'completed', 'cancelled')),
  recording_media_id uuid references public.media_objects(id) on delete set null,
  created_by         uuid,
  updated_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists qual_sessions_survey_idx on public.qual_sessions (survey_id, scheduled_at);

drop trigger if exists qual_sessions_touch on public.qual_sessions;
create trigger qual_sessions_touch before update on public.qual_sessions
  for each row execute function public.touch_updated_at();

/* ------------------------------------------------------------ transcripts */

create table if not exists public.qual_transcripts (
  id          uuid primary key default gen_random_uuid(),
  survey_id   uuid not null references public.surveys(id) on delete cascade,
  session_id  uuid references public.qual_sessions(id) on delete set null,
  title       text not null check (length(title) between 1 and 200),
  source      text not null check (source in ('import', 'stt', 'open_ends')),
  format      text check (format in ('vtt', 'srt', 'speaker', 'text', 'docx', 'stt', 'open_ends')),
  language    text,
  -- QualSegment[]: { id, index, speaker?, start?, end?, responseId?, questionId?, text }
  segments    jsonb not null default '[]'::jsonb check (jsonb_typeof(segments) = 'array'),
  -- { "<speaker label>": { "role": "moderator" | "participant", "group": "<segment>" } }
  speakers    jsonb not null default '{}'::jsonb check (jsonb_typeof(speakers) = 'object'),
  status      text not null default 'ready' check (status in ('processing', 'ready', 'failed')),
  error       text,
  char_count  integer not null default 0 check (char_count >= 0),
  media_id    uuid references public.media_objects(id) on delete set null,
  -- warnings from the parser, the STT model, diarized or not, the open-ends question ids
  meta        jsonb not null default '{}'::jsonb check (jsonb_typeof(meta) = 'object'),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists qual_transcripts_survey_idx  on public.qual_transcripts (survey_id, created_at);
create index if not exists qual_transcripts_session_idx on public.qual_transcripts (session_id);
-- one transcription per recording: a retried "Transcribe" finds the row instead of paying twice
create unique index if not exists qual_transcripts_media_idx on public.qual_transcripts (media_id) where media_id is not null;

drop trigger if exists qual_transcripts_touch on public.qual_transcripts;
create trigger qual_transcripts_touch before update on public.qual_transcripts
  for each row execute function public.touch_updated_at();

/* ------------------------------------------------------------ coding */

create table if not exists public.qual_codings (
  survey_id   uuid primary key references public.surveys(id) on delete cascade,
  codebook    jsonb not null default '{"version":0,"method":"inductive","codes":[],"themes":[],"relationships":[]}'::jsonb check (jsonb_typeof(codebook) = 'object'),
  excerpts    jsonb not null default '[]'::jsonb check (jsonb_typeof(excerpts) = 'array'),
  -- bumped on every write; a write names the version it read (optimistic concurrency between coders)
  version     integer not null default 0 check (version >= 0),
  -- { "redactNames": ["Anna Smith", …] } — the names replaced before AI processing and for members
  -- without contact details; itself personal data, returned only to members who hold it
  settings    jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

/* ------------------------------------------------------------ history */

create table if not exists public.qual_events (
  id           bigint generated always as identity primary key,
  survey_id    uuid not null references public.surveys(id) on delete cascade,
  actor        uuid,
  -- 'ai' for the model's suggestions; the person's display name otherwise (kept: an account can be deleted)
  actor_label  text,
  action       text not null check (length(action) between 1 and 60),
  detail       text not null,
  ids          jsonb not null default '[]'::jsonb check (jsonb_typeof(ids) = 'array'),
  created_at   timestamptz not null default now()
);
create index if not exists qual_events_survey_idx on public.qual_events (survey_id, created_at desc);

/* ------------------------------------------------------------ RLS: the backstop */

alter table public.qual_sessions    enable row level security;
alter table public.qual_transcripts enable row level security;
alter table public.qual_codings     enable row level security;
alter table public.qual_events      enable row level security;

-- the roles whose capability table holds `responses.read` (packages/access roles.ts); `custom` is
-- decided by the routes only, so it is not here — the backstop fails closed for it
drop policy if exists qual_sessions_data_read on public.qual_sessions;
create policy qual_sessions_data_read on public.qual_sessions for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );
drop policy if exists qual_transcripts_data_read on public.qual_transcripts;
create policy qual_transcripts_data_read on public.qual_transcripts for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );
drop policy if exists qual_codings_data_read on public.qual_codings;
create policy qual_codings_data_read on public.qual_codings for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );
drop policy if exists qual_events_data_read on public.qual_events;
create policy qual_events_data_read on public.qual_events for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );

comment on table public.qual_transcripts is
  'Qualitative sources (imported, transcribed, open-ended answers) cut into segments with speakers and timestamps. Respondents'' words: read through the Studio routes (Data view; redacted without contact-details permission).';
comment on table public.qual_codings is
  'One codebook and its excerpts per survey; every excerpt quote is the exact span of its segment. version = optimistic concurrency.';
