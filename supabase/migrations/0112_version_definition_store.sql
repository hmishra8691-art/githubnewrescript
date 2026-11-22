-- 0112 — PUBLISHED VERSIONS COPIED TO OBJECT STORAGE (scale readiness step 4, phase A, 2026-11-22).
--
-- A published version's definition (849 KB on average) is copied, gzipped and content-addressed, into the private
-- bucket `rescript-definitions` (Cloudflare R2 when configured, Supabase Storage otherwise): see
-- packages/media/src/definitions.ts and apps/studio/lib/definitionStore.ts. This migration records the copy:
--
--   definition_hash       sha256 of the canonical JSON — the object's name; identical versions share one object
--   definition_bytes      canonical JSON size, uncompressed
--   definition_store      which store holds it ("cloudflare-r2" | "supabase"), so a read asks the same one
--   definition_stored_at  when the store confirmed it; null = not copied yet (the sweep's work list)
--
-- PHASE A: the jsonb stays and is still what everything reads. Phase B reads the copy (jsonb as fallback); phase C
-- stops storing the jsonb. The hash is written once: a trigger refuses to change or clear it, so a non-null hash
-- always names an object the store confirmed. The version immutability trigger (0012) does not cover these columns,
-- and needs no change. Re-runnable.

begin;

alter table public.survey_versions
  add column if not exists definition_hash text,
  add column if not exists definition_bytes integer,
  add column if not exists definition_store text,
  add column if not exists definition_stored_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'survey_versions_definition_hash_shape') then
    alter table public.survey_versions add constraint survey_versions_definition_hash_shape
      check (definition_hash is null or definition_hash ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'survey_versions_definition_copy_complete') then
    alter table public.survey_versions add constraint survey_versions_definition_copy_complete
      check ((definition_hash is null) = (definition_stored_at is null));
  end if;
end $$;

-- the sweep's work list: versions not yet copied, oldest first
create index if not exists survey_versions_definition_uncopied_idx
  on public.survey_versions (created_at) where definition_stored_at is null;
-- which versions share an object (and, later, whether an object is still referenced)
create index if not exists survey_versions_definition_hash_idx
  on public.survey_versions (definition_hash) where definition_hash is not null;

create or replace function public.rescript_version_definition_pointer_guard()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
begin
  if old.definition_hash is not null and (
       new.definition_hash is distinct from old.definition_hash
    or new.definition_store is distinct from old.definition_store
    or new.definition_bytes is distinct from old.definition_bytes) then
    raise exception 'version %: its stored definition (%) is recorded once and cannot be changed', old.id, old.definition_hash
      using errcode = 'restrict_violation';
  end if;
  return new;
end $$;
revoke all on function public.rescript_version_definition_pointer_guard() from public, anon, authenticated;

drop trigger if exists survey_versions_definition_pointer_guard on public.survey_versions;
create trigger survey_versions_definition_pointer_guard
  before update of definition_hash, definition_store, definition_bytes on public.survey_versions
  for each row execute function public.rescript_version_definition_pointer_guard();

-- the private bucket, for installations on Supabase Storage (R2 needs no bucket per prefix)
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('rescript-definitions', 'rescript-definitions', false)
    on conflict (id) do nothing;
  end if;
end $$;

insert into public.schema_marks (migration, note) values ('0112', 'survey_versions: definition copied to object storage (hash, bytes, store, stored_at)')
on conflict (migration) do update set applied_at = now(), note = excluded.note;

commit;
