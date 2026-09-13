/*
 * RECORDINGS BECOME ROWS.
 *
 * Until now every piece of media this platform holds was known only by a
 * string buried in a jsonb blob: a question's video as `settings.interviewVideo`
 * inside `surveys.draft_definition`, a respondent's answer as
 * `responses.answers -> <qid> -> audio`. Nothing could be found from SQL. The
 * consequences were all the same consequence:
 *
 *   · deleting a survey left its videos in the bucket forever — the only
 *     cleanup that exists walks `responses.session_id`, so it reaches
 *     `rescript-uploads` and neither of the other two buckets;
 *   · purging a respondent for an erasure request destroyed the row that was
 *     the ONLY key from a bucket folder back to a survey, so their voice
 *     recording became permanently unreachable AND permanently retained;
 *   · deleting a question, or re-recording it, dropped the reference and kept
 *     the object — every take a researcher ever recorded is still there;
 *   · and a transcript had nowhere to live except the answer blob, so a
 *     transcription that failed could never be found again, let alone retried.
 *
 * Two tables fix all four, because all four are the same missing thing: a row
 * per object, keyed to the survey that owns it.
 *
 *     Project → Survey → Question  → Recording → Transcript
 *     Project → Survey → Response  → Question  → Recording → Transcript
 *
 * The blobs keep their copy of the url and path. That is deliberate: the
 * runtime renders from the definition and must not need a join to play a
 * video. These rows are the INVENTORY — what exists, who owns it, what state
 * it is in — not a second source of truth for the answer.
 *
 * ## Why transcripts are a table and not a status field
 *
 * A five-minute clip takes a speech-to-text provider twenty to sixty seconds.
 * On a serverless deployment the request the respondent is waiting on is dead
 * long before that, and today that timeout is indistinguishable in the stored
 * data from "no provider configured" — `{source: "none", failed: true}` either
 * way. So the work needs somewhere durable to live between "the clip is
 * stored" and "here is what they said": a row that survives the request that
 * created it, can be claimed by exactly one runner, counts its own attempts,
 * and can be re-driven from the stored audio rather than from a recording the
 * respondent no longer has.
 *
 * `rescript_claim_transcription` is that claim, done in SQL so two runners
 * racing on the same clip cannot both bill for it.
 */

/* ------------------------------------------------------------ media */

create table if not exists public.media_objects (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references public.customers(id) on delete cascade,
  survey_id         uuid not null references public.surveys(id) on delete cascade,
  /*
   * The question's id INSIDE the definition — text, not a foreign key,
   * because questions are jsonb and have no table. Nullable for media that
   * belongs to a survey rather than to one question.
   */
  question_id       text,
  /*
   * Respondent media carries both: `response_id` so an erasure cascades, and
   * `session_id` because that is what the storage path is keyed by and the
   * response row may be purged before the object is.
   */
  response_id       uuid references public.responses(id) on delete cascade,
  session_id        text,
  kind              text not null check (kind in (
                      'question_video',      -- the researcher asking, on camera
                      'question_audio',       -- the audio track of the above, for transcription
                      'answer_audio',         -- the respondent answering
                      'answer_upload',        -- any other respondent file answer
                      'localization_audio'    -- a recorded or generated question reading
                    )),
  bucket            text not null,
  path              text not null,
  original_filename text,
  mime_type         text,
  bytes             bigint,
  duration_seconds  numeric(10,2),
  width             integer,
  height            integer,
  /*
   * `pending` is written when the upload URL is handed out and `stored` when
   * the client confirms the object landed. A row stuck at `pending` is an
   * upload that never finished — which is exactly what the retry needs to
   * find, and exactly what a sweep should remove.
   */
  status            text not null default 'pending' check (status in ('pending','stored','failed')),
  error             text,
  uploaded_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (bucket, path)
);

create index if not exists media_objects_survey_idx   on public.media_objects (survey_id, kind);
create index if not exists media_objects_question_idx on public.media_objects (survey_id, question_id);
create index if not exists media_objects_response_idx on public.media_objects (response_id);
create index if not exists media_objects_session_idx  on public.media_objects (session_id);
create index if not exists media_objects_pending_idx  on public.media_objects (status, created_at) where status = 'pending';

create trigger media_objects_touch before update on public.media_objects
  for each row execute function public.touch_updated_at();

/* ------------------------------------------------------------ transcripts */

