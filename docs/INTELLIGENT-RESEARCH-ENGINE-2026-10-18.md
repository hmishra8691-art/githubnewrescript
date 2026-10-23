# Intelligent Mode as a research intelligence engine — audit and fixes (2026-10-17/18)

Master brief: "Transform Intelligent Mode into a Powerful Research Intelligence Engine". The architecture was kept. Each area was audited, then the root causes were fixed and tested.

| Area | Detail doc |
|---|---|
| Reliability | `INTELLIGENT-ENGINE-RELIABILITY-2026-10-17.md` |
| Analysis, Word plan, reporting | `ANALYSIS-APPLY-DOCX-REPORTING-2026-10-17.md` |
| Layout and scripts | `LAYOUT-CENTERING-AND-SCRIPTS-2026-10-17.md` |
| Research intelligence | `RESEARCH-INTELLIGENCE-2026-10-17.md` |

Earlier, still in force:

- `ADVANCED-METHODS-2026-10-17.md` (MaxDiff, conjoint, LEAST/List Fill)
- `VOICE-JS-COST-2026-10-17.md` (voice, popups, prompt caching)
- `P0-*` (scripts)

## 1. Audit — problems and root causes (evidence: production `intelligent_operations`, reproduced locally)

| # | Problem | Root cause | Severity | Fixed |
|---|---|---|---|---|
| 1 | A 25k-character ChatGPT brief returned a list of questions, not a plan ($0.15 spent) | Requests were silently cut to 8,000 characters, so the model saw a third. The plan call carried every action guide (43,698 characters). The plan prompt invited questions, and a non-plan reply fell back to single-shot generation | Critical | Yes |
| 2 | A full 30–35-minute survey generation: "connection to the AI service was interrupted" | One request could stay silent for up to 165 s, longer than the client connection held | Critical | Yes, staged with a 90 s cap |
| 3 | A Hindi research brief: "the provider refused the request" | The pre-10-14 code built all plan items in one request. It was cut off with a non-JSON page, which was mislabelled as a refusal. Not the Devanagari text | High | Yes |
| 4 | An ordinary edit: "the AI service could not process this request" | Most likely the zero-credit key that morning (fixed 10-14). A second path showed Studio exceptions as provider errors | Medium | Yes |
| 5 | The operation log kept only 4,000 characters of a prompt | A bounded column | Low | Yes, 20,000 plus length and SHA-256 (migration 0063) |
| 6 | Analysis Apply missing or disabled | A custom-access member checked by bare role. Builder rules disagreed with the runner in both directions (valid setups disabled, invalid ones enabled). The validator was stricter than the runner. The plan editor accepted items apply then skipped. A double click applied twice | Critical | Yes, one readiness rule (`planCheck.ts`) everywhere; a 422 names the missing input; double-apply guard |
| 7 | Word research plan unavailable | "Prepare a Word research plan" went to the model, which can only describe a file. The sandbox refused the SAP. Nothing validated a file. The Research tab revoked the download URL after 4 s | Critical | Yes |
| 8 | Content shifted left when a theme was applied | Branding "content align" became the survey frame's margins, with "left" the stored default, so a narrow theme pinned the survey to the left (480 px off centre at 1600) | High | Yes, offset now 0 at every viewport; text alignment kept inside the column |
| 9 | Horizontal overflow | A long word or URL overflowed (respondent page 3,720 px wide on a 390 px phone; conversation 3,182 px in a 994 px pane). The toolbar overflowed at 1024. A hidden menu measurer widened phone layouts | Medium | Yes |
| 10 | Hypotheses dropped on generation | `set_hypothesis` / `add_hypothesis` ran before `set_research` in the same batch, so it was refused or overwritten | High | Yes |
| 11 | Workflow cost line said "about 0 credits" | The pricing request was never retried after a failure | Low | Yes |

## 2. What was implemented

**Intent and long prompts**

- One deterministic scope reading, shared by engine and route (`requestScope.ts`):
  - **Unsupported** requests get the exact sentence from the brief, with no model call and no charge. "Unsupported" needs an explicit off-topic pattern and no research cue (English, Hinglish or Devanagari). Text over 1,500 characters is never unsupported.
  - **Mixed** requests: the supported part is done and the rest is named.
  - **Greetings:** one question.
- Long briefs (up to 60,000 characters after markdown normalisation) are always planned first, without guides, with assumptions instead of questions. Above 60,000 the researcher gets an honest "too long" card, with nothing sent or charged.
- Staged generation: no new item starts after 90 s; a checkpoint is returned and the page asks for the next batch. Each batch's output is kept and shown, stage ids are idempotent, a timeout is auto-resent once, and a Resume control appears after repeated failures.
- No card says "ready" or "applied" when nothing was changed.
- Each history line names what the previous turn proposed, so "it" resolves across turns (a six-turn test confirms).

**Research intelligence**

- A **capability registry** (`capabilities.ts`): methodologies, question types, analysis methods, qualitative support and exports, each supported, partial or not supported. It is read from the real registries; a test fails on drift. It also generates the public `capabilities.md`.
- A **traceability matrix** built from the actual study: objective → hypothesis → construct → questions → variables → method → chart → interpretation → limitations.
  - Status: planned / untested / descriptive only / tested — supported, not supported, mixed or inconclusive (only with a run).
  - Gaps flagged: hypothesis unmeasured, question serving nothing, missing variable, unsuitable method.
