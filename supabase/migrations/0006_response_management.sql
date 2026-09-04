-- 0006 — Response data management
--
-- One canonical response model, made explicit and safe to manage:
--   environment      TEST / LIVE as a stored column derived from is_test, so a
--                    query can filter on the word the UI uses and the two
--                    datasets are separated in the database, not in a filter
--   respondent_code  a stable, human-readable, searchable identifier issued
--                    per survey and environment (TEST_000001 / RESP_000001);
--                    session_id stays the unguessable runtime token
--   revision         bumped on every write — optimistic concurrency for edits
--   source           runtime / import / manual
--   deleted_at/by/reason  soft delete; every dataset reader excludes it
--   response_edits   the audit trail of every edit, deletion, restore, import
--   quota_counts.is_test  test and live quotas never share a counter
--
-- Every multi-row operation is a function, so it is one transaction: a
-- failure rolls the whole thing back instead of leaving half of it applied.
-- Idempotent: safe to re-run.

-- ------------------------------------------------------------ responses
alter table public.responses
  add column if not exists environment text generated always as (case when is_test then 'TEST' else 'LIVE' end) stored,
  add column if not exists respondent_code text,
  add column if not exists revision integer not null default 0,
  add column if not exists source text not null default 'runtime',
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text,
  add column if not exists deletion_reason text,
  add column if not exists last_saved_at timestamptz;

alter table public.responses drop constraint if exists responses_source_check;
alter table public.responses add constraint responses_source_check check (source in ('runtime', 'import', 'manual'));

-- per survey + environment counter behind the respondent codes
create table if not exists public.response_counters (
  survey_id uuid not null references public.surveys(id) on delete cascade,
  is_test boolean not null,
  next_n bigint not null default 1,
  primary key (survey_id, is_test)
);
alter table public.response_counters enable row level security;

create or replace function public.rescript_next_respondent_code(p_survey uuid, p_test boolean) returns text
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  insert into public.response_counters (survey_id, is_test, next_n) values (p_survey, p_test, 2)
  on conflict (survey_id, is_test) do update set next_n = public.response_counters.next_n + 1
  returning next_n - 1 into n;
  return (case when p_test then 'TEST_' else 'RESP_' end) || lpad(n::text, 6, '0');
end $$;

create or replace function public.rescript_assign_respondent_code() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.respondent_code is null then
    new.respondent_code := public.rescript_next_respondent_code(new.survey_id, new.is_test);
  end if;
  return new;
end $$;
drop trigger if exists responses_assign_code on public.responses;
create trigger responses_assign_code before insert on public.responses
  for each row execute function public.rescript_assign_respondent_code();

