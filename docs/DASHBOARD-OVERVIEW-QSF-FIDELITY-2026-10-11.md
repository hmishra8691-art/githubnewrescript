# Dashboard, Project Overview, Wallet, and Qualtrics QSF Fidelity — 2026-10-11

The "High-Priority Update" brief, executed in its priority order. Everything below is either **done** (shipped, tested, mutation-checked), **partial** (shipped with a stated limit), or **recommended** (not done; a next step). Nothing here claims more than the tests measure.

Commits (cloud): `058da08` Priority 1 (dashboard, overview, wallet, spend, activity events); the QSF work (Priorities 2–5) is the commit after it.

---

## 1. Dashboard changes — done

The project list keeps every per-project metric the brief lists (name and id, questions, live / test / completed responses, status) and **no longer shows Project Spend**. The summary band shows **Projects** and **Live** only; the total-questions and responses tiles are gone. The balance filter and the "spent" sorts are gone with the spend they filtered on. Usage tracking and billing are untouched: the meters are still read by `/api/billing/projects` and written by every metered route exactly as before; the dashboard simply does not draw them. `SurveyCard` keeps its budget menu item so a project's budget is still set from the list.

Files: `apps/studio/app/page.tsx` (the card is given no meter, so its spend block never renders — `SurveyCard.tsx` itself is unchanged), `apps/studio/app/design-system.css`.

## 2. Navigation changes — done

Login → Dashboard → **Project Overview** → the tool. The bare project URL `/studio/<id>` now renders the overview; `?tab=…`, `?mode=…` and `?split=…` open the Studio directly, so every existing deep link, bookmark and the tools' own links keep working, and a refresh on either page stays on that page. The Studio's top bar has an "← Overview" link; the overview has "Projects" in the header and a crumb back to the dashboard.

The overview (`components/project/ProjectOverview.tsx`, `GET /api/surveys/{id}/overview`) has the four sections the brief asks for:

- **A. Project information** — title, code, status, client, manager, due date, questions, pages, live / test / completed responses, last response time, languages.
- **B. Configuration and setup states** — ten modules (questionnaire, quotas, response collection, data quality, research design, analysis plan, dashboards & reports, languages, fieldwork, project details), each **Configured / Incomplete / Not set up / Needs attention**. Every state is computed in `lib/projectOverview.ts` from saved data only: the definition (draft first), the deployments table, the live quota counters, the reports and runs, the sample sources, the project configuration. Nothing is inferred from the lifecycle status alone and nothing is hard-coded; "Needs attention" comes from the engine's own quality check (logic errors) and from a project marked live with no live link deployed.
- **C. Project utilization** — the project's spend in dollars from the same `projectMeterView` the usage panel uses (used, allowance or limit, mode, level, event count), with the wallet shown only as "remaining in the wallet" so the two are never confused; and in the Studio a compact **`Mode | Project spend: $x.xx`** chip beside the Mode selector, read through `useMeterView` (5-second cache) so it moves with usage. There is no duplicate spend card.
- **D. Navigation** — one button per module into the existing Studio tabs, Analytics, Languages, Settings and Usage.

The overview also keeps **Recent activity** (§8) from the audit log; status changes and version restores now write `survey.status_changed` / `version.restored` audit events so they appear beside the others. No entry is invented.

`/sandbox/overview` renders the same component for the browser suites (exempted in `scripts/auth-guard-audit.mjs`).

## 3. Wallet and spend changes — done

The large wallet display is gone from the dashboard. `GET /api/billing/wallet` returns the signed-in person's wallet; `components/billing/WalletMenu.tsx` is a compact pill in the top-right account area (beside Profile / Security) on the Dashboard, Analytics and Studio headers, formatted to two decimals (`$125.50`) with the precise balance in its title, and a menu with **Add funds** (the page's own dialog where there is one, else `/billing#add-funds`), **Usage & billing** and **Transaction history** (`/billing#transactions`). It re-reads after a funds request. No new payment flow was added; billing calculations are untouched. The project-spend chip (§2 C) is a separate reading of the project meter, not the wallet.

## 4. QSF import audit — causes found

