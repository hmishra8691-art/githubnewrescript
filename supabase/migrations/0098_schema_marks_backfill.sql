-- 0098 — every migration records itself again (tenancy groundwork, 2026-11-13). NOT APPLIED: apply after review.
--
-- From 0091 each migration was to write its own row into `schema_marks`, so the newest migration a database has run
-- is READ, not inferred. 0093–0096 did not, so the live database's marks stop at 0092 although 0093–0096 are applied
-- (checked read-only on 2026-11-13: tracker_waves, help_messages, support_tickets and profiles.ui_theme exist).
--
-- Why it matters now: once a client can have a database of its own, the same migrations must run on every database,
-- and `scripts/tenancy-migrations-status.mjs` compares each database's marks with supabase/migrations. A mark is
-- written here only when the migration's own objects are present, so a database that never ran 0093 is not told it
-- did. `scripts/tenancy-audit.mjs` now refuses a new migration (0097 on) that does not write its mark.

insert into public.schema_marks (migration, note)
select '0093', 'wave tracker (recorded by 0098: applied before marks were written)' where to_regclass('public.tracker_waves') is not null
union all
select '0094', 'help conversations (recorded by 0098)' where to_regclass('public.help_messages') is not null
union all
select '0095', 'support tickets (recorded by 0098)' where to_regclass('public.support_tickets') is not null
union all
select '0096', 'profile UI theme (recorded by 0098)'
  where exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'ui_theme')
on conflict (migration) do nothing;

insert into public.schema_marks (migration, note) values
  ('0098', 'schema_marks backfill for 0093–0096; every migration records itself (tenancy groundwork)')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
