-- 0111 — RESPONSES, PARTITIONED BY MONTH (scale readiness step 5, 2026-11-22; docs/SCALE-READINESS-2026-11-22.md).
--
-- WHY NOW. `responses` is the one table that grows with every respondent. At consumer scale it reaches billions of
-- rows, and an unpartitioned table that size cannot be vacuumed, re-indexed, archived or trimmed without hours of
-- locks. Partitioning it later means rewriting the biggest table in the database under live traffic; today it holds a
-- few hundred rows (283 on the primary on 2026-11-22, 43 live), so the rewrite takes milliseconds.
--
-- THE DESIGN: RANGE PARTITIONS ON A TIME-ORDERED ID, NOT ON A TIMESTAMP COLUMN.
-- Postgres requires every unique key of a partitioned table, the primary key included, to contain the partition key.
-- Partitioning on `started_at` would make the key (id, started_at) and break all seven foreign keys that point at
-- `responses(id)` — and every insert into those tables. Instead new ids are UUIDv7 (the first 48 bits are the creation
-- time in milliseconds), and the table is range-partitioned on `id` itself, one partition per calendar month (UTC):
--
--   * the primary key stays `id`, so every foreign key and every line of application code is unchanged;
--   * a month's rows live in one partition, so old months can be detached, archived or dropped as a unit;
--   * the month is the month the ROW WAS CREATED (an imported response with an old started_at lands in the month it
--     was imported), which is what retention and vacuum care about.
--
-- WHAT POSTGRES CANNOT ENFORCE ON A PARTITIONED TABLE, AND WHERE IT MOVES. `session_id` was globally unique and
-- `(survey_id, respondent_code)` was unique per survey. Neither contains `id`, so neither can be a unique index on the
-- partitioned table. Both move to `response_keys`, a narrow unpartitioned table with one row per response, written
-- by a trigger in the same statement: a duplicate still fails with 23505 and nothing is inserted. The assessment
-- results foreign key on session_id now points at `response_keys(session_id)` (deleting a response still deletes its
-- result, through the key row).
--
-- EXISTING ROWS keep their ids (random UUIDv4 — nothing that names a response, storage paths included, changes). They
-- land in `responses_legacy_low` / `responses_legacy_high`, or, for the ~1% whose random bits fall inside the
-- UUIDv7 window, in the month partition those bits name; this migration creates any such month partition now, so
-- `responses_default` starts empty and stays the safety net for an id nothing else matches.
--
-- MAINTENANCE. `rescript_responses_ensure_partitions(months_ahead)` creates the coming months; the weekly housekeeping
-- cron calls it on every client database. This migration already creates partitions through the end of next year,
-- so nothing depends on the cron for a year.
--
-- SAFETY. One transaction. Re-runnable: a database where `responses` is already partitioned is left alone. The old
-- table is KEPT, renamed `responses_unpartitioned_0111`, its triggers dropped (so a survey deletion that cascades into
-- it cannot release a quota twice) and closed to anon/authenticated; drop it in a later migration once the new table
-- has been seen working. Rollback: scripts/0111-rollback.sql.

begin;

-- ---------------------------------------------------------------------------------------------------- UUIDv7
create or replace function public.rescript_uuid_v7(p_at timestamptz default clock_timestamp())
returns uuid language plpgsql volatile parallel safe set search_path = pg_catalog as $$
declare
  ms bigint := floor(extract(epoch from p_at) * 1000)::bigint;
  b bytea := uuid_send(gen_random_uuid());          -- 122 random bits, variant already 10xx
begin
  b := overlay(b placing substring(int8send(ms) from 3 for 6) from 1 for 6);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);  -- version 7
  return encode(b, 'hex')::uuid;
end $$;

-- the smallest UUIDv7 of a millisecond: a partition bound
create or replace function public.rescript_uuid_v7_floor(p_at timestamptz)
returns uuid language sql immutable parallel safe set search_path = pg_catalog as $$
  select (lpad(to_hex(floor(extract(epoch from p_at) * 1000)::bigint), 12, '0') || '00000000000000000000')::uuid
$$;

-- the millisecond a UUIDv7 names (meaningless, but harmless, for other ids)
create or replace function public.rescript_uuid_v7_time(p_id uuid)
returns timestamptz language sql immutable parallel safe set search_path = pg_catalog as $$
  select to_timestamp((('x' || substr(replace(p_id::text, '-', ''), 1, 12))::bit(48)::bigint) / 1000.0)
