/* ============================================================================
 * 0030 — THE INTERVIEW DOMAIN
 *
 * A second product in the same database, sharing the tenant (`customers`) and
 * the people (`profiles`) and nothing else. Every table here is new; nothing
 * existing is altered. A failure in this schema cannot reach a survey.
 *
 * ## Shape
 *
 *   interview_projects          the configuration a company sets up once
 *     ├── interview_pools       named groups a sequence is drawn from
 *     ├── interview_questions   what is asked
 *     ├── interview_requirements what is being assessed
 *     └── interviews            one candidate's sitting
 *           ├── interview_responses   one answer to one question
 *           │     └── interview_media   what is in object storage
 *           │           └── interview_transcripts
 *           ├── interview_telemetry
 *           ├── interview_evidence   requirement × response
 *           ├── interview_analysis
 *           └── interview_reviews
 *   interview_jobs              the asynchronous work queue
 *   interview_exports           generated packages
 *
 * ## Two rules this schema exists to enforce
 *
 * **No binary lives here.** `interview_media` holds a storage provider, a key
 * and the store's own byte count. The bytes are in object storage. A database
 * that holds video is a database nobody can back up, and every product that
 * has tried it has migrated back out.
 *
 * **A randomised sequence is recorded, not recomputed.** §8 asks that the
 * exact question order of a completed interview be reproducible for audit.
 * Storing the seed and re-running the shuffle is not reproducible — it is
 * reproducible *until somebody edits the pool*, which is the same thing as
 * not reproducible. So `interviews.question_sequence` is written when the
 * interview starts and never recomputed, and `selection_seed` is kept beside
 * it so the draw can be explained as well as replayed.
 *
 * ## Access
 *
 * Deny-all RLS on everything, service role only, exactly as `media_objects`
 * and the billing tables already are. Authorization is the application's job
 * and happens before any query; the policies are the second line, and they
 * say "no" so that a missing policy can never be mistaken for an oversight.
 * ==========================================================================*/

/* ------------------------------------------------------------------ helper */

create or replace function public.rescript_interviews_touch()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin new.updated_at := now(); return new; end $$;

revoke all on function public.rescript_interviews_touch() from public, anon, authenticated;

/* =============================================================== projects */

create table if not exists public.interview_projects (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  /* who pays: the billing subject resolves the wallet through this person */
  owner_id uuid references public.profiles(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,

  /* a short human handle, unique inside the workspace, used in links and exports */
  code text not null,
  name text not null,
  description text not null default '',

  status text not null default 'draft'
    check (status in ('draft', 'open', 'closed', 'archived')),

  /* what the candidate is shown before anything is recorded */
  instructions text not null default '',
  consent_text text not null default '',

  /*
   * Everything a programmer configures about how the interview runs, as one
   * document: retries, durations, whether the camera is required, whether the
   * candidate may download their own recording. It is jsonb rather than forty
   * columns because it is validated by a zod schema in the application, which
   * is where the defaults and the migration of older shapes already live —
   * the same decision `surveys.draft_definition` made and has not regretted.
   */
  settings jsonb not null default '{}'::jsonb,

  /* how the sequence is drawn: which pools, how many from each, in what order */
  selection jsonb not null default '{}'::jsonb,

  /* ---- retention (§20). Null means "keep until somebody says otherwise". */
  retention_days integer check (retention_days is null or retention_days between 1 and 3650),
  /* what the retention sweep is allowed to remove when it runs */
  retention_scope jsonb not null default
    '{"media": true, "transcripts": false, "analysis": false}'::jsonb,

  /* ---- cost controls (§22). Null means "no limit of its own". */
  max_recording_seconds integer check (max_recording_seconds is null or max_recording_seconds > 0),
  max_storage_bytes bigint check (max_storage_bytes is null or max_storage_bytes > 0),
  max_transcription_seconds integer check (max_transcription_seconds is null or max_transcription_seconds > 0),
  max_ai_analyses integer check (max_ai_analyses is null or max_ai_analyses >= 0),

  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, code)
);

