-- ============================================================================
-- QUALITATIVE MEDIA DELIVERY
--
-- A researcher needs the original recording; the platform should not keep it
-- forever. This is the whole feature in one sentence, and the schema below is
-- what makes the second half of it true rather than aspirational.
--
-- ## What is temporary and what is not
--
-- ONLY the bytes are temporary. After 48 hours the storage object and its
-- `media_objects` row are gone, and everything that makes the response a
-- research datum stays exactly where it was:
--
--   · the transcript, which by 0028 is the ANSWER VALUE inside
--     `responses.answers`, not a pointer to a recording;
--   · the response row, its status, its quality scores, its telemetry;
--   · the respondent, the project, the quotas, the exports.
--
-- That ordering is why this can be a retention policy rather than a data
-- loss: the recording is the evidence, the transcript is the datum, and the
-- datum was extracted before the evidence expired.
--
-- ## Why the delivery row outlives the media
--
-- `media_deliveries` keeps a `manifest` — what was in the package, under what
-- filenames, from which questions — and keeps it after the bytes are deleted.
-- Without that, "deleted at 14:02" is a timestamp attached to nothing, and a
-- researcher asking "what was in the email you sent me on Tuesday?" has no
-- answer. The manifest is metadata only: names, sizes, ids. No bytes, no
-- transcript text, nothing that would make this row a second copy of the
-- response.
--
-- ## Why the token is stored as a hash
--
-- The download link is a bearer credential, exactly like a password reset
-- link, and 0016 already established the rule for those: store the SHA-256,
-- never the token. A leaked database backup then yields no working links.
-- ============================================================================

-- ----------------------------------------------------------------- settings
--
-- Project-level, because a project is a piece of fieldwork with one research
-- team behind it. Two columns rather than one: an address that is present but
-- switched off is a real state — fieldwork paused, or the address kept for
-- the next wave — and `null` cannot express it.

alter table public.surveys
  add column if not exists media_delivery_email text,
  add column if not exists media_delivery_enabled boolean not null default false;

comment on column public.surveys.media_delivery_email is
  'Where qualitative audio/video is delivered. Never exposed to respondents.';
comment on column public.surveys.media_delivery_enabled is
  'Delivery runs only when this is true AND media_delivery_email is set.';

/*
 * Delivery cannot be switched on without somewhere to deliver to. Enforced
 * here rather than only in the form, because the cron reads this table and a
 * half-configured project would otherwise mean a job that can never succeed
 * and retries until it gives up.
 */
alter table public.surveys
  drop constraint if exists surveys_media_delivery_needs_email;
alter table public.surveys
  add constraint surveys_media_delivery_needs_email
  check (media_delivery_enabled = false or media_delivery_email is not null);

-- --------------------------------------------------------------- deliveries

create table if not exists public.media_deliveries (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  /*
   * The response is the unit of delivery — one respondent's sitting, however
   * many recordings it produced. ON DELETE CASCADE so that purging a response
   * takes its delivery record with it; a delivery for a response that no
   * longer exists is a row nobody can interpret.
   */
  response_id uuid not null references public.responses(id) on delete cascade,
  session_id text not null,
  respondent_label text,

  recipient_email text not null,

  /*
   * pending      discovered, nothing sent yet
   * processing   claimed by a run; the package is being built
   * sent         the email is out and the link is live
   * downloaded   the researcher opened it at least once
   * expired      past 48 hours; the link no longer works
   * deleted      the bytes are gone
   * failed       delivery gave up after `attempts`
   *
   * `expired` and `deleted` are separate because they are separate events and
   * can be separated in time by a failed storage call: the link must stop
   * working the moment it expires, whether or not the delete succeeded.
   */
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'downloaded', 'expired', 'deleted', 'failed')),

  media_count integer not null default 0,
  total_bytes bigint not null default 0,
  /* [{ mediaId, bucket, path, fileName, kind, bytes, questionId, questionCode, answerKey }] */
  manifest jsonb not null default '[]'::jsonb,

  token_hash text,
  expires_at timestamptz,

  attempts integer not null default 0,
  /*
   * WHEN THIS MAY BE TRIED AGAIN — an explicit instant, not arithmetic on
   * `updated_at`.
   *
   * The obvious backoff is "updated_at + a growing delay", and it is wrong
   * here: `media_deliveries_touch` sets `updated_at` on EVERY update, so any
   * write to the row for any reason — a status correction, a column added
   * later — silently restarts the wait. A delivery whose address bounces
   * would then be retried forever by whatever else happened to touch it.
   * The failure decides when the next attempt is due, and says so.
   */
  retry_after timestamptz,
  error text,
  provider_id text,

  claimed_at timestamptz,
  email_sent_at timestamptz,
  downloaded_at timestamptz,
  download_count integer not null default 0,
  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

