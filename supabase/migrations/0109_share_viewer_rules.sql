-- 0109 — VIEWER ROLES AND ROW FILTERS ON A SHARE LINK (Level 5 roadmap R3, 2026-11-22).
--
--   analytics_shares.viewer_rules   null = every viewer of the link sees what the published version froze (as before).
--                                   A list = each signed-in viewer sees only the part a rule opens to them (by email,
--                                   or by domain): everything, one viewer filter, or one drill-down value. A viewer no
--                                   rule names sees nothing. Checked and applied by packages/analytics/src/viewerAccess.ts;
--                                   the share route sends only that viewer's frozen answer.
--
-- Additive. The table keeps its existing row-level security; the column is read and written only by the service role.
--
-- Rollback:
--   alter table public.analytics_shares drop column if exists viewer_rules;

alter table public.analytics_shares add column if not exists viewer_rules jsonb
  check (viewer_rules is null or (jsonb_typeof(viewer_rules) = 'array' and jsonb_array_length(viewer_rules) <= 50));

insert into public.schema_marks (migration, note) values ('0109', 'analytics_shares.viewer_rules: per-viewer segments on a share link')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
