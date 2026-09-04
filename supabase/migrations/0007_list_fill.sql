-- 0007 — List Fill allocation
--
-- The engine (`packages/engine/src/listFill.ts`) decides what a respondent
-- SHOULD get and in what order. This migration is what makes exactly one of
-- those preferences true, once, under concurrency:
--
--   listfill_counts       the sample-level counter per survey / environment /
--                         list / option, with the claimed and the completed
--                         count kept apart
--   listfill_allocations  what each session actually won — the record that
--                         makes going back, reloading or double-submitting
--                         return the SAME items instead of allocating again
--
-- WHY A FUNCTION AND NOT A READ-THEN-WRITE.
-- Two respondents reaching the last slot of option A at the same moment must
-- not both get it. A `select count` followed by an `update` cannot promise
-- that: both reads see 149 and both write 150. So a claim is ONE statement
--
--   insert … on conflict … do update set count = count + 1 where count < cap
--
-- which takes a row lock, re-reads the row inside that lock and refuses when
-- the cap is already met. The loser gets no row back and moves to the next
-- option in its preference order. That is the whole concurrency argument, and
-- it is why the cap can never be exceeded no matter how many respondents
-- arrive together (requirement §27).
--
-- COUNTING. `allocated_count` moves the moment a slot is claimed, so caps
-- hold during fieldwork. `completed_count` moves when the response completes.
-- A list configured to count completes only is capped on the second number
-- and is expected to over-issue while sessions are open — that is the honest
-- reading of "150 completed interviews for A", and `rescript_release_listfill`
-- plus `rescript_recount_listfill` keep the claimed number from drifting when
-- sessions are abandoned or responses deleted.
--
-- Idempotent: safe to re-run.

-- ------------------------------------------------------------ counters
create table if not exists public.listfill_counts (
  survey_id uuid not null references public.surveys(id) on delete cascade,
  is_test boolean not null default false,
  list_fill_id text not null,
  option_code text not null,
  /** slots claimed, including sessions still in progress */
  allocated_count integer not null default 0,
  /** slots whose response reached a completed status */
  completed_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (survey_id, is_test, list_fill_id, option_code)
);
alter table public.listfill_counts enable row level security;

-- ------------------------------------------------------------ allocations
create table if not exists public.listfill_allocations (
  id uuid primary key default gen_random_uuid(),
  survey_id uuid not null references public.surveys(id) on delete cascade,
  session_id text not null,
  is_test boolean not null default false,
  list_fill_id text not null,
  slot integer not null,
  option_code text not null,
  /** the survey version the allocation was decided under (§37) */
  survey_version text,
  allocated_at timestamptz not null default now(),
  /** set when the claim was given back (abandoned session, deleted response) */
  released_at timestamptz,
  completed_at timestamptz
);
alter table public.listfill_allocations enable row level security;

-- one row per session / list / slot: the uniqueness that makes a
-- double-submitted page impossible to allocate twice
create unique index if not exists listfill_allocations_slot_idx
  on public.listfill_allocations (session_id, list_fill_id, slot);
create index if not exists listfill_allocations_survey_idx
  on public.listfill_allocations (survey_id, is_test, list_fill_id, option_code)
  where released_at is null;
create index if not exists listfill_allocations_session_idx
  on public.listfill_allocations (session_id);

-- ------------------------------------------------------------ the claim
/**
 * Claim ONE slot of one option, or return null when it is full.
 *
 * p_max null means unlimited. The `where` on the conflict path is what makes
 * this safe: it is evaluated after the row lock is taken, so it sees the
 * count as of this instant and not as of the caller's earlier read.
 */
create or replace function public.rescript_claim_listfill_slot(
  p_survey uuid,
  p_test boolean,
  p_list_fill text,
  p_option text,
  p_max integer,
  p_use_completed boolean default false
) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  -- a maximum of zero is not claimable at all, on either path
  if p_max is not null and p_max <= 0 then
    return null;
  end if;

  insert into public.listfill_counts (survey_id, is_test, list_fill_id, option_code, allocated_count)
  values (p_survey, p_test, p_list_fill, p_option, 1)
  on conflict (survey_id, is_test, list_fill_id, option_code) do update
    set allocated_count = public.listfill_counts.allocated_count + 1,
        updated_at = now()
    where p_max is null
       or (case when p_use_completed
                then public.listfill_counts.completed_count
                else public.listfill_counts.allocated_count end) < p_max
  returning allocated_count into n;

  return n; -- null when the cap refused the claim
end $$;

