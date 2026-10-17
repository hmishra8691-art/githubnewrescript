-- 0061 — List Fill: re-allocation after Back + a changed answer (audit 2026-10-17,
-- docs/LIST-FILL-LEAST-AUDIT-2026-10-17.md)
--
-- THE GAP. A sample-counted List Fill (per-item caps, least-filled, targets)
-- kept its FIRST allocation for good: `rescript_allocate_listfill` returns a
-- session's existing claims unchanged, and the only release
-- (`rescript_release_listfill`) gives back EVERY list of the session. So a
-- respondent who was allocated Apple, went Back and de-selected Apple, was
-- still asked about Apple — and Apple's counter still held their slot.
--
-- THE FIX.
--   rescript_reallocate_listfill   under the same per-session advisory lock:
--                                  release the claims of THIS list that are not
--                                  in p_keep (reason 'changed', counters given
--                                  back), keep the rest in their slots, and
--                                  claim the remaining positions from the
--                                  engine's new preference order — capped by
--                                  the same single-statement claim as 0007.
--                                  Nothing to drop and nothing to add = no write.
--
-- THREE LATENT DEFECTS IN 0007 THIS HAS TO CLOSE FIRST (reproduced on
-- Postgres 16 — scripts/listfill-reallocate-sql-test.sql and
-- scripts/listfill-reallocate-concurrency.sh):
--   1. the unique index (session_id, list_fill_id, slot) counted RELEASED rows,
--      so once a claim was released, a new claim for the same slot moved the
--      counter (+1) but its allocation row hit `on conflict do nothing` — the
--      counter leaked one slot per call and the allocation went unrecorded.
--      Now the uniqueness is over ACTIVE rows only.
--   2. restoring a soft-deleted response un-released EVERY released claim of
--      the session — with per-list re-allocation that would resurrect claims
--      the respondent had replaced. A claim released because the answer
--      changed carries release_reason 'changed' and is never resurrected.
--   3. DEADLOCK. A claim locks its counter row (an `on conflict do update`
--      locks the row even when the cap refuses it), and claims run in the
--      respondent's PREFERENCE order — which differs per respondent under
--      random / least-filled / balanced methods. Two respondents claiming
--      [A,B] and [B,A] at once deadlock; Postgres aborts one after
--      deadlock_timeout and the route answers 503. Measured: 16 clients, two
--      crossing orders, 2 items each → 126 deadlocks and the run never
--      finished. Every function that touches counters now locks the rows it
--      may touch FIRST, in code order (`rescript_lock_listfill_rows`), so
--      there is one global lock order and no cycle.
--
-- Re-runnable: `if not exists`, `create or replace` (same signatures), revoke.

-- ------------------------------------------------------------ why a claim was released
alter table public.listfill_allocations add column if not exists release_reason text;
comment on column public.listfill_allocations.release_reason is
  'null/released = session released (screen-out, abandoned, deleted); changed = replaced after the respondent changed the answers it was decided from (never restored)';

-- ------------------------------------------------------------ uniqueness over ACTIVE claims
create unique index if not exists listfill_allocations_active_slot_idx
  on public.listfill_allocations (session_id, list_fill_id, slot)
  where released_at is null;
drop index if exists public.listfill_allocations_slot_idx;

-- ------------------------------------------------------------ one lock order
/**
 * Lock the counter rows of these codes in CODE ORDER, creating the missing
 * ones (at zero) first, also in code order. Called before any counter is
 * touched, so every transaction acquires its row locks in the same global
 * order and two allocations can never wait on each other in a cycle.
 */