create index if not exists interview_projects_customer_idx
  on public.interview_projects (customer_id, created_at desc) where deleted_at is null;
create index if not exists interview_projects_owner_idx
  on public.interview_projects (owner_id) where deleted_at is null;

drop trigger if exists interview_projects_touch on public.interview_projects;
create trigger interview_projects_touch before update on public.interview_projects
  for each row execute function public.rescript_interviews_touch();

/* ------------------------------------------------------- project members */

/*
 * Who inside the workspace may see this project, and as what.
 *
 * Mirrors `project_members` deliberately — the same five-role idea, the same
 * "a row here overrides the workspace baseline" precedence — rather than
 * inventing a second vocabulary for the same question. The roles differ
 * because the work differs: an interview has a REVIEWER who watches and
 * assesses, which a survey has no equivalent of.
 */
create table if not exists public.interview_project_members (
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('manager', 'interviewer', 'reviewer', 'viewer')),
  invited_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index if not exists interview_project_members_user_idx
  on public.interview_project_members (user_id);

/* ================================================================== pools */

create table if not exists public.interview_pools (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  code text not null,
  name text not null,
  /* how many of this pool's questions a sitting draws; null = all of them */
  draw integer check (draw is null or draw >= 0),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, code)
);

drop trigger if exists interview_pools_touch on public.interview_pools;
create trigger interview_pools_touch before update on public.interview_pools
  for each row execute function public.rescript_interviews_touch();

/* ============================================================== questions */

create table if not exists public.interview_questions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  pool_id uuid references public.interview_pools(id) on delete set null,

  code text not null,
  /* hr | technical | behavioural | role | scenario | intro | custom (§8) */
  category text not null default 'custom',
  /* how the candidate answers */
  kind text not null default 'video'
    check (kind in ('video', 'audio', 'text')),

  prompt text not null,
  /* what the candidate is told before the clock starts */
  guidance text not null default '',
  /* a clip of the interviewer asking, stored like any other media */
  prompt_media_id uuid,

  required boolean not null default true,
  min_seconds integer check (min_seconds is null or min_seconds >= 0),
  max_seconds integer check (max_seconds is null or max_seconds > 0),
  /* how many times a candidate may discard a take and start again */
  max_retries integer not null default 0 check (max_retries >= 0),
  /* seconds to read the question before recording begins; 0 = start at once */
  think_seconds integer not null default 0 check (think_seconds >= 0),

  position integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, code),
  constraint interview_questions_duration_order
    check (min_seconds is null or max_seconds is null or min_seconds <= max_seconds)
);

create index if not exists interview_questions_project_idx
  on public.interview_questions (project_id, position) where archived_at is null;
create index if not exists interview_questions_pool_idx
  on public.interview_questions (pool_id) where archived_at is null;

drop trigger if exists interview_questions_touch on public.interview_questions;
create trigger interview_questions_touch before update on public.interview_questions
  for each row execute function public.rescript_interviews_touch();

/* =========================================================== requirements */

create table if not exists public.interview_requirements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  code text not null,
  title text not null,
  description text not null default '',
  /* what "meeting this" looks like, in the org's own words, for the analysis */
  criteria text not null default '',
  weight numeric(6,2) not null default 1 check (weight >= 0),
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, code)
);

drop trigger if exists interview_requirements_touch on public.interview_requirements;
create trigger interview_requirements_touch before update on public.interview_requirements
  for each row execute function public.rescript_interviews_touch();

/* ============================================================== interviews */