-- ------------------------------------------------------------ allocate
/**
 * Allocate this session's items for one List Fill.
 *
 * `p_preference` is the engine's ordered list, as
 *   [{"code":"A","maximum":150}, {"code":"B","maximum":75}, {"code":"C"}]
 * — order is meaning, and a missing/null maximum is unlimited.
 *
 * IDEMPOTENT. If this session already holds allocations for this list they
 * are returned unchanged and nothing is claimed, so going back, reloading,
 * resuming tomorrow or a double-submitted page all yield the same items. An
 * advisory lock on session+list serialises two simultaneous requests from the
 * SAME session, so even they cannot both allocate.
 *
 * Returns one row per position with the option actually won. Fewer rows than
 * `p_count` means the preference order ran out of capacity — the caller
 * records the shortfall rather than inventing an item.
 */
-- dropped first: `create or replace` cannot change a function's OUT columns,
-- so a re-run of an edited migration would fail without this
drop function if exists public.rescript_allocate_listfill(uuid, boolean, text, text, jsonb, integer, boolean, text);
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
begin
  -- serialise this session's own concurrent requests
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

  for n_slot in 1..greatest(coalesce(p_count, 0), 0) loop
    won := null;
    for cand in select * from jsonb_array_elements(coalesce(p_preference, '[]'::jsonb)) loop
      -- one item per option per respondent, unless the caller repeats the
      -- code in the preference list on purpose
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
      exit; -- nothing left anywhere in the preference order
    end if;

    insert into public.listfill_allocations
      (survey_id, session_id, is_test, list_fill_id, slot, option_code, survey_version)
    values (p_survey, p_session, p_test, p_list_fill, n_slot, won, p_version)
    on conflict (session_id, list_fill_id, slot) do nothing;

    used := used || won;
    return query select n_slot, won, false;
  end loop;
end $$;

-- ------------------------------------------------------------ complete
/**
 * Mark this session's allocations completed, moving `completed_count`. Called
 * once when a response reaches a completed status; running it twice is
 * harmless because it only touches rows not already marked.
 */
create or replace function public.rescript_complete_listfill(p_survey uuid, p_session text) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
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

-- ------------------------------------------------------------ release
/**
 * Give a session's claims back — an abandoned session, or a response that was
 * deleted. Without this, `allocated_count` would drift upward forever and an
 * option would look full while its completes sat well under target.
 */
create or replace function public.rescript_release_listfill(p_survey uuid, p_session text) returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in
    update public.listfill_allocations a set released_at = now()
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

-- ------------------------------------------------------------ recount
/**
 * Rebuild one environment's counters from the allocations that actually
 * stand. The repair path: after an import, a bulk delete, or any doubt about
 * the counters, this makes the dashboard agree with the data — one
 * transaction, so a reader never sees half a recount.
 */
create or replace function public.rescript_recount_listfill(p_survey uuid, p_test boolean) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  delete from public.listfill_counts where survey_id = p_survey and is_test = p_test;

  insert into public.listfill_counts (survey_id, is_test, list_fill_id, option_code, allocated_count, completed_count)
  select p_survey, p_test, a.list_fill_id, a.option_code,
         count(*),
         count(*) filter (where a.completed_at is not null)
  from public.listfill_allocations a
  where a.survey_id = p_survey and a.is_test = p_test and a.released_at is null
  group by a.list_fill_id, a.option_code;

  select count(*) into n from public.listfill_counts where survey_id = p_survey and is_test = p_test;
  return n;
end $$;

-- ------------------------------------------------------------ status read
/** The live allocation dashboard's data (§28), one row per option. */
create or replace function public.rescript_listfill_status(p_survey uuid, p_test boolean)
returns table (list_fill_id text, option_code text, allocated_count integer, completed_count integer, in_progress_count integer)
language sql stable security definer set search_path = public as $$
  select c.list_fill_id, c.option_code, c.allocated_count, c.completed_count,
         greatest(0, c.allocated_count - c.completed_count) as in_progress_count
  from public.listfill_counts c
  where c.survey_id = p_survey and c.is_test = p_test
  order by c.list_fill_id, c.option_code;
$$;

-- ------------------------------------------------------------ deleting a response releases its claims
/**
 * A soft-deleted or purged response must not keep holding a slot. The
 * trigger closes the gap that would otherwise need every deletion path to
 * remember to call the release function.
 */
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
    -- restored: take the claims back out of released state, then recount the
    -- environment so the counters are exact rather than incrementally patched
    update public.listfill_allocations a set released_at = null
    where a.session_id = new.session_id and a.survey_id = new.survey_id and a.released_at is not null;
    perform public.rescript_recount_listfill(new.survey_id, new.is_test);
  end if;
  return new;
end $$;

drop trigger if exists responses_release_listfill on public.responses;
create trigger responses_release_listfill
  after update of deleted_at or delete on public.responses
  for each row execute function public.rescript_release_listfill_on_delete();