$$;

-- ------------------------------------------------------------------------------- month partitions, by name
create or replace function public.rescript_responses_month_partition(p_month date)
returns text language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  m date := date_trunc('month', p_month)::date;
  nm text := format('responses_y%sm%s', to_char(m, 'YYYY'), to_char(m, 'MM'));
  lo uuid := public.rescript_uuid_v7_floor(m::timestamp at time zone 'utc');
  hi uuid := public.rescript_uuid_v7_floor((m + interval '1 month')::timestamp at time zone 'utc');
  blocked boolean := false;
begin
  if to_regclass('public.' || nm) is not null then return null; end if;
  -- a row already sitting in the default partition for this month would make the attach fail; leave the month to
  -- the default (inserts keep working) and say so, rather than failing the caller
  if to_regclass('public.responses_default') is not null then
    execute 'select exists (select 1 from public.responses_default where id >= $1 and id < $2)' into blocked using lo, hi;
  end if;
  if blocked then
    raise warning '[rescript:partitions] % not created: responses_default holds rows in its range', nm;
    return null;
  end if;
  execute format('create table public.%I partition of public.responses for values from (%L) to (%L)', nm, lo, hi);
  execute format('alter table public.%I enable row level security', nm);
  execute format('revoke all on public.%I from anon, authenticated', nm);
  return nm;
end $$;

create or replace function public.rescript_responses_ensure_partitions(p_months_ahead integer default 6)
returns jsonb language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  m date;
  this_month date := date_trunc('month', now() at time zone 'utc')::date;
  made text;
  created text[] := '{}';
  stray bigint := 0;
begin
  if (select relkind from pg_class where oid = to_regclass('public.responses')) is distinct from 'p' then
    return jsonb_build_object('skipped', 'responses is not partitioned (migration 0111 not applied)');
  end if;
  for m in select generate_series(this_month, this_month + make_interval(months => greatest(0, least(p_months_ahead, 60))), interval '1 month')::date loop
    made := public.rescript_responses_month_partition(m);
    if made is not null then created := created || made; end if;
  end loop;
  if to_regclass('public.responses_default') is not null then
    execute 'select count(*) from public.responses_default' into stray;
  end if;
  return jsonb_build_object('created', to_jsonb(created), 'default_rows', stray);
end $$;

-- ----------------------------------------------------------------------- uniqueness that moves to response_keys
create or replace function public.rescript_response_keys_sync()
returns trigger language plpgsql security definer set search_path = public, pg_catalog as $$
begin
  if tg_op = 'INSERT' then
    insert into public.response_keys (response_id, survey_id, session_id, respondent_code)
    values (new.id, new.survey_id, new.session_id, new.respondent_code);
  elsif new.session_id is distinct from old.session_id
     or new.respondent_code is distinct from old.respondent_code
     or new.survey_id is distinct from old.survey_id then
    update public.response_keys
       set survey_id = new.survey_id, session_id = new.session_id, respondent_code = new.respondent_code
     where response_id = new.id;
  end if;
  return null;
end $$;

-- ------------------------------------------------------------------------------------------- the conversion
do $$
declare
  r record;
  trig text[] := '{}';
  idx text[] := '{}';
  inbound jsonb := '[]';
  outbound text[] := '{}';
  pol text[] := '{}';
  acl text[] := '{}';
  force_rls boolean;
  cols text;
  s text;
  m date;
  first_month date;
  last_month date := (date_trunc('year', now() at time zone 'utc') + interval '2 years' - interval '1 month')::date;
  window_lo uuid := public.rescript_uuid_v7_floor('2026-01-01 00:00:00+00');
  window_hi uuid := public.rescript_uuid_v7_floor('2100-01-01 00:00:00+00');
