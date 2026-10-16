# 09 · Document export gap analysis — research plan, programming specification, analysis framework, cleaning plan

Evidence: `raw/documents-and-cleaning.md` Part A (A.1 inventory of every file-producing path; A.2 the four documents with canonical model and competing sources; A.3 findings), repros `docs/audit-2026-10-16/repro/doc/*.mjs` (docx unicode/stamp, sav unicode).

## The four documents
| Document | Status | Exists as | Canonical source | Gaps vs the brief | Effort |
|---|---|---|---|---|---|
| Research Plan (.docx) | PARTIAL | "Research proposal" — `packages/analytics/src/export/docx.ts:94–173` via `copilot/output` route (copilot sentence only, DOC-11) | `def.research` (brief, objective, hypotheses, research questions, KPIs, constructs, population, sample size, methodology, assumptions, sources, analysisPlan) + `def.questions/flow` + `surveys.fieldwork_from/to`, `client_name` | missing: sampling approach and quotas (data exists in `def.quotas`), screening/eligibility, geographic & demographic scope as a section, timeline, limitations; prints an **engine-synthesised** analysis plan when none is saved without labelling it (competing source) | M |
| Questionnaire / Programming Specification (.docx) | IMPLEMENTED | `exportSurveyDocx` (`exporters/src/docx.ts:489–713`), `POST /api/surveys/[id]/export/survey` | the POSTed editor draft through `surveyOutline(def)` (same walker as Survey Flow/JSON) | reflects the saved configuration (draft, by design — stamped with the version it branched from); covers ids/variables/text/options/types/required/validation/display+skip logic/randomisation/masking/embedded/quotas/termination/custom setups/redirects/notes. Base language only (DOC-12); stamp lacks time/revision/hash (DOC-13) | S |
| Analysis Framework / Statistical Analysis Plan (.docx) | PARTIAL (no standalone doc) | 5-column, 30-row table inside the proposal (`docx.ts:162`); fuller `explainPlanItem` exists in the engine (`analysisFramework.ts:1116–1301`) and the Plan workspace | `def.research.analysisPlan` + `question.analysis` tags + `explainPlanItem` | the stored plan has **no fields** for alpha/multiple-comparison policy, weighting, missing-data handling, subgroup cuts beyond `crosstabBy`; variable coding/levels, dependent/independent roles, chart requirements, conjoint/MaxDiff specs, "proposed vs executed" distinction (available from `analytics_runs`/`analytics_plan_applies`) are not printed | M (schema JSON additions + generator) |
| Data-Cleaning Plan | MISSING | nothing (closest: xlsx "About" sheet, `summarizeConfig()` JSON, Quality settings UI) | `resolveConfig(def)` × `RULES` catalogue (rule, category, enabled, thresholds per strictness, severity, role, points, question scope, bands, evidence policy, dataset rule, telemetry/retention/privacy) — fully deterministic | whole document; should also say which rules cannot run for imported/interview rows (CLEAN-13) and that exclusions require REMOVE or dataset=clean | S |

## Quality & synchronisation checks (brief §8E)
| Check | Result |
|---|---|
| Correct project / organisation | every route `requireProject(req, id, cap)` → 404 non-member / 403 insufficient (DOC-14); **download gated on `responses.read`** so viewers can export (DOC-07, P1) |
| Consistent IDs / variable names | spec and data exports use `buildVariableDictionary` / `dictionaryFor` (versioned) — consistent |
| Formatting (headings, tables, page breaks, numbering) | docx generators use `docx` library with styles; verified structure in repro |
| Unicode / multilingual | .docx keeps Devanagari/CJK/Arabic/Cyrillic/emoji (DOC-13); **.sav destroys all non-ASCII** (DOC-06, P1); CSV lacks BOM (DOC-10); .docx base language only (DOC-12) |
| Version & timestamp | spec: version + export date (no time, revision, definition hash); proposal: date only (DOC-13) |
| Confidential data | respondent tokens not in documents; data exports respect dataset filter; stat formats lack status/quality/env columns so `all` mixes test and REMOVED silently (DOC-08) |
| Download behaviour | routes stream with correct content types; proposal/findings reachable only via copilot sentence (DOC-11) |
| Regeneration after changes | spec regenerates from the current draft each call; proposal cached? — no cache, regenerated; story/report versions snapshot by design |

## Canonical model decision
Generate all four from the **saved definition + `def.research` + `def.quality` + run records**; never from a stored AI reply. The only competing source today is the proposal's silent fallback to an engine-built plan — label it or omit it. No new source-of-truth table is required; a `generated_documents` record (storage pointer, source version, generator version) is recommended for audit (see `10-schema-migration-report.md`).

## Data exports (the brief's Excel / SPSS / SAS / JSON claims)
All exist with tests: Excel (two-sheet with quality + About), SPSS .sav (hand-written writer; verified against R `haven` in repo tests), SAS .xpt bundle, Stata .dta, CSV, JSON, respondent lists, localisation sheets, variable-dictionary xlsx. Defects: DOC-06 (sav non-ASCII), DOC-07 (access), DOC-08 (status columns), DOC-09 (`SystemVars` not exported despite the comment), DOC-10 (BOM).
