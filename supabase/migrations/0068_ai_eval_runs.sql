-- 0068 — Intelligent Mode evaluation runs started from /platform (2026-10-18).
--
-- A platform administrator can run a small subset (at most 10 cases) of the
-- AI evaluation harness against the installation's real provider from the
-- /platform page. Each run is metered to the PLATFORM, not to a customer: the
-- cases run in the sandbox project (no customer project is read or written,
-- no customer wallet is charged), and what every model call cost at the
-- provider is kept here, with a hard cap checked before each case. The
-- finished report (pass rates, tokens incl. cache read/write, cost, latency)
-- is kept with the run so the page can show the last runs.
--
-- Re-runnable. Until it is applied the admin run keeps its state in the
-- server's memory (one instance) and says so. Written and read by the
-- service role only (the admin API); no policy for any other role.

create table if not exists public.ai_eval_runs (
  id uuid primary key default gen_random_uuid(),
  created_by uuid,
  status text not null default 'running' check (status in ('running', 'finished', 'capped', 'failed')),
  provider text not null default '' check (char_length(provider) <= 200),
  model text not null default '' check (char_length(model) <= 200),
  case_ids text[] not null default '{}',
  cap_usd numeric(12, 6) not null check (cap_usd >= 0 and cap_usd <= 100),
  estimate_usd numeric(12, 6) not null default 0,
  spent_usd numeric(12, 6) not null default 0,
  results jsonb not null default '[]'::jsonb,
  report jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ai_eval_runs is 'AI evaluation runs started by a platform administrator from /platform: the sandbox-only cases run, their per-call provider cost (metered to the platform, never to a customer), the cap, and the report.';

create index if not exists ai_eval_runs_created_idx on public.ai_eval_runs (created_at desc);

alter table public.ai_eval_runs enable row level security;
-- service role only: no policy is granted to anon or authenticated
revoke all on public.ai_eval_runs from anon, authenticated;