create or replace function public.rescript_lock_listfill_rows(
  p_survey uuid, p_test boolean, p_list_fill text, p_codes text[]
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.listfill_counts (survey_id, is_test, list_fill_id, option_code)
  select p_survey, p_test, p_list_fill, c
    from (select distinct unnest(p_codes) as c) u
   where c is not null
   order by c
  on conflict (survey_id, is_test, list_fill_id, option_code) do nothing;
  perform 1 from public.listfill_counts
   where survey_id = p_survey and is_test = p_test and list_fill_id = p_list_fill
     and option_code = any(p_codes)
   order by option_code
   for update;
end $$;

-- ------------------------------------------------------------ allocate (0007, conflict target fixed)
/**
 * As 0007: idempotent first allocation. The only change is the conflict
 * target — the partial unique index over active claims — and that a claim
 * whose row cannot be recorded gives its counter back instead of leaking it.
 */
create or replace function public.rescript_allocate_listfill(
  p_survey uuid,
  p_test boolean,
  p_list_fill text,
  p_session text,
  p_preference jsonb,
  p_count integer default 1,
  p_use_completed boolean default false,
  p_version text default null
) returns table (slot_no integer, option_code text, reused boolean)
language plpgsql security definer set search_path = public as $$
declare
  existing integer;
  n_slot integer;
  cand jsonb;
  claimed integer;
  won text;
  used text[] := array[]::text[];
  recorded integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_session || ':' || p_list_fill, 0));

  select count(*) into existing
  from public.listfill_allocations a
  where a.session_id = p_session and a.list_fill_id = p_list_fill and a.released_at is null;

  if existing > 0 then
    return query
      select a.slot, a.option_code, true
      from public.listfill_allocations a
      where a.session_id = p_session and a.list_fill_id = p_list_fill and a.released_at is null
      order by a.slot;
    return;
  end if;

  perform public.rescript_lock_listfill_rows(p_survey, p_test, p_list_fill,
    array(select e->>'code' from jsonb_array_elements(coalesce(p_preference, '[]'::jsonb)) e));

  for n_slot in 1..greatest(coalesce(p_count, 0), 0) loop
    won := null;
    for cand in select * from jsonb_array_elements(coalesce(p_preference, '[]'::jsonb)) loop
      if (cand->>'code') = any(used) and coalesce((cand->>'allowDuplicates')::boolean, false) = false then
        continue;
      end if;
      claimed := public.rescript_claim_listfill_slot(
        p_survey, p_test, p_list_fill, cand->>'code',
        case when cand->>'maximum' is null then null else (cand->>'maximum')::integer end,
        p_use_completed
      );
      if claimed is not null then
        won := cand->>'code';
        exit;
      end if;
    end loop;

    if won is null then
      exit;
    end if;

    insert into public.listfill_allocations
      (survey_id, session_id, is_test, list_fill_id, slot, option_code, survey_version)
    values (p_survey, p_session, p_test, p_list_fill, n_slot, won, p_version)
    on conflict (session_id, list_fill_id, slot) where released_at is null do nothing;
    get diagnostics recorded = row_count;
    if recorded = 0 then
      -- cannot happen under the advisory lock; if it ever does, do not leak the slot
      update public.listfill_counts c set allocated_count = greatest(0, c.allocated_count - 1), updated_at = now()
      where c.survey_id = p_survey and c.is_test = p_test and c.list_fill_id = p_list_fill and c.option_code = won;
      exit;
    end if;

    used := used || won;
    return query select n_slot, won, false;
  end loop;
end $$;

-- ------------------------------------------------------------ re-allocate after a change
/**
 * Re-allocate one List Fill for a session whose answers changed.
 *
 *   p_keep        the codes the session holds and still qualifies for (the
 *                 engine's `reconcileListFill` → kept items). A code the
 *                 session does NOT hold is ignored — keeping is not claiming.
 *   p_preference  the engine's order for the OTHER positions (as 0007)
 *   p_count       the total number of items wanted now
 *
 * Every active claim of this list not in p_keep is released (reason
 * 'changed') and its counters given back; kept claims stay in their slots
 * (counters untouched — a kept item never re-competes for its own slot); the
 * positions left are claimed from p_preference with the capped claim. Rows come
 * back in slot order: kept ones `reused = true`, new ones `reused = false`.
 */