create table if not exists public.interviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,

  /* the candidate, as the company knows them. No account, ever. */
  candidate_name text,
  candidate_email text,
  candidate_reference text,

  /*
   * THE LINK IS A SECRET AND IS STORED AS A HASH.
   *
   * `respondents.token` in the survey product is plaintext, and the migration
   * that hashed collaborator invitations said frankly that it should not be.
   * A new product has no reason to repeat it: the token is shown once, when
   * the link is created, and after that only its SHA-256 exists here. Losing
   * a link is a re-issue, which is a normal thing for a company to do and a
   * safe thing for us to offer; recovering one from the database is not.
   *
   * `token_prefix` is the first characters, kept so a support conversation can
   * identify which link is being discussed without being able to use it.
   */
  token_hash text not null unique,
  token_prefix text not null,
  token_issued_at timestamptz not null default now(),
  expires_at timestamptz,

  status text not null default 'invited' check (status in (
    'invited',      -- the link exists, nobody has opened it
    'started',      -- opened, consent not yet given
    'in_progress',  -- consented, answering
    'completed',    -- every required question answered
    'processing',   -- transcription / analysis in flight
    'processed',    -- everything downstream finished
    'expired',      -- the link ran out before it was used
    'abandoned',    -- started and left, past the abandon window
    'failed'        -- something went wrong that a person must look at
  )),

  /* TEST sittings never bill at the LIVE rate and never appear in reporting */
  is_test boolean not null default false,

  /*
   * THE EXACT SEQUENCE THIS CANDIDATE WAS ASKED.
   *
   * Written once, when the interview starts, and never recomputed — see the
   * header. `[{questionId, poolId, position}]`, in the order presented.
   */
  question_sequence jsonb not null default '[]'::jsonb,
  /* the seed the draw used, so the selection can be EXPLAINED, not just replayed */
  selection_seed text,

  consent_given_at timestamptz,
  consent_text_snapshot text,
  started_at timestamptz,
  completed_at timestamptz,
  processed_at timestamptz,
  last_seen_at timestamptz,

  /* what the browser told us about itself, for interpreting a failure */
  user_agent text,
  ip_hash text,

  error text,
  deleted_at timestamptz,
  /* set by the retention sweep once the media is gone */
  media_purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists interviews_project_idx
  on public.interviews (project_id, created_at desc) where deleted_at is null;
create index if not exists interviews_status_idx
  on public.interviews (status, created_at) where deleted_at is null;
create index if not exists interviews_customer_idx
  on public.interviews (customer_id) where deleted_at is null;
/* the retention sweep's working set */
create index if not exists interviews_retention_idx
  on public.interviews (completed_at)
  where deleted_at is null and media_purged_at is null and completed_at is not null;

drop trigger if exists interviews_touch on public.interviews;
create trigger interviews_touch before update on public.interviews
  for each row execute function public.rescript_interviews_touch();

/* =============================================================== responses */

/*
 * ONE ANSWER TO ONE QUESTION (§11).
 *
 * Not one recording per interview. Individually retryable, individually
 * transcribed, individually billed, individually deletable — every one of
 * which becomes a special case the moment a sitting is one object.
 */
create table if not exists public.interview_responses (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references public.interviews(id) on delete cascade,
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  question_id uuid not null references public.interview_questions(id) on delete restrict,

  /* where in this candidate's own sequence it came */
  position integer not null default 0,

  status text not null default 'pending' check (status in (
    'pending',    -- not reached yet
    'recording',  -- the camera is live
    'uploading',  -- bytes are moving
    'stored',     -- the store has confirmed the object
    'skipped',    -- an optional question the candidate passed on
    'failed'      -- the take did not survive; retryable
  )),

  /* a text answer, or the transcript once one exists — see interview_transcripts */
  answer_text text,
  duration_seconds numeric(10,2),
  retries integer not null default 0,
  /* how long the question was on screen before recording started */
  think_seconds numeric(10,2),

  started_at timestamptz,
  recorded_at timestamptz,
  stored_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  /* one live answer per question per sitting; a retake replaces rather than adds */
  unique (interview_id, question_id)
);

create index if not exists interview_responses_interview_idx
  on public.interview_responses (interview_id, position);
