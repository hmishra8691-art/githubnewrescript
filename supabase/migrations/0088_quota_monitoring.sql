-- 0088 — Quota monitoring (2026-11-05).
--
-- The audience specification has carried quota cells since 0081; nothing has ever counted against them. This
-- adds the counting, and the two operations that make it useful:
--
--   check   at ADMISSION, before a respondent starts: is there room in the cells they belong to? A person
--           turned away here has lost thirty seconds. A person turned away after finishing has lost twenty
--           minutes and is owed an incentive either way, which is why the check belongs at the door.
--   record  at COMPLETION: increment, and say whether the cell is now full so the orchestrator can stop
--           steering recruitment into it.
--
-- ## The race
--
-- Two respondents finishing into the last slot of a cell is the same race `participation_ledger` faced in
-- 0083, and application-level counting loses it the same way: both read 499 of 500, both write 500, and the
-- project has bought 501 completes for a cell that needed 500. The increment here is a single conditional
-- UPDATE, so the database decides.
--
-- ## Over-recruitment is recorded, never refused
--
-- `rescript_quota_record` does not reject a complete that overshoots. By the time it is called the respondent
-- has answered every question and is owed their incentive; refusing the record would lose the data and still
-- cost the money. It is counted, flagged, and shown — somebody paid for it and should see it.
--
-- Re-runnable: `if not exists`, `drop … if exists` first, `create or replace`. Undo:
--   drop table if exists public.quota_progress cascade;

