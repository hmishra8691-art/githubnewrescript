-- 0092 — The tables nothing writes (2026-11-05, platform audit).
--
-- Six tables had never held a row and had no writer: templates and design_files (0001), interview_exports
-- (0030), vendor_quotations (0081), vendor_circuit_state and vendor_api_calls (0086). The last two are written
-- since the Phase 3 commit of this audit's closure (vendorFetch is finally given its recorder and its durable
-- breaker). The other four are decided here, one by one, because "unused" is not one condition:
--
--   templates (0001)       Survey templates live in packages/templates as code and have since the first
--                          release; this table was the original schema's guess at where they would go. No
--                          reader, no writer, no row, no foreign key points at it. DROPPED.
--
--   design_files (0001)    0058 decided this one, and the decision stands: kept until a loader for
--                          `designs[].file.storagePath` exists, because moving designs out of the definition
--                          would use it. Its comment says so.
--
--   interview_exports      The Interviews app's export queue — kind, format, status, a media id for the
--   (0030)                 bundle. The shape of a feature that is designed and not built. Kept, and its
--                          comment now says that, so the next audit does not have to rediscover it.
--
--   vendor_quotations      A vendor's quote for a project, with the `quote` adapter capability (adapter.ts)
--   (0081)                 as its intended writer. No adapter in this build declares `quote` (Prolific does
--                          not quote a CPI). Kept, for the same reason and with the same note.
--
-- Re-runnable: `drop … if exists`, `comment on` is idempotent. Undo for the drop: re-create from 0001 lines
-- 84-91 and the `templates_read` policy at line 250 — there was nothing in it.

drop policy if exists templates_read on public.templates;
drop table if exists public.templates;

comment on table public.interview_exports is
  'The Interviews export queue (0030): designed, not built — nothing writes it yet (platform audit 2026-11-05). When an export job exists, it writes here.';
comment on table public.vendor_quotations is
  'A vendor''s quotation for a project (0081). Written by the `quote` adapter capability, which no adapter in this build declares (platform audit 2026-11-05). Empty until one does.';

insert into public.schema_marks (migration, note) values
  ('0092', 'templates dropped; interview_exports and vendor_quotations marked as awaiting their writers')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