create index if not exists interview_responses_project_idx
  on public.interview_responses (project_id, created_at desc);

drop trigger if exists interview_responses_touch on public.interview_responses;
create trigger interview_responses_touch before update on public.interview_responses
  for each row execute function public.rescript_interviews_touch();

/* =================================================================== media */

/*
 * THE INVENTORY OF WHAT IS IN OBJECT STORAGE.
 *
 * The lesson of `media_objects`: before it existed, an object was known only
 * by a string inside a jsonb blob, so deleting a survey left its videos in
 * the bucket for ever and an erasure request deleted the only key that could
 * have found them. Nothing here is written to storage without a row here
 * first, and the row is written BEFORE the upload — a row still `pending` an
 * hour later is the only evidence that a browser closed mid-transfer.
 */
create table if not exists public.interview_media (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  interview_id uuid references public.interviews(id) on delete cascade,
  response_id uuid references public.interview_responses(id) on delete cascade,
  question_id uuid references public.interview_questions(id) on delete set null,

  kind text not null check (kind in (
    'answer_video',    -- the take
    'answer_audio',    -- the audio-only companion, which is what gets transcribed
    'question_prompt', -- the interviewer asking
    'combined',        -- an optionally generated whole-interview recording
    'export'           -- a generated package
  )),

  /* which implementation of MediaStorageProvider wrote it */
  storage_provider text not null default 'cloudflare-r2',
  storage_key text not null,

  mime_type text,
  /* what the STORE says, never what the client claimed */
  file_size bigint,
  duration_seconds numeric(10,2),
  width integer,
  height integer,

  upload_status text not null default 'pending'
    check (upload_status in ('pending', 'uploading', 'stored', 'failed', 'deleted')),
  processing_status text not null default 'none'
    check (processing_status in ('none', 'queued', 'processing', 'complete', 'failed')),

  /* set while a multipart upload is in flight, so an abandoned one can be aborted */
  multipart_upload_id text,
  /* the client's own idea of this recording, for duplicate protection */
  client_token text,

  error text,
  uploaded_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (storage_provider, storage_key)
);

create index if not exists interview_media_interview_idx
  on public.interview_media (interview_id, kind) where deleted_at is null;
create index if not exists interview_media_response_idx
  on public.interview_media (response_id) where deleted_at is null;
create index if not exists interview_media_project_idx
  on public.interview_media (project_id) where deleted_at is null;
/* the abandoned-upload sweep's working set */
create index if not exists interview_media_pending_idx
  on public.interview_media (upload_status, created_at)
  where upload_status in ('pending', 'uploading');
/* duplicate protection: one client token means one object */
create unique index if not exists interview_media_client_token_idx
  on public.interview_media (response_id, client_token)
  where client_token is not null and deleted_at is null;

drop trigger if exists interview_media_touch on public.interview_media;
create trigger interview_media_touch before update on public.interview_media
  for each row execute function public.rescript_interviews_touch();

alter table public.interview_questions
  drop constraint if exists interview_questions_prompt_media_fk;
alter table public.interview_questions
  add constraint interview_questions_prompt_media_fk
  foreign key (prompt_media_id) references public.interview_media(id) on delete set null;

/* ============================================================ transcripts */

