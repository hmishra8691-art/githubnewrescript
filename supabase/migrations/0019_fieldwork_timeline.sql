-- =====================================================================
-- 0019 — FIELDWORK OVER TIME (§26 dashboard, §27 live monitoring)
--
-- Everything about fieldwork in this platform has been dimensioned by
-- SOMETHING ELSE: by supplier (0012), by list (0013), by quota cell, by
-- status, by environment. The one dimension nothing had was TIME. Before this
-- migration the string `date_trunc` did not appear anywhere in the repository,
-- and the only temporal facts any function returned were `min(started_at)` and
-- `max(started_at)` — first and last, with nothing in between.
--
-- That is the difference between "412 completes" and "412 completes, 180 of
-- them yesterday, none in the last four hours". The first is a number. The
-- second is a fieldwork decision.
--
-- Three functions, and one index.
--
--   rescript_field_timeline   the curve — a row per bucket, gapless
--   rescript_field_pulse      right now — one row, cheap enough to poll
--   rescript_field_positions  where the partials stopped
--
-- ## FOUR DECISIONS WORTH READING BEFORE CHANGING ANY OF THIS
--
-- 1. EVENTS, NOT COHORTS. A start belongs to the bucket of `started_at`; a
--    complete belongs to the bucket of `completed_at`. Somebody who started at
--    10:58 and finished at 11:03 is a start in the 10:00 hour and a complete
--    in the 11:00 hour. So within any window `sum(starts)` does NOT equal
--    `sum(completes) + sum(screened) + ...`, and that is correct rather than a
--    bug: the alternative — bucketing every outcome by `started_at` — answers
--    "of the people who arrived this hour, how many eventually finished",
--    which is a cohort question and is useless for watching delivery, because
--    the most recent bucket is always the emptiest and always looks like a
--    collapse.
--
-- 2. GAPLESS. The buckets come from `generate_series`, left-joined to the
--    counts. An hour in which nothing happened is a row with zeroes, never a
--    missing row. A chart fed missing rows draws a straight line across the
--    outage — the exact event the fieldwork manager opened the page to see.
--
-- 3. THE CALLER'S TIME ZONE, NOT THE SERVER'S. `date_trunc('day', ts)` on a
--    timestamptz truncates in whatever the session's TimeZone happens to be,
--    which on this platform is UTC. A fieldwork day for a team in Delhi is not
--    a UTC day, and "yesterday's completes" quietly meaning "UTC yesterday" is
--    a number that is wrong by five and a half hours and looks fine. So the
--    bucket is computed as `date_trunc(bucket, ts at time zone p_tz) at time
--    zone p_tz` — into local wall time, truncated there, and back to an
--    absolute instant for the caller.
--
-- 4. THE BUCKET VOCABULARY IS CLOSED, AND CHECKED. `p_bucket` reaches
--    `date_trunc` as a value, never as concatenated SQL, and an unrecognised
--    value raises rather than falling through to a default. A silent default
--    would mean a typo'd `?bucket=hours` charting days and labelling them
--    hours.
--
-- Needs 0001 (responses), 0006 (deleted_at, environment), 0012 (sample_source)
-- and 0015 (the fieldwork window on surveys). Idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- THE INDEX THE CURVE NEEDS — and the one it does not
--
-- `responses_survey_env_started_idx (survey_id, is_test, started_at desc)`
-- from 0006 already serves the starts curve. Nothing served the COMPLETES
-- curve: `completed_at` has never been indexed, so "completes in the last 24
-- hours" meant reading every response the survey has ever taken. That is the
-- read a fieldwork manager leaves open all day refreshing every thirty
-- seconds, so it is worth an index.
--
-- Partial on `completed_at is not null`, which on a live survey is a minority
-- of the rows and on a survey in field is a small minority.
--
-- Deliberately NOT added: an index on `updated_at` for the liveness read
-- below. That read is already narrowed to one survey's `in_progress` rows by
-- `responses_survey_env_status_idx`, and filtering a few hundred partials by
-- timestamp does not need help. `responses` is the hottest write table in the
-- platform — every autosave from every respondent updates a row — and an
-- index that earns nothing still costs every one of those writes.
-- ---------------------------------------------------------------------
create index if not exists responses_survey_env_completed_idx
  on public.responses (survey_id, is_test, completed_at desc)
  where completed_at is not null and deleted_at is null;