create table if not exists public.media_transcripts (
  id            uuid primary key default gen_random_uuid(),
  media_id      uuid not null unique references public.media_objects(id) on delete cascade,
  survey_id     uuid not null references public.surveys(id) on delete cascade,
  /*
   * The five states the interface promises, spelled once, here.
   * `processing` is "a runner has it and is fetching the audio";
   * `transcribing` is "the provider has it". They are separate because they
   * fail for different reasons and a researcher staring at a spinner deserves
   * to know which one is slow.
   */
  status        text not null default 'waiting' check (status in ('waiting','processing','transcribing','completed','failed')),
  attempts      integer not null default 0,
  text          text,
  language      text,
  model         text,
  provider      text,
  error         text,
  claimed_at    timestamptz,
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists media_transcripts_survey_idx on public.media_transcripts (survey_id, status);
create index if not exists media_transcripts_open_idx   on public.media_transcripts (status, claimed_at)
  where status in ('waiting','processing','transcribing');

create trigger media_transcripts_touch before update on public.media_transcripts
  for each row execute function public.touch_updated_at();

/* ------------------------------------------------------------ the claim */

/*
 * Move one transcript to `processing` and return it, but only if nobody else
 * already has it.
 *
 * `for update skip locked` rather than a plain update so two runners arriving
 * together do not both bill the provider for the same clip. A job that has
 * been sitting in `processing`/`transcribing` for longer than
 * `p_stale_seconds` is assumed to belong to a request that was killed
 * mid-flight — the serverless failure mode this whole table exists for — and
 * is reclaimable. `p_max_attempts` stops a clip the provider genuinely cannot
 * read from being retried forever at the customer's expense.
 */
create or replace function public.rescript_claim_transcription(
  p_media uuid,
  p_stale_seconds integer default 180,
  p_max_attempts integer default 3
) returns table (
  id uuid, media_id uuid, survey_id uuid, status text, attempts integer,
  bucket text, path text, mime_type text, duration_seconds numeric, kind text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  select t.id into v_id
  from public.media_transcripts t
  where t.media_id = p_media
    and t.attempts < p_max_attempts
    and (
      t.status in ('waiting', 'failed')
      or (t.status in ('processing', 'transcribing')
          and t.claimed_at < now() - make_interval(secs => p_stale_seconds))
    )
  for update skip locked;

  if v_id is null then
    return;
  end if;

  update public.media_transcripts t
     set status = 'processing',
         attempts = t.attempts + 1,
         claimed_at = now(),
         started_at = coalesce(t.started_at, now()),
         error = null
   where t.id = v_id;

  return query
  select t.id, t.media_id, t.survey_id, t.status, t.attempts,
         m.bucket, m.path, m.mime_type, m.duration_seconds, m.kind
    from public.media_transcripts t
    join public.media_objects m on m.id = t.media_id
   where t.id = v_id;
end $$;

revoke all on function public.rescript_claim_transcription(uuid, integer, integer) from public, anon, authenticated;

/*
 * Every object a survey owns, in one query, so the delete paths can be
 * complete for all three buckets instead of the one that happened to be
 * reachable through `responses.session_id`.
 */
create or replace function public.rescript_media_for_survey(p_survey uuid)
returns table (id uuid, bucket text, path text)
language sql
security definer
set search_path = public, pg_temp
as $$
  select m.id, m.bucket, m.path from public.media_objects m where m.survey_id = p_survey;
$$;

revoke all on function public.rescript_media_for_survey(uuid) from public, anon, authenticated;

/* ------------------------------------------------------------ RLS */

/*
 * The 0026 posture: these are reached through the service role and nothing
 * else. Said out loud so the absence of a policy is never read as an
 * oversight — a respondent's transcript is the most sensitive text this
 * platform stores.
 */
alter table public.media_objects     enable row level security;
alter table public.media_transcripts enable row level security;

drop policy if exists media_objects_service_role_only on public.media_objects;
create policy media_objects_service_role_only on public.media_objects
  as permissive for all to public using (false) with check (false);

drop policy if exists media_transcripts_service_role_only on public.media_transcripts;
create policy media_transcripts_service_role_only on public.media_transcripts
  as permissive for all to public using (false) with check (false);

comment on table public.media_objects is
  'Inventory of every object in storage, keyed to the survey that owns it. The definition and answer blobs keep their own url/path; this is what makes an object findable and deletable.';
comment on table public.media_transcripts is
  'One transcription job per recording. Durable so a serverless timeout is recoverable and a failure can be retried from the stored audio.';
