-- Research Engine Phase 4 (automated analysis): what a run says beyond its
-- findings — the multiple-comparison correction applied to the planned tests
-- (by family), the data advice per analysis (the checks and the method the
-- data recommends), and the discoveries beyond the plan (segment differences
-- the plan did not test, anomalies, trends across waves). One nullable jsonb
-- each; a run made before this migration simply has none.
alter table public.analytics_runs add column if not exists corrections jsonb;
alter table public.analytics_runs add column if not exists advice jsonb;
alter table public.analytics_runs add column if not exists discoveries jsonb;
