-- ============================================================================
-- Response quality & fraud detection
--
-- A response now carries three more things beside its answers:
--
--   telemetry   derived behavioural metadata recorded by the runtime while the
--               respondent answered — page/question timing, focus changes,
--               copy/paste COUNTS and lengths (never clipboard contents),
--               navigation sequence, interaction counts, device class.
--   quality     the engine's assessment: two scores (quality 0–100, best = 100;
--               fraud risk 0–100, worst = 100), a classification, and every
--               flag with its observed value, benchmark, severity, points and
--               explanation. Written at completion; recomputed on demand.
--   review      the researcher's decision — KEEP / REMOVE / REVIEW_LATER — with
--               who, when and why. REMOVE never deletes: the row stays, the
--               decision is data, and it can be reversed.
--
-- Identifiers are pseudonymous: the IP is stored only as a salted hash, the
-- device as a hash of coarse browser characteristics. Neither can be reversed;
-- both can be compared, which is all duplicate detection needs.
--
-- Safe to run more than once.
-- ============================================================================

alter table public.responses
  add column if not exists telemetry jsonb,
  add column if not exists ip_hash text,
  add column if not exists device_hash text,
  add column if not exists quality jsonb,
  add column if not exists quality_computed_at timestamptz,
  add column if not exists review_status text
    check (review_status is null or review_status in ('KEEP','REMOVE','REVIEW_LATER')),
  add column if not exists review_reason text,
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz;

comment on column public.responses.telemetry is
  'Derived behavioural metadata from the runtime (timing, focus, clipboard counts, navigation, device). No clipboard contents, no raw IP.';
comment on column public.responses.ip_hash is
  'sha256(salt + client IP). Comparable, not reversible.';
comment on column public.responses.device_hash is
  'sha256 of coarse device characteristics (UA family, platform, screen, timezone, language). Comparable, not reversible.';
comment on column public.responses.quality is
  '@rescript/quality assessment: {qualityScore, riskScore, classification, flags[], scores{}, system{}, cluster{}}.';
comment on column public.responses.review_status is
  'Researcher decision. REMOVE hides the response from clean datasets; the raw response is never deleted.';

-- the dashboard filters by classification and by review status
create index if not exists responses_quality_class_idx
  on public.responses (survey_id, (quality->>'classification'));
create index if not exists responses_review_idx
  on public.responses (survey_id, review_status);
-- duplicate detection looks up siblings by hash
create index if not exists responses_ip_hash_idx on public.responses (survey_id, ip_hash);
create index if not exists responses_device_hash_idx on public.responses (survey_id, device_hash);

-- ------------------------------------------------------------ review audit
-- Every decision, forever. Restoring a response is another row here, not an
-- erasure of the previous one.
create table if not exists public.response_reviews (
  id bigint generated always as identity primary key,
  response_id uuid not null references public.responses(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  decision text not null check (decision in ('KEEP','REMOVE','REVIEW_LATER','CLEAR')),
  reason text,
  decided_by text,
  decided_at timestamptz not null default now(),
  -- the assessment the decision was made against, so it can be revisited
  quality_snapshot jsonb
);
create index if not exists response_reviews_response_idx on public.response_reviews (response_id, decided_at desc);

alter table public.response_reviews enable row level security;
-- service role only (same posture as responses): no anon/authenticated policies.

-- ------------------------------------------------------------ quality profiles
-- Reusable configurations ("Healthcare — Strict"). The built-in presets are
-- code; these are the researcher's own, shared across a customer's surveys.
create table if not exists public.quality_profiles (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  name text not null,
  description text,
  config jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, name)
);
alter table public.quality_profiles enable row level security;
drop trigger if exists quality_profiles_touch on public.quality_profiles;
create trigger quality_profiles_touch before update on public.quality_profiles
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------ retention
-- Drops raw telemetry older than the given number of days for one survey,
-- keeping the computed assessment. Called by the Studio's purge action with
-- the survey's configured retention.
create or replace function public.rescript_purge_telemetry(p_survey_id uuid, p_days int)
returns int
language plpgsql
security definer
as $$
declare n int;
begin
  update public.responses
     set telemetry = null
   where survey_id = p_survey_id
     and telemetry is not null
     and coalesce(completed_at, updated_at) < now() - make_interval(days => p_days);
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.rescript_purge_telemetry(uuid, int) from anon;

-- ------------------------------------------------------------ dashboard counts
-- One query for the Quality dashboard header: rows per classification and per
-- review decision for a survey, live or test.
create or replace function public.rescript_quality_summary(p_survey_id uuid, p_is_test boolean)
returns table (classification text, review_status text, n bigint)
language sql
stable
security definer
as $$
  select coalesce(r.quality->>'classification', 'UNSCORED') as classification,
         r.review_status,
         count(*) as n
    from public.responses r
   where r.survey_id = p_survey_id
     and r.is_test = p_is_test
     and r.status <> 'in_progress'
   group by 1, 2;
$$;
revoke all on function public.rescript_quality_summary(uuid, boolean) from anon;
