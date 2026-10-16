-- 0058 — weekly housekeeping: retention for the tables that only ever grew (audit SCHEMA-09, SCHEMA-08, 2026-10-16)
--
-- Nothing deleted:
--   analytics_result_cache  rows past expires_at (0052 sets a 30-day expiry and checks it on read; no one
--                           removed the expired rows)
--   login_attempts          every sign-in attempt since 0008 (the lockout reads a window of minutes)
--   analytics_share_access  every share-link view / download / denial since 0011 (the guards read hours)
--   interview_telemetry     every candidate-side event since 0030 (interview retention removes a whole
--                           interview's telemetry, but nothing aged out the events of kept interviews)
--   auth_handoff_codes      `rescript_auth_sweep_handoff` (0032) existed with no caller
--
-- `rescript_housekeeping()` does all five and returns the counts as jsonb. It is called weekly by the
-- Studio cron `/api/cron/housekeeping` (CRON_SECRET, as the other Studio crons). Each table is trimmed in
-- batches of at most p_batch rows per call so a first run over a large backlog cannot hold a long lock;
-- the route calls again while a batch came back full. Defaults:
--   expired cache rows        always
--   login attempts            older than 90 days
--   share access log          older than 180 days
--   interview telemetry       older than 180 days
--   auth handoff codes        older than 60 minutes (the sweep's own default)
--
-- SCHEMA-08: `design_files` (0001) is unused — conjoint/MaxDiff designs ship inline in the definition
-- (`designs[].file.rows`). It is NOT dropped: the audit's own recommendation is to keep it until a loader
-- for `designs[].file.storagePath` exists, and moving designs out of the definition would use it. Marked
-- with a table comment instead; the decision is recorded in docs/MIGRATION-UNDO-NOTES.md.
--
-- Re-runnable. Undo: docs/MIGRATION-UNDO-NOTES.md. Applied to rescript-survey-platform on 2026-10-16 (SQL editor).

-- the age predicates need an index that leads with created_at (the existing ones lead with identifier / ip / share / interview)
create index if not exists login_attempts_created_idx on public.login_attempts (created_at);
create index if not exists analytics_share_access_created_idx on public.analytics_share_access (created_at);
create index if not exists interview_telemetry_created_idx on public.interview_telemetry (created_at);

create or replace function public.rescript_housekeeping(
  p_login_days integer default 90,
  p_share_access_days integer default 180,
  p_telemetry_days integer default 180,
  p_batch integer default 50000
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  n_cache integer := 0;
  n_login integer := 0;
  n_share integer := 0;
  n_telemetry integer := 0;
  n_handoff integer := 0;
  lim integer := greatest(1, least(coalesce(p_batch, 50000), 500000));
begin
  delete from public.analytics_result_cache c
   where (c.survey_id, c.input_hash) in (select x.survey_id, x.input_hash from public.analytics_result_cache x
                                          where x.expires_at < now() limit lim);
  get diagnostics n_cache = row_count;

  delete from public.login_attempts a
   where a.id in (select x.id from public.login_attempts x
                   where x.created_at < now() - make_interval(days => greatest(1, coalesce(p_login_days, 90))) limit lim);
  get diagnostics n_login = row_count;

  delete from public.analytics_share_access a
   where a.id in (select x.id from public.analytics_share_access x
                   where x.created_at < now() - make_interval(days => greatest(1, coalesce(p_share_access_days, 180))) limit lim);
  get diagnostics n_share = row_count;

  delete from public.interview_telemetry t
   where t.id in (select x.id from public.interview_telemetry x
                   where x.created_at < now() - make_interval(days => greatest(1, coalesce(p_telemetry_days, 180))) limit lim);
  get diagnostics n_telemetry = row_count;

  n_handoff := coalesce(public.rescript_auth_sweep_handoff(60), 0);

  return jsonb_build_object(
    'analytics_result_cache', n_cache,
    'login_attempts', n_login,
    'analytics_share_access', n_share,
    'interview_telemetry', n_telemetry,
    'auth_handoff_codes', n_handoff,
    'batch', lim,
    'more', (n_cache = lim or n_login = lim or n_share = lim or n_telemetry = lim)
  );
end $$;

revoke all on function public.rescript_housekeeping(integer, integer, integer, integer) from public, anon, authenticated;

-- SCHEMA-08: kept, marked
comment on table public.design_files is
  'unused — designs ship inline in the definition; see docs/MIGRATION-UNDO-NOTES.md';