/*
 * One delivery per response. The discovery query is a left join against this
 * uniqueness, so it is what stops a second cron run from emailing the same
 * recordings twice — the same job the partial unique index on
 * `mail_deliveries.dedupe_key` does for mail, one layer lower.
 */
create unique index if not exists media_deliveries_response_key
  on public.media_deliveries (response_id);

/* the work queue: what a run has to look at, cheapest first */
create index if not exists media_deliveries_due_idx
  on public.media_deliveries (status, created_at)
  where status in ('pending', 'processing', 'failed');

/* and the ones whose backoff has elapsed */
create index if not exists media_deliveries_retry_idx
  on public.media_deliveries (retry_after)
  where status = 'failed';

/* what has to expire, and when */
create index if not exists media_deliveries_expiry_idx
  on public.media_deliveries (expires_at)
  where status in ('sent', 'downloaded');

/* the Studio's own list */
create index if not exists media_deliveries_survey_idx
  on public.media_deliveries (survey_id, created_at desc);

/* the download route's only lookup */
create index if not exists media_deliveries_token_idx
  on public.media_deliveries (token_hash)
  where token_hash is not null;

drop trigger if exists media_deliveries_touch on public.media_deliveries;
create trigger media_deliveries_touch
  before update on public.media_deliveries
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------------- RLS
--
-- Deny-all, like `media_objects` and `media_transcripts` before it. Every
-- reader goes through the service role: the cron, the download route, and the
-- Studio's status list, each of which does its own authorization first. A row
-- here names a recipient address and carries a token hash, and neither
-- belongs in reach of the anon key.

alter table public.media_deliveries enable row level security;

drop policy if exists media_deliveries_service_role_only on public.media_deliveries;
create policy media_deliveries_service_role_only
  on public.media_deliveries as permissive for all to public
  using (false) with check (false);

revoke all on public.media_deliveries from public, anon, authenticated;

-- ------------------------------------------------------------------- mail
--
-- `mail_deliveries.kind` is a CHECK, so a new kind of mail has to be declared
-- before it can be logged. Without this the send succeeds and the log insert
-- fails, which is the worst of both: the researcher has the email and we have
-- no record that we sent it.

alter table public.mail_deliveries
  drop constraint if exists mail_deliveries_kind_check;
alter table public.mail_deliveries
  add constraint mail_deliveries_kind_check
  check (kind in (
    'password_reset', 'project_invitation', 'respondent_invitation', 'test',
    'media_delivery'
  ));

-- -------------------------------------------------------------- discovery
--
-- DISCOVERY, NOT ENQUEUEING.
--
-- The obvious design writes a `media_deliveries` row from the route that
-- finalises a response. This does not, and the reason is the respondent: that
-- route is the last thing standing between someone and a finished survey, and
-- an insert that fails there either loses the delivery silently or fails a
-- submission over an email. Discovery also heals — a response completed
-- before this feature existed, or while the cron was down, is found on the
-- next run rather than lost forever.
--
-- The window is deliberate. A response that completed a week ago and has no
-- delivery row is not a backlog, it is history; re-emailing it would be a
-- surprise, and its media is past any retention we would have given it.

