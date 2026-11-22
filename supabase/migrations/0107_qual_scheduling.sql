-- 0107 — SCHEDULING AND RECRUITING FOR INTERVIEWS AND GROUPS (Level 5 roadmap Q6, 2026-11-29)
--
--   qual_slots      bookable times for a study: start, end, capacity (1 for an interview, n for a group), moderator
--   qual_bookings   one row per invitee: who (a respondent of the survey's list, a sample-exchange identity or an
--                   email typed in), the invitation token's HASH (the token itself is only ever in the email), the
--                   slot they picked, the status (invited → booked → attended / no_show; cancelled; late_cancel),
--                   the reminders already sent, and the incentive settled
--
-- Additive. Service role only: row-level security on, no policy (the Studio and the public booking route read and
-- write through the service client after their own checks). Rules: packages/interviews/src/scheduling.ts.
--
-- Rollback:
--   drop table if exists public.qual_bookings, public.qual_slots;

create table if not exists public.qual_slots (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity integer not null default 1 check (capacity between 1 and 30),
  moderator text check (moderator is null or char_length(moderator) <= 200),
  status text not null default 'open' check (status in ('open', 'cancelled')),
  session_id uuid references public.qual_sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists qual_slots_survey_idx on public.qual_slots (survey_id, starts_at);
alter table public.qual_slots enable row level security;

create table if not exists public.qual_bookings (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  slot_id uuid references public.qual_slots(id) on delete set null,
  respondent_id uuid references public.respondents(id) on delete set null,
  source text not null default 'list' check (source in ('list', 'exchange', 'manual')),
  email text check (email is null or char_length(email) <= 320),
  name text check (name is null or char_length(name) <= 200),
  token_hash text not null unique check (char_length(token_hash) = 64),
  status text not null default 'invited' check (status in ('invited', 'booked', 'cancelled', 'late_cancel', 'attended', 'no_show')),
  invited_at timestamptz not null default now(),
  booked_at timestamptz,
  cancelled_at timestamptz,
  reminders_sent text[] not null default '{}',
  incentive jsonb,
  updated_at timestamptz not null default now()
);
create index if not exists qual_bookings_survey_idx on public.qual_bookings (survey_id, status);
create index if not exists qual_bookings_slot_idx on public.qual_bookings (slot_id) where slot_id is not null;
alter table public.qual_bookings enable row level security;

comment on table public.qual_slots is 'Bookable interview / group times (0107).';
comment on table public.qual_bookings is 'Interview invitations and bookings (0107). The invitation token is stored as its SHA-256 hash only.';

-- ------------------------------------------------------------------ the mail kinds for interview invitations and reminders
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
    union select 'interview_invitation'
    union select 'interview_reminder'
  ) x where k is not null and k <> '';
  execute 'alter table public.mail_deliveries drop constraint if exists mail_deliveries_kind_check';
  execute format('alter table public.mail_deliveries add constraint mail_deliveries_kind_check check (kind = any (%L::text[]))', kinds);
end $$;

insert into public.schema_marks (migration, note) values ('0107', 'interview scheduling: slots, bookings; mail kinds interview_invitation, interview_reminder')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
