-- 0039_media_cloudflare_first.sql
--
-- CLOUDFLARE FIRST FOR SURVEY MEDIA, WITHOUT MOVING A BYTE.
--
-- Every recording, upload and asset the Studio and the survey runtime store
-- from here on goes to Cloudflare R2 through `@rescript/storage`, uploaded by
-- the browser directly and downloaded through a short-lived signed URL the
-- application redirects to after checking who is asking. Nothing held in
-- Supabase Storage today is moved: each row now says WHICH store holds it, so
-- a read, a delete or a download URL goes to the right one, and the one-year
-- and five-year URLs already embedded in definitions and answers keep working
-- because the objects they name are exactly where they were.
--
-- ## What is added
--
-- `storage_provider` — "supabase" for every existing row (the default is the
-- migration's statement of fact), "cloudflare-r2" for new ones.
--
-- `multipart_upload_id` — a large object is cut into 8 MB parts and each part
-- is sent the moment it is complete; an interrupted upload resumes from the
-- parts the store already has. The id is what a resume asks about, and it is
-- cleared when the object is assembled.
--
-- `client_token` — the browser's name for one take, so a double-click, a
-- re-sent request after a timeout that actually succeeded, or a browser
-- refresh mid-upload finds the SAME row and the same upload rather than
-- starting a second one and paying for both. Unique per survey among rows
-- that are not failed.
--
-- `survey_asset` — a new kind: images, PDFs and documents a researcher
-- attaches to a question. They were pasted URLs before; they are stored
-- objects now, under the same lifecycle as everything else.
--
-- `media_deletions` — what the sweeps and the purges removed, and whether a
-- HEAD afterwards confirmed the object gone. A delete that returned 200 is a
-- claim; the row here records the check.
--
-- `rescript_claim_transcription` returns `storage_provider` so the runner
-- reads the clip from the store that holds it.
--
-- Additive; nothing existing changes meaning.

begin;

alter table public.media_objects
  add column if not exists storage_provider text not null default 'supabase',
  add column if not exists multipart_upload_id text,
  add column if not exists client_token text;

comment on column public.media_objects.storage_provider is
  'Which object store holds the bytes: supabase (everything before 0039) or cloudflare-r2. Reads, deletes and download URLs dispatch on it.';
comment on column public.media_objects.multipart_upload_id is
  'Set while a multipart upload is in flight so an interrupted one can resume from the parts the store has. Cleared on completion.';
comment on column public.media_objects.client_token is
  'The browser''s name for one take. A repeated begin with the same token finds this row instead of opening a second upload.';

create unique index if not exists media_objects_client_token_idx
  on public.media_objects (survey_id, client_token)
  where client_token is not null and status <> 'failed';

alter table public.media_objects drop constraint if exists media_objects_kind_check;
alter table public.media_objects
  add constraint media_objects_kind_check check (kind in (
    'question_video', 'question_audio', 'answer_audio', 'answer_upload', 'localization_audio', 'survey_asset'
  ));

/* ---------------------------------------------------------------- deletions */

create table if not exists public.media_deletions (
  id bigint generated always as identity primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  survey_id uuid,
  media_id uuid,
  storage_provider text not null,
  bucket text not null,
  path text not null,
  kind text,
  bytes bigint,
  /* retention | purge_survey | purge_question | purge_session | abandoned | replaced | delivered | removed */
  reason text not null,
  deleted_at timestamptz not null default now(),
  /* true: a HEAD afterwards found nothing. false: it was still there. */
  verified boolean not null default false,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists media_deletions_customer_idx on public.media_deletions (customer_id, deleted_at desc);
create index if not exists media_deletions_survey_idx on public.media_deletions (survey_id) where survey_id is not null;
alter table public.media_deletions enable row level security;

comment on table public.media_deletions is
  'Every object the media sweeps and purges removed, with the verification. The audit trail a deletion never had.';

/* --------------------------------------------------------- claim, with store */

drop function if exists public.rescript_claim_transcription(uuid, integer, integer);
create or replace function public.rescript_claim_transcription(
  p_media uuid,
  p_stale_seconds integer default 180,
  p_max_attempts integer default 3
) returns table (
  id uuid, media_id uuid, survey_id uuid, status text, attempts integer,
  bucket text, path text, mime_type text, duration_seconds numeric, kind text,
  storage_provider text, bytes bigint
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
         m.bucket, m.path, m.mime_type, m.duration_seconds, m.kind,
         m.storage_provider, m.bytes
    from public.media_transcripts t
    join public.media_objects m on m.id = t.media_id
   where t.id = v_id;
end $$;

revoke all on function public.rescript_claim_transcription(uuid, integer, integer) from public, anon, authenticated;

/* ------------------------------------------ expiry retries what did not go */

/*
 * A delivery whose link has expired but whose objects are still in storage —
 * a store that was down, a delete that did not verify — used to be marked
 * `deleted` regardless. It now stays `expired` until every object is
 * confirmed gone, and this function offers it to the sweep again. Deleted
 * means deleted.
 */
create or replace function public.rescript_media_deliveries_expiring(p_limit integer default 50)
returns table (id uuid, survey_id uuid, status text, manifest jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select d.id, d.survey_id, d.status, d.manifest
  from public.media_deliveries d
  where d.expires_at is not null
    and d.expires_at <= now()
    and d.deleted_at is null
    and d.status in ('sent', 'downloaded', 'expired')
  order by d.expires_at
  limit greatest(p_limit, 1);
$$;
revoke all on function public.rescript_media_deliveries_expiring(integer) from public, anon, authenticated;

commit;
