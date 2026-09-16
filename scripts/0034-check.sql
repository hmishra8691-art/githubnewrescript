-- ============================================================================
-- IS MIGRATION 0034 APPLIED TO THIS DATABASE?
-- ============================================================================
--
-- Paste the whole file into the Supabase SQL editor and run it, or:
--
--   psql "<connection string>" -f scripts/0034-check.sql
--
-- READ-ONLY. It writes nothing, locks nothing and can be run against
-- production at any time — before the migration to see where you are, and
-- after it to prove the migration landed.
--
-- ONE STATEMENT, ON PURPOSE. It used to be four queries with `\pset` in front
-- of them, which is psql's own syntax and a syntax error everywhere else: the
-- Supabase SQL editor is a plain SQL endpoint and answered
-- `42601: syntax error at or near "\"`. It would also have shown only the last
-- of the four results. So everything comes back as one table instead, which
-- every client can run and display.
--
-- HOW IT KNOWS. 0034 replaces the body of seven functions and adds two
-- columns. A function's body has an exact fingerprint —
-- `md5(pg_get_functiondef(oid))` — so "is the new one installed?" has a yes/no
-- answer rather than an eyeball comparison. The two fingerprints below for
-- each function were taken from a scratch PostgreSQL 16 with migrations
-- 0001–0033 applied (the BEFORE) and then 0034 applied (the AFTER).
--
-- A third answer is possible and is the one worth having: UNRECOGNISED. That
-- means this database's copy matches neither, so something edited it outside
-- the migrations. Applying 0034 would overwrite that edit, so find out what it
-- was first.

with expected(proname, before_md5, after_md5) as (values
  ('rescript_project_access',              '6e1d475a1f4c8a6196f36bd1203be9bb', '8c4677553f1f67943e6aa9574ea4b2bd'),
  ('rescript_project_members',             '3105717f30044d41101a0ce87ea8bdf2', '0fb04389863e8d0af87e9d6b96cc5db4'),
  ('rescript_my_projects',                 '586e54ffc521070f424f784dfb49135c', 'deec24579ce1b8c9a51aa59d97c3b326'),
  ('rescript_claim_invitations',           '77aa46a76b041b9dd4c7ac7f1e6419c8', '345264e1f955cef24aa28019dca1af8e'),
  ('rescript_billing_settle',              'c29b1a72d17372efaa730486ce6fc4e2', '88f4a1027cda9959da90c57862fdef11'),
  ('rescript_billing_record',              '3921362ca5c8177728dab723db4ca6ae', '7393f3b85007c3885a52199ac082b812'),
  ('rescript_billing_expire_reservations', '4738a20194b303f94f713f5e7426173f', 'ec30404413119d4ef87488956914db7a')
),
live as (
  select p.proname::text as proname, md5(pg_get_functiondef(p.oid)) as md5
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (select proname from expected)
),
fn as (
  select 1 as ord, e.proname::text as item,
         case
           when l.md5 is null        then 'MISSING - this function does not exist here'
           when l.md5 = e.after_md5  then 'applied'
           when l.md5 = e.before_md5 then 'NOT applied (still 0033)'
           else                           'UNRECOGNISED - edited outside the migrations'
         end as state
    from expected e
    left join live l on l.proname = e.proname
),
-- The two columns finding 2 turns on. Without them a removal cannot be
-- recorded, so removing a collaborator goes on returning them to the
-- workspace default instead of removing them.
col as (
  select 2 as ord, ('project_members.' || c.column_name)::text as item,
         case when x.table_name is null then 'MISSING - 0034 not applied' else 'present' end as state
    from (values ('revoked_at'), ('revoked_by')) as c(column_name)
    left join information_schema.columns x
      on x.table_schema = 'public' and x.table_name = 'project_members'
     and x.column_name = c.column_name
),
-- The index the live-membership reads use. Cosmetic next to the rest — a
-- missing index is slow, not wrong — but it says whether 0034 ran in full.
idx as (
  select 3 as ord, 'project_members_live_idx'::text as item,
         case when count(*) = 0 then 'MISSING - 0034 not applied' else 'present' end as state
    from pg_indexes
   where schemaname = 'public' and indexname = 'project_members_live_idx'
),
verdict as (
  select 4 as ord, '=> VERDICT'::text as item,
         case
           when (select count(*) from fn where state = 'applied') = 7
            and (select count(*) from col where state = 'present') = 2
           then '0034 IS APPLIED'
           else '0034 IS NOT (fully) APPLIED - see the rows above'
         end as state
)
select z.item as "check", z.state as "state"
  from (
    select * from fn
    union all select * from col
    union all select * from idx
    union all select * from verdict
  ) z
 order by z.ord, z.item;