begin
  set local search_path = public, extensions, pg_catalog;

  if to_regclass('public.responses') is null then
    raise exception '0111: public.responses does not exist';
  end if;
  if (select relkind from pg_class where oid = 'public.responses'::regclass) = 'p' then
    raise notice '0111: public.responses is already partitioned — nothing to do';
    return;
  end if;

  lock table public.responses in access exclusive mode;

  -- a unique index this migration does not know how to carry over would be lost: refuse instead
  for r in
    select i.indexrelid::regclass::text as name
      from pg_index i
     where i.indrelid = 'public.responses'::regclass and i.indisunique
       and i.indexrelid::regclass::text not in ('responses_pkey', 'responses_session_id_key', 'responses_survey_code_key')
  loop
    raise exception '0111: unexpected unique index % on responses — extend the migration before running it', r.name;
  end loop;

  -- capture everything that hangs off the table, BEFORE it is renamed
  select coalesce(array_agg(pg_get_triggerdef(t.oid)), '{}') into trig
    from pg_trigger t where t.tgrelid = 'public.responses'::regclass and not t.tgisinternal;

  select coalesce(array_agg(pg_get_indexdef(i.indexrelid)), '{}') into idx
    from pg_index i where i.indrelid = 'public.responses'::regclass and not i.indisunique;

  select coalesce(jsonb_agg(jsonb_build_object('tbl', c.conrelid::regclass::text, 'name', c.conname, 'def', pg_get_constraintdef(c.oid))), '[]')
    into inbound
    from pg_constraint c where c.confrelid = 'public.responses'::regclass and c.contype = 'f';

  select coalesce(array_agg(format('alter table public.responses add constraint %I %s', c.conname, pg_get_constraintdef(c.oid))), '{}')
    into outbound
    from pg_constraint c where c.conrelid = 'public.responses'::regclass and c.contype = 'f';

  select coalesce(array_agg(format('create policy %I on public.responses as %s for %s to %s%s%s',
           p.policyname, lower(p.permissive), p.cmd,
           (select string_agg(case when x = 'public' then 'public' else quote_ident(x) end, ', ') from unnest(p.roles) x),
           case when p.qual is not null then ' using (' || p.qual || ')' else '' end,
           case when p.with_check is not null then ' with check (' || p.with_check || ')' else '' end)), '{}')
    into pol
    from pg_policies p where p.schemaname = 'public' and p.tablename = 'responses';

  select coalesce(array_agg(format('grant %s on public.responses to %s', a.privilege_type,
           case when a.grantee = 0 then 'public' else quote_ident(a.grantee::regrole::text) end)), '{}')
    into acl
    from pg_class c, aclexplode(c.relacl) a
   where c.oid = 'public.responses'::regclass and a.grantee <> c.relowner;

  select relforcerowsecurity into force_rls from pg_class where oid = 'public.responses'::regclass;

  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols
    from pg_attribute a
   where a.attrelid = 'public.responses'::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';

  select coalesce(date_trunc('month', min(started_at) at time zone 'utc')::date,
                  date_trunc('month', now() at time zone 'utc')::date)
    into first_month from public.responses;
  first_month := least(first_month, date_trunc('month', now() at time zone 'utc')::date);

  -- the old table steps aside, its index names freed for the new ones
  for r in select i.indexrelid::regclass::text as name from pg_index i where i.indrelid = 'public.responses'::regclass loop
    execute format('alter index public.%I rename to %I', r.name, left(r.name, 50) || '_pre0111');
  end loop;
  alter table public.responses rename to responses_unpartitioned_0111;

  -- the new table: same columns, defaults, checks and generated columns; partitioned on id
  create table public.responses (like public.responses_unpartitioned_0111
    including defaults including constraints including generated including storage including comments)
    partition by range (id);
  alter table public.responses alter column id set default public.rescript_uuid_v7();
  alter table public.responses add constraint responses_pkey primary key (id);
  foreach s in array outbound loop execute s; end loop;

  -- partitions: the two legacy ranges, the months, the default
  execute format('create table public.responses_legacy_low partition of public.responses for values from (minvalue) to (%L)', window_lo);
  execute format('create table public.responses_legacy_high partition of public.responses for values from (%L) to (maxvalue)', window_hi);
  m := first_month;
  while m <= last_month loop
    perform public.rescript_responses_month_partition(m);
    m := (m + interval '1 month')::date;
  end loop;
  -- an existing random id that falls inside the UUIDv7 window gets the month partition its bits name, created now,
  -- so it never sits in the default partition blocking that month later
  for m in
    select distinct date_trunc('month', public.rescript_uuid_v7_time(o.id) at time zone 'utc')::date
      from public.responses_unpartitioned_0111 o
     where o.id >= window_lo and o.id < window_hi
  loop
    perform public.rescript_responses_month_partition(m);
  end loop;
  create table public.responses_default partition of public.responses default;
  alter table public.responses_legacy_low enable row level security;
  alter table public.responses_legacy_high enable row level security;
  alter table public.responses_default enable row level security;
  revoke all on public.responses_legacy_low, public.responses_legacy_high, public.responses_default from anon, authenticated;

  -- the rows, with no trigger firing (no codes re-issued, no quota touched)
  execute format('insert into public.responses (%s) select %s from public.responses_unpartitioned_0111', cols, cols);

  -- indexes (built once per partition by Postgres), plus the session lookup that used to ride on the unique index
  foreach s in array idx loop
    execute replace(s, ' ON public.responses_unpartitioned_0111 ', ' ON public.responses ');
  end loop;
  create index if not exists responses_session_idx on public.responses (session_id);

  -- uniqueness that a partitioned table cannot hold
  create table public.response_keys (
    response_id uuid primary key references public.responses(id) on delete cascade,
    survey_id uuid not null,
    session_id text not null,
    respondent_code text,
    constraint response_keys_session_id_key unique (session_id),
    constraint response_keys_survey_code_key unique (survey_id, respondent_code)
  );
  alter table public.response_keys enable row level security;
  revoke all on public.response_keys from anon, authenticated;
  comment on table public.response_keys is 'One row per response: the session id and per-survey respondent code uniqueness that the partitioned responses table cannot enforce (0111). Written only by trigger.';
  insert into public.response_keys (response_id, survey_id, session_id, respondent_code)
    select id, survey_id, session_id, respondent_code from public.responses;

  -- foreign keys that pointed at the old table now point at the new one (or at response_keys, for session_id)
  for r in select * from jsonb_to_recordset(inbound) as x(tbl text, name text, def text) loop
    execute format('alter table %s drop constraint %I', r.tbl, r.name);
    if r.def ~* 'references\s+(public\.)?responses\s*\(\s*id\s*\)' then
      execute format('alter table %s add constraint %I %s', r.tbl, r.name,
        regexp_replace(r.def, 'references\s+(public\.)?responses\s*\(', 'REFERENCES public.responses(', 'i'));
    elsif r.def ~* 'references\s+(public\.)?responses\s*\(\s*session_id\s*\)' then
      execute format('alter table %s add constraint %I %s', r.tbl, r.name,
        regexp_replace(r.def, 'references\s+(public\.)?responses\s*\(', 'REFERENCES public.response_keys(', 'i'));
    else
      raise exception '0111: foreign key %.% references responses by a column this migration does not carry: %', r.tbl, r.name, r.def;
    end if;
  end loop;

  -- triggers, after the copy; then the key trigger
  foreach s in array trig loop
    execute replace(s, ' ON public.responses_unpartitioned_0111 ', ' ON public.responses ');
  end loop;
  create trigger responses_keys_sync after insert or update of session_id, respondent_code, survey_id
    on public.responses for each row execute function public.rescript_response_keys_sync();

  -- access: same policies and grants; row-level security as before
  alter table public.responses enable row level security;
  if force_rls then alter table public.responses force row level security; end if;
  foreach s in array pol loop execute s; end loop;
  foreach s in array acl loop execute s; end loop;

  -- the old table keeps its rows for a while, inert
  for r in select tgname from pg_trigger where tgrelid = 'public.responses_unpartitioned_0111'::regclass and not tgisinternal loop
    execute format('drop trigger %I on public.responses_unpartitioned_0111', r.tgname);
  end loop;
  revoke all on public.responses_unpartitioned_0111 from anon, authenticated;
  comment on table public.responses_unpartitioned_0111 is 'The responses table before 0111 partitioned it. Inert (no triggers, closed to anon/authenticated); drop once the partitioned table is confirmed.';

  if (select count(*) from public.responses) <> (select count(*) from public.responses_unpartitioned_0111) then
    raise exception '0111: row counts differ after the copy';
  end if;
end $$;

revoke all on function public.rescript_uuid_v7(timestamptz) from public;
grant execute on function public.rescript_uuid_v7(timestamptz) to anon, authenticated, service_role;
revoke all on function public.rescript_responses_month_partition(date) from public, anon, authenticated;
revoke all on function public.rescript_responses_ensure_partitions(integer) from public, anon, authenticated;
grant execute on function public.rescript_responses_ensure_partitions(integer) to service_role;
revoke all on function public.rescript_response_keys_sync() from public, anon, authenticated;

analyze public.responses;
analyze public.response_keys;

insert into public.schema_marks (migration, note) values ('0111', 'responses partitioned by month on a UUIDv7 id; uniqueness in response_keys')
on conflict (migration) do update set applied_at = now(), note = excluded.note;

-- PostgREST re-reads the schema (the table behind `responses` changed); delivered at commit
notify pgrst, 'reload schema';

commit;
