-- 0056 — an `abandoned` response status for partials nobody came back to (audit RUNTIME-07, 2026-10-16)
--
-- Nothing ever closed an `in_progress` response. A respondent who walked away on page 3 stayed "in progress"
-- for ever: fieldwork counts, the in-progress filter and any List Fill claims the session held all carried
-- them indefinitely. The Studio cron `/api/cron/expire-partials` now marks an `in_progress` row whose last
-- activity (last_saved_at, else started_at) is older than the survey's partial-expiry window (default 30 days)
-- as `abandoned`, and releases its List Fill claims the same way a screen-out does.
--
-- `abandoned` is deliberately its own status rather than `terminated`: a termination is a decision the survey
-- made (a screen-out, a quality kill); an abandonment is the respondent's silence. Reports must be able to
-- tell them apart.
--
-- Widening a CHECK never fails on existing rows: every stored value is still permitted. Re-runnable.

alter table public.responses drop constraint if exists responses_status_check;
alter table public.responses add constraint responses_status_check
  check (status in ('in_progress', 'complete', 'screened', 'quota_full', 'terminated', 'abandoned'));

-- No new index: the sweep filters by (survey_id, status) on non-deleted rows, which
-- responses_survey_env_status_idx (0006) already serves.
