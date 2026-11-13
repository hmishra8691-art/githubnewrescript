-- 0097 — drop responses_answers_gin (scalability audit 2026-11-13). NOT APPLIED: apply only after review.
--
-- Why: every autosave rewrites `responses.answers`, and a GIN index on that column is rewritten with it. The index
-- answers only `answers @> …` containment queries, and nothing in the code base issues one (searched apps/ and
-- packages/, 2026-11-13); on the live database it has 0 scans since statistics began (pg_stat_user_indexes,
-- 2026-08-31 → 2026-11-13) while the table took 2,279 updates, of which only 250 were HOT.
--
-- Measured (local Postgres 16, 2 vCPU, live instance's memory settings, 110,000 rows, the save route's two
-- statements): 3,073 → 4,144 saves/s at 50 clients (+35%), 2,892 → 3,257 at 8 (+13%); latency 16.3 → 12.1 ms at 50.
--
-- A plain drop (migrations run in a transaction, where `concurrently` is refused). The live table is 2.7 MB, so the
-- lock it takes is held for milliseconds; on a large table, run `drop index concurrently` by hand instead.
drop index if exists public.responses_answers_gin;

insert into public.schema_marks (migration, note) values
  ('0097', 'dropped responses_answers_gin (never scanned; rewritten on every save) — scalability audit 2026-11-13')
on conflict (migration) do update set applied_at = now(), note = excluded.note;
