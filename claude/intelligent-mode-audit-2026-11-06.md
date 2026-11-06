# Intelligent Mode — complete audit and capability assessment (2026-11-06)

Audited on `origin/main = e0898de4`. The full report, with the module tables, lives in the Claude doc
"Intelligent Mode Audit" (https://claude.ai/artifact/CNsZmePPAqQtPxzMspUd5L); this is the record in the repo.
No code was changed; the harness that produced the measurements is `apps/studio/lib/copilot/auditHarness.ts`.

## The verdict in one paragraph

Intelligent Mode is a strong, well-gated survey-programming and research-design copilot — 106 gated action
ops across 17 action modules, plan-first tasks with a persistent runner, scripts verified in a real session
before Apply, explainable quality and analytics — that is not yet a research operating system. It reads a
sentence, proposes actions a model writes, and validates them; it does not read a research brief into
settings, testing, quotas, fieldwork and cleaning decisions, and the workflow it orchestrates stops at the
design document. **Overall score 58 / 100** (the mean of sixteen module scores, each weighing what the
platform does without a person configuring it by hand).

## Evidence conventions

inspected (read in the code, file named) · tested (executed here) · model-dependent (exists only through a
language model; the gate and the corpora are the evidence, not the model's answers) · proposed (not built).
A feature is never called working because its UI exists.

## Module scores (0–100) and maturity levels (0–5)

| Module | Score | Level | One line |
|---|---|---|---|
| Survey programming | 82 | 3 | 106 gated ops, refs resolved against the real survey, plan-first tasks, one repair turn; most sentences still need the model |
| JavaScript / HTML / CSS | 76 | 3–4 | codeGate + uxScriptGuard + scriptWrites; scripts run in a hidden session with scenarios before Apply; explain/debug without a model |
| Analytics configuration | 78 | 4 | plan from the design, apply, run with correction, Ask rules-first, Architect; banners and weighting by hand |
| Research analysis | 74 | 3 | findings, verdicts, two-layer interpretation, the claim gate on every model sentence |
| Reporting and presentation | 72 | 3 | proposal, SAP, findings report and deck, story, report builder, Present exports |
| Qualitative research | 70 | 3 | guides as actions, sessions, transcripts, AI coding with review states, synthesis with citations |
| Thematic coding | 68 | 3 | merge/split/rename/reassign, AI vs researcher origins kept apart, kappa |
| Data cleaning | 62 | 2 | 59 explainable rules; per-response review with undo; no bulk action, no model judgement, Intelligent Mode sets settings only |
| Quota management | 60 | 3 | create_quota with dimensions, feasibility review, advice from counts, sheet import; no deterministic reading, no availability check |
| Technical architecture | 72 | 4 | policy switch, metering, cache by connection, single-flight, fenced untrusted text, failure vocabulary, audit of every sentence; eval workflow deleted |
| Themes and UI | 58 | 2 | set_theme over a typed gate, image → palette, brand URL import; no guideline PDFs, no research-type look |
| Testing vs live | 45 | 1 | environments separated end to end; no production-like test from a sentence, no live-config simulation |
| Preview | 40 | 1 | device overrides and previews by hand; no accessibility checks, nothing from a sentence |
| Fieldwork and recruitment | 38 | 1 | feasibility, pricing, allocation, forecast, reallocation exist; Intelligent Mode only defines the audience |
| Survey settings | 30 | 1 | only title/description/code by action; back button, progress via set_theme; access, retake, dates, consent, bot protection have no action |
| Workflow orchestration | 30 | 2 (0 across the lifecycle) | a 12-step design planner; nothing from settings to presentation; 9 of 10 briefs classified as questions |

## Measurements

- `pnpm -r test` on this tree: 6,457 passing, 0 failing. Typecheck clean. `pnpm audit:code` clean.
- Action vocabulary from the built engine: 106 survey ops (12 analysis, 13 UX, 6 quota, 9 localization,
  24 option/settings, 5 methods, 4 logic-script, 3 list-fill, 3 assessment, 3 integration, 2 audience, 2 qual, …).
- 47-sentence harness through `interpretRequest`, `classifyRequest`, the guide intents and `estimateTaskSize`:
  the engine acted or answered on 5 (randomization, "plan the analysis", a method question, a deck, a proposal,
  the workflow), refused 3 (two misreads: "Require a number between 1 and 100 in Q6" and a conflicting request
  were taken as question names), handed 39 to the model; none was a plan-first task.
- 10 research briefs (healthcare, pharma, advertising, consumer, brand tracking, political, academic, qual,
  mixed-method, 12-country): 1 classified `generate`, 8 `question`, 1 `edit`; only the 60-question brief became
  a task; briefs under 1,500 characters are never "long".
- The master prompt's own sentence ("healthcare research among doctors in India, 1,000 completes, quotas,
  production-like test") against the live route (`next start`, `AI_API_URL=fake:`): mode `question`, no
  research context, 8,393 prompt characters, handed to the model, no action, no task.
- `researchWorkflow()`: 12 steps (objective → … → design document → deck); an empty survey with an objective
  is 0 of 12, the pricing fixture 4 of 12. Settings, testing, quotas, fieldwork, cleaning, qual and
  presentation are not steps.
- Settings reachability: `set_survey_settings` = title/description/code; `showBack`, `progressBar`, responsive
  overrides via `set_theme`; `sectionNav` via `set_navigation`; no action for access mode, password, retake,
  active dates, custom domain.
- Quality: 59 rule ids; flags carry explanation, observed, expected, severity, strength, confidence, caveat;
  verdict + evidence + recommendation (INCLUDE / REVIEW / LIKELY EXCLUDE); single-response review with undo.

## Capability classes (1 working · 2 needs improvement · 3 partial · 4 UI only · 5 suggests only · 6 missing · 7 unreliable)

Working (1): the action layer, plan-first tasks, script sandbox + verification, quotas engine + review +
advice + sheet import, the recruitment marketplace, the quality framework and per-response review, analytics
plan/apply/run/Ask/Architect, findings and the claim gate, qual guides/sessions/coding/synthesis/kappa/hand-off,
theme by action / image / brand URL, report themes, all outputs, the 12-step planner, the AI policy/metering/
cache/injection/audit layers. Needs improvement (2): deterministic sentence reading (two misreads), NL
conditions (model-dependent), settings via set_theme, transcription (provider-dependent), implications (gated
model text only). Partial (3): device previews, downstream impact (intra-survey only). Suggests only (5): a
consent screen from a sentence. Missing (6): deployment settings by action, research-type settings reasoning,
production-like test, quota sentences read deterministically, sample availability, fieldwork from a brief,
bulk review, model judgement of open ends, banners/weighting from a sentence, model sentiment, guideline PDFs,
accessibility checks, infographics, lifecycle orchestration. Unreliable (7): automatic assessment on arrival
(57 unassessed), short briefs recognised as generations, the real-model eval in CI.

## Roadmap (summary; the full table with files, APIs, DB, UI, acceptance and tests is in the doc)

P0: read a short brief as a generation (classifyRequest keyed on the structured research context) · fix the two
misreads · assess every complete on arrival (cron) · restore the real-model eval workflow.
P1: `set_deployment` + an extended `set_survey_settings` · settings advice from research context with a
*because* per setting (pure, property-keyed, never a research-type table) · production-like test (`simulate:
"live"`, simulated counts, responses marked) · quota sentences read deterministically · fieldwork plan from a
brief (`research.fieldwork`) · bulk quality review and batch proposals · lifecycle steps in the planner ·
downstream impact of an audience / method change.
P2: gated model judgement of open ends · accessibility and device checks · guideline PDF → theme · banners,
weighting, trackers from a sentence · sample availability vs cells · emerging-theme diff · infographic blocks.
P3: SLOs and alerts · a launch-readiness gate · cross-module configuration history · automatic test-case runs
after logic/quota/settings proposals · splitting `turn/route.ts` and `nlIntent.ts` under the suites.

## Regression posture

Every roadmap item is additive (a new op, a pure module with tests, a route, a panel section). Two optional
schema fields (`research.fieldwork`, `responses.simulation`). Named risks: widening `briefMode` (guard on the
structured context, keep the productionIntents negatives green); a settings step that must report `done` when
nothing changes; a simulated-live test must never move LIVE quota counts (gated by `is_test` already); bulk
review must write the audited columns per row.

## Not done here

No real model was called; production operations were not read; the production-intents browser suite could
not complete in this environment (Playwright `networkidle` never settled on the sandbox page — an environment
limit; the route it exercises answered directly).

## After the upgrade (IM1–IM10, same day)

Re-scored on the same rubric after the ten phases in `claude/intelligent-mode-upgrade-2026-11-06.md`: **86 / 100**
(was 58). Survey settings 95, testing vs live 92, quotas 92, data cleaning 92, analytics configuration 92,
orchestration 90, survey programming 88, architecture 88, themes 85, fieldwork 85, qualitative 82, reporting 82,
research analysis 80, JS/HTML/CSS 78, preview 78, thematic coding 76 — each residual named in that record. The
harness: 30 of 47 sentences handled by the engine (was 8), the other 17 the writing and composing a model is for;
9 of 9 survey briefs are plan-first builds.