-- ---------------------------------------------------------------------
-- rescript_field_timeline — the curve
--
-- One row per bucket between p_from and p_to inclusive of the bucket
-- containing p_from, with counts of each event that happened in it.
--
-- `p_is_test` has no default, on purpose: the platform's rule is that
-- environment is never assumed (see 0006 and 0012). Test traffic must never
-- reach a curve somebody is about to read as delivery.
--
-- THE WINDOW IS SNAPPED OUT TO WHOLE BUCKETS, which is the one thing here
-- that is easy to get wrong and hard to notice. The obvious implementation
-- generates a bucket for the one containing `p_to` and then counts only events
-- up to `p_to` itself — so the last bucket of every single chart is a partial
-- bucket, and every chart ends in what looks like a collapse. Asking for
-- 09:00 to 13:00 hourly returns five whole hours, 09:00 through 13:59, and the
-- returned `bucket_start` values say exactly which. A total over the series is
-- then a well-defined quantity rather than a clipped one.
--
-- The series is generated in LOCAL wall time and each edge converted back,
-- rather than stepping an interval across absolute instants. Adding `interval
-- '1 day'` to a timestamptz adds 24 hours, so across a daylight-saving change
-- the buckets would slide an hour off local midnight and stay there. In local
-- space a day is a day. The event FILTER, though, is expressed against the raw
-- timestamptz columns, because `started_at at time zone $1 >= $2` cannot use
-- an index and this read is polled all day.
--
-- The bucket count is capped. An unbounded `generate_series` of hours across
-- a year is 8 760 rows travelling to a browser to be drawn 3 pixels wide;
-- refusing with the number is more useful than either truncating silently or
-- timing out.
-- ---------------------------------------------------------------------
create or replace function public.rescript_field_timeline(
  p_survey uuid,
  p_is_test boolean,
  p_bucket text,
  p_from timestamptz,
  p_to timestamptz,
  p_tz text default 'UTC'
)
returns table (
  bucket_start timestamptz,
  starts bigint,
  completes bigint,
  screened bigint,
  quota_full bigint,
  terminated bigint,
  median_seconds numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_step interval;
  v_first_local timestamp;
  v_last_local timestamp;
  v_from_abs timestamptz;
  v_to_abs timestamptz;
  v_buckets numeric;
begin
  if p_bucket not in ('hour', 'day', 'week') then
    raise exception 'unknown bucket %; expected hour, day or week', p_bucket
      using errcode = 'invalid_parameter_value';
  end if;

  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'the window must run forwards: from % to %', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;

  -- validated by using it: an unknown zone raises here rather than silently
  -- becoming UTC three lines later
  perform now() at time zone p_tz;

  v_step := case p_bucket
              when 'hour' then interval '1 hour'
              when 'day'  then interval '1 day'
              else             interval '1 week'
            end;

  /*
   * The window, snapped out to whole buckets, in the caller's wall time. The
   * absolute bounds are derived from those — so the filter below is a plain
   * timestamptz range that the indexes can serve, while the bucket arithmetic
   * stays in local space where a day is a calendar day.
   */
  v_first_local := date_trunc(p_bucket, p_from at time zone p_tz);
  v_last_local  := date_trunc(p_bucket, p_to   at time zone p_tz);
  v_from_abs := v_first_local at time zone p_tz;
  v_to_abs   := (v_last_local + v_step) at time zone p_tz;

  v_buckets := extract(epoch from (v_last_local - v_first_local))
               / extract(epoch from v_step) + 1;
  if v_buckets > 2000 then
    raise exception 'that window is % % buckets; narrow it or choose a coarser bucket',
      ceil(v_buckets), p_bucket
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  with
  /* the bucket boundaries, as local wall time */
  edges as (
    select generate_series(v_first_local, v_last_local, v_step) as b
  ),
  /*
   * Every response of this survey and environment with an event inside the
   * window. One row here can contribute a start to one bucket and an outcome
   * to another, which is why the counting below is done per event rather than
   * with a single group-by.
   *
   * Half-open on the upper bound: an event at exactly the first instant of the
   * bucket after the last belongs to that next bucket, and counting it here
   * as well would double it in any two adjacent windows.
   */
  live as (
    select r.started_at, r.completed_at, r.status,
           case
             when r.completed_at is not null and r.started_at is not null
             then extract(epoch from (r.completed_at - r.started_at))
           end as secs
    from public.responses r
    where r.survey_id = p_survey
      and r.is_test = p_is_test
      and r.deleted_at is null
      and (
        (r.started_at >= v_from_abs and r.started_at < v_to_abs)
        or (r.completed_at is not null
            and r.completed_at >= v_from_abs and r.completed_at < v_to_abs)
      )
  ),
  started as (
    select date_trunc(p_bucket, started_at at time zone p_tz) as b,
           count(*) as n
    from live
    where started_at >= v_from_abs and started_at < v_to_abs
    group by 1
  ),
  /*
   * Ended events, keyed on when they ENDED. `completed_at` is stamped for
   * every terminal status, not only 'complete' — a screen-out is an outcome
   * that happened at a moment, and a screen-out curve is how a fieldwork
   * manager sees a supplier's quality change during the day.
   */
  ended as (
    select date_trunc(p_bucket, completed_at at time zone p_tz) as b,
           count(*) filter (where status = 'complete')   as completes,
           count(*) filter (where status = 'screened')   as screened,
           count(*) filter (where status = 'quota_full') as quota_full,
           count(*) filter (where status = 'terminated') as terminated,
           round(percentile_cont(0.5) within group (
             order by case when status = 'complete' then secs end
           )::numeric, 0) as median_seconds
    from live
    where completed_at is not null
      and completed_at >= v_from_abs and completed_at < v_to_abs
    group by 1
  )
  select
    (edges.b at time zone p_tz)             as bucket_start,
    coalesce(started.n, 0)::bigint          as starts,
    coalesce(ended.completes, 0)::bigint    as completes,
    coalesce(ended.screened, 0)::bigint     as screened,
    coalesce(ended.quota_full, 0)::bigint   as quota_full,
    coalesce(ended.terminated, 0)::bigint   as terminated,
    ended.median_seconds
  from edges
  left join started on started.b = edges.b
  left join ended   on ended.b   = edges.b
  order by edges.b;
end;
$$;

comment on function public.rescript_field_timeline(uuid, boolean, text, timestamptz, timestamptz, text) is
  'Fieldwork over time for one survey and environment: starts, completes, screen-outs and median duration per hour/day/week, bucketed in the caller''s time zone. Gapless — a bucket with no activity is a row of zeroes. Starts are keyed on started_at and outcomes on completed_at, so the two do not sum to each other.';

-- ---------------------------------------------------------------------
-- rescript_field_pulse — right now, in one row
--
-- This is the read behind §27, and it is designed to be POLLED: one row, no
-- series, no join to anything, every predicate served by an existing index.
--
-- "In field" means an `in_progress` response touched within
-- p_active_seconds. The column is `updated_at`, which the `responses_touch`
-- trigger moves on every write, so every autosave from a respondent keeps
-- them counted. The caveat, stated rather than hidden: a reviewer editing a
-- response also moves `updated_at`. It cannot pollute this number, because
-- only `in_progress` rows are counted and review happens on finished ones —
-- but if that ever stops being true, this is the line that becomes wrong.
--
-- The window counts (last p_window_minutes) are here rather than obtained by
-- calling the timeline with a one-bucket window, because "completes in the
-- last hour" is a rolling hour and a bucket is a clock hour. At 10:05 the
-- clock hour holds five minutes of data, and a monitor that reported that as
-- the current rate would announce a collapse every hour on the hour.
-- ---------------------------------------------------------------------
create or replace function public.rescript_field_pulse(
  p_survey uuid,
  p_is_test boolean,
  p_active_seconds integer default 900,
  p_window_minutes integer default 60
)
returns table (
  -- right now
  in_field bigint,
  stalled bigint,
  -- the rolling window
  window_minutes integer,
  window_starts bigint,
  window_completes bigint,
  window_screened bigint,
  window_quota_full bigint,
  window_terminated bigint,
  window_median_seconds numeric,
  -- since the beginning, for the same environment
  total_starts bigint,
  total_completes bigint,
  total_partials bigint,
  last_start_at timestamptz,
  last_complete_at timestamptz,
  last_activity_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with live as (
    select r.status, r.started_at, r.completed_at, r.updated_at,
           case
             when r.completed_at is not null and r.started_at is not null
             then extract(epoch from (r.completed_at - r.started_at))
           end as secs
    from public.responses r
    where r.survey_id = p_survey
      and r.is_test = p_is_test
      and r.deleted_at is null
  )
  select
    count(*) filter (
      where status = 'in_progress'
        and updated_at >= now() - make_interval(secs => greatest(p_active_seconds, 0))
    )::bigint as in_field,
    count(*) filter (
      where status = 'in_progress'
        and updated_at <  now() - make_interval(secs => greatest(p_active_seconds, 0))
    )::bigint as stalled,
    greatest(p_window_minutes, 1) as window_minutes,
    count(*) filter (
      where started_at >= now() - make_interval(mins => greatest(p_window_minutes, 1))
    )::bigint as window_starts,
    count(*) filter (
      where status = 'complete'
        and completed_at >= now() - make_interval(mins => greatest(p_window_minutes, 1))
    )::bigint as window_completes,
    count(*) filter (
      where status = 'screened'
        and completed_at >= now() - make_interval(mins => greatest(p_window_minutes, 1))
    )::bigint as window_screened,
    count(*) filter (
      where status = 'quota_full'
        and completed_at >= now() - make_interval(mins => greatest(p_window_minutes, 1))
    )::bigint as window_quota_full,
    count(*) filter (
      where status = 'terminated'
        and completed_at >= now() - make_interval(mins => greatest(p_window_minutes, 1))
    )::bigint as window_terminated,
    round(percentile_cont(0.5) within group (
      order by case
        when status = 'complete'
          and completed_at >= now() - make_interval(mins => greatest(p_window_minutes, 1))
        then secs
      end
    )::numeric, 0) as window_median_seconds,
    count(*)::bigint as total_starts,
    count(*) filter (where status = 'complete')::bigint as total_completes,
    count(*) filter (where status = 'in_progress')::bigint as total_partials,
    max(started_at) as last_start_at,
    max(completed_at) filter (where status = 'complete') as last_complete_at,
    max(updated_at) as last_activity_at
  from live;
$$;

comment on function public.rescript_field_pulse(uuid, boolean, integer, integer) is
  'One row of live fieldwork state for a survey and environment: how many respondents are in field now, how many partials have stalled, a rolling window of starts and outcomes, and the running totals. Cheap enough to poll.';

-- ---------------------------------------------------------------------
-- rescript_field_positions — where the partials stopped
--
-- `responses.step_index` is the respondent's position in the compiled flow,
-- written on every save since 0001 and read, until now, by nothing but the
-- resume path. Grouped over the `in_progress` rows it is the drop-off
-- distribution: "of 412 partials, 180 stopped at step 7" is the sentence that
-- makes somebody go and look at step 7.
--
-- It returns the step INDEX and no label, because a step number means a page
-- only in the context of a compiled definition, and which definition a
-- response was taken against is the response's own `version_id` — resolving
-- that here would mean compiling flows in SQL. The caller maps indexes to
-- page names using the definition it already has loaded; where a response
-- came from an older version whose flow was shorter, an index can exceed the
-- current page count, and that is a real fact about a live survey rather than
-- an error to hide.
-- ---------------------------------------------------------------------
create or replace function public.rescript_field_positions(
  p_survey uuid,
  p_is_test boolean,
  p_active_seconds integer default 900
)
returns table (
  step_index integer,
  in_field bigint,
  stalled bigint,
  oldest_at timestamptz,
  newest_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.step_index,
    count(*) filter (
      where r.updated_at >= now() - make_interval(secs => greatest(p_active_seconds, 0))
    )::bigint as in_field,
    count(*) filter (
      where r.updated_at <  now() - make_interval(secs => greatest(p_active_seconds, 0))
    )::bigint as stalled,
    min(r.updated_at) as oldest_at,
    max(r.updated_at) as newest_at
  from public.responses r
  where r.survey_id = p_survey
    and r.is_test = p_is_test
    and r.deleted_at is null
    and r.status = 'in_progress'
  group by r.step_index
  order by r.step_index;
$$;

comment on function public.rescript_field_positions(uuid, boolean, integer) is
  'Drop-off distribution for a survey and environment: for each step index, how many in-progress respondents are sitting there now and how many have stalled. Step indexes are relative to the definition each response was taken against; the caller supplies the page names.';

-- ---------------------------------------------------------------------
-- Access.
--
-- Same posture as 0012 and 0013: security definer with the survey check made
-- by the calling route through `requireProject(..., 'responses.read')`, and
-- execute granted to `authenticated` and `service_role` only. `anon` never
-- reaches fieldwork figures — the only public door in the platform is the
-- read-only report share token, and that resolves through its own function.
-- ---------------------------------------------------------------------
grant execute on function public.rescript_field_timeline(uuid, boolean, text, timestamptz, timestamptz, text) to authenticated, service_role;
grant execute on function public.rescript_field_pulse(uuid, boolean, integer, integer) to authenticated, service_role;
grant execute on function public.rescript_field_positions(uuid, boolean, integer) to authenticated, service_role;

revoke all on function public.rescript_field_timeline(uuid, boolean, text, timestamptz, timestamptz, text) from anon;
revoke all on function public.rescript_field_pulse(uuid, boolean, integer, integer) from anon;
revoke all on function public.rescript_field_positions(uuid, boolean, integer) from anon;