create table if not exists public.interview_transcripts (
  id uuid primary key default gen_random_uuid(),
  media_id uuid not null unique references public.interview_media(id) on delete cascade,
  interview_id uuid references public.interviews(id) on delete cascade,
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  response_id uuid references public.interview_responses(id) on delete cascade,

  status text not null default 'waiting' check (status in (
    'waiting',      -- queued, nobody has it
    'processing',   -- a runner has it and is fetching the audio
    'transcribing', -- the provider has it
    'completed',
    'failed'
  )),
  attempts integer not null default 0,

  text text,
  /* word or segment timings, when the provider gives them: [{start,end,text}] */
  segments jsonb,
  language text,
  provider text,
  model text,
  /* what we paid a provider for, so a retry can be told from a re-bill */
  billed_seconds numeric(10,2),

  error text,
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists interview_transcripts_open_idx
  on public.interview_transcripts (status, claimed_at)
  where status in ('waiting', 'processing', 'transcribing');
create index if not exists interview_transcripts_interview_idx
  on public.interview_transcripts (interview_id);

drop trigger if exists interview_transcripts_touch on public.interview_transcripts;
create trigger interview_transcripts_touch before update on public.interview_transcripts
  for each row execute function public.rescript_interviews_touch();

/* ============================================================== evidence */

/*
 * WHAT THE ANALYSIS FOUND, AND WHERE IT FOUND IT.
 *
 * One row per (requirement × response) the analysis had something to say
 * about. The verdict is deliberately three-valued and the third value is
 * `insufficient` rather than `not_met` — §15 is explicit that the system must
 * never invent evidence, and "we did not find enough to say" is a different
 * claim from "this person does not have it". A schema that cannot express the
 * difference guarantees the product will not either.
 */
create table if not exists public.interview_evidence (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references public.interviews(id) on delete cascade,
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  requirement_id uuid not null references public.interview_requirements(id) on delete cascade,
  response_id uuid references public.interview_responses(id) on delete set null,
  question_id uuid references public.interview_questions(id) on delete set null,

  verdict text not null check (verdict in ('evidence', 'partial', 'insufficient')),
  /* the analysis's own words about why */
  explanation text not null default '',
  /* the transcript passage it is pointing at — quoted, never paraphrased */
  quote text,
  quote_start_seconds numeric(10,2),
  quote_end_seconds numeric(10,2),
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),

  provider text,
  model text,
  created_at timestamptz not null default now(),
  unique (interview_id, requirement_id, response_id)
);

create index if not exists interview_evidence_interview_idx
  on public.interview_evidence (interview_id, requirement_id);

/* =============================================================== analysis */

