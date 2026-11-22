# Scale readiness: consumer scale on Postgres (2026-11-22)

**Goal:** a design that can grow to consumer scale (eventually ~1 billion surveys a year, created by individual
users) without a rewrite. **Decision: stay on Supabase / Postgres**, and make the data shardable and the payloads
small. Every step below keeps Postgres, so moving a client to another database (another Supabase project, Citus,
Aurora, self-managed) later is a migration, not a rewrite.

## The numbers that drive this

- A survey definition averages **849 KB** (up to 2.6 MB); a draft 365 KB (`claude/prelaunch-audit.md`).
- 1 billion definitions × 849 KB ≈ **850 TB** for one version each. That cannot live as `jsonb` in one Postgres.
- The Studio autosaves the WHOLE definition every 900 ms pause, and the draft route reads the full pre-image back
  from the database before each write — so each save moves the definition ~3 times.

## Already in place (do not rebuild)

The tenancy groundwork (`docs/TENANCY-2026-11-13.md`) is the cell architecture and data access layer this plan
needs: `tables.json` classifies 188 tables, `dbFor` / `platformDb` route every call (6 direct calls left, all
waiting on decisions), `tenant_directory` maps keys to clients, crons loop over every database, UUID keys mean
no collisions when a client moves. `ROUTING_WIRED` stays false until steps 4–8 of that plan are done.

## Step 1 — done in this commit: gzip the autosave

`apps/studio/lib/compressedBody.ts`. The editor gzips large JSON bodies (CompressionStream); the draft route
reads plain or gzip (DecompressionStream) and caps the decompressed size at 32 MB (413). Measured on the Master
Demo: 196 KB → 37 KB (5.3×). Safe across deploy skew: an older server's refusal gets one plain retry, then plain
for the rest of the tab; older editors still send plain JSON. 8 tests; Studio suite 1,341/1,341; `audit:code` clean.

## Step 4, phase A — built: published versions copied to object storage (migration 0112, NOT YET APPLIED)

- `@rescript/media` `definitions.ts`: each version is stored gzipped under the sha256 of its **canonical** JSON
  (keys sorted) in the private bucket `rescript-definitions` — R2 when configured, Supabase Storage otherwise.
  Identical versions (templates, clones) are one object. Writes are idempotent; reads verify the hash and refuse a
  corrupted or swapped object.
- Migration 0112 adds `definition_hash / _bytes / _store / _stored_at` to `survey_versions`. A check keeps hash and
  stored_at together; a trigger refuses to change or clear a recorded hash, so a non-null hash always names an object
  the store confirmed. The 0012 immutability trigger is untouched and still freezes the jsonb.
- `/api/cron/definition-store` (every 10 minutes, every client database) copies uncopied versions oldest first,
  10 at a time inside a 40-second budget. The publish path is not touched: the copy is read from Postgres, the truth.
- **Nothing reads the copies yet.** Phase B: the runtime definition route reads by hash (Postgres fallback) and
  checks the two agree for a while. Phase C: new versions stop storing the jsonb (the immutability trigger then
  allows `definition` to become null once a hash exists), and a backfill nulls the old jsonb; unreferenced objects
  are garbage-collected by hash.
- Tested: 6 store tests (Master Demo round trip at ~5× compression, dedup across key order, integrity refusal,
  write race), 6 sweep tests (dedup, failure isolation, time budget, missing migration, slow store), 0112 replayed
  with the whole chain on Postgres 16 and its constraints exercised.

## Step 5 — done: `responses` partitioned by month (migration 0111, applied 2026-11-22)

`supabase/migrations/0111_responses_partitioned.sql`, rollback `scripts/0111-rollback.sql`.

- **Range partitions on a UUIDv7 `id`**, one per calendar month (UTC). New ids carry their creation time
  (`rescript_uuid_v7()`), so the primary key stays `id` and none of the seven foreign keys or any insert changes.
  Partitioning on `started_at` instead would have forced `(id, started_at)` keys into every child table.
- **Uniqueness that a partitioned table cannot hold** (`session_id`; `survey_id + respondent_code`) moves to
  `response_keys`, written by trigger in the same statement — a duplicate still fails with 23505. The assessment
  results foreign key on `session_id` now points there.
- **Existing rows keep their ids** (storage paths and links stay valid): they live in `responses_legacy_low/high`, or
  in the month their random bits name (3 on the primary; those months are created by the migration).
  `responses_default` starts empty and catches any id nothing else matches, so an insert never fails for want of a
  partition.
- **Partitions** exist through the end of next year; the weekly housekeeping cron runs
  `rescript_responses_ensure_partitions(6)` on every client database and logs any rows in the default.
- **Kept, inert:** `responses_unpartitioned_0111` (the old table, triggers dropped, closed to anon/authenticated).
  Drop it in a later migration once the new table has been seen working.
- **Tested** on PostgreSQL 16 with the whole chain replayed: conversion of 300 legacy rows, new inserts land in the
  current month with a code issued, duplicate session id / respondent code refused, updates and soft deletes fire
  their triggers, deletes cascade (edits, keys, assessment results), survey deletion cascades through both tables,
  re-running is a no-op, rollback restores an ordinary table with every row and re-applying works. All 48 SQL test
  files give the same result before and after (43 pass; the same 5 fail on the bare harness either way).
- **Known costs.** A lookup by `session_id` probes each partition's index (fine for years of monthly partitions;
  later the runtime can resolve the id through `response_keys` and prune to one partition). `response_keys` is
  unpartitioned and narrow (~150 bytes a row); it is the next thing to shard, by hash, at billions of rows.

**Apply:** Supabase SQL editor → paste 0111 → Run (one transaction, milliseconds at today's size; it takes an
exclusive lock on `responses` for that time). Then check `select public.rescript_responses_ensure_partitions();`
returns `default_rows: 0`, start a test session, and open a portal scorecard page (PostgREST embeds `responses`
through a foreign key).

## Next steps, in order

| # | Step | Why | Size |
|---|---|---|---|
| 2 | **Finish tenancy steps 4–8** (cross-class functions, the 3 review tables, the 6 direct calls, per-database migrations, the move procedure, unlock) | Without it there is only ever one database | 3–5 weeks (existing plan) |
| 3 | **Drafts as patches.** The editor sends a JSON patch against the revision it holds; the server applies it. Drop the full pre-image read (keep the script-audit diff from the patch itself) | Save cost becomes proportional to the edit, not the survey | 1–2 weeks |
| 4 | **Published versions in object storage.** Immutable versions go to R2 (`@rescript/storage` already has it) keyed by content hash; `survey_versions` keeps id, hash, size, pointer. Read-through cache; the runtime already caches definitions for a year | Takes the petabyte-scale data out of Postgres; identical content (templates, clones) is stored once | 2–3 weeks |
| 5 | ~~Partition `responses` by month~~ — built, see above (children such as `response_edits` can follow the same pattern when they grow) | | done |
| 6 | **Hot counters** (`quota_counts`, `response_counters`, `listfill_counts`): sharded counter rows summed on read, or batched recounts | One busy survey must not serialise every respondent on one row lock | 1 week |
| 7 | **Analytics off the transactional database**: change-data-capture into a columnar store; heavy crosstabs read there | Billions of rows of analytics on Postgres is the first thing to fall over | 2–4 weeks, when volume demands |
| 8 | **Regional cells** (India, EU, US): the tenant directory already routes by client; add a region to each database | Latency and data residency | when needed |

Steps 3, 5 and 6 are worth doing early because they change data shapes; 7 and 8 can wait for real volume.
Supabase compute, disk and plan limits should be confirmed with Supabase before planning capacity beyond one cell.
