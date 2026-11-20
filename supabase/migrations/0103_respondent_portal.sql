-- 0103 — THE RESPONDENT PORTAL: ACCOUNTS, CREDENTIALS, SESSIONS (Respondent Intelligence Engine, phase 1, 2026-11-20).
--
-- A respondent has been one row per survey (public.respondents) with a link token and nothing else: no account, no
-- password, no session. This adds the PERSON above those rows, without changing them:
--
--   portal_accounts      the person: a respondent id (RSP-XXXXXXXX), optional email and name, persistent or
--                        assessment-only, invited / active / suspended / closed, an optional expiry
--   portal_credentials   the password (scrypt hash only), lockout counter, invitation and reset tokens (SHA-256 only)
--   portal_sessions      signed-in sessions (token SHA-256 only), last seen, revoked
--   portal_events        who signed in, opened or changed what, and when — the access log
--   respondents.*        account_id (which person this enrolment belongs to), the access window, attempts, and the
--                        researcher's suspend / lock / reopen switches for this one enrolment
--
-- An account is PLATFORM data, like a staff profile: one identity, wherever the client's own data lives. It holds no
-- answers and names no survey. What a workspace can see of a person is exactly the enrolments in its own surveys
-- (respondents rows, client data) — an account by itself reveals nothing to another workspace.
--
-- All additive. Existing links, lists and tokens are untouched; every new respondents column is null / false, which
-- is "as before". Service role only: row-level security on, no policy.

