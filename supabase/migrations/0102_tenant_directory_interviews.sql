-- 0102 — TENANT DIRECTORY: THE INTERVIEWS PRODUCT'S KEYS (tenancy wiring, 2026-11-20).
--
-- The interviews app reaches an interview by its id (a researcher's page) and a candidate by their link token. Two
-- more kinds for public.tenant_directory (0101): 'interview' (the interview's id) and 'interview_candidate' (the
-- SHA-256 of the candidate's token — the hash interviews.token_hash already keeps; never the token). Nothing reads
-- or writes these rows while routing is inactive.
alter table public.tenant_directory drop constraint if exists tenant_directory_kind_check;
alter table public.tenant_directory add constraint tenant_directory_kind_check check (kind in (
  'survey', 'session', 'group', 'media', 'interview_project', 'ai_interview_study', 'ai_interview_session',
  'live_invite', 'live_member', 'interview', 'interview_candidate'
));

insert into public.schema_marks (migration, note) values ('0102', 'tenant_directory: interview and interview_candidate kinds')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