create table if not exists public.quota_progress (
  id uuid primary key default gen_random_uuid(),
  recruitment_project_id uuid not null references public.recruitment_projects(id) on delete cascade,
  /* the cell's id from the audience specification, so the two stay addressable by the same key */
  cell_id text not null check (char_length(cell_id) between 1 and 60),
  label text not null default '',
  /*
   * Which criteria this cell constrains, joined and sorted — "gender", or "ageBand+gender" for a cell of the
   * cross. Stored rather than derived so a report does not have to re-implement the grouping rule that
   * packages/recruitment/src/quotas.ts applies.
   */
  dimension text not null default '*',
  criteria jsonb not null default '{}'::jsonb,

  target integer not null default 0 check (target >= 0),
  accepted integer not null default 0 check (accepted >= 0),
  /* started but not yet finished, so a cell is not oversold while twenty people are mid-survey */
  in_progress integer not null default 0 check (in_progress >= 0),
  /* turned away at the door because this cell was already full */
  turned_away integer not null default 0 check (turned_away >= 0),

  first_complete_at timestamptz,
  last_complete_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists quota_progress_cell_uniq
  on public.quota_progress (recruitment_project_id, cell_id);
create index if not exists quota_progress_project_idx
  on public.quota_progress (recruitment_project_id, dimension);

alter table public.quota_progress enable row level security;

/*
 * Readable by the project's own organisation in the roles that run recruitment. A quota cell carries no
 * supply-chain information — it is the researcher's own targeting — so this is NOT narrowed to platform
 * administrators the way the commercial tables are.
 */
drop policy if exists quota_progress_read on public.quota_progress;
create policy quota_progress_read on public.quota_progress for select to authenticated
  using (
    public.rescript_recruitment_project_customer(recruitment_project_id) = public.current_customer_id()
    or public.rescript_is_platform_admin(auth.uid())
  );

revoke all on public.quota_progress from anon;
grant select on public.quota_progress to authenticated;

/* ------------------------------------------------------------ writing the specification down */

/**
 * Replace a project's quota cells with the ones its audience now specifies.
 *
 * `accepted` is PRESERVED across a rewrite. A researcher adjusting a target from 500 to 600 mid-field has not
 * un-recruited the 300 people already counted, and resetting the count would make the dashboard lie and the
 * steering recruit a filled cell all over again.
 */
create or replace function public.rescript_quota_sync(p_project uuid, p_cells jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_rows integer := 0;
begin
  insert into public.quota_progress (recruitment_project_id, cell_id, label, dimension, criteria, target)
  select p_project,
         c->>'id',
         coalesce(c->>'label', ''),
         coalesce(c->>'dimension', '*'),
         coalesce(c->'criteria', '{}'::jsonb),
         coalesce((c->>'targetCompletes')::integer, 0)
    from jsonb_array_elements(coalesce(p_cells, '[]'::jsonb)) c
  on conflict (recruitment_project_id, cell_id) do update
    set label = excluded.label, dimension = excluded.dimension,
        criteria = excluded.criteria, target = excluded.target,
        updated_at = now();
  get diagnostics v_rows = row_count;

  -- a cell removed from the specification stops being tracked; its history is not interesting once it is gone
  delete from public.quota_progress
   where recruitment_project_id = p_project
     and cell_id not in (select c->>'id' from jsonb_array_elements(coalesce(p_cells, '[]'::jsonb)) c);

  return v_rows;
end;
$$;

/**
 * Is there room for somebody matching these criteria?
 *
 * Returns the cells they belong to and whether every one of them has space. A respondent belongs to a cell
 * when the cell's criteria are a SUBSET of theirs — a cell constraining `{gender: male}` matches a male
 * respondent of any age, and a cell constraining `{gender: male, ageBand: 18-34}` matches only if both agree.
 *
 * `in_progress` counts against the target. Twenty people mid-survey in a cell with ten slots left is how a
 * quota is overshot by people who were all admitted correctly.
 */
create or replace function public.rescript_quota_check(p_project uuid, p_attributes jsonb)
returns table (admit boolean, full_cells text[], matched integer)
language plpgsql stable security definer set search_path = public as $$
declare v_full text[]; v_matched integer;
begin
  select coalesce(array_agg(q.cell_id) filter (where q.accepted + q.in_progress >= q.target), '{}'),
         count(*)
    into v_full, v_matched
    from public.quota_progress q
   where q.recruitment_project_id = p_project
     and q.target > 0
     -- the cell's criteria must all be present and equal in the respondent's attributes
     and coalesce(p_attributes, '{}'::jsonb) @> q.criteria;

  return query select coalesce(array_length(v_full, 1), 0) = 0, v_full, coalesce(v_matched, 0)::integer;
end;
$$;

/**
 * Count a completed respondent into every cell they belong to.
 *
 * One conditional statement per cell, so two completes landing on the last slot contend in the database
 * rather than in application code. Returns the cells that are now full, for the orchestrator to stop
 * steering into, and the ones that went OVER, which is reported rather than prevented.
 */
create or replace function public.rescript_quota_record(p_project uuid, p_attributes jsonb)
returns table (counted integer, now_full text[], overshot text[])
language plpgsql security definer set search_path = public as $$
declare v_counted integer; v_full text[]; v_over text[];
begin
  with hit as (
    update public.quota_progress q
       set accepted = q.accepted + 1,
           in_progress = greatest(q.in_progress - 1, 0),
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

/** Somebody has started; hold a slot so a cell is not oversold by people already answering. */
create or replace function public.rescript_quota_hold(p_project uuid, p_attributes jsonb, p_release boolean default false)
returns integer language plpgsql security definer set search_path = public as $$
declare v_rows integer;
begin
  update public.quota_progress q
     set in_progress = case when p_release then greatest(q.in_progress - 1, 0) else q.in_progress + 1 end,
         updated_at = now()
   where q.recruitment_project_id = p_project
     and coalesce(p_attributes, '{}'::jsonb) @> q.criteria;
  get diagnostics v_rows = row_count;
  return coalesce(v_rows, 0);
end;
$$;

/** Record that somebody was turned away because their cells were full — the number that justifies a quota change. */
create or replace function public.rescript_quota_turned_away(p_project uuid, p_cells text[])
returns integer language plpgsql security definer set search_path = public as $$
declare v_rows integer;
begin
  update public.quota_progress q
     set turned_away = q.turned_away + 1, updated_at = now()
   where q.recruitment_project_id = p_project and q.cell_id = any (coalesce(p_cells, '{}'));
  get diagnostics v_rows = row_count;
  return coalesce(v_rows, 0);
end;
$$;

revoke all on function public.rescript_quota_sync(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.rescript_quota_check(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.rescript_quota_record(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.rescript_quota_hold(uuid, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.rescript_quota_turned_away(uuid, text[]) from public, anon, authenticated;

comment on table public.quota_progress is 'Quota cells and what has been counted against them (0088). Over-recruitment is recorded, never refused — by the time it is known the respondent has finished and is owed their incentive.';
