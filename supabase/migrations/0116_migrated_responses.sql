-- 0116 — MIGRATED LEGACY RESPONSES (Level 5 roadmap I4, 2026-11-23). Needs 0006.
--
-- Responses carried over from another platform (an SPSS file, a CSV or a workbook of a past wave) are stored
-- beside the survey's own, marked source = 'migration':
--   · they are data — tables, trends and exports read them like any response;
--   · they are NOT interviews — quota recounts leave them out, and they are billed per migrated response
--     (event SURVEY_RESPONSE_IMPORTED), not as completes;
--   · each upload is one batch (embedded._migration = the batch id, embedded.LEGACY_ID = the source's own id),
--     so a batch is written once and can be found or removed as a unit.
--
--   rescript_migrate_responses(survey, version, is_test, batch, rows, by)
--     inserts every row in ONE transaction, or none: a batch id already used in this survey raises
--     MIGRATION_BATCH_EXISTS, so a retried request cannot store the file twice.
--
-- Additive. Rollback:
--   delete from public.responses where source = 'migration';
--   drop function if exists public.rescript_migrate_responses(uuid, uuid, boolean, text, jsonb, text);
--   alter table public.responses drop constraint if exists responses_source_check;
--   alter table public.responses add constraint responses_source_check check (source in ('runtime', 'import', 'manual'));

alter table public.responses drop constraint if exists responses_source_check;
alter table public.responses add constraint responses_source_check check (source in ('runtime', 'import', 'manual', 'migration'));

create index if not exists responses_migration_batch_idx on public.responses (survey_id, (embedded->>'_migration')) where source = 'migration';

create or replace function public.rescript_migrate_responses(
  p_survey uuid,
  p_version uuid,
  p_test boolean,
  p_batch text,
  p_rows jsonb,
  p_by text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb; n integer := 0;
begin
  if p_batch is null or p_batch !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'MIGRATION_BATCH_INVALID'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'MIGRATION_EMPTY'; end if;
  if jsonb_array_length(p_rows) > 50000 then raise exception 'MIGRATION_TOO_LARGE'; end if;
  if exists (select 1 from public.responses where survey_id = p_survey and source = 'migration' and embedded->>'_migration' = p_batch) then
    raise exception 'MIGRATION_BATCH_EXISTS %', p_batch;
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    n := n + 1;
    insert into public.responses (survey_id, version_id, session_id, is_test, status, answers, embedded, started_at, completed_at, source)
    values (
      p_survey, p_version, 'mig_' || p_batch || '_' || n, p_test, 'complete',
      coalesce(r->'answers', '{}'::jsonb),
      coalesce(r->'embedded', '{}'::jsonb) || jsonb_build_object('_migration', p_batch) ||
        case when nullif(r->>'legacy_id', '') is null then '{}'::jsonb else jsonb_build_object('LEGACY_ID', r->>'legacy_id') end,
      coalesce((r->>'started_at')::timestamptz, now()),
      coalesce((r->>'completed_at')::timestamptz, (r->>'started_at')::timestamptz, now()),
      'migration'
    );
  end loop;
  return jsonb_build_object('created', n, 'batch', p_batch, 'by', p_by);
end $$;
revoke all on function public.rescript_migrate_responses(uuid, uuid, boolean, text, jsonb, text) from public, anon, authenticated;

-- the customer price, where the rates were copied into the database (otherwise the platform's defaults apply)
insert into public.billing_rates (id, provider, service, model, side, unit, provider_cost, unit_size, markup_pct, customer_rate, currency, active, estimated, note)
select 'rescript.runtime.response_imported', 'rescript', 'runtime', 'response_imported', null, 'response', 0, 1, 0, 0.002, 'USD', true, true,
       'customer price per migrated legacy response (I4)'
where exists (select 1 from public.billing_rates)
on conflict (id) do nothing;

insert into public.schema_marks (migration, note) values ('0116', 'migrated legacy responses: source migration, rescript_migrate_responses, billed per response')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
