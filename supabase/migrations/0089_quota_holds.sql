-- 0089 — Quota holds, and the mapping that makes them possible (2026-11-05).
--
-- 0088 built the cells and five primitives. Nothing called them. This is the wiring, and it corrects the one
-- thing 0088 could not have known: that the cells a respondent is HELD in and the cells they are COUNTED in
-- are not the same cells.
--
-- ## A hold has to belong to a session
--
-- `rescript_quota_hold` increments `in_progress` and has no idea who holds it. That is harmless in a test and
-- wrong in a field period. A respondent who closes the tab on question three holds their slot for ever;
-- `in_progress` counts against the target in `rescript_quota_check`; and a cell with fifty abandoned starts
-- stops admitting anybody while it is nowhere near full. So a hold is a ROW now, keyed by session, and three
-- things end it: the completion, any other terminal save, and the abandonment sweep.
--
-- ## Held cells and counted cells differ, and that is normal
--
-- The hold is taken on what the VENDOR claimed at the door — it is all that is known then, and the door is the
-- only moment at which turning somebody away is cheap. The completion is counted on what the SURVEY observed,
-- because the person answering the question is better evidence than a panel profile filled in three years ago.
--
-- When those disagree, two slots go wrong at once: the cell that was held keeps a slot for somebody who
-- finished as somebody else, and the cell that is counted never had a slot held for them.
--
-- 0088's `rescript_quota_record` decremented `in_progress` on every cell it counted into — which silently
-- assumes the hold was taken on exactly those cells. In both directions that is wrong: a held cell that is not
-- counted never gets its slot back, and a counted cell that was never held has SOMEBODY ELSE'S hold taken off
-- it. A function that does not know what was held cannot adjust it, so this one stops trying: `record` now
-- counts and nothing else, and the correction is made where the hold is actually known.
--
-- The completion is then exactly the two primitives, composed:
--
--      release every cell the CLAIM held        (rescript_quota_hold … p_release => true)
--      count   every cell the MERGE belongs to  (rescript_quota_record)
--
-- Cells in both get one of each, which is right. Cells only in the first get their slot back, which is the
-- leak. Cells only in the second are counted without a release, which is what should happen to a cell nobody
-- held a slot in.
--
-- ## The mapping is configuration, not a guess
--
-- One vendor sends `?gender=m`, another `?g=1`, another `?sex=Male`. No rule reads all three, and inventing one
-- is how a project counts every man as a woman for a week before anybody notices. `quota_mapping` is where a
-- project declares its vendors' parameter names and values; an unmapped parameter produces no attribute, and a
-- respondent with no attributes is ADMITTED, because refusing people a cell cannot be proven to contain turns
-- away valid sample over a configuration gap.
--
-- Re-runnable: `if not exists`, `drop … if exists` first, `create or replace`. Undo:
--   drop table if exists public.quota_holds cascade;
--   alter table public.recruitment_projects drop column if exists quota_mapping;
--   (and re-apply 0088 to restore rescript_quota_record's old body)

/* ------------------------------------------------------------ the project's mapping */

alter table public.recruitment_projects
  -- vendor parameter name -> { criterion, values?, bands? }. See packages/identity/src/attributes.ts.
  add column if not exists quota_mapping jsonb not null default '{}'::jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'recruitment_projects_quota_mapping') then
    alter table public.recruitment_projects
      add constraint recruitment_projects_quota_mapping
        check (jsonb_typeof(quota_mapping) = 'object' and pg_column_size(quota_mapping) <= 65536);
  end if;
end $$;

/* ------------------------------------------------------------ the hold */

create table if not exists public.quota_holds (
  -- one hold per session: a survey has one recruitment project, and a session starts once
  session_id text primary key,
  recruitment_project_id uuid not null references public.recruitment_projects(id) on delete cascade,
  -- what the vendor claimed, read through the mapping. This is what gets released, whatever the survey found.
  claimed jsonb not null default '{}'::jsonb,
  -- what the survey observed, written at the end. Kept beside the claim because the disagreement is evidence.
  observed jsonb,
  /*
   * Where the two disagree: [{"criterion":"gender","claimed":"male","observed":"female"}]. A vendor whose
   * demographic claims do not survive contact with the questions is selling sample it has mis-described, and
   * this is the only place that fact is written down.
   */
  conflicts jsonb not null default '[]'::jsonb,
  -- how many cells the hold touched, so a release can be checked against what was taken
  cells integer not null default 0 check (cells >= 0),
  held_at timestamptz not null default now(),
  released_at timestamptz,
  outcome text,
  constraint quota_holds_outcome check (
    outcome is null or outcome in ('complete', 'screened', 'quota_full', 'terminated', 'abandoned')
  ),
  -- a released hold has a reason; an open hold has neither
  constraint quota_holds_release_pair check ((released_at is null) = (outcome is null))
);

create index if not exists quota_holds_project_idx on public.quota_holds (recruitment_project_id, held_at desc);
-- the sweep's query: open holds, oldest first
create index if not exists quota_holds_open_idx on public.quota_holds (held_at) where released_at is null;