create table if not exists public.interview_analysis (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references public.interviews(id) on delete cascade,
  project_id uuid not null references public.interview_projects(id) on delete cascade,

  status text not null default 'queued'
    check (status in ('queued', 'running', 'complete', 'failed')),
  attempts integer not null default 0,

  /* a per-requirement roll-up: {requirementCode: {verdict, evidenceCount}} */
  summary jsonb not null default '{}'::jsonb,
  /* the analysis's prose, for a reviewer to read before watching anything */
  narrative text,

  provider text,
  model text,
  /* the requirement set as it was when this ran, so a later edit cannot
     silently change what a completed analysis appears to have assessed */
  requirements_snapshot jsonb not null default '[]'::jsonb,

  error text,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists interview_analysis_interview_idx
  on public.interview_analysis (interview_id);

drop trigger if exists interview_analysis_touch on public.interview_analysis;
create trigger interview_analysis_touch before update on public.interview_analysis
  for each row execute function public.rescript_interviews_touch();

/* ================================================================ reviews */

/*
 * THE HUMAN VERDICT (§16).
 *
 * Separate from `interview_analysis` on purpose, and not nullable into it:
 * the AI's output is a signal and a person's assessment is a decision, and a
 * schema that stores them in one row invites a product that shows them as one
 * thing. A review can disagree with the analysis, and the disagreement is
 * itself worth keeping.
 */
create table if not exists public.interview_reviews (
  id uuid primary key default gen_random_uuid(),
  interview_id uuid not null references public.interviews(id) on delete cascade,
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  reviewer_id uuid not null references public.profiles(id) on delete cascade,

  status text not null default 'in_progress'
    check (status in ('in_progress', 'complete')),
  /* the reviewer's own assessment per requirement: {requirementId: verdict} */
  assessments jsonb not null default '{}'::jsonb,
  notes text not null default '',
  recommendation text check (recommendation in ('advance', 'hold', 'decline')),

  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (interview_id, reviewer_id)
);

drop trigger if exists interview_reviews_touch on public.interview_reviews;
create trigger interview_reviews_touch before update on public.interview_reviews
  for each row execute function public.rescript_interviews_touch();

/* ============================================================== telemetry */

/*
 * TECHNICAL SIGNALS, NOT ACCUSATIONS (§17).
 *
 * The column is `kind`, not `violation`. Nothing here is evidence of
 * anything; a tab change is a person checking the time, or a notification,
 * or a second monitor, or cheating, and the database has no way to tell.
 * Storing it under a neutral name is the cheapest possible way to stop the
 * product from quietly acquiring an opinion it cannot support.
 */
create table if not exists public.interview_telemetry (
  id bigint generated always as identity primary key,
  interview_id uuid not null references public.interviews(id) on delete cascade,
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  response_id uuid references public.interview_responses(id) on delete cascade,
  question_id uuid references public.interview_questions(id) on delete set null,

  kind text not null,
  /* whatever the event carries: durations, counts, permission states */
  detail jsonb not null default '{}'::jsonb,
  /* the browser's clock, which may disagree with ours and is kept separately */
  client_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists interview_telemetry_interview_idx
  on public.interview_telemetry (interview_id, created_at);
create index if not exists interview_telemetry_kind_idx
  on public.interview_telemetry (project_id, kind);

/* =================================================================== jobs */

/*
 * THE ASYNCHRONOUS WORK QUEUE (§23).
 *
 * The survey product has no queue at all — its transcription job is driven by
 * the browser that created it, which means a candidate who closes the tab
 * leaves work nobody picks up. That is acceptable for a two-minute voice
 * answer and unacceptable for an interview, so this is a real queue: rows
 * claimed with `for update skip locked`, a retry count, an explicit
 * `run_after` rather than an inferred one, and a stale-claim timeout so a
 * serverless function killed mid-job is reclaimed rather than lost.
 *
 * `idempotency_key` is what makes §23's "retrying a job must not create
 * duplicate billing events or duplicate transcripts" true rather than hoped
 * for: it is unique, so the second insert loses.
 */
create table if not exists public.interview_jobs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  interview_id uuid references public.interviews(id) on delete cascade,

  kind text not null check (kind in (
    'transcription', 'analysis', 'media_processing', 'export', 'retention'
  )),
  /* what the job is about: a media id, an interview id, an export id */
  subject_id uuid,
  payload jsonb not null default '{}'::jsonb,

  status text not null default 'queued'
    check (status in ('queued', 'running', 'complete', 'failed', 'cancelled')),
  priority integer not null default 100,
  attempts integer not null default 0,
  max_attempts integer not null default 3,

  /* the next instant this may be claimed. Explicit, never derived from updated_at. */
  run_after timestamptz not null default now(),
  claimed_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,

  error text,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists interview_jobs_due_idx
  on public.interview_jobs (kind, priority, run_after)
  where status in ('queued', 'failed');
create index if not exists interview_jobs_running_idx
  on public.interview_jobs (claimed_at) where status = 'running';
create index if not exists interview_jobs_interview_idx
  on public.interview_jobs (interview_id, kind);

drop trigger if exists interview_jobs_touch on public.interview_jobs;
create trigger interview_jobs_touch before update on public.interview_jobs
  for each row execute function public.rescript_interviews_touch();

/* ================================================================ exports */

create table if not exists public.interview_exports (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  project_id uuid not null references public.interview_projects(id) on delete cascade,
  interview_id uuid references public.interviews(id) on delete cascade,
  requested_by uuid references public.profiles(id) on delete set null,

  kind text not null check (kind in ('interview_package', 'project_report', 'transcript_bundle')),
  format text not null default 'zip',
  status text not null default 'queued'
    check (status in ('queued', 'running', 'ready', 'failed', 'expired')),

  media_id uuid references public.interview_media(id) on delete set null,
  /* what went in: [{responseId, mediaId, fileName, bytes}] */
  manifest jsonb not null default '[]'::jsonb,
  total_bytes bigint not null default 0,

  /* a share link, hashed exactly as the interview token is */
  token_hash text,
  expires_at timestamptz,
  download_count integer not null default 0,
  downloaded_at timestamptz,

  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists interview_exports_project_idx
  on public.interview_exports (project_id, created_at desc);
create index if not exists interview_exports_token_idx
  on public.interview_exports (token_hash) where token_hash is not null;

drop trigger if exists interview_exports_touch on public.interview_exports;
create trigger interview_exports_touch before update on public.interview_exports
  for each row execute function public.rescript_interviews_touch();

/* ============================================================= the claims */

/**
 * Claim one due job of a kind.
 *
 * `for update skip locked` is the whole mechanism: two runners racing cannot
 * both claim the same row, so a job cannot be billed for twice by concurrency
 * alone. A row `running` for longer than `p_stale_seconds` is reclaimable —
 * that is a serverless function that was killed, and without it the job would
 * sit `running` for ever with nobody working on it.
 */
create or replace function public.rescript_interview_claim_job(
  p_kind text,
  p_stale_seconds integer default 300,
  p_now timestamptz default now()
)
returns public.interview_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.interview_jobs; target uuid;
begin
  select id into target
    from public.interview_jobs
   where kind = p_kind
     and attempts < max_attempts
     and (
       (status in ('queued', 'failed') and run_after <= p_now)
       or (status = 'running' and claimed_at < p_now - make_interval(secs => greatest(30, p_stale_seconds)))
     )
   order by priority, run_after
   for update skip locked
   limit 1;

  if target is null then return j; end if;

  update public.interview_jobs
     set status = 'running',
         attempts = attempts + 1,
         claimed_at = p_now,
         started_at = coalesce(started_at, p_now),
         error = null
   where id = target
   returning * into j;
  return j;
end $$;

/**
 * Finish a job.
 *
 * A failure that has attempts left goes back to `failed` with a `run_after`
 * the CALLER computes — backoff is policy, and policy belongs in TypeScript
 * where it can be tested without a database. A failure with no attempts left
 * stays `failed` and stops being claimed, which is what stops an unreadable
 * recording being sent to a paid provider for ever.
 */
create or replace function public.rescript_interview_finish_job(
  p_job uuid,
  p_status text,
  p_error text default null,
  p_run_after timestamptz default null
)
returns public.interview_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.interview_jobs;
begin
  update public.interview_jobs
     set status = p_status,
         error = p_error,
         run_after = coalesce(p_run_after, run_after),
         completed_at = case when p_status in ('complete', 'cancelled') then now() else completed_at end,
         claimed_at = case when p_status = 'running' then claimed_at else null end
   where id = p_job
   returning * into j;
  return j;
end $$;

/** The same claim, for one transcript. */
create or replace function public.rescript_interview_claim_transcript(
  p_media uuid,
  p_stale_seconds integer default 300,
  p_max_attempts integer default 3
)
returns public.interview_transcripts
language plpgsql security definer set search_path = public, pg_temp as $$
declare t public.interview_transcripts; target uuid;
begin
  select id into target
    from public.interview_transcripts
   where media_id = p_media
     and attempts < p_max_attempts
     and (
       status in ('waiting', 'failed')
       or (status in ('processing', 'transcribing')
           and claimed_at < now() - make_interval(secs => greatest(30, p_stale_seconds)))
     )
   for update skip locked
   limit 1;

  if target is null then return t; end if;

  update public.interview_transcripts
     set status = 'processing', attempts = attempts + 1,
         claimed_at = now(), started_at = coalesce(started_at, now()), error = null
   where id = target
   returning * into t;
  return t;
end $$;

/**
 * Everything one interview holds in object storage.
 *
 * The retention sweep and the erasure path both read this, and both need it
 * to work AFTER the rows have been read but BEFORE they are deleted — an
 * object whose row is already gone is invisible for ever.
 */
create or replace function public.rescript_interview_media_for(p_interview uuid)
returns table (id uuid, storage_provider text, storage_key text)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.id, m.storage_provider, m.storage_key
    from public.interview_media m
   where m.interview_id = p_interview
     and m.deleted_at is null
$$;

/** Interviews whose retention window has passed and whose media is still there. */
create or replace function public.rescript_interview_retention_due(p_limit integer default 50)
returns table (
  interview_id uuid, project_id uuid, customer_id uuid,
  retention_days integer, retention_scope jsonb, completed_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp as $$
  select i.id, i.project_id, i.customer_id, p.retention_days, p.retention_scope, i.completed_at
    from public.interviews i
    join public.interview_projects p on p.id = i.project_id
   where i.deleted_at is null
     and i.media_purged_at is null
     and p.retention_days is not null
     and i.completed_at is not null
     and i.completed_at < now() - make_interval(days => p.retention_days)
   order by i.completed_at
   limit greatest(1, p_limit)
$$;

/**
 * Uploads that were begun and never finished.
 *
 * A `pending` row an hour old is a browser that closed mid-transfer. It is
 * also the ONLY evidence such an upload happened, which is why the row is
 * written before the ticket is issued rather than after the bytes land.
 */
create or replace function public.rescript_interview_abandoned_uploads(
  p_older_than_minutes integer default 120,
  p_limit integer default 200
)
returns table (
  id uuid, storage_provider text, storage_key text, multipart_upload_id text, project_id uuid
)
language sql stable security definer set search_path = public, pg_temp as $$
  select m.id, m.storage_provider, m.storage_key, m.multipart_upload_id, m.project_id
    from public.interview_media m
   where m.upload_status in ('pending', 'uploading')
     and m.deleted_at is null
     and m.created_at < now() - make_interval(mins => greatest(1, p_older_than_minutes))
   order by m.created_at
   limit greatest(1, p_limit)
$$;

/** What one project is storing, for the §22 cap and the usage dashboard. */
create or replace function public.rescript_interview_storage_bytes(p_project uuid)
returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(m.file_size), 0)::bigint
    from public.interview_media m
   where m.project_id = p_project
     and m.upload_status = 'stored'
     and m.deleted_at is null
$$;

/* ============================================================ permissions */

/*
 * DENY ALL, SERVICE ROLE ONLY.
 *
 * Every query in this product goes through the service role after the
 * application has authorized it — the same arrangement the billing and media
 * tables already use. The policies below are the second line, and they exist
 * so that "this table has no policy" can never be confused with "this table
 * was forgotten". `0026_least_privilege.sql` is the reason the REVOKEs are
 * here too: a SECURITY DEFINER function is executable by PUBLIC unless it is
 * explicitly taken away, and that default was once a complete auth bypass.
 */
do $$
declare t text;
begin
  foreach t in array array[
    'interview_projects', 'interview_project_members', 'interview_pools',
    'interview_questions', 'interview_requirements', 'interviews',
    'interview_responses', 'interview_media', 'interview_transcripts',
    'interview_evidence', 'interview_analysis', 'interview_reviews',
    'interview_telemetry', 'interview_jobs', 'interview_exports'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_service_role_only', t);
    execute format(
      'create policy %I on public.%I for all using (false) with check (false)',
      t || '_service_role_only', t
    );
  end loop;
end $$;

revoke all on function public.rescript_interview_claim_job(text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.rescript_interview_finish_job(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.rescript_interview_claim_transcript(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.rescript_interview_media_for(uuid) from public, anon, authenticated;
revoke all on function public.rescript_interview_retention_due(integer) from public, anon, authenticated;
revoke all on function public.rescript_interview_abandoned_uploads(integer, integer) from public, anon, authenticated;
revoke all on function public.rescript_interview_storage_bytes(uuid) from public, anon, authenticated;
