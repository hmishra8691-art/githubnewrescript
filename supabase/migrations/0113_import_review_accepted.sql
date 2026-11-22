-- 0113 — THE SIDE-BY-SIDE REVIEW'S ACCEPTANCE, KEPT WITH THE IMPORT (Level 5 roadmap I6, 2026-11-22).
--
--   import_sessions.review_accepted   the questions a person accepted in the side-by-side review: [{ sourceId, level,
--                                     at, by }]. Read against the import's current comparison (a question that changed
--                                     since is dropped and said). Written by /api/import/sessions/[id]/review.
--
-- Additive. The table keeps its row-level security; the column is read and written only by the service role.
--
-- Rollback:
--   alter table public.import_sessions drop column if exists review_accepted;

alter table public.import_sessions add column if not exists review_accepted jsonb not null default '[]'::jsonb
  check (jsonb_typeof(review_accepted) = 'array' and jsonb_array_length(review_accepted) <= 5000);

insert into public.schema_marks (migration, note) values ('0113', 'import_sessions.review_accepted: side-by-side review acceptance')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
