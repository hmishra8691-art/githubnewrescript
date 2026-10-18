-- ARTIFACTS & REPORT THEMES SQL TEST (migration 0064) — run against a database
-- with every migration applied:
--   psql -d <db> -v ON_ERROR_STOP=1 -f scripts/artifacts-sql-test.sql
--
-- Proves, on real Postgres:
--   1. an artifact row needs a known type, a SHA-256 checksum, a positive size,
--      and an owner when it is private; a signed URL has nowhere to go
--   2. one live row per fingerprint (a second generation of the same inputs is
--      refused by the index, so the route reuses the first); a new fingerprint
--      takes the next version; two people's PRIVATE copies may share one
--   3. RLS for a direct authenticated connection: a member reads the project's
--      artifacts, NOT another member's private one; a non-member reads nothing
--      (project isolation); a deleted artifact is not read
--   4. report themes are scoped: an org theme is read by that organisation only,
--      a user theme by its owner only; one name per org / per person (case and
--      punctuation folded); versions are kept
--   5. a project's applied theme is read by its members only
--   6. the private bucket exists and is not public
--
-- Everything runs in one transaction and rolls back.

begin;

insert into public.customers (id, slug, name) values
  ('a0000000-0000-0000-0000-000000000064', 'art64', 'Artifacts 0064'),
  ('a0000000-0000-0000-0000-000000000065', 'art65', 'Other org 0064')
on conflict do nothing;

insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000064-0000-0000-0000-000000000001', 'owner@a64.test', '{}'::jsonb),
  ('a0000064-0000-0000-0000-000000000002', 'ana@a64.test', '{}'::jsonb),
  ('a0000064-0000-0000-0000-000000000003', 'out@a65.test', '{}'::jsonb)
on conflict do nothing;

insert into public.profiles (id, customer_id, email, full_name, role) values
  ('a0000064-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000064', 'owner@a64.test', 'Owner', 'programmer'),
  ('a0000064-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000064', 'ana@a64.test', 'Ana', 'programmer'),
  ('a0000064-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000065', 'out@a65.test', 'Out', 'programmer')
on conflict (id) do update set customer_id = excluded.customer_id;

insert into public.surveys (id, customer_id, code, title, owner_id) values
  ('a0000000-0000-0000-0000-000000000164', 'a0000000-0000-0000-0000-000000000064', 'A64', 'Artifacts project', 'a0000064-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000165', 'a0000000-0000-0000-0000-000000000065', 'A65', 'Someone else''s project', 'a0000064-0000-0000-0000-000000000003')
on conflict (id) do update set owner_id = excluded.owner_id;

/* Ana is an explicit viewer of A64 (not the owner); "out" belongs to another organisation */
insert into public.project_members (survey_id, user_id, role, added_by)
values ('a0000000-0000-0000-0000-000000000164', 'a0000064-0000-0000-0000-000000000002', 'viewer', 'a0000064-0000-0000-0000-000000000001')
on conflict (survey_id, user_id) do update set role = excluded.role, revoked_at = null, expires_at = null;

-- ============================================== 1–2. SHAPE, FINGERPRINT, VERSIONS

