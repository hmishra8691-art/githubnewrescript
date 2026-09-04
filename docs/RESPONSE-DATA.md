# Response Data — persistence, environments, management

`supabase/migrations/0006_response_management.sql` · runtime session start/save · `apps/studio/lib/responseData.ts` · `packages/engine/src/responseFilter.ts`, `responseImport.ts` · Data → Manage · quotas

One canonical dataset feeds everything:

```
Survey → Survey version
            ↓
        Response  ── environment TEST | LIVE
            ├── respondent_code   TEST_000001 / RESP_000001 (stable, searchable)
            ├── session_id        the runtime's unguessable token
            ├── status            in_progress | complete | screened | quota_full | terminated
            ├── answers           keyed by QUESTION ID, values are OPTION CODES
            ├── revision          every write bumps it (optimistic concurrency)
            ├── source            runtime | import | manual
            └── deleted_at/by/reason
                 ↓
   ┌─────────────┼──────────────┬─────────────┐
Data manager   Quotas      Quality engine   Exports / analysis
```

There are no separate copies. The Data manager, the quota recount, the quality
engine and every export read `responses` through the same service.

## 1. What was wrong (audited 2026-09-04, on the live database)

| symptom | cause |
|---|---|
| 51 of 73 rows `in_progress`, 44 with `answers = {}` | the row was inserted while the survey page was SERVER-RENDERED, so every visit wrote one — a refresh, the Test Survey tab, a crawler |
| a respondent who reloaded lost their answers | the reload minted a NEW row; the answers stayed in the orphan |
| the quality engine could run twice on one completion | the final save fired `sendBeacon` **and** a `fetch`, awaiting neither |
| a failed completion still showed "Thank you" | nothing checked the save's result |
| a test run filled live quota cells | `quota_counts` had no environment column |
| an edited or deleted response left quotas wrong for good | counters were increment-only, never recomputed |
| nothing was searchable, nothing was reversible | no respondent code, no soft delete, no audit trail |

## 2. Persistence

**Sessions are client-initiated and resumable.** `POST /api/session/start`
(`{client, study, mode, token?, requestedVersionId?, resume?}`) mints the row —
or resumes one, when the session id the tab kept in `sessionStorage` belongs to
the same survey and environment and is still in progress, in which case the
answers, calculated values, embedded data and position come back and the
compiled flow is rebuilt around them. One attempt is one row; a refresh
continues, it does not restart. `Restart test session` clears the stored id on
purpose.

**The final save is confirmed.** Every save carries the whole state, so a lost
intermediate save costs nothing. The completion save is awaited and retried
three times (a 4xx is not retried); until it lands the respondent sees
"Saving your answers…", and if it fails they see Retry — never a false
thank-you. A response that ends before the first page (quota full, screened by
embedded data) is persisted the same way.

**Quotas count per environment.** `increment_quota_counts(survey, cells, p_test)`.

## 3. Environment is a parameter, never a default

`apps/studio/lib/responseData.ts` has no fallback environment: `TEST`, `LIVE`
or `ALL`, and `ALL` only because a researcher can ask for it. Every API route
returns **400** when it is missing. `responses.environment` is a stored
generated column (`case when is_test then 'TEST' else 'LIVE' end`), so the
separation is in the database, not in a filter — and every read excludes
`deleted_at is not null` unless the recycle bin was asked for.

## 4. Filtering — one logic engine, two stages

A researcher's filter is an ordinary `Condition` (the same tree, builder and
evaluator as display logic, quotas and quality custom rules).

```
condition → compileResponseFilter → prefilter clauses → the database narrows
                                  → evaluateCondition decides  → count / page / ids
```

The compiled clauses are a **prefilter, never the verdict**: only a top-level
AND of rules contributes, only where a clause no matching row can fail exists
(scalar equality → `answers @> {...}`, index-backed by `responses_answers_gin`).
OR, NOT, negative operators, grid cells and multi-selects contribute nothing
and simply widen the scan. When the compiler can prove the clauses ARE the
condition (`exact`), a count is one indexed query; otherwise the narrowed set
streams through the engine in 1 000-row chunks. Nothing is filtered in the
browser, and a prefilter bug can only ever cost time, never delete the wrong
row. 12 unit tests hold that line.

## 5. Managing — Data → Manage

Grid (paginated server-side, sortable, selectable, sticky id + actions),
one-box search over respondent codes and every exported value, and the filter
builder. Editing: a cell in place, or the full editor with one control per
question type. Every edit is validated by the survey's **own** `validateQuestion`
(with `required` relaxed — a legitimately skipped answer must stay editable)
and carries `expectedRevision`, so a stale editor gets a 409 with the newer
value rather than overwriting it.

Deleting is **soft** and always confirmed with a count the researcher has seen.
A filter-based delete must send `confirmCount`; if the dataset moved since, the
server refuses with the new number (409) — a "delete 23" can never become a
"delete 240". Deleted rows wait in the recycle bin, restore, and are purged
only as a separate act (and only if already soft-deleted). Every edit, delete,
restore and import lands in `response_edits` with who, when, what and why.

## 6. Importing — validate → preview → confirm → one transaction

CSV, TSV or JSON. `suggestMapping` matches columns by variable name (so a file
this platform exported maps itself), then question code, then question text;
anything else is reported, never guessed. Cells are coerced to the shape the
question stores (labels resolve to codes, grids assemble per row) and the
assembled row is validated by `validateQuestion`. The preview reports detected
/ valid / warnings / errors / duplicates / will-create / will-update with a row
number, column, value and expectation for every problem. The commit sends back
the prepared rows and runs `rescript_import_responses` — one transaction, so
`create` mode meeting an existing id rolls the whole file back. An existing
respondent code is **updated in place**, merging the file's columns onto the
stored answers; no `TEST_000123_2` is ever created.

## 7. Quotas from the data

`recountQuotas` evaluates each cell's condition against the stored responses
(complete, not deleted, one environment) and replaces that environment's
counters atomically. It runs after every edit, delete and import, and from the
Quotas panel's **Recount from data**. **Generate from data** reads the distinct
answers of the questions you pick and writes ordinary cells with ordinary
`selected` conditions as an undoable Studio edit — the runtime cannot tell
them from hand-built ones.

## 8. Tests

- `packages/engine`: `responseFilter.test.ts` (12) — prefilter safety, verdict
  parity, free-text search; `responseImport.test.ts` (9) — mapping, coercion,
  validation, duplicates, modes, CSV parsing. 378 engine tests in total.
- SQL: all six migrations replay on a scratch Postgres 16 and the functions are
  exercised end-to-end (codes per environment, `REVISION_CONFLICT`, `create`
  rolling back a duplicate, purge touching only soft-deleted rows).
- `scripts/response-data-test.mjs` (13 checks) — separation, search,
  filter→count→delete, the stale-count refusal, in-grid edit, the full editor,
  concurrency, validation, selection delete, bin + restore, import preview and
  commit, pagination, and the API's refusal of a request with no environment.
