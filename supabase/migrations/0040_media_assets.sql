-- 0040 — the asset library.
--
-- `media_objects` rows of kind `survey_asset` become things a researcher
-- manages by name in Survey Studio's Assets tab, not just the destination of
-- an Upload button. Four facts a library needs and the row did not have:
--
--   display_name  what the researcher calls it ("Client logo", not
--                 "1726578123-logo_final_v3.png"); null means the original
--                 file name is shown
--   alt_text      what a screen reader says when the asset is a picture;
--                 travels with the asset so every insertion inherits it
--   sha256        the content hash the browser computed before uploading —
--                 the same file uploaded twice is found here and reused,
--                 which is how "avoid unnecessary duplication" is kept
--   shared        a customer-wide asset: visible and pickable from every
--                 survey of the customer, not only the one it was uploaded
--                 to. The row still belongs to its survey (survey_id stays
--                 NOT NULL); `shared` widens who may read it.
--
-- Additive; nothing existing changes meaning. Deletion stays a verified hard
-- delete with a `media_deletions` audit row — the "does not silently break
-- the survey" guarantee is a usage check in the application before the
-- delete, not a soft-delete flag.

begin;

alter table public.media_objects
  add column if not exists display_name text,
  add column if not exists alt_text text,
  add column if not exists sha256 text,
  add column if not exists shared boolean not null default false,
  add column if not exists created_by uuid;

comment on column public.media_objects.display_name is
  'The researcher''s name for a library asset; null shows original_filename.';
comment on column public.media_objects.alt_text is
  'Accessible description of a picture asset, inherited by every place it is inserted.';
comment on column public.media_objects.sha256 is
  'Hex SHA-256 of the object''s bytes, computed by the uploading browser. Lets the same file be found and reused instead of stored twice.';
comment on column public.media_objects.shared is
  'True: the asset is offered to every survey of the customer (survey_id still names where it was uploaded).';
comment on column public.media_objects.created_by is
  'The user who uploaded it, when known.';

alter table public.media_objects drop constraint if exists media_objects_sha256_check;
alter table public.media_objects
  add constraint media_objects_sha256_check check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$');

-- "is this file already here?" — per survey, and per customer for shared assets
create index if not exists media_objects_sha256_idx
  on public.media_objects (survey_id, sha256)
  where sha256 is not null and status = 'stored';
create index if not exists media_objects_shared_idx
  on public.media_objects (customer_id, kind)
  where shared and status = 'stored';

/*
 * WHERE IS THIS ASSET USED? Every place a definition can hold a media URL —
 * question text, an option label, `settings.mediaUrl`, an option's
 * `imageUrl`, the branding logo, a block's media — stores the asset's stable
 * `/api/media/<id>/…` URL as text somewhere in the JSON. So "is it used" is
 * "does the JSON contain the id", asked of every survey of the customer:
 * the autosaved draft and the currently published version of each. The
 * Studio shows the answer before a delete, which is what makes "deleting an
 * asset does not silently break a survey" a promise rather than a hope.
 *
 * Text search over jsonb::text is a scan, bounded by the customer's surveys;
 * a customer with a thousand surveys asks this once, when they click Delete.
 */
create or replace function public.rescript_media_usage(p_media uuid)
returns table (survey_id uuid, code text, title text, in_draft boolean, in_live boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with m as (select customer_id from public.media_objects where id = p_media),
  s as (
    select sv.id, sv.code, sv.title,
      coalesce(sv.draft_definition::text like '%' || p_media::text || '%', false) as in_draft,
      coalesce((select v.definition::text like '%' || p_media::text || '%'
                from public.survey_versions v where v.id = sv.current_version_id), false) as in_live
    from public.surveys sv, m
    where sv.customer_id = m.customer_id
  )
  select s.id, s.code, s.title, s.in_draft, s.in_live from s where s.in_draft or s.in_live
  order by s.code;
$$;
revoke all on function public.rescript_media_usage(uuid) from public, anon, authenticated;

commit;