create or replace function public.rescript_reallocate_listfill(
  p_survey uuid,
  p_test boolean,
  p_list_fill text,
  p_session text,
  p_keep jsonb,
  p_preference jsonb,
  p_count integer default 1,
  p_use_completed boolean default false,
  p_version text default null
) returns table (slot_no integer, option_code text, reused boolean)
language plpgsql security definer set search_path = public as $$
declare
  keep_codes text[] := array(select jsonb_array_elements_text(coalesce(p_keep, '[]'::jsonb)));
  r record;
  kept integer;
  next_slot integer;
  n integer;
  cand jsonb;
  claimed integer;
  won text;
  used text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(p_session || ':' || p_list_fill, 0));

  -- 0. every counter row this may touch — held claims and the preference — in code order
  perform public.rescript_lock_listfill_rows(p_survey, p_test, p_list_fill,
    array(select e->>'code' from jsonb_array_elements(coalesce(p_preference, '[]'::jsonb)) e)
    || array(select a.option_code from public.listfill_allocations a
              where a.session_id = p_session and a.list_fill_id = p_list_fill and a.released_at is null));

  -- 1. give back what no longer qualifies (and anything beyond the new count)
  for r in
    update public.listfill_allocations a
       set released_at = now(), release_reason = 'changed'
     where a.session_id = p_session and a.list_fill_id = p_list_fill and a.survey_id = p_survey
       and a.released_at is null
       and (not (a.option_code = any(keep_codes))
            or a.slot not in (
              select k.slot from public.listfill_allocations k
               where k.session_id = p_session and k.list_fill_id = p_list_fill and k.survey_id = p_survey
                 and k.released_at is null and k.option_code = any(keep_codes)
               order by k.slot limit greatest(coalesce(p_count, 0), 0)))
    returning a.is_test, a.option_code, a.completed_at
  loop
    update public.listfill_counts c
       set allocated_count = greatest(0, c.allocated_count - 1),
           completed_count = case when r.completed_at is not null then greatest(0, c.completed_count - 1) else c.completed_count end,
           updated_at = now()
     where c.survey_id = p_survey and c.is_test = r.is_test
       and c.list_fill_id = p_list_fill and c.option_code = r.option_code;
  end loop;

  -- 2. what stays, and where new slots start (after every slot ever used, so the audit trail is unambiguous)
  select count(*), coalesce(array_agg(a.option_code), array[]::text[]) into kept, used
    from public.listfill_allocations a
   where a.session_id = p_session and a.list_fill_id = p_list_fill and a.released_at is null;
  select coalesce(max(a.slot), 0) into next_slot
    from public.listfill_allocations a
   where a.session_id = p_session and a.list_fill_id = p_list_fill;

  -- 3. claim the positions left, in the engine's order, capped as in 0007
  for n in 1..greatest(coalesce(p_count, 0) - kept, 0) loop
    won := null;
    for cand in select * from jsonb_array_elements(coalesce(p_preference, '[]'::jsonb)) loop
      if (cand->>'code') = any(used) then continue; end if;
      claimed := public.rescript_claim_listfill_slot(
        p_survey, p_test, p_list_fill, cand->>'code',
        case when cand->>'maximum' is null then null else (cand->>'maximum')::integer end,
        p_use_completed
      );
      if claimed is not null then won := cand->>'code'; exit; end if;
    end loop;
    exit when won is null;
    next_slot := next_slot + 1;
    insert into public.listfill_allocations
      (survey_id, session_id, is_test, list_fill_id, slot, option_code, survey_version)
    values (p_survey, p_session, p_test, p_list_fill, next_slot, won, p_version);
    used := used || won;
  end loop;

  return query
    select a.slot, a.option_code, (a.option_code = any(keep_codes))
      from public.listfill_allocations a
     where a.session_id = p_session and a.list_fill_id = p_list_fill and a.released_at is null
     order by a.slot;
end $$;