The pipeline is one deterministic path: `readQsf` (adapter) → `CanonicalSurvey` → `mapCanonical` → `SurveyDefinition` (schema-parsed, then the engine's quality check) → `buildReport`. The Studio's `/api/import/analyze` runs it (estimate, then run); nothing is persisted until `POST /api/surveys` creates the project or the editor applies a merge. The audit traced every field the adapter reads and every field it ignores, and compared each against what the Rescript schema can represent. The highest-impact gaps, all confirmed on the corpus before the fixes:

1. **Matrix row display logic attached to the wrong element.** Qualtrics keeps a grid's statements in `Choices` and its scale in `Answers`; a choice's `DisplayLogic` was attached to the *option* (column) with the same number, so the wrong thing was hidden.
2. **Quota conditions never converted.** `LogicType: "Quota"` was reached only after the operator table lookup failed, so every "quota has been met" branch became a condition the mapper could not convert and the branch **applied to everyone** — the screener corpus file screened out every respondent. `QuotaNotMet` was also read as *met*.
3. **Choice-count conditions (`SelectedChoicesCount`) not read**, although the engine evaluates count conditions.
4. **BlockRandomizer unsupported** (reported as a flow element with no equivalent), although it is exactly a randomizer of blocks.
5. **Carry-forward dropped**: the adapter parsed `DynamicChoices` into a settings note that the mapper's settings filter then discarded; the schema has a first-class `carryForward`.
6. **Advanced randomization flattened** to a plain shuffle: fixed positions, random subsets and undisplayed choices were lost, although options have anchor flags, `randomization.pick` and `always_hide`.
7. **Translations ignored**: the per-question `Language` map was never read, although the definition has a localization store with per-key translations.
8. **Images lost or silently passed through**: a choice that is an `<img>` became an option whose label is the HTML; graphic blocks (`DB/GRB`, `Graphic: IM_…`) became empty; no asset was listed.
9. **Side by side** became a grid with the first column only (and, with `AdditionalQuestions`, no columns at all), although the schema's `composite` grid carries columns with their own answer types and choices.
10. **Piping silently left as written**: any `${…}` the converter did not know stayed verbatim in the question text, unreported (`ChoiceDescription`, `QuestionText`, `SelectedChoicesCount`, `rand://`, `date://`).
11. **Flow elements that wrap children** (Authenticator, Table of Contents) lost their children: the blocks inside were treated as "not in the flow" and hidden behind a never-true branch.
12. **Silently ignored payload**: `DefaultChoices`, `DataVisibility.Hidden`, `Configuration` (repeat headers, label position, slider decimals), `ValidURL`, date-format details, survey options (back button, progress bar, button labels), the end-of-survey message id written as if it were the message, and every element kind the reader does not know (`SC` scoring, `PROJ`, `STAT`, `RS`…) — none of it appeared in the report.
13. **No measured fidelity**: the report counted "detected → created" totals but could not say, per element, what came across unchanged, what was changed, and what was dropped; unresolved references were scattered through issues; there was no runtime verification of the result.

## 5. Import fixes — done (with the limits in §8)

All in `packages/import` (`src/adapters/qsf.ts`, `src/map.ts`, `src/canonical.ts`, `src/report.ts`, new `src/verify.ts`); the Decipher / document adapters are untouched and go through the same mapper, so they gain the inventory for everything the mapper decides.

- **Loss-aware inventory.** Every element the adapter or the mapper decides is recorded as an `InventoryItem` — `imported`, `partial` or `unsupported`, with the reason. The report's `fidelity` section counts them per feature (questions, choices / row logic, display logic, skips, branches, randomizers, block randomizers, loops, embedded data, quotas, quota conditions, carry-forward, randomization, piping, translations, assets, custom JavaScript, other flow elements, survey options, default answers, validation), lists **unresolved references** (question, choice, row, block, embedded, quota, loop, piping — with where), the **assets** with their hosting risk, the **languages**, and the file's **element table** (every element kind, counted, read / ignored / unsupported).
- **Grid row logic** goes to the row (`row.visibleIf`); answer logic to the column.
- **Quota conditions** convert to `quota ≥ limit` / `< limit` (the test the quota check makes); a cell of a quota group is converted and flagged *partial* because the group's whole count is read.
- **`SelectedChoicesCount`** → count conditions (`countGte/Lte/Eq`, with `>`/`<` shifted by one).
- **BlockRandomizer** → randomizer (subset, even presentation).
- **Carry-forward** → `question.carryForward {sourceQuestionId, filter, into}`; a missing source is an unresolved reference.
- **Advanced randomization** → `anchor_top` / `anchor_bottom` flags, `randomization.pick`, `logic.visibility: "always_hide"`; fixed choices *between* randomized groups are flagged partial.
- **Translations** → `localization.languages` (`in_review`) and `translations[lang][q:<id>:text | opt:<code> | row:<code>]`, written through the engine's `recordTranslation` (origin `import`, source-hashed, so an edit marks them outdated).
- **Images** → option `imageUrl` with the alt text as label; graphic blocks keep a visible image or a visible placeholder; every image is an asset with `external | platform (Qualtrics-hosted) | library_id (no URL)` risk.
- **Side by side** → `composite` / `matrix.mixed` with one column per additional question, its own response type and choices; data columns `variable_column_row` (Qualtrics `variable#column_row`), the rename recorded in the map.
- **Piping**: `ChoiceDescription` and `QuestionText` written in as the words; `SelectedChoicesCount` → `.count`; `DisplayedChoices` / `UnselectedChoices` → `.displayed` / `.remaining`; anything left (`rand://`, `date://`…) stays as written **and** is an unsupported item and an issue. An embedded field set from such a pipe becomes fixed text, flagged partial.
- **Wrapping flow elements** (Authenticator, Table of Contents) still unsupported, but their children are imported in their place.
- **New homes**: `Draw/Signature` → `upload.signature`; `PGR` → `dragdrop.buckets` (rank within group not carried, flagged); `Matrix/Bipolar` → `matrix.semantic`; Likert single → `matrix.likert`; `Profile` matrix → single grid, flagged.
- **Settings**: `DefaultChoices` → `settings.defaultValue`; `DataVisibility.Hidden` → `settings.hidden`; `RepeatHeaders` → `headerRepeat`; `LabelPosition` → `fieldLabelPosition`; slider / number `NumDecimals` → `decimalPlaces`; `ValidURL` → url rule; date-format detail flagged partial.
- **Survey options** → `branding.buttons.showBack`, `nextLabel`, `backLabel`, `layout.progressBar` / `progressStyle`; `SaveAndContinue`, `BallotBoxStuffingPrevention`, `SurveyExpiration`… listed as unsupported.
- **End-of-survey message ids** are no longer written as the message; the library reference is a `dropped` issue. A source that carries the words (a Decipher terminate) keeps them on the end.
- **Element table**: `SC` scoring is an explicit unsupported issue; unknown kinds are listed as ignored.

## 6. Validation improvements — done

`packages/import/src/verify.ts` runs after every new-project import (`/api/import/analyze` returns `verification`; the card shows it):

- **Structure** — every source question has a Rescript question of the same family, the same number of choices and rows, the source's variable name (or a recorded rename), every option code the source data carried (a suffixed duplicate is a recorded change; anything else is an error), every row code; every source block has a page; every quota a quota. Lost text and lost requiredness are warnings. This is also the **analysis-compatibility** check: variable names kept / renamed, codes kept / changed, rows kept are reported as numbers.
- **Runtime** — the engine (`start`, `visibleQuestions`, `validatePage`, `advance`) walks the result under eight strategies: *deepest* (a look-ahead that, at each page, picks the choices leaving the most survey ahead — the walk that gets past a screener), first choice, last choice and five random seeds. Each walk reports pages, questions, loop iterations, the end status, every validation refusal (a required question the walker could not satisfy) and any exception. Questions no walk reached are listed with a reason: **by source** (behind a never-true branch — a block outside the Qualtrics flow) or **no walk**. Uploads, hotspots and tasks are not answered by the walker and are listed, not counted as failures.
- The engine's existing quality check (ids, references, logic, flow) still runs in the mapper; its errors are in the report and in `verification.ok`.

## 7. Testing results — measured fidelity

**Corpus** (`packages/import/corpus/qsf/`, three synthetic, sanitized QSF files written in the shape Qualtrics exports; `scripts/qsf-corpus-build.mjs` is how they were made). No real client export was available in this session — the user was asked and none arrived — so the corpus is built from the format, and the numbers below are for these files only. `scripts/qsf-fidelity.mjs` measures them, pins the whole measurement in `expected.json`, and takes `--dir <folder>` to measure real exports in place (nothing from that folder is copied).

| File | Elements | As-is | Changed | Not reproduced | Unresolved refs | Runtime reached | Ends | Structure |
|---|---|---|---|---|---|---|---|---|
| 01 simple satisfaction (6 Q) | 15 | 14 (93.3 %) | 0 | 1 (SaveAndContinue) | 0 | 6 / 6 | complete | 8 / 8 |
| 02 screener, logic, quotas (12 Q) | 45 | 38 (84.4 %) | 2 | 5 | 2 (a trashed question in display logic; a skip to a missing QID — both by design in the file) | 12 / 12 | complete, screened | 20 / 20 |
| 03 complex tracker (29 Q, loops, block randomizer, SBS, PGR, images, ES/FR) | 87 | 66 (75.9 %) | 9 | 12 | 0 | 26 / 27 (the one not reached is a block outside the Qualtrics flow) | complete | 40 / 41 (the GeoIP quota is a warning) |

"Elements" are the inventory items (questions, logic rules, branches, loops, quotas, translations, assets, piping tokens…), not a weighting; the percentage is items as-is ÷ items detected and is **not** a claim about Qualtrics compatibility in general. What is "not reproduced" in 03: one captcha, one GeoIP quota, one device-type branch (applies to everyone, flagged high), two custom JavaScript items (kept disabled), the Authenticator and WebService elements, one `date://` pipe, one library-only graphic, one custom validation, two survey options.

**Before → after on the same corpus** (the pre-change importer built from `HEAD` beside the new one; runtime measured with the new walker):

| | 02 screener | 03 complex |
|---|---|---|
| runtime questions reached | 4 / 12 (the quota branch screened everyone) | 20 / 27 (intro block lost behind the Authenticator; SBS empty) |
| | **12 / 12** | **26 / 27** |
| carry-forward questions | 0 → **1** | 0 → **1** |
| rows with display logic | 0 → **1** | — |
| options with anchors / hidden | 0 → **3** | — |
| translated strings | — | 0 → **22** |
| options with images | — | 0 → **2** |
| side-by-side as a mixed grid | — | 0 → **1** |
| placeholders ("not migrated") | — | 3 → **1** |
| unconverted `${…}` left silently | 1 unreported → **0** | 1 unreported → 1 **reported** |
| measured fidelity | none → 84.4 % | none → 75.9 % |

**Tests**

- `packages/import`: 49 pass (21 new in `qsfFidelity.test.ts`, one per feature above, plus the structure and runtime verifiers and the walker's answers against the engine's own validation). Mutation-checked: **25 / 25 caught** (row logic, carry-forward, BlockRandomizer, quota NotMet, choice count, anchors, undisplayed, translations, image labels, silent piping, SBS columns, defaults, EOSM, quota condition, translation keys, pick, always_hide, branding, unresolved, fidelity counting partial as imported, per-code structure check, deepest walk, by-source reason, refusals, end message).
- `scripts/import-engine-test.mjs` (browser): 8 pass, extended with the fidelity bar, the per-feature detail, the element table, and the engine check on a new-project preview (absent on a merge preview, where nothing is claimed). UI mutations: 2 / 2 caught.
- Priority 1: `lib/projectOverview.test.ts` (mutation 5 / 5), `scripts/dashboard-overview-test.mjs` 5 checks (UI mutations 5 / 5 caught after the pill test was strengthened with a sub-cent balance), `scripts/project-meter-test.mjs` rewritten.
- Every package: `pnpm -r test` green (engine 1772, analytics 255, studio 295, import 49, …). Studio typecheck, `auth-guard-audit` (171 handlers, 0 problems), public docs check: clean.
- Full browser corpus (137 suites): running at the time of writing; the result is appended in §7a of the commit message / the project note. Known baseline failures (ai-conversation, auth-collaboration, billing, dashboard-outage, listfill-allocation, lock-concurrency, picker-taxonomy, qa-fixes, quality, version-scoped-export) are unchanged by this work.

## 8. Remaining limitations — partial / recommended

- **Only three synthetic files have been measured.** Real exports differ in ways a spec cannot predict (older schema versions, library references, brand-specific payload keys). Run `node scripts/qsf-fidelity.mjs --dir <folder of real .qsf>` on actual client files before fielding anything imported; the report will say per file what came across. *Recommended.*
- **Quota conditions on a cell of a quota group** read the group's count against the cell's limit (flagged partial). The engine's quota source reads a whole quota; per-cell conditions would need a `rowCode`-style cell reference on the quota source. *Partial.*
- **Branches whose condition cannot be converted still apply to everyone** (GeoIP, device type, scoring). That is the pre-existing behaviour, flagged high; a safer default would be "applies to no one" with the same flag. *Recommended — a product decision.*
- **Question-order randomization inside one page** cannot be represented (Rescript randomizes pages); flagged. **Fixed choices between randomized groups** become randomized; flagged partial.
- **Profile matrices** (a different answer set per row) come in with one shared set of columns. **PGR** loses the rank within each group. **Heat maps / hot spots** need their regions redrawn. **Captcha, scoring, WebService, Authenticator** have no equivalent. **Custom JavaScript and custom validation** are kept disabled for Deep analysis, never run.
- **Assets are carried by reference, never fetched.** Qualtrics-hosted images stop resolving when the account closes; library ids have no URL at all — both are listed with the risk. A fetch-and-upload step into the project's media store is the next step. *Recommended.*
- **Translations** cover question text, choices and answers (what the QSF carries per question). Block descriptions, end messages and survey-level strings are not in the file's `Language` maps. Imported languages are `in_review`, never `ready`.
- **Piping** `rand://`, `date://`, `${q://…/ChoiceGroup/…TextEntry}` variants beyond the ones listed stay as written and are reported.
- **The runtime walker** answers single, multi, dropdown, text, numeric, date, time, every grid family, ranking, allocation and composite; it does not answer uploads, hotspots, conjoint / MaxDiff tasks — a required one is listed as unanswerable rather than failing the survey. "Deepest" looks one page ahead; a gate that depends on two pages' answers together may still not open for it.
- **Decipher / Word** are untouched by design (Phase 1 is QSF); they share the mapper and the verifier, so their reports now also carry the mapper-side inventory, but their adapters record nothing of their own yet.

## 9. Files changed

Priority 1 (`058da08`): `apps/studio/app/page.tsx`, `app/billing/page.tsx`, `app/studio/[id]/page.tsx`, `app/sandbox/overview/page.tsx` (new), `app/api/billing/wallet/route.ts` (new), `app/api/surveys/[id]/overview/route.ts` (new), `app/api/surveys/[id]/route.ts`, `app/api/surveys/[id]/versions/[versionId]/route.ts`, `components/project/ProjectOverview.tsx` (new), `components/billing/WalletMenu.tsx` (new), `components/ui/AppHeader.tsx`, `components/studio/Studio.tsx`, `components/studio/MenuBar.tsx`, `lib/projectOverview.ts` (new) + test, `lib/metering.ts`, `app/design-system.css`, `content/docs/api.md`, `packages/access/src/audit.ts`, `scripts/auth-guard-audit.mjs`, `scripts/dashboard-overview-test.mjs` (new), `scripts/project-meter-test.mjs`.

QSF (this commit): `packages/import/src/adapters/qsf.ts`, `canonical.ts`, `map.ts`, `report.ts`, `verify.ts` (new), `index.ts`, `fixtures.ts`, `import.test.ts`, `qsfFidelity.test.ts` (new), `packages/import/corpus/qsf/*.qsf` + `expected.json` (new), `scripts/qsf-corpus-build.mjs` (new), `scripts/qsf-fidelity.mjs` (new), `scripts/import-engine-test.mjs`, `apps/studio/app/api/import/analyze/route.ts`, `components/intelligent/ImportCard.tsx`, `IntelligentView.tsx`, `app/design-system.css`, `content/docs/api.md`, this document.

## 10. Deployment considerations

- No migration. No new environment variable. No change to billing calculations or to the usage events written by the import route.
- The overview route reads tables that may not exist on an older database (`quota_counts`, `analytics_reports`, `analytics_runs`, `sample_sources`); each read fails soft and the overview says what it could not read in `warnings`.
- `/api/import/analyze` now also walks the imported survey on a `phase=run` for a new project; on the corpus that adds well under a second. It is bounded (500 pages per walk, eight walks) and a failure is returned as `verification.error`, never as a pass.
- Imported translations land as `in_review` with origin `import`; the localization editor shows them for approval like any other.
- `expected.json` pins the corpus measurement: a change to the importer that alters any count fails `node scripts/qsf-fidelity.mjs` and must be re-recorded deliberately with `--update`.