- A **research validator** (blocking / warning / recommendation) that reuses the existing review, with separate qualitative, quantitative and mixed checks and method-suitability rules. Shown in the Review tab and on the generated-study card.
- **Guides:** research planning and qualitative guides (sent only when needed, cached). A new `set_probe` action makes probed interview guides possible.

**Analysis, documents, reports**

- One readiness rule for Apply (about 30 per-method cases tested).
- Word research plan: 17 sections in the brief's order, with traceability.
  - Every document gets running headers, "Page X of Y" footers, repeating table headers and rows that do not split.
  - Validated (`checkDocx`) before a link is offered; named `<Code>_Research_Plan_<date>.docx`.
  - Made from a sentence or from the Research tab.
  - Checked with python-docx and a LibreOffice PDF conversion.
- Reports from a sentence (`reportBriefFromText` → report builder settings). Drafted from executed analyses only: untested hypotheses labelled, no causal claims, no number the results lack (tested).
- The copilot's reporting guide is wired in: it never claims a file and never invents numbers.

**Layout and scripts**

- Centred survey frame at every viewport and with every theme.
- Wrapping for long words.
- One centred 860 px conversation column; the toolbar wraps.
- Scripting stack verified under live theme changes: one stylesheet, one sandbox, the script runs once. The 8 compatibility rules are in the layout doc.

## 3. Methodologies and procedures verified functional

Per the capability registry and today's suites:

- **Methodologies:** MaxDiff (optimized design, pooled logit, recovery-tested), CBC (efficient design, aggregate MNL, recovery-tested), menu-based (counts), ACBC (design only), List Fill / least fill, TURF, ranking, monadic and sequential-monadic arms, Van Westendorp pricing, cluster segmentation, brand funnel.
- **Analyses:** crosstab and significance, t-test, ANOVA, chi-square, correlation, regression (linear and logistic), reliability, factor, driver analysis, text themes, NPS / top box.
- **Not supported** (marked in the registry and guides, never claimed):
  - moderated interviews and focus groups;
  - AI theme coding and quotes in reports;
  - Gabor–Granger from the plan;
  - HB, latent class and SEM estimators.

## 4. Verification

**Unit tests, typechecks and audits.** All pass:

- engine 2,122, access 123, designs 99, ai 123, billing 52, templates 110, exporters 135, quality 61, analytics 545, Studio lib 630, runtime lib 20;
- typechecks (Studio, runtime, renderer) clean;
- public docs current;
- dependency boundaries 0 violations.

**New browser suites, all passing:**

- `intelligent-engine-test` (9 scenarios: long brief, never-plans, staged with progress and applied once, mid-stage timeout, repeated timeouts → Resume, unsupported, mixed, multi-turn, empty build);
- `analysis-apply-test` (10);
- `research-plan-docx-test` (4);
- `research-intelligence-test`;
- `layout-centering-test` (14).

**Regression suites, passing:** copilot, copilot-errors, intelligent-runtime, provider-resilience, methods-intelligent, phase2-nl, engine-first, findings/quota/translation-copilot, analysis-framework (red since 10-15, now green), analysis-plan, analytics, analytics-navigation, analytics-ask, data-export, phase1/3/5/6/8, desktop-layout-theming, menubar, style-script-p0, popup-p3, theme-voice, story-report, dashboard-overview.

**Intermittent under load** (pass on a fresh server, fail at varying steps when the dev server is busy; both failed the same way before this work):

- `intelligent-mode-test` (passed 55/55 in engineer C's run);
- `analytics-audit-test`.

**Test changes:** stale expectations were updated with reasons:

- `analysis-framework`: correct H2 crosstab;
- `analytics-test`: conjoint simulator retitled "Share-of-preference simulation (from the aggregate logit)";
- `desktop-layout-theming`: centred frame;
- `phase6-agent`: waits for pricing.

## 5. Unresolved and not supported

- **Streaming or keep-alive responses from the copilot route.** This is the definitive cure for idle-connection drops; staging covers it today. Not done because it changes the page/route protocol.
- **A long brief is re-sent with each staged item.** Summarising it once would cut cost.
- **After a page reload, a copilot download link is gone.** Asking again regenerates it.
- **A report theme requested in a sentence is suggested, not applied.** Themes are stored records.
- **Copilot analysis-plan actions with missing inputs are accepted** and marked invalid in Data Analytics, not refused up front. *(Fixed 2026-10-22: refused at action time by the same readiness rule — `ENGINE-11-14-2026-10-22.md` §2.)*
- **Three panes at 1024 px** leave the conversation 418 px wide.
- **Not tested in a browser:** right-to-left layouts.
- **Not supported:** moderated interviews and focus groups, AI theme coding, HB, latent class and SEM (see §3).

## 6. Deploy

1. Apply **0062** (`0062_project_access_permissions.sql`, from the previous change) if not yet applied, BEFORE deploying the code.
2. Apply **0063** (`0063_intelligent_operations_prompt_20k.sql`). It is optional: without it the log keeps 4,000 characters, as before.
3. Deploy the code. No new environment variables.