-- every write bumps the revision (the runtime's autosave included)
create or replace function public.rescript_bump_response_revision() returns trigger
language plpgsql as $$
begin
  new.revision := old.revision + 1;
  return new;
end $$;
drop trigger if exists responses_bump_revision on public.responses;
create trigger responses_bump_revision before update on public.responses
  for each row execute function public.rescript_bump_response_revision();

-- backfill codes for rows that predate this migration, in arrival order
do $$
declare r record;
begin
  for r in select id, survey_id, is_test from public.responses where respondent_code is null order by survey_id, is_test, started_at, id loop
    update public.responses set respondent_code = public.rescript_next_respondent_code(r.survey_id, r.is_test) where id = r.id;
  end loop;
end $$;

create unique index if not exists responses_survey_code_key on public.responses (survey_id, respondent_code);
create index if not exists responses_survey_env_status_idx on public.responses (survey_id, is_test, status) where deleted_at is null;
create index if not exists responses_survey_env_started_idx on public.responses (survey_id, is_test, started_at desc);
create index if not exists responses_answers_gin on public.responses using gin (answers jsonb_path_ops);

-- ------------------------------------------------------------ audit trail
create table if not exists public.response_edits (
  id bigint generated always as identity primary key,
  response_id uuid not null references public.responses(id) on delete cascade,
  survey_id uuid not null,
  respondent_code text,
  action text not null check (action in ('edit', 'delete', 'restore', 'import_create', 'import_update', 'purge')),
  -- edit: {"<questionId>": {"from": ..., "to": ...}}; import: {"before": {...}, "after": {...}}
  changes jsonb,
  reason text,
  edited_by text not null default 'researcher',
  edited_at timestamptz not null default now(),
  revision_before integer,
  revision_after integer
);
create index if not exists response_edits_response_idx on public.response_edits (response_id, edited_at desc);
create index if not exists response_edits_survey_idx on public.response_edits (survey_id, edited_at desc);
alter table public.response_edits enable row level security;

-- ------------------------------------------------------------ edit (optimistic concurrency)
-- Applies a full answers map when the row is still at the revision the
-- editor loaded. A stale editor gets REVISION_CONFLICT instead of overwriting
-- a newer save (the runtime's, an import's, another editor's).
create or replace function public.rescript_update_response(
  p_id uuid,
  p_expected_revision integer,
  p_answers jsonb,
  p_calculated jsonb,
  p_changes jsonb,
  p_by text,
  p_reason text
) returns table (new_revision integer, new_updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare cur integer; sid uuid; code text; newrev integer; newat timestamptz;
begin
  select r.revision, r.survey_id, r.respondent_code into cur, sid, code
    from public.responses r where r.id = p_id and r.deleted_at is null for update;
  if not found then raise exception 'RESPONSE_NOT_FOUND'; end if;
  if p_expected_revision is not null and cur <> p_expected_revision then
    raise exception 'REVISION_CONFLICT expected % but the row is at %', p_expected_revision, cur;
  end if;
  update public.responses
     set answers = p_answers,
         calculated = coalesce(p_calculated, public.responses.calculated),
         source = case when public.responses.source = 'runtime' then 'manual' else public.responses.source end
   where id = p_id
   returning public.responses.revision, public.responses.updated_at into newrev, newat;
  insert into public.response_edits (response_id, survey_id, respondent_code, action, changes, reason, edited_by, revision_before, revision_after)
  values (p_id, sid, code, 'edit', p_changes, p_reason, coalesce(p_by, 'researcher'), cur, newrev);
  return query select newrev, newat;
end $$;

-- ------------------------------------------------------------ soft delete / restore / purge
create or replace function public.rescript_soft_delete_responses(p_survey uuid, p_ids uuid[], p_by text, p_reason text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with upd as (
    update public.responses
       set deleted_at = now(), deleted_by = coalesce(p_by, 'researcher'), deletion_reason = p_reason
     where survey_id = p_survey and id = any(p_ids) and deleted_at is null
     returning id, respondent_code, revision
  )
  insert into public.response_edits (response_id, survey_id, respondent_code, action, reason, edited_by, revision_before, revision_after)
  select id, p_survey, respondent_code, 'delete', p_reason, coalesce(p_by, 'researcher'), revision - 1, revision from upd;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.rescript_restore_responses(p_survey uuid, p_ids uuid[], p_by text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with upd as (
    update public.responses
       set deleted_at = null, deleted_by = null, deletion_reason = null
     where survey_id = p_survey and id = any(p_ids) and deleted_at is not null
     returning id, respondent_code, revision
  )
  insert into public.response_edits (response_id, survey_id, respondent_code, action, edited_by, revision_before, revision_after)
  select id, p_survey, respondent_code, 'restore', coalesce(p_by, 'researcher'), revision - 1, revision from upd;
  get diagnostics n = row_count;
  return n;
end $$;

-- permanent removal — only of rows already soft-deleted; a separate, explicit act
create or replace function public.rescript_purge_responses(p_survey uuid, p_ids uuid[], p_by text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.audit_logs (action, entity, entity_id, detail)
  select 'response.purge', 'response', r.id::text, jsonb_build_object('survey_id', p_survey, 'respondent_code', r.respondent_code, 'by', coalesce(p_by, 'researcher'), 'deleted_at', r.deleted_at, 'deletion_reason', r.deletion_reason)
    from public.responses r where r.survey_id = p_survey and r.id = any(p_ids) and r.deleted_at is not null;
  delete from public.responses where survey_id = p_survey and id = any(p_ids) and deleted_at is not null;
  get diagnostics n = row_count;
  return n;
end $$;

-- ------------------------------------------------------------ import (one transaction)
-- p_rows: [{ "respondent_code": "TEST_000012" | null, "answers": {...}, "embedded": {...}?, "status": "complete"?, "started_at"?, "completed_at"? }]
-- p_mode: 'create' (new rows only; an existing code is an error → whole import rolls back)
--         'update' (existing codes only; unknown codes are skipped)
--         'upsert' (both)
-- Answers of an updated row are MERGED key by key, so a file with three
-- columns changes three answers and leaves the rest.
create or replace function public.rescript_import_responses(
  p_survey uuid,
  p_version uuid,
  p_test boolean,
  p_mode text,
  p_rows jsonb,
  p_by text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb; code text; ex_id uuid; ex_answers jsonb; ex_rev integer; merged jsonb; newrev integer;
  created integer := 0; updated integer := 0; skipped integer := 0; new_id uuid; st text;
begin
  if p_mode not in ('create', 'update', 'upsert') then raise exception 'IMPORT_MODE_INVALID %', p_mode; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    code := nullif(trim(r->>'respondent_code'), '');
    ex_id := null;
    if code is not null then
      select id, answers, revision into ex_id, ex_answers, ex_rev
        from public.responses where survey_id = p_survey and is_test = p_test and respondent_code = code and deleted_at is null
        for update;
    end if;
    if ex_id is not null then
      if p_mode = 'create' then
        raise exception 'IMPORT_DUPLICATE respondent % already exists', code;
      end if;
      merged := coalesce(ex_answers, '{}'::jsonb) || coalesce(r->'answers', '{}'::jsonb);
      st := coalesce(nullif(r->>'status', ''), null);
      update public.responses
         set answers = merged,
             embedded = case when r ? 'embedded' then coalesce(embedded, '{}'::jsonb) || (r->'embedded') else embedded end,
             status = coalesce(st, status),
             completed_at = coalesce((r->>'completed_at')::timestamptz, completed_at),
             source = 'import'
       where id = ex_id
       returning revision into newrev;
      insert into public.response_edits (response_id, survey_id, respondent_code, action, changes, reason, edited_by, revision_before, revision_after)
      values (ex_id, p_survey, code, 'import_update', jsonb_build_object('before', ex_answers, 'after', merged), null, coalesce(p_by, 'researcher'), ex_rev, newrev);
      updated := updated + 1;
    else
      if p_mode = 'update' then
        skipped := skipped + 1;
        continue;
      end if;
      insert into public.responses (survey_id, version_id, session_id, respondent_code, is_test, status, answers, embedded, started_at, completed_at, source)
      values (
        p_survey, p_version, 'imp_' || replace(gen_random_uuid()::text, '-', ''), code, p_test,
        coalesce(nullif(r->>'status', ''), 'complete'),
        coalesce(r->'answers', '{}'::jsonb), coalesce(r->'embedded', '{}'::jsonb),
        coalesce((r->>'started_at')::timestamptz, now()),
        coalesce((r->>'completed_at')::timestamptz, case when coalesce(nullif(r->>'status', ''), 'complete') = 'in_progress' then null else now() end),
        'import'
      ) returning id, respondent_code into new_id, code;
      insert into public.response_edits (response_id, survey_id, respondent_code, action, changes, edited_by, revision_before, revision_after)
      values (new_id, p_survey, code, 'import_create', jsonb_build_object('after', coalesce(r->'answers', '{}'::jsonb)), coalesce(p_by, 'researcher'), null, 0);
      created := created + 1;
    end if;
  end loop;
  return jsonb_build_object('created', created, 'updated', updated, 'skipped', skipped);
end $$;

-- ------------------------------------------------------------ quotas per environment
alter table public.quota_counts add column if not exists is_test boolean not null default false;
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
     where table_schema = 'public' and table_name = 'quota_counts' and constraint_name = 'quota_counts_pkey'
  ) and not exists (
    select 1 from information_schema.key_column_usage
     where table_schema = 'public' and table_name = 'quota_counts' and constraint_name = 'quota_counts_pkey' and column_name = 'is_test'
  ) then
    alter table public.quota_counts drop constraint quota_counts_pkey;
    alter table public.quota_counts add primary key (survey_id, quota_id, cell_id, is_test);
  end if;
end $$;

-- the runtime's increment, now per environment (two-argument calls keep working: live)
drop function if exists public.increment_quota_counts(uuid, jsonb);
create or replace function public.increment_quota_counts(
  p_survey_id uuid,
  p_cells jsonb,
  p_test boolean default false
) returns void
language plpgsql security definer set search_path = public as $$
declare c jsonb;
begin
  for c in select * from jsonb_array_elements(p_cells) loop
    insert into public.quota_counts (survey_id, quota_id, cell_id, is_test, count)
    values (p_survey_id, c->>'quotaId', c->>'cellId', p_test, 1)
    on conflict (survey_id, quota_id, cell_id, is_test)
    do update set count = public.quota_counts.count + 1;
  end loop;
end $$;

-- replace every count of one environment atomically (recount from the dataset)
create or replace function public.rescript_replace_quota_counts(p_survey uuid, p_test boolean, p_cells jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare c jsonb; n integer := 0;
begin
  delete from public.quota_counts where survey_id = p_survey and is_test = p_test;
  for c in select * from jsonb_array_elements(coalesce(p_cells, '[]'::jsonb)) loop
    insert into public.quota_counts (survey_id, quota_id, cell_id, is_test, count)
    values (p_survey, c->>'quotaId', c->>'cellId', p_test, coalesce((c->>'count')::integer, 0));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ------------------------------------------------------------ readers exclude deleted rows
-- The two SQL readers of responses (0002 dashboard stats, 0005 quality
-- summary) are re-created to skip soft-deleted rows, so a deleted response
-- leaves every count at once.
create or replace function public.rescript_quality_summary(p_survey_id uuid, p_is_test boolean)
returns table (classification text, review_status text, n bigint)
language sql stable security definer as $$
  select coalesce(r.quality->>'classification', 'UNSCORED') as classification,
         r.review_status,
         count(*) as n
    from public.responses r
   where r.survey_id = p_survey_id
     and r.is_test = p_is_test
     and r.status <> 'in_progress'
     and r.deleted_at is null
   group by 1, 2;
$$;
revoke all on function public.rescript_quality_summary(uuid, boolean) from anon;

create or replace function public.survey_dashboard_stats()
returns table (
  survey_id uuid,
  question_count int,
  response_count int,
  test_response_count int,
  live_response_count int,
  complete_count int,
  last_response_at timestamptz,
  contributor_ids uuid[],
  version_count int
)
language sql stable security definer set search_path = public as $$
  select
    s.id as survey_id,
    coalesce(public.rescript_question_count(v.definition), 0) as question_count,
    coalesce(r.total, 0)::int as response_count,
    coalesce(r.test_total, 0)::int as test_response_count,
    coalesce(r.live_total, 0)::int as live_response_count,
    coalesce(r.complete_total, 0)::int as complete_count,
    r.last_at as last_response_at,
    coalesce(c.ids, array[]::uuid[]) as contributor_ids,
    coalesce(vc.n, 0)::int as version_count
  from public.surveys s
  left join public.survey_versions v on v.id = s.current_version_id
  left join lateral (
    select
      count(*) as total,
      count(*) filter (where x.is_test) as test_total,
      count(*) filter (where not x.is_test) as live_total,
      count(*) filter (where x.status = 'complete') as complete_total,
      max(x.started_at) as last_at
    from public.responses x
    where x.survey_id = s.id and x.deleted_at is null
  ) r on true
  left join lateral (
    select array_agg(distinct uid) as ids
    from (
      select s.created_by as uid
      union
      select sv.created_by from public.survey_versions sv where sv.survey_id = s.id
      union
      select al.user_id from public.audit_logs al where al.entity_id = s.id::text
    ) u
    where uid is not null
  ) c on true
  left join lateral (
    select count(*) as n from public.survey_versions sv2 where sv2.survey_id = s.id
  ) vc on true;
$$;
