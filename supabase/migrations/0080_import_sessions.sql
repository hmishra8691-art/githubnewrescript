-- 0080 — Import sessions: history, the source file for 90 days, rollback (2026-11-01, I4,
-- docs/IMPORT-V2-2026-11-01.md)
--
-- WHAT THIS ADDS — additive; no existing row or column is touched:
--
--   1. public.import_sessions — one row per import RUN (a QSF / Word / Excel / … file read, reconstructed and
--      previewed). It keeps what is needed to explain and undo the import:
--        * the file: name, format, size, fingerprint, and where its bytes are (bucket + key, never a URL) until
--          `source_expires_at` (created + 90 days); the weekly housekeeping removes the object and clears the key;
--        * the canonical survey the reader produced (`canonical`, bounded by the route) and a digest of the
--          report (mapping classes, graph findings, fidelity totals, script verdicts, summary sentences);
--        * the decisions a person made during the import (`decisions`, I5 fills it);
--        * the outcome: analyzed → applied (survey_id = the new project or the merged survey) → rolled_back,
--          or failed / discarded;
--        * for a merge, `prior_definition`: the survey as it was when the import was applied onto it, so a
--          rollback restores exactly that (applied in the editor, like every edit).
--   2. the private Storage bucket `rescript-imports` (when Cloudflare R2 is the primary store it is a key
--      prefix there and this row is unused).
--   3. rescript_import_sessions_expired(p_limit) — the sessions whose source object is due for removal.
--
-- ACCESS. Studio routes use the service role and check the session's organisation and the project
-- permission (survey.edit to apply or roll back a merge, project.delete to roll back a new project). RLS is the
-- backstop for a direct authenticated connection: members of the organisation read its sessions. Writes:
-- service role only.
--
-- DEPLOY ORDER: this file, then the code. Code before this file: the import works as before; the session is
-- not kept (the route answers `session: null` with the reason) and history / rollback say "not available".
--
-- Re-runnable: `if not exists`, constraints and policies dropped and re-created, `create or replace`, the
-- bucket insert `on conflict do nothing`. Undo: drop the table and the function (and the bucket row).

begin;

create table if not exists public.import_sessions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  user_id uuid,
  /* the project the import was previewed in (merge) or created (new); null until applied for a new project */
  survey_id uuid references public.surveys(id) on delete set null,
  into_mode text not null default 'new',
  scope text not null default 'full',
  file_name text not null,
  format text not null,
  platform text,
  fingerprint text not null,
  size_bytes integer not null default 0,
  storage_provider text,
  bucket text,
  storage_key text,
  source_expires_at timestamptz not null default (now() + interval '90 days'),
  status text not null default 'analyzed',
  report_digest jsonb not null default '{}'::jsonb,
  canonical jsonb,
  decisions jsonb not null default '[]'::jsonb,
  prior_definition jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz,
  rolled_back_at timestamptz
);

alter table public.import_sessions drop constraint if exists import_sessions_status_check;
alter table public.import_sessions add constraint import_sessions_status_check
  check (status in ('analyzed', 'applied', 'rolled_back', 'failed', 'discarded'));
alter table public.import_sessions drop constraint if exists import_sessions_into_check;
alter table public.import_sessions add constraint import_sessions_into_check check (into_mode in ('new', 'merge'));
alter table public.import_sessions drop constraint if exists import_sessions_scope_check;
alter table public.import_sessions add constraint import_sessions_scope_check check (scope in ('full', 'structure', 'questions'));
/* a key is only ever set together with its bucket */
alter table public.import_sessions drop constraint if exists import_sessions_object_check;
alter table public.import_sessions add constraint import_sessions_object_check check ((storage_key is null) = (bucket is null));

create index if not exists import_sessions_customer_created on public.import_sessions (customer_id, created_at desc);
create index if not exists import_sessions_survey on public.import_sessions (survey_id) where survey_id is not null;
create index if not exists import_sessions_expiring on public.import_sessions (source_expires_at) where storage_key is not null;

alter table public.import_sessions enable row level security;
drop policy if exists import_sessions_member_read on public.import_sessions;
create policy import_sessions_member_read on public.import_sessions for select to authenticated
  using (
    /* current_customer_id() is security definer: a subquery on profiles here would run profiles' own policy */
    customer_id = public.current_customer_id()
    or public.rescript_is_platform_admin(auth.uid())
  );
grant select on public.import_sessions to authenticated;

/* the source objects due for removal, oldest first — the housekeeping job deletes each object, then clears its key */
create or replace function public.rescript_import_sessions_expired(p_limit integer default 200)
returns table (id uuid, bucket text, storage_key text, storage_provider text)
language sql stable
set search_path = public, pg_temp
as $$
  select s.id, s.bucket, s.storage_key, s.storage_provider
  from public.import_sessions s
  where s.storage_key is not null and s.source_expires_at <= now()
  order by s.source_expires_at
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;
revoke all on function public.rescript_import_sessions_expired(integer) from public, anon, authenticated;
grant execute on function public.rescript_import_sessions_expired(integer) to service_role;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('rescript-imports', 'rescript-imports', false)
    on conflict (id) do nothing;
  end if;
end $$;

commit;
