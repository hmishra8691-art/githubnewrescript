-- 0101 — THE TENANT DIRECTORY (tenancy wiring, step 1, 2026-11-19).
--
-- When a big client is given a database of its own, a request still arrives with only a survey id, a session id, a
-- group join code, a media object id or a bearer link (an AI interview or live session; keyed by the token's SHA-256,
-- never the token). This table, in the PRIMARY database, says which client owns each such key, so
-- the apps can open the right database before reading anything (apps/*/lib/db.ts, @rescript/storage/directory).
--
-- Nothing reads or writes it while routing is inactive (today). Rows are written as keys are created once routing is
-- on, and the procedure that moves a client to its own database writes that client's rows first
-- (docs/TENANCY-2026-11-13.md, step 7). Platform data: service role only, row-level security on, no policy.
create table if not exists public.tenant_directory (
  kind text not null check (kind in ('survey', 'session', 'group', 'media', 'interview_project', 'ai_interview_study', 'ai_interview_session', 'live_invite', 'live_member')),
  key text not null check (char_length(key) between 1 and 200),
  customer_id uuid not null references public.customers(id) on delete cascade,
  survey_id uuid,
  created_at timestamptz not null default now(),
  primary key (kind, key)
);
create index if not exists tenant_directory_customer_idx on public.tenant_directory (customer_id);

alter table public.tenant_directory enable row level security;

comment on table public.tenant_directory is 'Tenancy: which client owns a survey, session, group code, media object or interview project — read before routing to a client database; service role only.';

insert into public.schema_marks (migration, note) values ('0101', 'tenant_directory: key → client, for routing to client databases')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
