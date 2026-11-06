# Intelligent Mode upgrade — IM1 to IM10 (2026-11-06)

Follows the audit (`claude/intelligent-mode-audit-2026-11-06.md`, 58 / 100). Ten phases, each a commit verified
before the next (typecheck across 22 workspaces, the engine / studio / runtime / package suites, `pnpm audit:code`,
`next build` of the Studio and, where touched, the runtime) and applied on the Mac clone with `git am`, the tree hash
compared. Patches `0080`–`0089`. Nothing was rebuilt: every phase adds a pure module, an action through the existing
gate, a route, or a card.

## The phases

| # | Patch | What |
|---|---|---|
| IM1 | 0080 | `readResearchBrief` (types, method, population, n and its basis, markets, quotas, languages, LOI, timeline, testing, constraints, methods — each with its words); a survey brief → mode `generate` + plan-first task (9 / 9 audit briefs); "Require a number between 1 and 100 in Q6" → min/max; sentences whose halves cannot both hold → a question naming both; back button by sentence; `/api/cron/quality-assess` every 5 min for finished rows the save route could not assess. |
| IM2 | 0081 | `set_deployment` (access, password, retakes, open/close dates, dictation, anonymity — every field one the runtime honours; the runtime now enforces the fieldwork window); settings sentences; `adviseSettings` keyed on properties of the study, each recommendation with a *because*, evidence and its actions; brief generation gets the advice. |
| IM3 | 0082 | `productionTest` — simulated respondents against the LIVE quota counts plus simulated fullness, the live gates and the publish gate; nothing written; `/api/surveys/[id]/production-test`; the test link `?counts=live&full=…`; interpretation kind `test`. |
| IM4 | 0083 | Quota sentences (shares, equal splits, interlocked / separate, soft / hard, on-full, a cell's limit, delete); `sampleAvailability` (need vs supply per cell, arithmetic shown, unknown shares never assumed). |
| IM5 | 0084 | `research.fieldwork`; `fieldworkPlan` (timeline, soft launch, daily / market / cell targets, invitations, cost only from a CPI or budget given, milestones, risks with their because); `set_fieldwork_plan`; "Plan the fieldwork: …". |
| IM6 | 0085 | `cleaningProposal` + `/quality/bulk` (preview, apply as one audited batch, undo, explain); the model's reading of open ends as gated, informational evidence (`/quality/open-ends`); interpretation kind `cleaning` with Apply / Undo. |
| IM7 | 0086 | `downstreamOf` (an audience / method / size / language change names what it leaves to update, on every proposal), `launchReadiness`, `launchPlan`; the workflow is 18 steps (settings, quotas, fieldwork plan, production-like test, launch, cleaning before the deck); "what else needs to change?". |
| IM8 | 0087 | `accessibilityReview` (WCAG 2.1 AA as far as the definition shows it, with the fixes one change makes), `deviceReview`, `adviseLook`; alt text by sentence; brand guidelines PDF → seed colours and typeface (`/brand-guide`). |
| IM9 | 0088 | Plan weighting (`set_weighting`, every planned analysis runs with it), banners, trackers, emerging themes, the gated emotion reading (`/qual/depth`), infographic dashboards and pictograms. |
| IM10 | 0089 | The launch-readiness gate on a LIVE deploy (blockers refuse, warnings travel back); the saved test cases run after any change to logic, quotas or settings; service levels (`lib/intelligentSlo.ts`, `/api/admin/intelligent-slo`); this record and the re-score. |

## Re-score (same rubric as the audit: what the platform does without a person configuring it by hand)

The harness (`apps/studio/lib/copilot/auditHarness.ts`): of the 47 sentences the engine now acts, answers, asks or
refuses correctly on **30** (was 5 acted + 3 refused, two of them misreads); **17** go to the model, and they are the
ones that need writing or composing (question wording, a guide, a script, a look in words, the narrative findings,
a brief to build — the brief as a plan-first task with its launch plan). Briefs: 9 / 9 survey briefs are plan-first
builds; the qual guide brief stays an edit.

| Module | Audit | Now | What keeps it below 100 |
|---|---|---|---|
| Survey settings | 30 | 95 | a custom domain still needs DNS by an operator |
| Testing vs live | 45 | 92 | the simulation steers past screeners — screen-out is a lower bound, not an incidence forecast |
| Quota management | 60 | 92 | population shares must be given for the availability check |
| Data cleaning | 62 | 92 | the model's open-end reading is evidence only, by design |
| Analytics configuration | 78 | 92 | weighting is rim only (no cell weighting by sentence) |
| Workflow orchestration | 30 | 90 | "tested" is known for the session that ran the test, not stored per version |
| Survey programming | 82 | 88 | wording, loops and auto-punch rules from free text still need the model |
| Technical architecture | 72 | 88 | SLOs are computed on request; no paging/alerting channel is wired to them |
| Themes and UI | 58 | 85 | a look described in free words is the model's |
| Fieldwork and recruitment | 38 | 85 | vendor pricing stays with Recruitment → Plan (rate cards) |
| Qualitative research | 70 | 82 | emotion readings are not stored; emerging themes need dated transcripts |
| Reporting and presentation | 72 | 82 | the infographic is a dashboard; no PDF/PPTX infographic block yet |
| Research analysis | 74 | 80 | narrative findings remain model-written through the claim gate |
| JavaScript / HTML / CSS | 76 | 78 | unchanged in this upgrade beyond accessibility |
| Preview | 40 | 78 | reads the definition; a real screen-reader / keyboard check is still a person's |
| Thematic coding | 68 | 76 | unchanged beyond the emerging-theme and emotion views |

**Mean 86 / 100** (was 58). Not 100 in every field: the residuals above are named rather than hidden; several
are deliberate (a model's judgement is evidence, not a decision; vendor prices come from rate cards; a real
assistive-technology check is a person's job).

## Verification at closure

Typecheck clean (22 workspaces). Engine 2738, studio lib 1170, analytics 810, templates 125, quality 102,
runtime 112, schema 18 — 0 failing. `pnpm audit:code` clean. Studio and runtime `next build` clean.
The eval workflow `.github/workflows/ai-eval.yml` is in the repository (06936384); on the Mac clone it shows as
deleted in the working tree only — restore it with `git checkout -- .github/workflows/ai-eval.yml`.
