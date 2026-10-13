-- 0052 — a persisted cache of computed analytics results (audit S-14, Phase 1).
--
-- A result is a pure function of its inputs: the analysis definition, the dataset it is run on, the data at that
-- moment (the response count and the newest change), the questionnaire version it is read through, and the version of
-- the computations. Every result now carries a hash of those inputs (`provenance.inputHash`). This table keeps the
-- results by that hash, so an analysis nobody has changed is served from here after a restart or a deploy instead of
-- being recomputed from the response rows — and a new response, an edited definition or a new engine version changes the
-- hash, so a stale result is never found.
--
-- It is a cache, not a record: rows expire (30 days) and can be dropped at any time without losing anything — the
-- results are recomputed on demand. The Studio works without this table (it falls back to computing), so applying the
-- migration is what turns the cache on.

create table if not exists public.analytics_result_cache (
  survey_id uuid not null references public.surveys(id) on delete cascade,
  input_hash text not null,
  engine_version text not null,
  payload jsonb not null,
  bytes integer not null default 0,
  computed_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  primary key (survey_id, input_hash)
);
create index if not exists analytics_result_cache_expiry_idx on public.analytics_result_cache (expires_at);

-- written and read only by the Studio's service role; no member policy, so nothing else can see computed results by hash
alter table public.analytics_result_cache enable row level security;

comment on table public.analytics_result_cache is
  'Computed analytics results by the hash of their inputs (definition, dataset, data version, questionnaire version, engine version). A cache: rows expire and may be deleted at any time.';
