-- 0104 — THE RESPONDENT PORTAL: SCORECARDS AND BENCHMARKS (Respondent Intelligence Engine, phase 2, 2026-11-20).
--
--   portal_scorecards   one row per completed interview of a survey that defines a scorecard (def.portal.scorecard):
--                       the raw score of each dimension, the comparison group(s) the person belongs to, and the
--                       fingerprint of the scoring they were computed with. It exists so a comparison never rescans
--                       every answer. A person's OWN scores are always recomputed from their answers when shown.
--   portal_benchmarks   one row per survey: the snapshot the portal compares against — per dimension and per group
--                       that may be shown, a count, mean, spread and percentile cut points. It names no person, and
--                       a group below the minimum size (never under 10) is not in it at all.
--
-- Both are CLIENT data and live with the survey's responses. Additive; nothing existing changes. Service role only:
-- row-level security on, no policy.

create table if not exists public.portal_scorecards (
  response_id uuid primary key references public.responses(id) on delete cascade,
  survey_id uuid not null references public.surveys(id) on delete cascade,
  respondent_id uuid references public.respondents(id) on delete set null,
  is_test boolean not null default false,
  fingerprint text not null check (char_length(fingerprint) between 1 and 64),
  scores jsonb not null default '{}'::jsonb check (jsonb_typeof(scores) = 'object'),
  cohort jsonb not null default '{}'::jsonb check (jsonb_typeof(cohort) = 'object'),
  result jsonb not null check (jsonb_typeof(result) = 'object' and (result ->> 'v') is not null),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists portal_scorecards_survey_idx on public.portal_scorecards (survey_id, is_test, fingerprint);
create index if not exists portal_scorecards_respondent_idx on public.portal_scorecards (respondent_id) where respondent_id is not null;
alter table public.portal_scorecards enable row level security;

create table if not exists public.portal_benchmarks (
  survey_id uuid primary key references public.surveys(id) on delete cascade,
  fingerprint text not null check (char_length(fingerprint) between 1 and 64),
  people integer not null default 0 check (people >= 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object' and (snapshot ->> 'v') is not null),
  computed_at timestamptz not null default now()
);
alter table public.portal_benchmarks enable row level security;

revoke all on public.portal_scorecards, public.portal_benchmarks from anon, authenticated;

insert into public.schema_marks (migration, note) values ('0104', 'respondent portal: scorecards per completed interview, benchmark snapshot per survey')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