create or replace function public.rescript_media_deliveries_due(
  p_limit integer default 25,
  p_window_hours integer default 48
)
returns table (
  response_id uuid,
  survey_id uuid,
  customer_id uuid,
  session_id text,
  respondent_label text,
  recipient_email text,
  media_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    r.id, r.survey_id, s.customer_id, r.session_id,
    coalesce(r.respondent_code, left(r.session_id, 8)),
    s.media_delivery_email,
    count(m.id)
  from public.responses r
  join public.surveys s on s.id = r.survey_id
  join public.media_objects m
    on m.session_id = r.session_id
   and m.status = 'stored'
   and m.kind in ('answer_audio', 'answer_upload')
  where r.status = 'complete'
    and r.deleted_at is null
    and r.is_test = false
    and r.completed_at is not null
    and r.completed_at > now() - make_interval(hours => p_window_hours)
    and s.media_delivery_enabled = true
    and s.media_delivery_email is not null
    and not exists (
      select 1 from public.media_deliveries d where d.response_id = r.id
    )
  group by r.id, r.survey_id, s.customer_id, r.session_id, r.respondent_code, s.media_delivery_email
  order by max(r.completed_at)
  limit greatest(p_limit, 1);
$$;

comment on function public.rescript_media_deliveries_due(integer, integer) is
  'Completed live responses with stored respondent media, a configured delivery address, and no delivery row yet.';

-- ------------------------------------------------------------------- claim
--
-- The same `for update skip locked` shape as `rescript_claim_transcription`,
-- and for the same reason: two overlapping cron runs are normal — a slow run
-- and its successor — and without this they would both build the package and
-- both send the email.
--
-- A `failed` row is reclaimable so that retries happen by themselves, but
-- only after a backoff that grows with `attempts`, so a project whose address
-- bounces is retried a few times over a few hours rather than every ten
-- minutes for two days.

create or replace function public.rescript_claim_media_delivery(
  p_id uuid,
  p_stale_seconds integer default 300,
  p_max_attempts integer default 5
)
returns table (
  id uuid,
  customer_id uuid,
  survey_id uuid,
  response_id uuid,
  session_id text,
  respondent_label text,
  recipient_email text,
  status text,
  attempts integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.media_deliveries%rowtype;
begin
  select * into v_row
  from public.media_deliveries d
  where d.id = p_id
    and d.attempts < p_max_attempts
    and (
      d.status = 'pending'
      or (d.status = 'failed' and (d.retry_after is null or d.retry_after <= now()))
      or (d.status = 'processing'
          and d.claimed_at is not null
          and d.claimed_at < now() - make_interval(secs => greatest(p_stale_seconds, 30)))
    )
  for update skip locked;

  if not found then
    return;
  end if;

  update public.media_deliveries d
  set status = 'processing',
      claimed_at = now(),
      attempts = d.attempts + 1
  where d.id = v_row.id;

  return query
  select v_row.id, v_row.customer_id, v_row.survey_id, v_row.response_id,
         v_row.session_id, v_row.respondent_label, v_row.recipient_email,
         'processing'::text, v_row.attempts + 1;
end;
$$;

-- ------------------------------------------------------------------ expiry
--
-- Everything past its 48 hours, whether or not anyone downloaded it. Not
-- downloading is not a reason to keep a recording longer; it is the ordinary
-- case, and the retention promise made in the email has to hold either way.

create or replace function public.rescript_media_deliveries_expiring(
  p_limit integer default 50
)
returns table (
  id uuid,
  survey_id uuid,
  status text,
  manifest jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.survey_id, d.status, d.manifest
  from public.media_deliveries d
  where d.expires_at is not null
    and d.expires_at <= now()
    and d.status in ('sent', 'downloaded')
  order by d.expires_at
  limit greatest(p_limit, 1);
$$;

-- ------------------------------------------------------------- the summary
--
-- What the Studio shows. A view rather than a select in the route, so the
-- status list and any future report agree about what "delivered" counts as.

create or replace function public.rescript_media_delivery_status(p_survey uuid)
returns table (
  id uuid,
  response_id uuid,
  session_id text,
  respondent_label text,
  recipient_email text,
  status text,
  media_count integer,
  total_bytes bigint,
  attempts integer,
  error text,
  email_sent_at timestamptz,
  downloaded_at timestamptz,
  download_count integer,
  expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select d.id, d.response_id, d.session_id, d.respondent_label, d.recipient_email,
         d.status, d.media_count, d.total_bytes, d.attempts, d.error,
         d.email_sent_at, d.downloaded_at, d.download_count,
         d.expires_at, d.deleted_at, d.created_at
  from public.media_deliveries d
  where d.survey_id = p_survey
  order by d.created_at desc
  limit 200;
$$;

-- ----------------------------------------------------------- least privilege
--
-- 0026's rule: a SECURITY DEFINER function is not granted to anyone until
-- there is a reason. Every one of these is called by the service role, which
-- bypasses grants, so nothing is granted at all.

revoke all on function public.rescript_media_deliveries_due(integer, integer) from public, anon, authenticated;
revoke all on function public.rescript_claim_media_delivery(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.rescript_media_deliveries_expiring(integer) from public, anon, authenticated;
revoke all on function public.rescript_media_delivery_status(uuid) from public, anon, authenticated;
