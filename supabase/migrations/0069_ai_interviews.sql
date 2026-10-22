-- 0069 — AI-moderated interviews (2026-10-22).
--
-- An interview guide (`definition.qualStudy`, kind interview) configured for AI moderation
-- (`qualStudy.aiModeration`) is LAUNCHED as a study with a public link; each participant who
-- consents (and passes the screener and the quota) has a 1:1 interview with the AI moderator,
-- turn by turn. What that produces is data and lives here:
--
--   ai_interview_studies       one launched study: the public link token (and a separate test token),
--                              a SNAPSHOT of the guide + configuration (editing the guide never changes
--                              a running interview), status live / paused / closed, AI spend so far
--   ai_interview_quotas        the study's quota targets by segment (from the configuration at launch)
--   ai_interview_participants  who took part: P<number>, segment, screener answers, consent (statement
--                              shown, recording yes/no, when), language, the panel's own id; is_test
--   ai_interview_sessions      one interview: the hashed resume token, mode (text / voice / video),
--                              status (in_progress / completed / screened_out / abandoned / flagged /
--                              ended), excluded by the researcher, the moderator's state, flags, turns,
--                              cost; on completion the qual_sessions / qual_transcripts rows (0065) it
--                              was written to — so coding, quotes, kappa and reports read it unchanged
--   ai_interview_turns         every turn: speaker, text (the participant's own words), the speech-to-text
--                              output before their correction, language, translation, audio / video media,
--                              ms from the start, the moderator's decision record
--
-- Two functions make the concurrency-sensitive steps atomic (service role only):
--   rescript_ai_interview_begin       admit a participant: the study is live, its target / budget / the
--                                     segment's quota still open (completed + in progress, abandoned ones
--                                     swept first), number them, create the participant and the session —
--                                     under a lock on the study row, so a burst of starts cannot overfill
--   rescript_ai_interview_record_turn write one exchange: the session's state only if nobody else has
--                                     (optimistic version), its turns (unique seq), the cost added to the
--                                     session and the study in the same transaction
--
-- Access: like the qualitative tables (0065) — respondents' words and voices, decided by the Data module.
-- The Studio's routes enforce it; RLS is the backstop: roles that read responses may SELECT; custom
-- members, vendors, interviewers and strangers see nothing; nobody but the service role writes. The
-- runtime (respondent link) uses the service role behind its own token check.
--
-- Re-runnable: `if not exists`, `drop … if exists` first, `create or replace`. Widens one CHECK of 0065
-- (qual_transcripts.source / format gain 'ai_interview'). Undo (destroys AI interview data):
--   drop function if exists public.rescript_ai_interview_record_turn(uuid, integer, jsonb, jsonb, text, jsonb, integer, numeric, boolean);
--   drop function if exists public.rescript_ai_interview_begin(uuid, text, boolean, jsonb, jsonb, text, text, text, text, jsonb, jsonb, boolean);
--   drop table if exists public.ai_interview_turns, public.ai_interview_sessions, public.ai_interview_participants,
--     public.ai_interview_quotas, public.ai_interview_studies;
--   and restore the 0065 checks on qual_transcripts (after deleting rows with source 'ai_interview').

/* ------------------------------------------------------------ a transcript from an AI interview is a qualitative source */

alter table public.qual_transcripts drop constraint if exists qual_transcripts_source_check;
alter table public.qual_transcripts add constraint qual_transcripts_source_check
  check (source in ('import', 'stt', 'open_ends', 'ai_interview'));
alter table public.qual_transcripts drop constraint if exists qual_transcripts_format_check;
alter table public.qual_transcripts add constraint qual_transcripts_format_check
  check (format in ('vtt', 'srt', 'speaker', 'text', 'docx', 'stt', 'open_ends', 'ai_interview'));

/* ------------------------------------------------------------ studies */

