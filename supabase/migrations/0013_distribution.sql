-- =====================================================================
-- 0013 — DISTRIBUTION (§24)
--
-- `public.respondents` has existed since the first migration and no screen
-- has ever written to it. The runtime reads it — `access.mode` of
-- `unique_links` or `invitation` looks a token up here — so those two access
-- modes have been selectable, and unusable, since the beginning: the Studio
-- says so itself, in a warning chip that tells the programmer the live link
-- "will refuse everyone until tokens exist in the respondents table".
--
-- Making the table writable from a screen needs four things the schema did
-- not have. All four are additive; every existing column, default,
-- constraint and policy is untouched, and the token default stays exactly
-- where it is (in the database, where a secret belongs).
--
--   §24.1  an ENVIRONMENT, so a test list cannot answer a live link
--   §24.2  the fields a real list carries — a name, when it was sent, which
--          upload it came from
--   §24.3  the indexes the runtime's own lookup needs
--   §24.4  one query for the panel, instead of six counts
--
-- And one latent bug is closed: `responses`'s status vocabulary includes
-- `in_progress` and this table's CHECK did not, so the save route's
-- respondent update was one guard away from violating a constraint on every
-- partial interview.
-- =====================================================================

-- ---------------------------------------------------------------------
-- §24.1  Which environment a respondent belongs to
--
-- The platform's rule since 0006 is that an environment is never assumed:
-- test traffic and live traffic never share a counter, a quota or a report.
-- A respondent list is the same fact one step earlier. Without this column a
-- programmer testing a unique-link survey would burn tokens from the client's
-- real list — and, worse, the fieldwork report would count their test
-- interviews as delivered.
--
-- `false` for existing rows, which is right: the only rows that can exist
-- today are the runtime's throwaway test respondents (which carry
-- `meta.test`) and nothing else, and calling those live changes no number
-- anybody reads.
-- ---------------------------------------------------------------------
alter table public.respondents
  add column if not exists is_test boolean not null default false;

comment on column public.respondents.is_test is
  'Which environment this respondent belongs to. A test list can only be used by a test link, exactly as test responses can only fill test quotas (0006).';

-- ---------------------------------------------------------------------
-- §24.2  What a real respondent list carries
--
-- `name` because a distribution screen that can only show an email address
-- is unusable for a client list of 4 000 people, and because a resend has to
-- be addressed to somebody.
--
-- `list_name` groups one upload. A study is invited in waves — "wave 1",
-- "the reminder file", "the top-up from the client" — and every operational
-- question is asked per wave: who has not started, which wave is
-- underperforming, whose links have not gone out. Without it the only
-- available grouping is `invited_at`, which is a timestamp per row, not a
-- batch.
--
-- `sent_at` is the honest record of delivery, and it is deliberately
-- separate from `invited_at` (which the table has always set at insert):
-- uploading a list is not sending it. This platform cannot send email yet,
-- so this column is what a screen marks when the links leave by whatever
-- route the team actually used.
-- ---------------------------------------------------------------------
alter table public.respondents
  add column if not exists name text,
  add column if not exists list_name text,
  add column if not exists sent_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

comment on column public.respondents.list_name is
  'The upload or wave this respondent arrived in, so a study invited in several files can be reported and re-sent per file.';
comment on column public.respondents.sent_at is
  'When this respondent''s link was actually sent. Distinct from invited_at, which is when the row was created: uploading a list is not sending it.';

-- ---------------------------------------------------------------------
-- §24.3  The indexes the reads need
--
-- The runtime's token lookup is `survey_id = ? and token = ?` on every
-- single session of a unique-link survey, and the table had only the
-- table-wide unique on `token` — which serves it, but the panel's reads
-- (by survey, by status, by wave) had nothing at all.
--
-- The partial unique on `external_id` is the one real constraint added here.
-- `external_id` is the client's own key for a person, so two rows with the
-- same one means the same person was invited twice — two links, two possible
-- interviews, and a duplicate that is invisible in the data because it is
-- two different respondent ids. Rows without an external id are unaffected,
-- because a list identified only by email is a legitimate shape.
--
-- It is keyed on the ENVIRONMENT too, and that is not a detail: the most
-- natural way to test a unique-link survey is to upload a handful of rows
-- from the client's own file, and a constraint that spans environments would
-- refuse exactly that — while telling the programmer their client's list
-- contains duplicates.
-- ---------------------------------------------------------------------
create index if not exists respondents_survey_idx
  on public.respondents (survey_id, is_test, status);

create index if not exists respondents_survey_list_idx
  on public.respondents (survey_id, list_name);

create unique index if not exists respondents_survey_external_key
  on public.respondents (survey_id, is_test, lower(external_id))
  where external_id is not null;

-- ---------------------------------------------------------------------
-- The status vocabulary, aligned with responses
--
-- `responses.status` allows in_progress; this CHECK did not. `session/save`
-- copies the response's new status onto the respondent, and only a
-- `newStatus !== "in_progress"` guard one call earlier stood between that
-- and a constraint violation on every partially-completed interview. The
-- vocabularies should match, so they now do.
--
-- Widening a CHECK can never fail on existing rows: every value already
-- stored is still permitted.
-- ---------------------------------------------------------------------
alter table public.respondents drop constraint if exists respondents_status_check;
alter table public.respondents add constraint respondents_status_check
  check (status in ('invited', 'started', 'in_progress', 'complete', 'screened', 'quota_full', 'terminated'));

-- keep `updated_at` honest without asking every writer to remember
create or replace function public.rescript_touch_respondent()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists respondents_touch on public.respondents;
create trigger respondents_touch
  before update on public.respondents
  for each row execute function public.rescript_touch_respondent();

-- ---------------------------------------------------------------------
-- §24.4  The distribution panel's numbers, in one query
--
-- Per wave and per environment: how many were invited, how many links have
-- been sent, how many started, how many finished, and how many are still
-- sitting on an unused link. That last number is the one a distribution
-- screen exists for — it is the answer to "who do we chase".
--
-- `p_is_test` has no default, like every other per-environment function
-- here: an environment is never assumed.
-- ---------------------------------------------------------------------
create or replace function public.rescript_respondent_stats(
  p_survey uuid,
  p_is_test boolean
)
returns table (
  list_name text,
  total bigint,
  sent bigint,
  not_sent bigint,
  -- invited and never opened their link
  waiting bigint,
  started bigint,
  completed bigint,
  screened bigint,
  quota_full bigint,
  terminated bigint,
  first_invited timestamptz,
  last_invited timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(nullif(trim(r.list_name), ''), '(no list)') as list_name,
    count(*) as total,
    count(*) filter (where r.sent_at is not null) as sent,
    count(*) filter (where r.sent_at is null) as not_sent,
    count(*) filter (where r.status = 'invited') as waiting,
    count(*) filter (where r.status in ('started', 'in_progress')) as started,
    count(*) filter (where r.status = 'complete') as completed,
    count(*) filter (where r.status = 'screened') as screened,
    count(*) filter (where r.status = 'quota_full') as quota_full,
    count(*) filter (where r.status = 'terminated') as terminated,
    min(r.invited_at) as first_invited,
    max(r.invited_at) as last_invited
  from public.respondents r
  where r.survey_id = p_survey
    and r.is_test = p_is_test
  group by 1
  order by 1;
$$;

comment on function public.rescript_respondent_stats(uuid, boolean) is
  'Distribution progress for one survey and environment, grouped by upload/wave: invited, sent, still waiting on an unused link, started and finished.';

grant execute on function public.rescript_respondent_stats(uuid, boolean) to authenticated, service_role;
