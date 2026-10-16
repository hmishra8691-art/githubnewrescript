# Migration undo notes

Audit SCHEMA-03 and SCHEMA-08, 2026-10-16. None of the SQL below has been executed. The sandbox it was written in has no Postgres. Run it on a Supabase branch first.

## Policy: migrations only go forward

- `supabase/migrations/` holds forward migrations only. There are no down files, and none will be added. A down file is code that nobody runs until the day it matters, so it is the least-tested code in the repo.
- The way to recover from a bad migration is to **restore from backup or point-in-time recovery**. Use that when data has been written under the new schema and you cannot afford to reason about every row.
- The other way is a **new forward migration** that undoes the change. Use that when the bad change is structural and the data is fine. The SQL below gives you a starting point for that migration, for each migration that moves data or changes behaviour in a way that is hard to see.
- Each new migration's header says whether it can be re-run, what it moves, and points here. Migrations that only add something (new tables, nullable columns, `create or replace` functions with the same signature) can be undone in the obvious way and are not listed.
- The one existing scripted rollback is `scripts/0034-rollback.sql`, checked with `scripts/0034-check.sql`.

## The three migrations that move data

### 0025 — one wallet per person (`0025_central_wallet.sql`)

What it moved: `rescript_billing_sweep_to_owners()` transferred every owned project wallet's balance to the owner's personal wallet. Each transfer went through `rescript_billing_transfer` with reason `central_wallet_migration`. It then set `project_wallets.retired_at`, created a `project_spending` row for every survey, and copied `total_used` into `project_spending.spent`.

Undo. Only do this before 0031: 0031 renames `project_spending.survey_id`. It also only works while the owner still holds the money.

```sql
-- 1. reverse each sweep transfer; a transfer the owner has since spent refuses with insufficient_available
select t.code,
       public.rescript_billing_transfer(t.destination_wallet_id, t.source_wallet_id, t.amount,
         'central_wallet_migration_undo', 'Undo of 0025', null, t.id, 0) as result
  from public.credit_transfers t
 where t.reason = 'central_wallet_migration' and t.status = 'completed' and t.reversal_of is null;
-- 2. project wallets fund themselves again
update public.project_wallets set retired_at = null, updated_at = now()
 where survey_id is not null and retired_at is not null;
-- 3. re-create rescript_billing_wallet_for / _reserve / _release / _settle / _record from the LAST migration
--    before 0025 that defines each (grep "function public.<name>" in 0001–0024; copy those sections verbatim)
-- 4. the policy table, last (nothing reads it once step 3 is done)
drop function if exists public.rescript_billing_sweep_to_owners();
drop function if exists public.rescript_billing_set_spending(uuid, uuid, text, numeric);
drop function if exists public.rescript_billing_spending_for(uuid, uuid, boolean);
drop function if exists public.rescript_billing_project_state(public.project_spending);
drop function if exists public.rescript_billing_project_headroom(public.project_spending);
drop table if exists public.project_spending;
alter table public.project_wallets drop column if exists retired_at;
```

The ledger is immutable. The reversal adds lines and deletes none, so the history shows the move and its undo.

### 0031 — billing subject (`0031_billing_subject.sql`)

What it moved: it renamed `project_spending.survey_id` to `subject_id` and rebuilt the primary key as `(subject_kind, subject_id)`. It dropped the foreign key to `surveys` and replaced the cascade with `*_forget_spending` triggers. It added `subject_kind` to `usage_reservations` and `usage_events`, and `usage_events.idempotency_key`. It also replaced `rescript_billing_reserve` with an 11-argument version (dropped first).

Undo. Interview billing must be switched off and interview spending rows removed first. A `survey_id` column cannot hold them.

```sql
delete from public.project_spending where subject_kind <> 'survey';
drop trigger if exists interview_projects_forget_spending on public.interview_projects;
drop trigger if exists surveys_forget_spending on public.surveys;
drop function if exists public.rescript_billing_forget_subject();
alter table public.project_spending drop constraint if exists project_spending_pkey;
alter table public.project_spending drop constraint if exists project_spending_subject_kind_check;
alter table public.project_spending rename column subject_id to survey_id;
alter table public.project_spending drop column if exists subject_kind;
alter table public.project_spending add primary key (survey_id);
delete from public.project_spending p where not exists (select 1 from public.surveys s where s.id = p.survey_id);
alter table public.project_spending add constraint project_spending_survey_id_fkey
  foreign key (survey_id) references public.surveys(id) on delete cascade;
-- the ten-argument reserve and every other billing function 0031 replaced: re-create from the LAST migration
-- before 0031 that defines each (grep "function public.<name>" in 0001–0030), verbatim,
-- after `drop function if exists public.rescript_billing_reserve(uuid, uuid, uuid, uuid, text, text, numeric, numeric, numeric, integer, text);`
-- subject_kind on usage_* and usage_events.idempotency_key are harmless to keep (defaults; nothing old reads them)
```

