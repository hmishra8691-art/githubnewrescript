-- 0066 — chunked execution of long-running statistical models (advanced statistics, 2026-10-18).
--
-- Hierarchical Bayes (HB-MNL) for CBC / MaxDiff runs thousands of MCMC iterations per chain: about 12 s for
-- 300 respondents × 12 tasks at the default 2 × (5,000 + 5,000) iterations, ~40 s for 1,000 respondents — beyond
-- one serverless request (maxDuration 60 s, shared with dataset loading). The sampler is a serialisable state
-- machine (`@rescript/analytics` models/hb.ts: seeded RNG state, chains, running sums), so a run is advanced in
-- chunks of ≤ 40 s: each request loads the job, continues the chains from `state`, and stores the new state. The
-- draws are exactly those of an uninterrupted run (same seed, same data → same result).
--
-- One row per run. `state` is the chain state while running (cleared when done); `result` the finished
-- AnalysisResult, which is also written to analytics_result_cache under the same input hash `compute()` uses, so
-- reports and exports of the saved analysis are served the finished run. `data_fingerprint` pins the exact data
-- the run started on: a continuation on changed data is refused. `lease_until` keeps two continuations from
-- advancing the same chains at once. Re-runnable.

create table if not exists public.analytics_model_jobs (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  analysis_id uuid null,
  kind text not null check (kind in ('hb', 'lca', 'sem')),
  status text not null default 'running' check (status in ('running', 'done', 'failed', 'refused', 'cancelled')),
  definition jsonb not null,
  input_hash text not null,
  engine_version text not null,
  seed integer null,
  data_fingerprint text null,
  progress jsonb not null default '{}'::jsonb,
  state jsonb null,
  result jsonb null,
  error text null,
  created_by uuid null,
  lease_until timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz null
);

alter table public.analytics_model_jobs add column if not exists lease_until timestamptz null;
alter table public.analytics_model_jobs add column if not exists finished_at timestamptz null;

create index if not exists analytics_model_jobs_survey_idx on public.analytics_model_jobs (survey_id, created_at desc);
create index if not exists analytics_model_jobs_hash_idx on public.analytics_model_jobs (survey_id, input_hash);

-- written and read only by the Studio's service role (the analytics route checks the member's capability first);
-- no member policy, so chain state and results are never readable directly
alter table public.analytics_model_jobs enable row level security;

comment on table public.analytics_model_jobs is
  'Chunked runs of long statistical models (HB-MNL): serialised chain state between requests, progress, and the finished result. Service role only.';
