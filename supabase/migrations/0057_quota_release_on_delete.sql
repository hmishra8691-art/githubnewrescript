-- 0057 — deleting a complete response gives its quota cells back (audit SCHEMA-07, 2026-10-16)
--
-- `quota_counts` were incremented on completion (`increment_quota_counts`, 0006/0010) and never decremented:
-- soft-deleting a complete response left it counted until somebody ran the manual Quota recount. List Fill
-- solved the same problem with the `responses_release_listfill` trigger (0007); this mirrors it.
--
-- The difficulty quotas have and List Fill does not: which cells a response counts in is decided by the
-- engine in TypeScript (`quotaIncrements(def, state)`), not stored anywhere — the database cannot work it
-- out again from the answers. So:
--   1. `responses.quota_cells` (jsonb, nullable) records the cells a response was counted in, in the same
--      [{"quotaId","cellId"}] shape `increment_quota_counts` takes. Null = not recorded.
--   2. `rescript_count_quota_cells(survey, session, cells, test)` records them on the row AND increments, in
--      one transaction, once: a second call for the same session is a no-op returning false (a retried or
--      raced finalise can no longer count a response twice).
--   3. The trigger: deleted_at null → set on a complete row with recorded cells decrements those cells
--      (never below 0); set → null (restore) increments them again; a hard DELETE of a row that was not
--      already soft-deleted decrements (purge only removes soft-deleted rows, which were released already).
--
-- Rows completed before the runtime calls (2) have quota_cells = null: deleting them changes no counter, as
-- before, and the Quota recount stays the way to correct those. Test and live counters are kept apart by
-- the row's own is_test.
--
-- Needs the runtime to call `rescript_count_quota_cells` instead of `increment_quota_counts` on completion
-- (apps/runtime/app/api/session/save/route.ts), falling back to the old call when this migration is not
-- applied yet. Until then the trigger is inert (no row has quota_cells) and behaviour is unchanged.
--
-- Re-runnable. Undo: docs/MIGRATION-UNDO-NOTES.md. UNEXECUTED when written (no Postgres in the sandbox).

alter table public.responses add column if not exists quota_cells jsonb;
comment on column public.responses.quota_cells is
  'quota cells this response was counted in at completion ([{quotaId, cellId}]); null = not recorded. Written by rescript_count_quota_cells, read by the responses_release_quota trigger (0057).';

-- ------------------------------------------------------------ count once, remembering the cells
create or replace function public.rescript_count_quota_cells(
  p_survey uuid,
  p_session text,
  p_cells jsonb,
  p_test boolean default false
) returns boolean
language plpgsql security definer set search_path = public as $$
declare hit integer;
begin
  if p_cells is null or jsonb_typeof(p_cells) <> 'array' or jsonb_array_length(p_cells) = 0 then
    return false;
  end if;
  update public.responses r
     set quota_cells = p_cells
   where r.survey_id = p_survey and r.session_id = p_session
     and r.quota_cells is null and r.deleted_at is null;
  get diagnostics hit = row_count;
  if hit = 0 then
    return false;  -- already counted, deleted, or no such session: never count twice
  end if;
  perform public.increment_quota_counts(p_survey, p_cells, p_test);
  return true;
end $$;

-- ------------------------------------------------------------ decrement helper
create or replace function public.rescript_release_quota_cells(p_survey uuid, p_cells jsonb, p_test boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare c jsonb;
begin
  if p_cells is null or jsonb_typeof(p_cells) <> 'array' then return; end if;
  for c in select * from jsonb_array_elements(p_cells) loop
    update public.quota_counts q
       set count = greatest(0, q.count - 1), updated_at = now()
     where q.survey_id = p_survey and q.is_test = p_test
       and q.quota_id = c->>'quotaId' and q.cell_id = c->>'cellId';
  end loop;
end $$;

-- ------------------------------------------------------------ the trigger
create or replace function public.rescript_release_quota_on_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'DELETE') then
    if old.deleted_at is null and old.status = 'complete' and old.quota_cells is not null then
      perform public.rescript_release_quota_cells(old.survey_id, old.quota_cells, old.is_test);
    end if;
    return old;
  end if;
  if (new.deleted_at is not null and old.deleted_at is null) then
    if old.status = 'complete' and old.quota_cells is not null then
      perform public.rescript_release_quota_cells(old.survey_id, old.quota_cells, old.is_test);
    end if;
  elsif (new.deleted_at is null and old.deleted_at is not null) then
    -- restored: the response counts again, in the cells it was counted in
    if new.status = 'complete' and new.quota_cells is not null then
      perform public.increment_quota_counts(new.survey_id, new.quota_cells, new.is_test);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists responses_release_quota on public.responses;
create trigger responses_release_quota
  after update of deleted_at or delete on public.responses
  for each row execute function public.rescript_release_quota_on_delete();

-- ------------------------------------------------------------ permissions (service role only, as 0026)
revoke all on function public.rescript_count_quota_cells(uuid, text, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.rescript_release_quota_cells(uuid, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.rescript_release_quota_on_delete() from public, anon, authenticated;
