# Restore drill: quarterly runbook (audit P1-12)

**Goal:** know how long recovering from a lost database takes (RTO) and how much data that recovery loses (RPO),
from a measured run, not an estimate. Run it once a quarter, and after any change to backups or the database plan.

**Status:** the procedure and the measurement script are written. **No drill has been run yet.** It needs a
staging project and the owner's go-ahead. The first drill's report goes at the end of this file.

## Before you start (about 10 minutes)

1. Find the backup to restore. Supabase dashboard → Database → Backups. Pick a daily backup, or a point in time
   if PITR is on. Write down its time: that is `BACKUP_TAKEN_AT`.
2. Make sure a staging project exists. It must be a separate Supabase project, never production. Its Studio and
   runtime must point at it.
3. Write down the time you start the restore: that is `RESTORE_STARTED_AT`.

## Restore

- **Supabase "Restore to a new project"** (Pro plan or higher, from a daily backup or PITR): choose the staging
  project as the target.
- **Or from a logical dump:** `pg_dump --format=custom` of production (taken by the backup job), then
  `pg_restore --no-owner --dbname "$RESTORED_DB_URL" backup.dump`.
- Re-point the staging apps if the database URL changed, and redeploy.
- The media bucket (R2) is restored separately from its versioned copy, or by syncing the bucket to a staging
  bucket. Record how long that takes in the report too.

## Measure

```
PRIMARY_DB_URL=postgres://readonly@…/postgres \
RESTORED_DB_URL=postgres://…staging…/postgres \
RESTORE_STARTED_AT=2026-12-01T09:00:00Z BACKUP_TAKEN_AT=2026-12-01T03:00:00Z \
STAGING_HEALTH_URL=https://staging-studio…/api/health \
node scripts/restore-drill-verify.mjs > drill-2026-12.md
```

The script is read-only on both databases. It compares the main tables' row counts and newest timestamps,
checks that every migration recorded in production is recorded in the restore, and checks the staging Studio's
health. It prints RTO, RPO and the table.

## Then check by hand (about 15 minutes)

- Sign in to the staging Studio. Open a project with responses. Export a CSV and check the row count matches the
  table.
- Open a live link on the staging runtime, complete one response, and see it arrive.
- Open one recording (if media was restored).

## Pass

The script exits 0, the manual checks pass, and the RTO and RPO are within the targets the owner sets. Suggested
starting targets: RTO ≤ 4 hours, RPO ≤ 24 hours on daily backups, ≤ 5 minutes with PITR.

## Reports

_No drill has been run yet._
