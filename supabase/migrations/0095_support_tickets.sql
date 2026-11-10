-- 0095 — HELP ESCALATION TO A PERSON (2026-11-10).
--
-- When the Help assistant cannot resolve a problem — the user asks for a person, the problem survives two fixes, the
-- guides don't cover it — it offers to hand the case to the support team. A ticket carries everything the support
-- engineer needs so the user never has to explain it again:
--
--   transcript    the conversation (questions and answers, with the sources each answer used)
--   diagnostics   what the survey checks found (Level 2), verified from the survey definition
--   attempts      the steps already tried and the levels that tried them (guides, survey checks, AI)
--   context       where the user was: Studio tab, the survey's summary, the selected question
--
-- Nothing is sent without the user's confirmation, and the ticket shows them exactly what is shared. It is the user's
-- own: /api/help/escalate creates it for the caller (requireUser); platform administrators read and update tickets
-- through /api/admin/support (requireAdmin). Reached only through those routes (service role): no grants to anon or
-- authenticated.
--
-- help_messages.content also records how each answer was produced — `route` { level, reason, confidence, cached,
-- modelUsed } and the charge — which is what the Help usage report on the admin page aggregates. No column change.

begin;

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  user_id uuid not null,
  customer_id uuid,
  user_email text,
  survey_id uuid references public.surveys(id) on delete set null,
  conversation_id uuid references public.help_conversations(id) on delete set null,
  subject text not null,
  reason text,
  -- the user's own words about the problem, if they added any when escalating
  message text,
  transcript jsonb not null default '[]'::jsonb,
  diagnostics jsonb,
  attempts jsonb not null default '[]'::jsonb,
  context jsonb,
  status text not null default 'open',
  -- the support team's note, visible to administrators
  resolution text,
  emailed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint support_tickets_status check (status in ('open', 'in_progress', 'resolved', 'closed')),
  constraint support_tickets_subject check (length(subject) between 1 and 200),
  constraint support_tickets_size check (pg_column_size(transcript) <= 262144 and coalesce(pg_column_size(diagnostics), 0) <= 65536 and coalesce(pg_column_size(context), 0) <= 65536)
);
create index if not exists support_tickets_status_idx on public.support_tickets (status, created_at desc);
create index if not exists support_tickets_user_idx on public.support_tickets (user_id, created_at desc);

alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from anon, authenticated;

comment on table public.support_tickets is 'Help escalations to the support team: the conversation, diagnostics, steps tried and context. Created by /api/help/escalate for the caller; read and updated by platform administrators via /api/admin/support.';

-- the e-mail to the support address is logged in mail_deliveries like every other mail: widen the kind check by union.
-- The kinds already allowed are read from the current constraint in BOTH forms Postgres prints it in — an ARRAY of
-- quoted items (ARRAY['a'::text, …]) or one array literal ('{a,b}'::text[], which is what 0072's widening writes) —
-- and every kind already stored in the table is kept too, so no existing row can violate the new check.
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
    union select unnest(array['password_reset', 'project_invitation', 'respondent_invitation', 'test', 'media_delivery',
                              'alert', 'live_session_invite', 'live_session_reminder', 'support_escalation'])
  ) x where k is not null and k <> '';
  execute 'alter table public.mail_deliveries drop constraint if exists mail_deliveries_kind_check';
  execute format('alter table public.mail_deliveries add constraint mail_deliveries_kind_check check (kind = any (%L::text[]))', kinds);
end $$;

commit;