alter table public.quota_holds enable row level security;

/*
 * The same reach as quota_progress: a hold is the researcher's own fieldwork, not supply-chain information.
 * It names no vendor — the claim it carries has already been translated out of the vendor's vocabulary.
 */
drop policy if exists quota_holds_read on public.quota_holds;
create policy quota_holds_read on public.quota_holds for select to authenticated
  using (
    public.rescript_recruitment_project_customer(recruitment_project_id) = public.current_customer_id()
    or public.rescript_is_platform_admin(auth.uid())
  );

revoke all on public.quota_holds from anon;
grant select on public.quota_holds to authenticated;

/* ------------------------------------------------------------ record stops guessing about holds */

/**
 * Count a completed respondent into every cell they belong to.
 *
 * CHANGED from 0088: this no longer touches `in_progress`. It is handed attributes, not a session, so it
 * cannot know whether a slot was held on these cells or on different ones — and a decrement made on that
 * assumption either strands a slot in the cell that WAS held or steals one from a cell that was not.
 * `rescript_quota_complete_session` releases the real hold before calling this.
 *
 * Over-recruitment is still recorded, never refused: by the time this runs the respondent has answered every
 * question and is owed their incentive, so refusing the record would lose the data and still cost the money.
 */
create or replace function public.rescript_quota_record(p_project uuid, p_attributes jsonb)
returns table (counted integer, now_full text[], overshot text[])
language plpgsql security definer set search_path = public as $$
declare v_counted integer; v_full text[]; v_over text[];
begin
  with hit as (
    update public.quota_progress q
       set accepted = q.accepted + 1,
           first_complete_at = coalesce(q.first_complete_at, now()),
           last_complete_at = now(),
           updated_at = now()
     where q.recruitment_project_id = p_project
       and coalesce(p_attributes, '{}'::jsonb) @> q.criteria
    returning q.cell_id, q.accepted, q.target
  )
  select count(*)::integer,
         coalesce(array_agg(cell_id) filter (where accepted >= target and target > 0), '{}'),
         coalesce(array_agg(cell_id) filter (where accepted > target and target > 0), '{}')
    into v_counted, v_full, v_over
    from hit;

  return query select coalesce(v_counted, 0), v_full, v_over;
end;
$$;

/* ------------------------------------------------------------ the three session moments */

/**
 * Somebody has started. Hold a slot in every cell their CLAIMED attributes put them in.
 *
 * Idempotent on the session: a reload, a retried start, two tabs — the second call finds the row and
 * increments nothing. Without that a respondent who refreshes twice holds three slots.
 */
create or replace function public.rescript_quota_hold_session(
  p_project uuid, p_session text, p_claimed jsonb
) returns table (held boolean, cells integer)
language plpgsql security definer set search_path = public as $$
declare v_new boolean := false; v_cells integer := 0;
begin
  insert into public.quota_holds (session_id, recruitment_project_id, claimed)
  values (p_session, p_project, coalesce(p_claimed, '{}'::jsonb))
  on conflict (session_id) do nothing;

  get diagnostics v_cells = row_count;
  v_new := v_cells > 0;
  if not v_new then
    return query select false, 0;
    return;
  end if;

  /*
   * An empty claim holds NOTHING: `'{}'::jsonb @> '{"gender":"male"}'` is false, so a respondent whose
   * attributes the mapping could not resolve matches no cell and reserves no slot. That is the right answer —
   * a slot cannot be held in a cell membership of which cannot be shown — and it is why the quota is still
   * protected: the completion is counted on what the survey observed, whatever the door knew.
   */
  v_cells := public.rescript_quota_hold(p_project, coalesce(p_claimed, '{}'::jsonb), false);
  update public.quota_holds h set cells = v_cells where h.session_id = p_session;
  return query select true, v_cells;
end;
$$;

/**
 * The session ended without a complete — screened out, terminated, quota full, or swept up as abandoned.
 *
 * Gives the slots back and nothing else. Keyed on the session alone: the hold row knows its project, so the
 * abandonment sweep does not have to look one up per row.
 *
 * Idempotent: an already-released hold returns 0. A session that never held one returns 0 too, which is the
 * ordinary case for a study with no quota cells.
 */