create table if not exists public.portal_accounts (
  id uuid primary key default gen_random_uuid(),
  respondent_id text not null unique check (respondent_id ~ '^RSP-[0-9A-HJKMNP-TV-Z]{8}$'),
  email text check (email is null or (email = lower(email) and char_length(email) <= 254)),
  name text check (name is null or char_length(name) <= 200),
  scope text not null default 'persistent' check (scope in ('persistent', 'assessment')),
  status text not null default 'invited' check (status in ('invited', 'active', 'suspended', 'closed')),
  expires_at timestamptz,
  locale text check (locale is null or char_length(locale) <= 20),
  created_by uuid references public.profiles(id) on delete set null,
  created_customer_id uuid references public.customers(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);
-- one persistent account per email address; an assessment-only account never claims the address
create unique index if not exists portal_accounts_email_idx on public.portal_accounts (email) where email is not null and scope = 'persistent';

create table if not exists public.portal_credentials (
  account_id uuid primary key references public.portal_accounts(id) on delete cascade,
  password_hash text check (password_hash is null or password_hash like 'scrypt$%'),
  must_change boolean not null default false,
  password_changed_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  last_failed_at timestamptz,
  invite_token_hash text unique check (invite_token_hash is null or char_length(invite_token_hash) = 64),
  invite_expires_at timestamptz,
  reset_token_hash text unique check (reset_token_hash is null or char_length(reset_token_hash) = 64),
  reset_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.portal_accounts(id) on delete cascade,
  token_hash text not null unique check (char_length(token_hash) = 64),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text,
  device_label text check (device_label is null or char_length(device_label) <= 120),
  ip_hash text check (ip_hash is null or char_length(ip_hash) <= 64)
);
create index if not exists portal_sessions_account_idx on public.portal_sessions (account_id) where revoked_at is null;

create table if not exists public.portal_events (
  id bigint generated always as identity primary key,
  account_id uuid references public.portal_accounts(id) on delete cascade,
  event text not null check (char_length(event) between 1 and 60),
  survey_id uuid,
  customer_id uuid,
  -- who did it when it was not the respondent: a staff profile id
  actor_user_id uuid,
  detail jsonb not null default '{}'::jsonb check (pg_column_size(detail) <= 8192),
  ip_hash text check (ip_hash is null or char_length(ip_hash) <= 64),
  created_at timestamptz not null default now()
);
create index if not exists portal_events_account_idx on public.portal_events (account_id, created_at desc);
create index if not exists portal_events_survey_idx on public.portal_events (survey_id, created_at desc) where survey_id is not null;

alter table public.portal_accounts enable row level security;
alter table public.portal_credentials enable row level security;
alter table public.portal_sessions enable row level security;
alter table public.portal_events enable row level security;
revoke all on public.portal_accounts, public.portal_credentials, public.portal_sessions, public.portal_events from anon, authenticated;

comment on table public.portal_accounts is 'Respondent portal: the person (platform data). No answers, no survey; enrolments are respondents.account_id.';
comment on table public.portal_credentials is 'Respondent portal: scrypt password hash, lockout, invitation and reset token hashes. Never a readable secret.';
comment on table public.portal_sessions is 'Respondent portal: signed-in sessions, token stored as SHA-256 only.';
comment on table public.portal_events is 'Respondent portal: access log — sign-ins, views, edits, researcher actions.';

-- ------------------------------------------------------------------ the enrolment (one person in one survey)
alter table public.respondents
  add column if not exists account_id uuid,
  add column if not exists access_from timestamptz,
  add column if not exists access_until timestamptz,
  add column if not exists max_attempts integer check (max_attempts is null or max_attempts between 1 and 1000),
  add column if not exists portal_suspended boolean not null default false,
  add column if not exists portal_locked_at timestamptz,
  add column if not exists portal_reopened_until timestamptz;
-- no foreign key: the account is platform data and this row may live in a client's own database (docs/TENANCY)
create index if not exists respondents_account_idx on public.respondents (account_id) where account_id is not null;
create unique index if not exists respondents_account_survey_idx on public.respondents (survey_id, account_id, is_test) where account_id is not null;

comment on column public.respondents.account_id is 'The portal account (public.portal_accounts.id, in the platform database) this enrolment belongs to; null = a link-only respondent, as before.';

-- ------------------------------------------------------------------ a respondent changing their own answer
-- The same atomic write as rescript_update_response (0006) — revision check, new answers, one response_edits row —
-- but it leaves `source` alone (the row is still the respondent's own interview, not a researcher's manual edit)
-- and refuses a row that is not a completed, undeleted interview.
create or replace function public.rescript_portal_edit_response(
  p_id uuid,
  p_expected_revision integer,
  p_answers jsonb,
  p_calculated jsonb,
  p_changes jsonb,
  p_by text
) returns table (new_revision integer, new_updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare cur integer; sid uuid; code text; st text; newrev integer; newat timestamptz;
begin
  select r.revision, r.survey_id, r.respondent_code, r.status into cur, sid, code, st
    from public.responses r where r.id = p_id and r.deleted_at is null for update;
  if not found then raise exception 'RESPONSE_NOT_FOUND'; end if;
  if st <> 'complete' then raise exception 'RESPONSE_NOT_COMPLETE'; end if;
  if p_expected_revision is null or cur <> p_expected_revision then
    raise exception 'REVISION_CONFLICT expected % but the row is at %', p_expected_revision, cur;
  end if;
  update public.responses
     set answers = p_answers,
         calculated = coalesce(p_calculated, public.responses.calculated)
   where id = p_id
   returning public.responses.revision, public.responses.updated_at into newrev, newat;
  insert into public.response_edits (response_id, survey_id, respondent_code, action, changes, reason, edited_by, revision_before, revision_after)
  values (p_id, sid, code, 'edit', p_changes, 'changed by the respondent in the portal', p_by, cur, newrev);
  return query select newrev, newat;
end $$;
revoke all on function public.rescript_portal_edit_response(uuid, integer, jsonb, jsonb, jsonb, text) from public, anon, authenticated;

-- ------------------------------------------------------------------ mail kinds for the portal
do $$
declare
  def text;
  kinds text[];
begin
  if to_regclass('public.mail_deliveries') is null then return; end if;
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c where c.conrelid = 'public.mail_deliveries'::regclass and c.conname = 'mail_deliveries_kind_check';
  select array_agg(distinct k order by k) into kinds from (
    select (regexp_matches(coalesce(def, ''), '''([a-z_]+)''', 'g'))[1] as k
    union select trim(x) from unnest(string_to_array(coalesce(substring(def from '\{([^}]*)\}'), ''), ',')) as x
    union select distinct kind from public.mail_deliveries
    union select unnest(array['portal_invitation', 'portal_reset'])
  ) x where k is not null and k <> '';
  execute 'alter table public.mail_deliveries drop constraint if exists mail_deliveries_kind_check';
  execute format('alter table public.mail_deliveries add constraint mail_deliveries_kind_check check (kind = any (%L::text[]))', kinds);
end $$;

insert into public.schema_marks (migration, note) values ('0103', 'respondent portal: accounts, credentials, sessions, events; respondents.account_id and access columns; portal edit function')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
