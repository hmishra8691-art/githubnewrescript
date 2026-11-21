-- 0105 — THE RESPONDENT PORTAL: CONSENT AND PRIVACY REQUESTS (Respondent Intelligence Engine, phase 5, 2026-11-20).
--
--   portal_consents   which version of the portal notice a person agreed to, when, and when they withdrew it.
--                     One row per (account, version). The text of each version is in the code
--                     (@rescript/access PORTAL_CONSENT), so a row always points at words that can be shown again.
--   portal_requests   a person's request to an organiser about ONE assessment: a copy of their data, a correction,
--                     or deletion — and what the organiser answered. Recording the answer does not itself change
--                     or delete data; the organiser does that with the existing tools and then marks the request.
--
-- Both are PLATFORM data, beside the account they belong to (0103). A workspace reads the requests addressed to
-- its own surveys and nothing else. Additive. Service role only: row-level security on, no policy.

create table if not exists public.portal_consents (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.portal_accounts(id) on delete cascade,
  version text not null check (char_length(version) between 1 and 40),
  given_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  ip_hash text check (ip_hash is null or char_length(ip_hash) <= 64),
  unique (account_id, version)
);
alter table public.portal_consents enable row level security;

create table if not exists public.portal_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.portal_accounts(id) on delete cascade,
  -- no foreign keys below: the survey and the enrolment are client data and may live in a client's own database
  survey_id uuid not null,
  customer_id uuid,
  enrolment_id uuid not null,
  kind text not null check (kind in ('access', 'correction', 'deletion')),
  status text not null default 'open' check (status in ('open', 'done', 'declined')),
  message text check (message is null or char_length(message) <= 2000),
  response_note text check (response_note is null or char_length(response_note) <= 2000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  check ((status = 'open') = (resolved_at is null))
);
create index if not exists portal_requests_account_idx on public.portal_requests (account_id, created_at desc);
create index if not exists portal_requests_survey_idx on public.portal_requests (survey_id, status, created_at desc);
alter table public.portal_requests enable row level security;

revoke all on public.portal_consents, public.portal_requests from anon, authenticated;

insert into public.schema_marks (migration, note) values ('0105', 'respondent portal: consent records and privacy requests')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
