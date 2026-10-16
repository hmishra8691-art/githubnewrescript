# Independent verification of `11-bug-register.md` — 2026-10-16

Verifier: separate agent, read-only on the repo (`b0dbe08`, working tree clean apart from `docs/audit-2026-10-16/`). Inputs: `11-bug-register.md`, `01-executive-summary.md`, `raw/*.md`, repo source, two repro runs.

## 1. ID coverage and priority/status agreement with the raw reports

**Coverage.** Every ID that has a row/heading in register sections A–D (123 unique IDs; 116 area + 7 `OR-`) exists in a raw report or is an `OR-` orchestrator finding. No orphan IDs.

Raw IDs that have no row in A–D and are not named in section E: `ANALYTICS-04` (P2 UNVERIFIED — folded into OR-03's evidence column), `CLEAN-11` (IMPLEMENTED), `CLEAN-13` (IMPLEMENTED by design — only cross-referenced from RUNTIME-01), `DOC-15` (IMPLEMENTED as designed), `RUNTIME-13` (P3 UNVERIFIED, Playwright suites not runnable).

**Mismatches (register vs raw).**

| ID | Register | Raw report | Verdict |
|---|---|---|---|
| RUNTIME-01 | P0 | `schema-and-runtime.md` P1 BROKEN (server trust) | PRIORITY MISMATCH (register escalated; not stated as an orchestrator override) |
| RUNTIME-02 | P1 | `schema-and-runtime.md` P2 BROKEN (access gate bypass) | PRIORITY MISMATCH (escalated) |
| DOC-12 | P3 (section D) | `documents-and-cleaning.md` P2 PARTIAL | PRIORITY MISMATCH (demoted) |
| ARCH-04 | P3 | `architecture.md` P2 | PRIORITY MISMATCH |
| ARCH-10 | P3 | `architecture.md` P2 | PRIORITY MISMATCH |
| ARCH-13 | P2 | `architecture.md` P3 | PRIORITY MISMATCH |
| QT-14 | MISSING | `question-types-validation.md` PARTIAL | STATUS MISMATCH |
| ANALYTICS-11 | PARTIAL | `analytics.md` IMPLEMENTED (P3) | STATUS MISMATCH |
| CLEAN-08 | PARTIAL (merged with DOC-08) | `documents-and-cleaning.md` IMPLEMENTED (gap in statistical formats = DOC-08) | STATUS MISMATCH (defensible merge, but raw says IMPLEMENTED) |
| CLEAN-12 | PARTIAL | `documents-and-cleaning.md` UNVERIFIED on real data | STATUS MISMATCH |
| DOC-13 | PARTIAL in D **and** "verified as implemented" in E | raw: IMPLEMENTED (stamping PARTIAL) | Listed in two sections; consistent with raw but double-counted |
| ARCH-01..13 | all "PARTIAL" | `architecture.md` table has no status column (Severity only) | Status not sourced from raw (register-invented) |
| AI-01 | P1, no Status line | raw P1 BROKEN (repro) | OK (format only) |
| QT-08 | UNVERIFIED | raw "UNVERIFIED→PARTIAL" | minor |
| LOGIC-12 | UI-ONLY | raw "BROKEN (repro) / UI-ONLY" | minor |
| RUNTIME-08 | PARTIAL (repro) | raw PARTIAL (no repro) | OK — orchestrator added the browser repro |

All other IDs: priority and status agree.

## 2. Header counts — recount

Header says: **P0: 1 · P1: 11 · P2: 54 · P3: 63 — 129 findings (119 area + 10 OR-)**.

Recount from the register's own sections:

| Section | Rows | Unique IDs | Header |
|---|---|---|---|
| A (P0) | 1 | 1 | 1 ✓ |
| B (P1) | 11 | 11 | 11 ✓ (includes AI-01 = duplicate of QT-01) |
| C (P2) | 47 | 50 (3 rows carry two IDs: DOC-08/CLEAN-08, SCHEMA-01/RUNTIME-03, ARCH-05/SCHEMA-10) | **54 ✗** |
| D (P3) | 61 | 61 | **63 ✗** |
| Total | **120 rows / 123 IDs** | | **129 ✗** |
| `OR-` findings | 7 (OR-01..07) | | **10 ✗** |
| Area findings | 113 rows / 116 IDs | | **119 ✗** |

Status tally over the 120 rows: BROKEN 21 · PARTIAL 75 · MISSING 11 · UNVERIFIED 5 · UI-ONLY 3 · by design 2 · UI gap 1 · IMPLEMENTED 1 (ANALYTICS-09) · no status line 1 (AI-01). The header's "verified defects 71 / suspected 9 / enhancements 49" (=129) cannot be reconstructed from the rows under any grouping I tried; it should be recomputed. Note QT-04 is a row that is literally "= RUNTIME-01" and AI-01 "tracked together with QT-01", so two of the counted findings are duplicates.

## 3. P0/P1 code citations

| ID | Cited location | Verdict | What I saw |
|---|---|---|---|
| RUNTIME-01 | `apps/runtime/app/api/session/save/route.ts:47–69` | **CONFIRMED** | `:47-48` accept any `status` in a 5-value list; `:60-69` build `update` with `answers: answers ?? {}`, `calculated`, `embedded`, `flags`, `step_index: Number(stepIndex)\|\|0`, `completed_at` verbatim. `resolveRunDefinition` at `:54` feeds only telemetry config. `grep validatePage\|validateQuestion\|checkQuotas apps/runtime/app apps/runtime/lib` → 0 files. |
| QT-01 / AI-01 | `packages/engine/src/surveyActions.ts:1127` | **CONFIRMED** | `:1127` `if (a.validation?.length) q.validation = a.validation.map(...)` — assignment, not merge. `:553` and `:701` (`set_validation`) likewise assign `q.validation = validationFromSpecs(...)`. Seeds it overwrites: `questionCreate.ts:44` `q.validation = v.defaults.validation`; `variants.ts:835` email `defaults.validation [{kind:"email"}]`, `:941` integer `[{kind:"integer"}]`. |
| QT-02 | `prompt.ts` numeric example; no `inferValidation` | **CONFIRMED by repro** | Cases A/B of `age-validation.mjs` (see §4). Not re-read `prompt.ts`. |
| LOGIC-01 | `apps/studio/components/studio/QuestionsPanel.tsx:426–428`; `store.tsx:275–287`; `optionActions.ts:303–327` | **CONFIRMED** | `:426-428` `<input data-testid="option-code" onChange={(e) => set(i, { code: e.target.value })}>` — raw patch. `store.tsx:280-286` `withOptionCodes` only canonicalises labels→codes. `recodeConditions` (`optionActions.ts:303`) / `recodeOwnLists` (`:324`) exist and are not referenced from QuestionsPanel or store (grep → 0). |
| LOGIC-03 | `packages/engine/src/calcContext.ts:100–122`; `calc.ts:339–347`; `dependencies.ts:645` | **CONFIRMED** | `calcContext.ts:100-121` `resolver` checks loop scope, `flat` (variable names), `state.calculated`, embedded, named expressions, then `return undefined` — no code→variable lookup. `calc.ts:344-345` `o.resolver(n.name)` → `undefined` becomes `null`. `dependencies.ts:644` `lintCalculations` (cycles only). |
| METHOD-01 | `packages/engine/src/validate.ts:706`; renderer `QuestionRenderer.tsx:1795–1870` | **CONFIRMED** | `:706` `if (q.type === "conjoint_task" && q.required ...)` — the comment above (`:701-705`) promises MaxDiff "best AND worst" but the condition is conjoint-only. The only `maxdiff_task` block is `:478` and checks the anchor follow-up only. Renderer `:1799` `isMaxdiff` in the design-task component. |
| METHOD-02 | `packages/analytics/src/stats/choice.ts:203` | **CONFIRMED — WRONG PATH** | `stats/choice.ts` is 96 lines. The code is at **`packages/analytics/src/analyses/choice.ts:203`**: `const version = String(c.answers[\`${qid}_version\`] ?? "1")` with no `c.vars[..._VERSION]` fallback; the conjoint runner at `:74` has it. Raw report cites the correct path; the register dropped `analyses/`. |
| METHOD-03 | `stats/choice.ts:56` (`chosen: -1` → TypeError) | **CONFIRMED (line approx.)** | `analyses/choice.ts:218` `rest = ids.filter(i => i !== b)` … `chosen: rest.indexOf(wo)` → `-1` when best==worst. `stats/choice.ts:53-54` `const ch = alts[s.chosen]; ... ch[i]` → TypeError on `undefined`. Line 56 is the compiled `dist/stats/choice.js` line; source is 53-54. |
| DOC-06 | `packages/exporters/src/spss.ts:72–78` `ascii()` | **CONFIRMED** | `:72-78` `.replace(/[^\x20-\x7e]/g, " ")`; applied at `:59` (fixed-width strings), `:92` (names), `:171` (var labels), `:218` (string cells), `:228` (value labels). |
| DOC-07 | `apps/studio/app/api/surveys/[id]/responses/route.ts:29` vs `packages/access/src/roles.ts:181–185` | **CONFIRMED** | `:29` `requireProject(req, params.id, "responses.read")` is the only gate; the `format !== "summary"` branch (`:65-87`) adds a read-only meter check and an audit row, no capability check; `responses.export` appears nowhere in the file. `roles.ts:181-185` `viewer: ["project.read","project.read_members","responses.read","analytics.read"]`. |
| RUNTIME-02 | `apps/runtime/app/api/session/start/route.ts:35–50` vs `app/s/[client]/[study]/page.tsx:22–43` | **CONFIRMED** | `start/route.ts:35-50` parses client/study/mode, `loadDeployment(client, study, "live")`, 404 if null — no `password`, `BLOCKING_STATUSES`, `paused`, `closed` anywhere in the route (grep → 0). `lib/deployment.ts` only *reports* `surveyStatus`; `BLOCKING_STATUSES` is consumed solely by `page.tsx:24` and the password check lives at `page.tsx:33-34`. |

Secondary citations spot-checked and present: `QuestionRenderer.tsx:2798 default: body = <TextInput>` (OR-01), `calc.ts:336-349` var case.

## 4. Reproductions run by the verifier

`node docs/audit-2026-10-16/repro/qt/age-validation.mjs` (exit 0) — matches the register:
- A (numeric 18–100): `25.5`, `"abc"`, `"1e2"` ACCEPTED (3 mismatches).
- B (numeric 1–100): same 3 mismatches.
- C (`type:"integer"` + min/max): stored validation `[min_value, max_value]` — **the `integer` rule is gone**; `25.5`, `"abc"`, `"1e2"` ACCEPTED.
- D (numeric + explicit `integer` rule): `25.5` and `"abc"` rejected ("Please enter a whole number"); `"1e2"` still ACCEPTED (QT-03 residue).

`node docs/audit-2026-10-16/repro/logic/calc-eq.mjs` (exit 0) — matches the register:
- calc `Q7 > 3` with answer 5 → `OUT=false`, `err=` (empty); `Q7 == 5` → false; `COLOR == 2` (variable name) → true; `lintCalculations(Q7 > 3)` → `[]`.
- Trailing lines (`parseLogicExpression`) show the *condition* path resolves `Q7 > 3 -> true`, consistent with the register's note that only the calc DSL is affected.
- The register's "`Q7 + 1` = 1" figure is from the sibling `calc-eq2.mjs` (also run: `safeExpression Q7 + 1: 1  N + 1: 6  Q7 > 3: false`), not from `calc-eq.mjs`.

## 5. Section E ("verified as implemented") — proof trail

| Claim | Proof cited in raw | Verdict |
|---|---|---|
| ANALYTICS-01 base = answered, 83/84 | `repro/analytics/controlled.mjs` (exists); output file `repro/analytics/*.out` **missing** | PROVEN by script; output not kept |
| ANALYTICS-08 full stat catalogue, Holm letters | `analytics.md` row lists the catalogue; no test or script named | **NO CITED PROOF** (code reading only) |
| ANALYTICS-10 one `compute()` | `analytics.md:109` code trace of `apps/studio/lib/analytics.ts compute()`; no test | **NO CITED PROOF** (code reading; raw itself notes two side paths `synthesis.ts`, `dataQuery.ts` compute their own counts) |
| CLEAN-02/04/05/10/14 | `pnpm --filter @rescript/quality test` → 51 pass; `repro/clean/run-rules.mjs` (exists; `run-rules.out` **missing**); CLEAN-04/05/10 are code/migration citations, each with raw "gaps P3" | Partly proven (CLEAN-14 by test run; 02/04/05/10 by code reading) |
| DOC-01 questionnaire spec .docx | `docxText.test.ts`, `surveyExport.test.ts:133-227`; `repro/doc/docx-unicode.mjs` | PROVEN |
| DOC-05 export catalogue with tests | `pnpm --filter @rescript/exporters test` → 102 pass; `exporters.test.ts` | PROVEN |
| DOC-13 Unicode in .docx | `repro/doc/docx-unicode.mjs` | PROVEN (but DOC-13 stamping is also a P3 row in D) |
| DOC-14 org/project scoping | `guard.ts:215-285`, `roles.ts:187-191` code reading | **NO CITED PROOF** (and raw flags a P3 `test_user` gap) |
| LOGIC-06 delete prunes references | `repro/logic/ref-integrity.mjs` §5 | PROVEN |
| RUNTIME-12 double-submit CAS, resume | `save/route.ts:89-114` code; engine `resumeStep` 34/34 tests | Partly proven (engine tests; CAS by code reading, no DB) |
| SCHEMA-12 immutability, CAS, single running apply | migrations read; raw states `scripts/*-sql-test.sql` **could not be run (no Postgres)** | **NO EXECUTED PROOF** — register's "IMPLEMENTED = verified by an executed test or repro" vocabulary is not met |
| ARCH summary: typecheck clean, 3,929 tests, auth-guard clean, 92 tables RLS | `architecture.md:9-12` command table; logs `repro/arch/typecheck.log`, `authguard.log`, `pkgtests.log`, `studiotests.log` **all missing**; `repro/arch/tables.txt` + `repro/schema-runtime/rls.txt` exist | Claimed executed; logs not retained |
| Script pipeline 13-check browser suite (2026-10-15) | Not in any raw report; refers to the prior session's doc | **NO PROOF IN THIS AUDIT** |
| METHOD generators (CBC balance, prohibitions, BIBD, seeded versions, planted-utility recovery) | `repro/method/01-designs.mjs` + `.out.txt`, `02-estimation.mjs` + `v1/v4.out.txt` (all exist) | PROVEN |

## 6. "repro"-marked findings whose script is absent

No register row marked "(repro)" points at a non-existent script. All referenced `.mjs/.ts` repro files under `docs/audit-2026-10-16/repro/` exist (39 scripts). Mapping of unnamed "(repro)" rows to scripts: OR-01 and RUNTIME-08 → `browser/runtime-misc.mjs`; OR-04/05/06 → `browser/matrix-selector.mjs`; OR-02 → `browser/matrix-scroll.mjs` + `mobile-390.png`; AI-02/03/06 → `ai/brand-tracker.mjs` (`run1.txt` §3/§9/§11); LOGIC-09 → `logic/matrix-refs2.mjs`; LOGIC-10 → `logic/lint-rhs.mjs`; LOGIC-12 → `logic/custom-design.mjs`; CLEAN-06 → `clean/deleted-peers.mjs`; ANALYTICS-02/05 → `analytics/controlled.mjs` / `plan.mjs`.

Referenced **output/helper files that do not exist** (raw reports cite them as kept): `repro/analytics/controlled.out`, `repro/clean/run-rules.out`, `repro/clean/synthetic.mjs`, `repro/arch/typecheck.log`, `repro/arch/authguard.log`, `repro/arch/pkgtests.log`, `repro/arch/studiotests.log`, `repro/arch/imports.sh`, `repro/arch/sqlscan.py`, `repro/arch/tablewrites.py`.

## Summary

- All 10 P0/P1 citations are real and say what the register claims; one path is wrong (METHOD-02: `stats/choice.ts:203` → `analyses/choice.ts:203`) and one line is a dist line (METHOD-03: source `stats/choice.ts:53-54`).
- Both requested repros reproduce as described.
- Header counts are wrong: true figures are P0 1 · P1 11 · P2 47 rows (50 IDs) · P3 61 — 120 rows / 123 IDs; `OR-` findings are 7, not 10.
- Six priority and four status disagreements with the raw reports (table in §1); ARCH statuses have no raw source.
- Section E: 5 of 14 claims rest on code reading or an unrun SQL test rather than an executed proof (ANALYTICS-08, ANALYTICS-10, DOC-14, SCHEMA-12, script-pipeline suite); 10 cited output/log files are not in the repo.


---
## Orchestrator response to this verification (2026-10-16)
Applied: header counts recomputed (120 rows / 124 IDs; P0 1, P1 11, P2 49, P3 59); DOC-12, ARCH-04, ARCH-10 restored to P2 and ARCH-13 moved to P3 to match the raw reports; QT-14, ANALYTICS-11, CLEAN-08, CLEAN-12 statuses aligned with raw; ARCH statuses labelled as orchestrator classification; DOC-13 removed from the "verified implemented" list; METHOD-02/03 citations corrected to analyses/choice.ts:203 and stats/choice.ts:53-54; the "Q7 + 1 = 1" figure attributed to calc-eq2.mjs; section E split into "proven by executed test/repro" vs "code-verified only"; ANALYTICS-04, CLEAN-11, CLEAN-13, DOC-15, RUNTIME-13 referenced; missing output files regenerated (controlled.out, run-rules.out, calc-eq2.out, ref-integrity.out) and references to non-kept helpers removed. Deliberate deviations kept: RUNTIME-01 rated P0 and RUNTIME-02 rated P1 by the orchestrator (integrity exposure to any respondent-side actor), above the area auditor's P1/P2.