create or replace function public.rescript_quota_release_session(
  p_session text, p_outcome text
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_hold public.quota_holds; v_cells integer;
begin
  select * into v_hold from public.quota_holds
   where session_id = p_session and released_at is null for update;
  if not found then return 0; end if;

  v_cells := public.rescript_quota_hold(v_hold.recruitment_project_id, v_hold.claimed, true);
  update public.quota_holds
     set released_at = now(),
         outcome = case when p_outcome in ('screened', 'quota_full', 'terminated', 'abandoned')
                        then p_outcome else 'abandoned' end
   where session_id = p_session;
  return v_cells;
end;
$$;

/**
 * The session completed. Release what the claim held, count what the survey observed.
 *
 * The merge is `claimed || observed`: the survey wins every contest, and a criterion the survey did not ask
 * about keeps the vendor's answer rather than becoming unknown. The two steps are the two primitives, and
 * they are two steps on purpose — see this migration's header for what happens when one function tries to be
 * both.
 *
 * The disagreements are worked out HERE rather than passed in, because this is the only moment at which both
 * halves exist in the same place: the claim is on the hold row, the observation has just arrived, and the
 * caller saving the response has never seen the claim. Asking it to supply the comparison would mean reading
 * the hold back first — a round trip on the save path to recompute something this statement can see.
 *
 * Only where BOTH have a value and the values differ. A criterion the survey did not ask about is not a
 * disagreement; counting it as one would make every vendor look like a liar for the questions nobody put to
 * the respondent. Nor is the reverse — a claim of nothing and an answer of something is the survey learning.
 *
 * A session with no hold still counts. An arrival that did not come through the gateway — a direct link, a
 * test, a study that turned recruitment on mid-field — is a real complete, and refusing to count it would
 * make the dashboard disagree with the data.
 */
create or replace function public.rescript_quota_complete_session(
  p_project uuid, p_session text, p_observed jsonb
) returns table (counted integer, now_full text[], overshot text[], released integer, corrected boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_hold public.quota_holds;
  v_merged jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_released integer := 0;
  v_rec record;
begin
  select * into v_hold from public.quota_holds
   where session_id = p_session and released_at is null for update;

  if found then
    v_merged := coalesce(v_hold.claimed, '{}'::jsonb) || coalesce(p_observed, '{}'::jsonb);

    select coalesce(jsonb_agg(jsonb_build_object(
             'criterion', o.key, 'claimed', c.value, 'observed', o.value) order by o.key), '[]'::jsonb)
      into v_conflicts
      from jsonb_each_text(coalesce(p_observed, '{}'::jsonb)) o
      join jsonb_each_text(coalesce(v_hold.claimed, '{}'::jsonb)) c on c.key = o.key
     where c.value is distinct from o.value;

    v_released := public.rescript_quota_hold(v_hold.recruitment_project_id, v_hold.claimed, true);
    update public.quota_holds h
       set released_at = now(), outcome = 'complete',
           observed = coalesce(p_observed, '{}'::jsonb),
           conflicts = v_conflicts
     where h.session_id = p_session;
  else
    v_merged := coalesce(p_observed, '{}'::jsonb);
  end if;

  select * into v_rec from public.rescript_quota_record(p_project, v_merged);

  return query select v_rec.counted, v_rec.now_full, v_rec.overshot, v_released,
                      jsonb_array_length(v_conflicts) > 0;
end;
$$;

/**
 * The abandonment sweep's release: every open hold among these sessions, in one statement.
 *
 * A loop would be one round trip per abandoned respondent, and the sweep abandons them five hundred at a
 * time. More to the point, the arithmetic cannot be done per row with a single UPDATE … FROM: one quota cell
 * can match several different claims, and Postgres updates a row once per statement however many FROM rows
 * match it, so the counts have to be aggregated per CELL before anything is written. Releasing four claims
 * that all match the same cell has to take four slots off it, not one.
 */
create or replace function public.rescript_quota_release_abandoned(p_sessions text[])
returns integer language plpgsql security definer set search_path = public as $$
declare v_released integer := 0;
begin
  with taken as (
    update public.quota_holds h
       set released_at = now(), outcome = 'abandoned'
     where h.session_id = any (coalesce(p_sessions, '{}'::text[]))
       and h.released_at is null
    returning h.recruitment_project_id as project, h.claimed as claimed
  ),
  per_cell as (
    select q.id as cell, count(*)::integer as n
      from taken t
      join public.quota_progress q
        on q.recruitment_project_id = t.project and t.claimed @> q.criteria
     group by q.id
  ),
  given_back as (
    update public.quota_progress q
       set in_progress = greatest(q.in_progress - p.n, 0), updated_at = now()
      from per_cell p
     where q.id = p.cell
    returning 1
  )
  select count(*)::integer into v_released from taken;
  return coalesce(v_released, 0);
end;
$$;

revoke all on function public.rescript_quota_hold_session(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.rescript_quota_release_abandoned(text[]) from public, anon, authenticated;
revoke all on function public.rescript_quota_release_session(text, text) from public, anon, authenticated;
revoke all on function public.rescript_quota_complete_session(uuid, text, jsonb) from public, anon, authenticated;

comment on table public.quota_holds is
  'A slot held for a session in progress, and the claim it was held on (0089). Released by the completion, by any other terminal save, and by the abandonment sweep — a hold nothing releases closes a cell that is not full.';
comment on column public.quota_holds.conflicts is
  'Where the vendor''s claim and the survey''s answer disagreed. A vendor whose demographics do not survive the screener is mis-describing its sample.';
comment on column public.recruitment_projects.quota_mapping is
  'Vendor URL parameter -> quota criterion, declared per project. Unmapped parameters produce no attribute; a respondent with no attributes is admitted (0089).';