### 0053 — one running plan apply (`0053_plan_apply_single_running.sql`)

What it moved: it marked `running` rows older than 2 minutes as `failed` ("This apply did not finish — it was interrupted."). Where two rows were running for one survey, it kept the newer one and marked the older `failed` ("Superseded by a newer apply."). It then added a partial unique index.

Undo. The status changes cannot be told apart from real failures except by their `error` text, and a running apply older than two minutes was already dead. Drop the index only:

```sql
drop index if exists public.analytics_plan_applies_one_running;
```

## The 2026-10-16 batch

### 0055 — profile self-update limited to descriptive columns

```sql
drop trigger if exists profiles_guard on public.profiles;
drop function if exists public.rescript_profiles_guard();
grant update on public.profiles to authenticated;   -- re-opens SCHEMA-05: a user may update role / customer_id of their own row
```

### 0056 — `abandoned` response status (engineer R)

The sweep already released the List Fill claims of abandoned rows. Re-opening those rows does not take the claims back. Run `rescript_recount_listfill` per survey and environment afterwards if that matters.

```sql
update public.responses set status = 'in_progress' where status = 'abandoned';
alter table public.responses drop constraint if exists responses_status_check;
alter table public.responses add constraint responses_status_check
  check (status in ('in_progress', 'complete', 'screened', 'quota_full', 'terminated'));
-- and remove /api/cron/expire-partials from apps/studio/vercel.json, or it re-abandons them
```

### 0057 — quota cells released when a complete response is deleted

Counters the trigger has already moved stay where they are. After the undo, run the Quota recount for affected surveys (Studio, Quotas, then Recount, which calls `rescript_replace_quota_counts`). The runtime must go back to calling `increment_quota_counts` before `rescript_count_quota_cells` is dropped. If it does not, its fallback path handles a missing function.

```sql
drop trigger if exists responses_release_quota on public.responses;
drop function if exists public.rescript_release_quota_on_delete();
drop function if exists public.rescript_release_quota_cells(uuid, jsonb, boolean);
drop function if exists public.rescript_count_quota_cells(uuid, text, jsonb, boolean);
alter table public.responses drop column if exists quota_cells;
```

### 0058 — weekly housekeeping

Deleted rows cannot be undone; restore them from backup if they are needed. To stop the sweep:

```sql
drop function if exists public.rescript_housekeeping(integer, integer, integer, integer);
drop index if exists public.login_attempts_created_idx;
drop index if exists public.analytics_share_access_created_idx;
drop index if exists public.interview_telemetry_created_idx;
comment on table public.design_files is null;
```

Also remove `/api/cron/housekeeping` from `apps/studio/vercel.json`. If you leave it, the route answers `skipped` while the function is missing. To change retention without removing the sweep, pass arguments: `rescript_housekeeping(p_login_days, p_share_access_days, p_telemetry_days, p_batch)`. The defaults are 90 / 180 / 180 / 50 000.

### 0059 — engineer A

The undo notes for 0059 belong to that migration's author.

## Decision: `design_files` is kept (SCHEMA-08)

`design_files` (0001) has no reader or writer in `apps/` or `packages/`. Conjoint and MaxDiff designs are stored inline in the survey definition (`designs[].file.rows`, `packages/schema/src/survey.ts`), and that is how they reach the runtime.

**It is not dropped.** The audit's own recommendation (`raw/schema-and-runtime.md` A10 row 3) is to *use* the table. Generated design matrices should move out of the respondent payload into `design_files`, with `survey_version_id` and `definition_hash` added, behind a loader that resolves `designs[].file.storagePath` first. Dropping the table before that loader exists would mean re-creating it, with its RLS and grants, in the migration that adds the loader.

The table is marked instead: `comment on table public.design_files is 'unused — designs ship inline in the definition; see docs/MIGRATION-UNDO-NOTES.md'` (0058). Revisit when the design loader is built. If the decision then is not to use it, `drop table if exists public.design_files;` in a numbered migration is the whole change. Nothing references it.
