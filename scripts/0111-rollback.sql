-- ROLLBACK FOR 0111 (responses partitioned by month). Not a migration: run by hand only if 0111 must be undone.
--
-- Puts every row — including those written since 0111 — back into an ordinary `responses` table with the unique
-- constraints it had before (session_id; survey_id + respondent_code), points the seven foreign keys back at it,
-- restores its triggers, policies and grants, and drops `response_keys`, the partitioned table and the pre-0111 copy
-- (`responses_unpartitioned_0111`, whose rows are a subset of what is restored). New ids are random again.
-- One transaction; a database where `responses` is not partitioned is left alone.

begin;

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
begin
  set local search_path = public, extensions, pg_catalog;
  if (select relkind from pg_class where oid = to_regclass('public.responses')) is distinct from 'p' then
    raise notice '0111 rollback: public.responses is not partitioned — nothing to do';
    return;
  end if;
  lock table public.responses in access exclusive mode;

  select coalesce(array_agg(pg_get_triggerdef(t.oid)), '{}') into trig
    from pg_trigger t where t.tgrelid = 'public.responses'::regclass and not t.tgisinternal and t.tgname <> 'responses_keys_sync';
  select coalesce(array_agg(pg_get_indexdef(i.indexrelid)), '{}') into idx
    from pg_index i where i.indrelid = 'public.responses'::regclass and not i.indisunique
     and i.indexrelid::regclass::text <> 'responses_session_idx';
  select coalesce(jsonb_agg(jsonb_build_object('tbl', c.conrelid::regclass::text, 'name', c.conname, 'def', pg_get_constraintdef(c.oid))), '[]')
    into inbound
    from pg_constraint c
   where c.contype = 'f' and c.conrelid <> 'public.response_keys'::regclass
     and c.confrelid in ('public.responses'::regclass, 'public.response_keys'::regclass);
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

  for r in select i.indexrelid::regclass::text as name from pg_index i where i.indrelid = 'public.responses'::regclass loop
    execute format('alter index public.%I rename to %I', r.name, left(r.name, 48) || '_part0111');
  end loop;
  alter table public.responses rename to responses_partitioned_0111;

  create table public.responses (like public.responses_partitioned_0111
    including defaults including constraints including generated including storage including comments);
  alter table public.responses alter column id set default gen_random_uuid();
  alter table public.responses add constraint responses_pkey primary key (id);
  alter table public.responses add constraint responses_session_id_key unique (session_id);
  create unique index responses_survey_code_key on public.responses (survey_id, respondent_code);
  foreach s in array outbound loop execute s; end loop;

  execute format('insert into public.responses (%s) select %s from public.responses_partitioned_0111', cols, cols);
  foreach s in array idx loop execute s; end loop;

  for r in select * from jsonb_to_recordset(inbound) as x(tbl text, name text, def text) loop
    execute format('alter table %s drop constraint %I', r.tbl, r.name);
    execute format('alter table %s add constraint %I %s', r.tbl, r.name,
      regexp_replace(r.def, 'references\s+(public\.)?(responses|response_keys)\s*\(', 'REFERENCES public.responses(', 'i'));
  end loop;

  foreach s in array trig loop execute s; end loop;
  alter table public.responses enable row level security;
  if force_rls then alter table public.responses force row level security; end if;
  foreach s in array pol loop execute s; end loop;
  foreach s in array acl loop execute s; end loop;

  if (select count(*) from public.responses) <> (select count(*) from public.responses_partitioned_0111) then
    raise exception '0111 rollback: row counts differ after the copy';
  end if;

  drop table public.response_keys;
  drop table public.responses_partitioned_0111;
  drop table if exists public.responses_unpartitioned_0111;
end $$;

drop function if exists public.rescript_response_keys_sync();
drop function if exists public.rescript_responses_ensure_partitions(integer);
drop function if exists public.rescript_responses_month_partition(date);
delete from public.schema_marks where migration = '0111';

commit;
