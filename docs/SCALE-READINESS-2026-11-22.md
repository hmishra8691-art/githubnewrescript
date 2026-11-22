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

## Next steps, in order

| # | Step | Why | Size |
|---|---|---|---|
| 2 | **Finish tenancy steps 4–8** (cross-class functions, the 3 review tables, the 6 direct calls, per-database migrations, the move procedure, unlock) | Without it there is only ever one database | 3–5 weeks (existing plan) |
| 3 | **Drafts as patches.** The editor sends a JSON patch against the revision it holds; the server applies it. Drop the full pre-image read (keep the script-audit diff from the patch itself) | Save cost becomes proportional to the edit, not the survey | 1–2 weeks |
| 4 | **Published versions in object storage.** Immutable versions go to R2 (`@rescript/storage` already has it) keyed by content hash; `survey_versions` keeps id, hash, size, pointer. Read-through cache; the runtime already caches definitions for a year | Takes the petabyte-scale data out of Postgres; identical content (templates, clones) is stored once | 2–3 weeks |
| 5 | **Partition `responses` by month** (and its large children) **before the first live wave** | Zero live responses today: free now, very expensive with billions of rows | 1 week |
| 6 | **Hot counters** (`quota_counts`, `response_counters`, `listfill_counts`): sharded counter rows summed on read, or batched recounts | One busy survey must not serialise every respondent on one row lock | 1 week |
| 7 | **Analytics off the transactional database**: change-data-capture into a columnar store; heavy crosstabs read there | Billions of rows of analytics on Postgres is the first thing to fall over | 2–4 weeks, when volume demands |
| 8 | **Regional cells** (India, EU, US): the tenant directory already routes by client; add a region to each database | Latency and data residency | when needed |

Steps 3, 5 and 6 are worth doing early because they change data shapes; 7 and 8 can wait for real volume.
Supabase compute, disk and plan limits should be confirmed with Supabase before planning capacity beyond one cell.