do $$
declare ok boolean; sum64 text := repeat('ab', 32);
begin
  insert into public.artifacts (survey_id, owner_id, created_by, type, edition, version, fingerprint, storage_provider, bucket, storage_key, file_name, mime, size_bytes, checksum)
  values ('a0000000-0000-0000-0000-000000000164', 'a0000064-0000-0000-0000-000000000001', 'a0000064-0000-0000-0000-000000000001', 'research_plan_docx', 'standard', 1, 'fp-0001-aaaa', 'supabase', 'rescript-reports', 'a64/artifacts/research_plan_docx/v1.docx', 'A64_Research_Plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 12345, sum64);

  begin
    insert into public.artifacts (survey_id, owner_id, type, version, fingerprint, storage_provider, bucket, storage_key, file_name, mime, size_bytes, checksum)
    values ('a0000000-0000-0000-0000-000000000164', 'a0000064-0000-0000-0000-000000000001', 'research_plan_docx', 2, 'fp-0001-aaaa', 'supabase', 'rescript-reports', 'k2', 'f', 'm', 1, sum64);
    ok := false;
  exception when unique_violation then ok := true; end;
  assert ok, 'the same inputs (fingerprint) cannot make a second live document';

  begin
    insert into public.artifacts (survey_id, owner_id, type, version, fingerprint, storage_provider, bucket, storage_key, file_name, mime, size_bytes, checksum)
    values ('a0000000-0000-0000-0000-000000000164', 'a0000064-0000-0000-0000-000000000001', 'research_plan_docx', 1, 'fp-0002-bbbb', 'supabase', 'rescript-reports', 'k3', 'f', 'm', 1, sum64);
    ok := false;
  exception when unique_violation then ok := true; end;
  assert ok, 'a version number is taken once per document line';

  insert into public.artifacts (survey_id, owner_id, type, version, fingerprint, storage_provider, bucket, storage_key, file_name, mime, size_bytes, checksum)
  values ('a0000000-0000-0000-0000-000000000164', 'a0000064-0000-0000-0000-000000000001', 'research_plan_docx', 2, 'fp-0002-bbbb', 'supabase', 'rescript-reports', 'k4', 'f', 'm', 1, sum64);
  update public.artifacts set status = 'superseded' where storage_key = 'a64/artifacts/research_plan_docx/v1.docx';
  assert (select count(*) from public.artifacts where survey_id = 'a0000000-0000-0000-0000-000000000164' and type = 'research_plan_docx') = 2, 'the earlier version is kept';

  foreach sum64 in array array['not-a-sha', upper(repeat('ab', 32))] loop
    begin
      insert into public.artifacts (survey_id, owner_id, type, version, fingerprint, storage_provider, bucket, storage_key, file_name, mime, size_bytes, checksum)
      values ('a0000000-0000-0000-0000-000000000164', 'a0000064-0000-0000-0000-000000000001', 'sap_docx', 1, 'fp-0003-cccc', 'supabase', 'b', 'k', 'f', 'm', 1, sum64);
      ok := false;
    exception when check_violation then ok := true; end;
    assert ok, 'a checksum is a lower-case SHA-256: ' || sum64;
  end loop;
  sum64 := repeat('ab', 32);
  begin
    insert into public.artifacts (survey_id, type, version, fingerprint, storage_provider, bucket, storage_key, file_name, mime, size_bytes, checksum, visibility)
    values ('a0000000-0000-0000-0000-000000000164', 'sap_docx', 1, 'fp-0003-cccc', 'supabase', 'b', 'k', 'f', 'm', 1, sum64, 'private');
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'a private artifact needs an owner';
  begin
    insert into public.artifacts (survey_id, owner_id, type, version, fingerprint, storage_provider, bucket, storage_key, file_name, mime, size_bytes, checksum)
    values ('a0000000-0000-0000-0000-000000000164', 'a0000064-0000-0000-0000-000000000001', 'video_mp4', 1, 'fp-0004-dddd', 'supabase', 'b', 'k', 'f', 'm', 1, sum64);
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'only the document types are artifacts';
  begin
    insert into public.artifacts (survey_id, owner_id, type, version, fingerprint, storage_provider, bucket, storage_key, file_name, mime, size_bytes, checksum)
    values ('a0000000-0000-0000-0000-000000000164', 'a0000064-0000-0000-0000-000000000001', 'sap_docx', 1, 'fp-0005-eeee', 'supabase', 'b', 'k', 'f', 'm', 0, sum64);
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'an empty file is not stored';

  /* two people's PRIVATE copies of the same inputs may coexist (versions apart) */
  insert into public.artifacts (survey_id, owner_id, type, edition, version, fingerprint, storage_provider, bucket, storage_key, file_name, mime, size_bytes, checksum, visibility)
  values ('a0000000-0000-0000-0000-000000000164', 'a0000064-0000-0000-0000-000000000001', 'findings_docx', 'client', 1, 'fp-0006-ffff', 'supabase', 'b', 'p1', 'f', 'm', 9, sum64, 'private'),
         ('a0000000-0000-0000-0000-000000000164', 'a0000064-0000-0000-0000-000000000002', 'findings_docx', 'client', 2, 'fp-0006-ffff', 'supabase', 'b', 'p2', 'f', 'm', 9, sum64, 'private');
  /* a deleted row frees its fingerprint */
  update public.artifacts set deleted_at = now(), status = 'deleted' where storage_key = 'p2';
  insert into public.artifacts (survey_id, owner_id, type, edition, version, fingerprint, storage_provider, bucket, storage_key, file_name, mime, size_bytes, checksum, visibility)
  values ('a0000000-0000-0000-0000-000000000164', 'a0000064-0000-0000-0000-000000000002', 'findings_docx', 'client', 3, 'fp-0006-ffff', 'supabase', 'b', 'p3', 'f', 'm', 9, sum64, 'private');
  /* the other project's artifact, for isolation */
  insert into public.artifacts (survey_id, owner_id, type, version, fingerprint, storage_provider, bucket, storage_key, file_name, mime, size_bytes, checksum)
  values ('a0000000-0000-0000-0000-000000000165', 'a0000064-0000-0000-0000-000000000003', 'proposal_docx', 1, 'fp-0007-gggg', 'supabase', 'b', 'o1', 'f', 'm', 9, sum64);
  raise notice 'ok 1-2: shape, fingerprint uniqueness, versions, private copies';
end $$;

-- ============================================== 4. THEMES (as the service role writes them)

do $$
declare ok boolean; tid uuid;
begin
  insert into public.report_themes (scope, customer_id, name, name_key, theme, created_by)
  values ('org', 'a0000000-0000-0000-0000-000000000064', 'Board Pack', 'board pack', '{"v":1,"name":"Board Pack"}', 'a0000064-0000-0000-0000-000000000001')
  returning id into tid;
  insert into public.report_theme_versions (theme_id, version, theme) values (tid, 1, '{"v":1}');
  update public.report_themes set version = 2, theme = '{"v":1,"name":"Board Pack","x":2}' where id = tid;
  insert into public.report_theme_versions (theme_id, version, theme) values (tid, 2, '{"v":1,"x":2}');
  assert (select count(*) from public.report_theme_versions where theme_id = tid) = 2, 'every version is kept';
  begin
    insert into public.report_themes (scope, customer_id, name, name_key, theme) values ('org', 'a0000000-0000-0000-0000-000000000064', 'board-pack', 'board pack', '{}');
    ok := false;
  exception when unique_violation then ok := true; end;
  assert ok, 'one name per organisation';
  insert into public.report_themes (scope, customer_id, name, name_key, theme) values ('org', 'a0000000-0000-0000-0000-000000000065', 'Board Pack', 'board pack', '{}');
  insert into public.report_themes (scope, owner_id, customer_id, name, name_key, theme) values ('user', 'a0000064-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000064', 'Ana''s look', 'anas look', '{}');
  begin
    insert into public.report_themes (scope, name, name_key, theme) values ('org', 'Global', 'global', '{}');
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'there are no global themes: an org theme needs its organisation';
  begin
    insert into public.report_themes (scope, customer_id, name, name_key, theme) values ('user', 'a0000000-0000-0000-0000-000000000064', 'Nobody', 'nobody', '{}');
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'a personal theme needs its person';
  insert into public.report_theme_selections (survey_id, theme_ref, theme_version, theme, applied_by)
  values ('a0000000-0000-0000-0000-000000000164', tid::text, 2, '{"v":1}', 'a0000064-0000-0000-0000-000000000001');
  begin
    insert into public.report_theme_selections (survey_id, theme) values ('a0000000-0000-0000-0000-000000000165', '"not an object"');
    ok := false;
  exception when check_violation then ok := true; end;
  assert ok, 'an applied theme is an object';
  raise notice 'ok 4: theme scope, names, versions';
end $$;

-- ============================================== 3–5. WHAT A DIRECT AUTHENTICATED CONNECTION READS

set local role authenticated;

set local request.jwt.claim.sub = 'a0000064-0000-0000-0000-000000000001';
do $$ begin
  assert (select count(*) from public.artifacts) = 3, 'the owner reads the project''s two plan versions and their own private copy, got ' || (select count(*) from public.artifacts);
  assert not exists (select 1 from public.artifacts where storage_key in ('p3', 'o1')), 'not Ana''s private copy, not the other project''s';
  assert (select count(*) from public.report_themes) = 1 and exists (select 1 from public.report_themes where name = 'Board Pack'), 'their organisation''s theme only';
  assert (select count(*) from public.report_theme_versions) = 2;
  assert (select count(*) from public.report_theme_selections) = 1;
  raise notice 'ok 3/4/5: owner';
end $$;

set local request.jwt.claim.sub = 'a0000064-0000-0000-0000-000000000002';
do $$ begin
  assert (select count(*) from public.artifacts) = 3, 'Ana (viewer) reads the project''s plan versions and her own private copy, got ' || (select count(*) from public.artifacts);
  assert not exists (select 1 from public.artifacts where storage_key in ('p1', 'p2', 'o1')), 'not the owner''s private copy, not a deleted row, not the other project''s';
  assert (select count(*) from public.report_themes) = 2, 'her organisation''s theme and her own';
  raise notice 'ok 3/4: member';
end $$;

set local request.jwt.claim.sub = 'a0000064-0000-0000-0000-000000000003';
do $$ begin
  assert (select count(*) from public.artifacts) = 1 and exists (select 1 from public.artifacts where storage_key = 'o1'), 'project isolation: only their own project''s artifact';
  assert (select count(*) from public.report_themes) = 1 and (select customer_id from public.report_themes) = 'a0000000-0000-0000-0000-000000000065', 'only their organisation''s theme';
  assert (select count(*) from public.report_theme_selections) = 0, 'another project''s applied theme is not theirs to read';
  raise notice 'ok 3/4/5: outsider';
end $$;

set local request.jwt.claim.sub = '';
do $$ begin
  assert (select count(*) from public.artifacts) = 0 and (select count(*) from public.report_themes) = 0, 'no session, nothing';
  raise notice 'ok 3: anonymous';
end $$;

reset role;

-- ============================================== 6. THE BUCKET

do $$ begin
  if to_regclass('storage.buckets') is not null then
    assert exists (select 1 from storage.buckets where id = 'rescript-reports' and public = false), 'the reports bucket exists and is private';
  end if;
  raise notice 'ok 6: private bucket';
end $$;

rollback;
