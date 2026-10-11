-- Research Engine Phase 8 (waves across runs): every KPI of the research
-- design measured on the run's own data, and what moved since the previous
-- comparable run — the KPI deltas with their significance, the planned
-- findings that changed, the verdicts that changed. One nullable jsonb each;
-- a run made before this migration simply has none, and the Studio inserts
-- without them when the columns are not there yet.
alter table public.analytics_runs add column if not exists kpis jsonb;
alter table public.analytics_runs add column if not exists since jsonb;