-- ------------------------------------------------------------ release-all marks its reason
create or replace function public.rescript_release_listfill(p_survey uuid, p_session text) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in
    select a.is_test, a.list_fill_id, array_agg(a.option_code) as codes
      from public.listfill_allocations a
     where a.session_id = p_session and a.survey_id = p_survey and a.released_at is null
     group by a.is_test, a.list_fill_id
     order by a.list_fill_id
  loop
    perform public.rescript_lock_listfill_rows(p_survey, r.is_test, r.list_fill_id, r.codes);
  end loop;
  for r in
    update public.listfill_allocations a set released_at = now(), release_reason = 'released'
    where a.session_id = p_session and a.survey_id = p_survey and a.released_at is null
    returning a.is_test, a.list_fill_id, a.option_code, a.completed_at
  loop
    update public.listfill_counts c
      set allocated_count = greatest(0, c.allocated_count - 1),
          completed_count = case when r.completed_at is not null then greatest(0, c.completed_count - 1) else c.completed_count end,
          updated_at = now()
    where c.survey_id = p_survey and c.is_test = r.is_test
      and c.list_fill_id = r.list_fill_id and c.option_code = r.option_code;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ------------------------------------------------------------ complete (0007, one lock order)
create or replace function public.rescript_complete_listfill(p_survey uuid, p_session text) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in
    select a.is_test, a.list_fill_id, array_agg(a.option_code) as codes
      from public.listfill_allocations a
     where a.session_id = p_session and a.survey_id = p_survey and a.released_at is null and a.completed_at is null
     group by a.is_test, a.list_fill_id
     order by a.list_fill_id
  loop
    perform public.rescript_lock_listfill_rows(p_survey, r.is_test, r.list_fill_id, r.codes);
  end loop;
  for r in
    update public.listfill_allocations a set completed_at = now()
    where a.session_id = p_session and a.survey_id = p_survey
      and a.released_at is null and a.completed_at is null
    returning a.is_test, a.list_fill_id, a.option_code
  loop
    insert into public.listfill_counts (survey_id, is_test, list_fill_id, option_code, allocated_count, completed_count)
    values (p_survey, r.is_test, r.list_fill_id, r.option_code, 0, 1)
    on conflict (survey_id, is_test, list_fill_id, option_code) do update
      set completed_count = public.listfill_counts.completed_count + 1, updated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

-- ------------------------------------------------------------ restore never resurrects a replaced claim
create or replace function public.rescript_release_listfill_on_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'DELETE') then
    perform public.rescript_release_listfill(old.survey_id, old.session_id);
    return old;
  end if;
  if (new.deleted_at is not null and old.deleted_at is null) then
    perform public.rescript_release_listfill(new.survey_id, new.session_id);
  elsif (new.deleted_at is null and old.deleted_at is not null) then
    -- restored: the claims the deletion released come back; claims the respondent
    -- replaced by changing an answer ('changed') stay released
    update public.listfill_allocations a set released_at = null, release_reason = null
    where a.session_id = new.session_id and a.survey_id = new.survey_id and a.released_at is not null
      and coalesce(a.release_reason, 'released') <> 'changed';
    perform public.rescript_recount_listfill(new.survey_id, new.is_test);
  end if;
  return new;
end $$;

-- ------------------------------------------------------------ least privilege (as 0026)
revoke all on function public.rescript_lock_listfill_rows(uuid, boolean, text, text[]) from public, anon, authenticated;
revoke all on function public.rescript_allocate_listfill(uuid, boolean, text, text, jsonb, integer, boolean, text) from public, anon, authenticated;
revoke all on function public.rescript_complete_listfill(uuid, text) from public, anon, authenticated;
revoke all on function public.rescript_reallocate_listfill(uuid, boolean, text, text, jsonb, jsonb, integer, boolean, text) from public, anon, authenticated;
revoke all on function public.rescript_release_listfill(uuid, text) from public, anon, authenticated;
revoke all on function public.rescript_release_listfill_on_delete() from public, anon, authenticated;
