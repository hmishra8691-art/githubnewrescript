-- 0108 — EXPORT HISTORY FOR EVERY FORMAT A REPORT RENDERS AS (Level 5 roadmap R1, 2026-11-22).
--
-- analytics_exports.format was created allowing only 'pptx' and 'xlsx'. The Studio has exported PDF and CSV since
-- M6, and the history row for those was refused by this check (the insert's error was not read, so the download
-- itself worked and the history silently missed it). R1 adds Word. The check now names every format the one renderer
-- (packages/analytics/src/export/render.ts) produces. Additive: no row changes.
--
-- Rollback (only if no pdf / csv / docx rows exist):
--   alter table public.analytics_exports drop constraint analytics_exports_format_check;
--   alter table public.analytics_exports add constraint analytics_exports_format_check check (format in ('pptx', 'xlsx'));

alter table public.analytics_exports drop constraint if exists analytics_exports_format_check;
alter table public.analytics_exports add constraint analytics_exports_format_check check (format in ('pptx', 'xlsx', 'pdf', 'csv', 'docx'));

insert into public.schema_marks (migration, note) values ('0108', 'analytics_exports.format: pdf, csv, docx allowed')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
