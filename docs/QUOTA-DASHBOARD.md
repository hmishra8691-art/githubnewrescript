# Quota Dashboard

The **Quotas** tab in the Studio now opens a management dashboard on top of the existing quota system. The Quota Logic Builder (`QuotasPanel`) is unchanged and one click away (**Edit Logic**, **Logic Builder**, or **+ Create Quota**, which creates the quota and opens the builder on it).

```
Quota Logic Builder  ──writes──▶  def.quotas (configuration)
runtime completes    ──increment─▶ quota_counts (counters, per environment)
                                        │
                     quotaDashboard(def, counts)   ← one pure function, @rescript/engine
                                        │
                                 QUOTA DASHBOARD
                            view · search/filter/sort · inline numeric edit · delete
                                        │
                        s.update() → definition autosave (flushed) → audit_logs
```

There is no second quota store. Every number on the dashboard is derived from the definition the Logic Builder writes and the counters the runtime writes, using the engine's own `effectiveLimit` — so a cell the dashboard calls **FULL** is exactly a cell `checkQuotas` turns a respondent away on.

## What a programmer sees

**Overview strip** — total quotas, active, near full, full, inactive/unlimited, remaining capacity (sum of remaining-to-maximum over limited cells) and overall utilization. Utilization is *weighted* (Σ current ÷ Σ maximum over limited cells), never an average of percentages, and is omitted when nothing has a maximum.

**One card per quota** — name, status, mode (hard/soft) and on-full action, the **source question(s)** (code – text · variable · type, derived from the cell conditions), the quota total line, then every cell with: label, its condition in words, `current / maximum`, a progress bar, `%`, current, target, maximum (percent cells show the resolved count and the %), remaining to target and remaining to maximum, and its own status. Multi-dimensional quotas (cells crossing several questions) and quotas with more than four cells start collapsed with **Expand ▼**. The footer shows *Last updated* (when the counters last moved, migration 0010) and *Used by* (the quota check nodes, List Fills and rules that read the quota).

**Table view** — a compact grid: Quota · Source question · Cell · Condition · Target · Maximum · Current · Remaining · % · Status · Actions, with the same expand behaviour.

**Statuses**

| Cell | meaning |
|---|---|
| FULL | current ≥ maximum |
| NEAR FULL | ≥ 90 % of maximum |
| ACTIVE | open |
| UNLIMITED | no effective maximum (limit 0, or a percent with no target total) |

A quota is FULL when every limited cell is full, NEAR FULL when any cell is full or near full, ACTIVE otherwise, UNLIMITED when no cell has a maximum, and **INACTIVE** when nothing enforces it — no `quota_check` node reads it and no List Fill consults it (a List Fill with `respectQuotas` and no explicit ids consults every *hard* quota). An inactive quota still counts; the dashboard shows the counts and flags "not enforced".

**Search** matches quota name, id, status, question code/text/variable, cell label and condition text. **Filter**: all / active / near full / full / inactive / unlimited. **Sort**: status (needs attention first — the default), name, question, current, remaining, % filled, last updated; direction toggles.

## Editing numbers

**Edit** turns the card into a form: quota name, target total (when any cell is a percent), and per cell label, **Target**, **Maximum** and unit (count / % of target total). Conditions, mode and on-full actions stay in the Logic Builder.

Validation (`validateQuotaEdit`) blocks the save on: empty name; non-integer or negative values; percent above 100; percent cells without a target total > 0; **Maximum below Target** ("Maximum (100) must be greater than or equal to Target (140)."). A new maximum **below the current count** is allowed only after an explicit confirmation ("the current response count (123) already exceeds the new maximum (100). This change may cause the quota to be considered full immediately. No responses are changed.").

**Save Changes** writes the new quota into the definition through `s.update()` — the same path the Logic Builder uses — and flushes the draft autosave immediately, so the feedback is truthful: *"Quota updated successfully."* or *"Unable to save quota changes. Your changes have not been applied."* (the local edit is undone on failure). **Cancel** restores the previous values. Leaving the tab or the page with an open edit asks first.

Each saved change posts `POST /api/surveys/:id/quotas/audit` with the before/after diff (`quotaEditDiff`), which lands in `audit_logs` as `quota.modified` (also `quota.created`, `quota.deleted`) with who, when and the revision. The **Details** view shows the quota's fields, conditions, references and this change history (`GET /api/surveys/:id/quotas/history?quotaId=`).

## Deleting

**Delete** opens a confirmation naming the quota and its cell count. If the quota is referenced — quota check nodes, List Fills (explicit or implicit), rules that read `quota.<id>` — the dialog says so; for quota checks and explicit List Fill ids a checked-by-default option removes the id from those places so no broken reference is left. Only the rule is removed: responses, questions, variables and history are untouched, and the counters stay in `quota_counts` (recount rebuilds them from data at any time).

## Data

* Counts: `GET /api/surveys/:id/quotas?environment=TEST|LIVE|ALL` — raw `quota_counts` per environment plus `updatedAt` per quota (migration 0010 adds `quota_counts.updated_at`, stamped by both counter functions) and `fetchedAt`. The dashboard re-fetches every 30 s while visible, on **Refresh**, and after **Recount from data** (the existing recount route).
* Schema: `QuotaCell.target` (optional, informational) joins `limit` (the maximum); the engine still routes on `limit` alone, so every existing quota behaves exactly as before.
* Engine: `packages/engine/src/quotaDashboard.ts` — `quotaDashboard`, `quotaRow`, `quotaCellRow`, `quotaReferences`, `filterQuotas`, `sortQuotas`, `validateQuotaEdit`, `applyQuotaEdit`, `quotaEditDiff` (+ 7 tests).
* Studio: `components/studio/QuotaDashboard.tsx`; `QuotasPanel` gains an optional `focusQuotaId`; the store gains `setLeaveGuard` / `canLeaveTab`, which the leftnav consults.
* Tests: `pnpm --filter @rescript/engine test`, `node scripts/quota-dashboard-test.mjs` (16 browser checks on the sandbox with the Master Demo's four quotas and mocked counts).
