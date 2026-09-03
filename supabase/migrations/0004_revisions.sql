-- ============================================================================
-- Revisions — stale writes can no longer overwrite newer work
--
-- The draft was written with an unconditional UPDATE: whichever request
-- reached the database last won, regardless of which was based on newer work.
-- Two tabs, a retried request, or one slow request finishing after a fast one
-- was enough to put an older definition on top of a newer one, silently.
--
-- `surveys.revision` makes every write conditional. The client sends the
-- revision it read; the update only matches while the row is still at that
-- revision, and bumps it. A late write finds no row to update, is told so, and
-- is rejected instead of applied.
--
-- Safe to run more than once.
-- ============================================================================

alter table public.surveys
  add column if not exists revision bigint not null default 0;

comment on column public.surveys.revision is
  'Optimistic-concurrency counter. Every accepted write to draft_definition or current_version_id increments it; a write whose base revision is behind is refused.';

-- Existing rows start at 0, which is correct: no client holds a newer number.

-- --------------------------------------------------------------- draft save
-- One statement so the check and the write cannot interleave.
--
-- Returns the new revision on success. Returns NULL when the caller's base
-- revision is stale, which the API turns into a 409 carrying the current
-- server state — the caller then reconciles rather than clobbering.
create or replace function public.rescript_save_draft(
  p_survey_id uuid,
  p_definition jsonb,
  p_base_revision bigint,
  p_base_version_id uuid default null,
  p_title text default null
)
returns table (revision bigint, draft_updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  return query
  update public.surveys s
     set draft_definition = p_definition,
         draft_updated_at = v_now,
         draft_base_version_id = coalesce(p_base_version_id, s.draft_base_version_id),
         title = coalesce(p_title, s.title),
         updated_at = v_now,
         revision = s.revision + 1
   where s.id = p_survey_id
     -- the guard: only write on top of the revision the caller actually read
     and s.revision = p_base_revision
  returning s.revision, s.draft_updated_at;
end;
$$;

comment on function public.rescript_save_draft(uuid, jsonb, bigint, uuid, text) is
  'Conditional draft write. Returns no row when p_base_revision is behind, so a stale save is refused rather than applied.';

-- ------------------------------------------------------------ version save
-- Cutting a version also clears the draft: the draft existed to hold work the
-- version did not yet contain, and now it does. Leaving it behind is what made
-- a freshly saved survey reopen reading "Unsaved changes", and made a restored
-- version lose to a draft written before the restore.
create or replace function public.rescript_finalize_version(
  p_survey_id uuid,
  p_version_id uuid,
  p_base_revision bigint
)
returns table (revision bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.surveys s
     set current_version_id = p_version_id,
         draft_definition = null,
         draft_updated_at = null,
         draft_base_version_id = null,
         updated_at = now(),
         revision = s.revision + 1
   where s.id = p_survey_id
     and (p_base_revision < 0 or s.revision = p_base_revision)
  returning s.revision;
end;
$$;

comment on function public.rescript_finalize_version(uuid, uuid, bigint) is
  'Point a survey at a version and clear its draft, guarded by revision. Pass -1 as the base revision to force (explicit restore).';

revoke all on function public.rescript_save_draft(uuid, jsonb, bigint, uuid, text) from anon;
revoke all on function public.rescript_finalize_version(uuid, uuid, bigint) from anon;
