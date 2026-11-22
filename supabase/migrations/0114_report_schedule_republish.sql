-- 0114 — REPUBLISH A SHARED REPORT ON REFRESH (Level 5 roadmap R5, 2026-11-22). Needs 0110.
--
--   report_schedules.republish   kind 'report' only: each run (scheduled or "run now") also publishes the fresh
--                                results as the report's next version (analytics_report_versions, the same publish as
--                                the Studio's button: viewer filters, drill values and the minimum base included), and
--                                points analytics_reports.published_version at it. Share links with no pinned version
--                                (analytics_shares.report_version null) then show the new numbers; pinned links do not
--                                change. A run whose report comes out blank or partial is not published, and says so.
--
-- Additive. The table keeps its row-level security with no policy (service role only).
--
-- Rollback:
--   alter table public.report_schedules drop column if exists republish;

alter table public.report_schedules add column if not exists republish boolean not null default false;
alter table public.report_schedules drop constraint if exists report_schedules_republish_report_only;
alter table public.report_schedules add constraint report_schedules_republish_report_only check (kind = 'report' or not republish);

insert into public.schema_marks (migration, note) values ('0114', 'report_schedules.republish: republish a shared report on refresh')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