create table if not exists public.ai_interview_studies (
  id              uuid primary key default gen_random_uuid(),
  survey_id       uuid not null references public.surveys(id) on delete cascade,
  title           text not null check (length(title) between 1 and 200),
  status          text not null default 'live' check (status in ('live', 'paused', 'closed')),
  -- the public link (/i/<link_token>) and the researcher's test link (/i/<link_token>?test=<test_token>)
  link_token      text not null unique default encode(gen_random_bytes(18), 'hex'),
  test_token      text not null unique default encode(gen_random_bytes(18), 'hex'),
  -- QualStudy (incl. aiModeration) as launched; the definition can change, a running study does not
  guide           jsonb not null check (jsonb_typeof(guide) = 'object'),
  guide_language  text not null default 'en',
  spent_usd       numeric(12, 4) not null default 0 check (spent_usd >= 0),
  launched_by     uuid,
  launched_at     timestamptz not null default now(),
  closed_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists ai_interview_studies_survey_idx on public.ai_interview_studies (survey_id, created_at desc);
-- one open (live or paused) study per survey; a closed one stays for its data
create unique index if not exists ai_interview_studies_open_idx on public.ai_interview_studies (survey_id) where status in ('live', 'paused');

drop trigger if exists ai_interview_studies_touch on public.ai_interview_studies;
create trigger ai_interview_studies_touch before update on public.ai_interview_studies
  for each row execute function public.touch_updated_at();

create table if not exists public.ai_interview_quotas (
  study_id  uuid not null references public.ai_interview_studies(id) on delete cascade,
  segment   text not null check (length(segment) between 1 and 120),
  target    integer not null check (target >= 0),
  primary key (study_id, segment)
);

/* ------------------------------------------------------------ participants */

create table if not exists public.ai_interview_participants (
  id            uuid primary key default gen_random_uuid(),
  study_id      uuid not null references public.ai_interview_studies(id) on delete cascade,
  survey_id     uuid not null references public.surveys(id) on delete cascade,
  number        integer not null check (number >= 1),
  segment       text,
  screener      jsonb not null default '{}'::jsonb check (jsonb_typeof(screener) = 'object'),
  -- { "statement": true, "recording": false, "at": "…", "statementHash": "…" }
  consent       jsonb not null default '{}'::jsonb check (jsonb_typeof(consent) = 'object'),
  language      text,
  external_ref  text check (external_ref is null or length(external_ref) <= 120),
  is_test       boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (study_id, number)
);

/* ------------------------------------------------------------ interviews */

create table if not exists public.ai_interview_sessions (
  id                  uuid primary key default gen_random_uuid(),
  study_id            uuid not null references public.ai_interview_studies(id) on delete cascade,
  survey_id           uuid not null references public.surveys(id) on delete cascade,
  participant_id      uuid not null references public.ai_interview_participants(id) on delete cascade,
  -- sha-256 (hex) of the resume token the participant's browser keeps; the token itself is never stored
  token_hash          text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  mode                text not null default 'text' check (mode in ('text', 'voice', 'video')),
  language            text,
  status              text not null default 'in_progress' check (status in ('in_progress', 'completed', 'screened_out', 'abandoned', 'flagged', 'ended')),
  excluded            boolean not null default false,
  exclusion_reason    text,
  is_test             boolean not null default false,
  -- the moderator's state (engine aiModerator.ts ModeratorState)
  state               jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
  flags               jsonb not null default '[]'::jsonb check (jsonb_typeof(flags) = 'array'),
  turns_count         integer not null default 0 check (turns_count >= 0),
  cost_usd            numeric(12, 4) not null default 0 check (cost_usd >= 0),
  -- bumped on every write; a turn names the version it read
  version             integer not null default 0 check (version >= 0),
  started_at          timestamptz not null default now(),
  last_activity_at    timestamptz not null default now(),
  completed_at        timestamptz,
  ended_by            uuid,
  qual_session_id     uuid references public.qual_sessions(id) on delete set null,
  qual_transcript_id  uuid references public.qual_transcripts(id) on delete set null
);
create index if not exists ai_interview_sessions_study_idx on public.ai_interview_sessions (study_id, status, started_at desc);
create index if not exists ai_interview_sessions_survey_idx on public.ai_interview_sessions (survey_id, started_at desc);
create index if not exists ai_interview_sessions_open_idx on public.ai_interview_sessions (study_id, last_activity_at) where status = 'in_progress';

create table if not exists public.ai_interview_turns (
  id              bigint generated always as identity primary key,
  session_id      uuid not null references public.ai_interview_sessions(id) on delete cascade,
  survey_id       uuid not null references public.surveys(id) on delete cascade,
  seq             integer not null check (seq >= 1),
  speaker         text not null check (speaker in ('moderator', 'participant')),
  text            text not null check (length(text) <= 20000),
  original_text   text,
  language        text,
  translation     text,
  audio_media_id  uuid references public.media_objects(id) on delete set null,
  video_media_id  uuid references public.media_objects(id) on delete set null,
  decision        jsonb check (decision is null or jsonb_typeof(decision) = 'object'),
  offset_ms       integer not null default 0 check (offset_ms >= 0),
  duration_ms     integer check (duration_ms is null or duration_ms >= 0),
  created_at      timestamptz not null default now(),
  unique (session_id, seq)
);

/* ------------------------------------------------------------ admitting a participant, atomically */

drop function if exists public.rescript_ai_interview_begin(uuid, text, boolean, jsonb, jsonb, text, text, text, text, jsonb, jsonb);

-- p_screened_out: record a participant the screener (or a full quota) turned away — no admission checks,
-- the session is written as screened_out and finished
create or replace function public.rescript_ai_interview_begin(
  p_study uuid, p_segment text, p_is_test boolean, p_screener jsonb, p_consent jsonb,
  p_language text, p_external_ref text, p_mode text, p_token_hash text, p_state jsonb, p_flags jsonb,
  p_screened_out boolean default false
) returns table (admitted boolean, reason text, participant_id uuid, session_id uuid, participant_number integer)
language plpgsql security definer set search_path = public as $$
declare
  st public.ai_interview_studies%rowtype;
  q public.ai_interview_quotas%rowtype;
  target integer; budget numeric; done integer; open_now integer; used integer; n integer;
  pid uuid; sid uuid;
begin
  -- the lock serialises admissions per study: two starts cannot both take the last place
  select * into st from public.ai_interview_studies where id = p_study for update;
  if not found then return query select false, 'unknown study'::text, null::uuid, null::uuid, null::integer; return; end if;
  if not p_screened_out and (st.status = 'closed' or (st.status = 'paused' and not p_is_test)) then
    return query select false, 'closed'::text, null::uuid, null::uuid, null::integer; return;
  end if;
  -- interviews idle for 30 minutes are abandoned: they stop holding a quota place
  update public.ai_interview_sessions set status = 'abandoned', completed_at = now(), version = version + 1
   where study_id = p_study and status = 'in_progress' and last_activity_at < now() - interval '30 minutes';
  if not p_is_test and not p_screened_out then
    target := nullif(st.guide #>> '{aiModeration,targetCompletes}', '')::integer;
    budget := nullif(st.guide #>> '{aiModeration,studyBudgetUsd}', '')::numeric;
    select count(*) filter (where s.status = 'completed' and not s.excluded), count(*) filter (where s.status = 'in_progress')
      into done, open_now from public.ai_interview_sessions s where s.study_id = p_study and not s.is_test;
    if target is not null and done >= target then return query select false, 'target reached'::text, null::uuid, null::uuid, null::integer; return; end if;
    if target is not null and done + open_now >= ceil(target * 1.2) then return query select false, 'full for now'::text, null::uuid, null::uuid, null::integer; return; end if;
    if budget is not null and st.spent_usd >= budget then return query select false, 'budget reached'::text, null::uuid, null::uuid, null::integer; return; end if;
    if p_segment is not null then
      select * into q from public.ai_interview_quotas where study_id = p_study and segment = p_segment;
      if found then
        select count(*) into used from public.ai_interview_sessions s join public.ai_interview_participants p on p.id = s.participant_id
         where s.study_id = p_study and p.segment = p_segment and not s.is_test and ((s.status = 'completed' and not s.excluded) or s.status = 'in_progress');
        if used >= q.target then return query select false, 'quota full'::text, null::uuid, null::uuid, null::integer; return; end if;
      end if;
    end if;
  end if;
  select coalesce(max(number), 0) + 1 into n from public.ai_interview_participants where study_id = p_study;
  insert into public.ai_interview_participants (study_id, survey_id, number, segment, screener, consent, language, external_ref, is_test)
    values (p_study, st.survey_id, n, p_segment, coalesce(p_screener, '{}'::jsonb), coalesce(p_consent, '{}'::jsonb), p_language, left(p_external_ref, 120), p_is_test)
    returning id into pid;
  insert into public.ai_interview_sessions (study_id, survey_id, participant_id, token_hash, mode, language, is_test, state, flags, status, completed_at)
    values (p_study, st.survey_id, pid, p_token_hash, p_mode, p_language, p_is_test, coalesce(p_state, '{}'::jsonb), coalesce(p_flags, '[]'::jsonb),
            case when p_screened_out then 'screened_out' else 'in_progress' end, case when p_screened_out then now() end)
    returning id into sid;
  return query select true, null::text, pid, sid, n;
end $$;

/* ------------------------------------------------------------ one exchange, atomically */

-- p_turns: [{ seq, speaker, text, original_text?, language?, translation?, audio_media_id?, video_media_id?, decision?, offset_ms, duration_ms? }]
-- returns the new version, or null when the session moved on since p_expected (the caller reloads: a double submit)
create or replace function public.rescript_ai_interview_record_turn(
  p_session uuid, p_expected integer, p_turns jsonb, p_state jsonb, p_status text, p_flags jsonb,
  p_turns_count integer, p_cost_delta numeric, p_completed boolean
) returns integer
language plpgsql security definer set search_path = public as $$
declare s public.ai_interview_sessions%rowtype; nv integer;
begin
  update public.ai_interview_sessions
     set state = p_state, status = p_status, flags = coalesce(p_flags, flags), turns_count = p_turns_count,
         cost_usd = cost_usd + greatest(coalesce(p_cost_delta, 0), 0), version = version + 1, last_activity_at = now(),
         completed_at = case when p_completed then coalesce(completed_at, now()) else completed_at end
   where id = p_session and version = p_expected and status = 'in_progress'
   returning * into s;
  if not found then return null; end if;
  nv := s.version;
  insert into public.ai_interview_turns (session_id, survey_id, seq, speaker, text, original_text, language, translation, audio_media_id, video_media_id, decision, offset_ms, duration_ms)
  select p_session, s.survey_id, (t->>'seq')::integer, t->>'speaker', t->>'text', t->>'original_text', t->>'language', t->>'translation',
         nullif(t->>'audio_media_id', '')::uuid, nullif(t->>'video_media_id', '')::uuid, case when jsonb_typeof(t->'decision') = 'object' then t->'decision' end,
         greatest(coalesce((t->>'offset_ms')::integer, 0), 0), (t->>'duration_ms')::integer
    from jsonb_array_elements(coalesce(p_turns, '[]'::jsonb)) t;
  if coalesce(p_cost_delta, 0) > 0 then
    update public.ai_interview_studies set spent_usd = spent_usd + p_cost_delta where id = s.study_id;
  end if;
  return nv;
end $$;

revoke all on function public.rescript_ai_interview_begin(uuid, text, boolean, jsonb, jsonb, text, text, text, text, jsonb, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.rescript_ai_interview_record_turn(uuid, integer, jsonb, jsonb, text, jsonb, integer, numeric, boolean) from public, anon, authenticated;

/* ------------------------------------------------------------ RLS: the backstop */

alter table public.ai_interview_studies      enable row level security;
alter table public.ai_interview_quotas       enable row level security;
alter table public.ai_interview_participants enable row level security;
alter table public.ai_interview_sessions     enable row level security;
alter table public.ai_interview_turns        enable row level security;

-- the roles whose capability table holds `responses.read` (as 0065); `custom` is decided by the routes only
drop policy if exists ai_interview_studies_data_read on public.ai_interview_studies;
create policy ai_interview_studies_data_read on public.ai_interview_studies for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );
drop policy if exists ai_interview_quotas_data_read on public.ai_interview_quotas;
create policy ai_interview_quotas_data_read on public.ai_interview_quotas for select to authenticated
  using (exists (
    select 1 from public.ai_interview_studies s where s.id = study_id and (
      public.rescript_project_role(auth.uid(), s.survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
      or public.rescript_is_platform_admin(auth.uid()))
  ));
drop policy if exists ai_interview_participants_data_read on public.ai_interview_participants;
create policy ai_interview_participants_data_read on public.ai_interview_participants for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );
drop policy if exists ai_interview_sessions_data_read on public.ai_interview_sessions;
create policy ai_interview_sessions_data_read on public.ai_interview_sessions for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );
drop policy if exists ai_interview_turns_data_read on public.ai_interview_turns;
create policy ai_interview_turns_data_read on public.ai_interview_turns for select to authenticated
  using (
    public.rescript_project_role(auth.uid(), survey_id) in ('owner', 'project_admin', 'editor', 'programmer', 'reviewer', 'viewer', 'viewer_data', 'deployment_manager')
    or public.rescript_is_platform_admin(auth.uid())
  );

-- the tokens are secrets of the respondent link: never readable through the API, even by members
-- (a column revoke does not override a table grant, so the table grant is replaced by a column list)
revoke all on public.ai_interview_studies, public.ai_interview_quotas, public.ai_interview_participants,
  public.ai_interview_sessions, public.ai_interview_turns from anon;
revoke select on public.ai_interview_studies from authenticated;
grant select (id, survey_id, title, status, guide, guide_language, spent_usd, launched_by, launched_at, closed_at, created_at, updated_at)
  on public.ai_interview_studies to authenticated;
revoke select on public.ai_interview_sessions from authenticated;
grant select (id, study_id, survey_id, participant_id, mode, language, status, excluded, exclusion_reason, is_test, state, flags, turns_count,
  cost_usd, version, started_at, last_activity_at, completed_at, ended_by, qual_session_id, qual_transcript_id)
  on public.ai_interview_sessions to authenticated;

comment on table public.ai_interview_sessions is
  'AI-moderated 1:1 interviews (0069). Respondents'' words: read through the Studio routes (Data view). On completion the transcript is written to qual_transcripts (source ai_interview) for coding.';
comment on table public.ai_interview_turns is
  'Each turn of an AI interview: the participant''s own words (and the STT output before their correction), translation, media, and the moderator''s decision record.';
