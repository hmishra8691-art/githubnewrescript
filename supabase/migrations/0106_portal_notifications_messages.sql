-- 0106 — THE RESPONDENT PORTAL: NOTIFICATIONS AND MESSAGES (Respondent Intelligence Engine, phase 6, 2026-11-20).
--
--   portal_notifications   what a person is told in their portal: an assessment is due, one is about to close, a
--                          privacy request was answered, the organiser wrote. `dedupe` makes each one happen once
--                          (a reminder job that runs twice tells the person once). `emailed_at` is when the same
--                          notice also went by email. A notice says THAT something happened and names the
--                          assessment; it never carries an answer or a score.
--   portal_messages        the conversation between one respondent and the organiser of one assessment.
--
-- Both are PLATFORM data, beside the account (0103). A workspace reads and writes only the messages of its own
-- surveys. Additive. Service role only: row-level security on, no policy.

create table if not exists public.portal_notifications (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.portal_accounts(id) on delete cascade,
  kind text not null check (kind in ('due', 'closing', 'request_answered', 'message')),
  title text not null check (char_length(title) between 1 and 200),
  body text check (body is null or char_length(body) <= 1000),
  -- no foreign keys: the survey and the enrolment are client data and may live in a client's own database
  survey_id uuid,
  enrolment_id uuid,
  dedupe text not null check (char_length(dedupe) between 1 and 200),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  emailed_at timestamptz,
  unique (account_id, dedupe)
);
create index if not exists portal_notifications_account_idx on public.portal_notifications (account_id, created_at desc);
alter table public.portal_notifications enable row level security;

create table if not exists public.portal_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.portal_accounts(id) on delete cascade,
  survey_id uuid not null,
  customer_id uuid,
  enrolment_id uuid not null,
  from_staff boolean not null default false,
  staff_user_id uuid,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  read_by_respondent_at timestamptz,
  read_by_staff_at timestamptz,
  check (from_staff or staff_user_id is null)
);
create index if not exists portal_messages_thread_idx on public.portal_messages (survey_id, enrolment_id, created_at);
create index if not exists portal_messages_account_idx on public.portal_messages (account_id, created_at desc);
alter table public.portal_messages enable row level security;

revoke all on public.portal_notifications, public.portal_messages from anon, authenticated;

-- ------------------------------------------------------------------ the mail kind for a portal notice
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
    union select 'portal_notice'
  ) x where k is not null and k <> '';
  execute 'alter table public.mail_deliveries drop constraint if exists mail_deliveries_kind_check';
  execute format('alter table public.mail_deliveries add constraint mail_deliveries_kind_check check (kind = any (%L::text[]))', kinds);
end $$;

insert into public.schema_marks (migration, note) values ('0106', 'respondent portal: notifications and messages; mail kind portal_notice')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
