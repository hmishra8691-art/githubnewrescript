# Next phase — context and cost, persistent artifacts, report themes, qualitative research, advanced statistics (2026-10-18)

## Detail docs

| Area | Detail doc |
|---|---|
| Context and cost (§3), capability registry (§11) | `CONTEXT-COST-REGISTRY-2026-10-18.md` |
| Environment variables (§10) | `ENVIRONMENT-CHECKLIST-2026-10-18.md` |
| Artifacts (§4), report themes (§5) | `ARTIFACTS-AND-REPORT-THEMES-2026-10-18.md` |
| Interviews, focus groups, coding (§6, §7) | `QUALITATIVE-RESEARCH-2026-10-18.md` |
| HB, LCA, SEM (§8), statistical gap audit (§9) | `ADVANCED-STATISTICS-2026-10-18.md` |

## 1. Verified status

| Capability | Before this phase | Now |
|---|---|---|
| Long-brief summarisation and context reuse | Not implemented: the full brief was re-sent with every staged item | **Implemented and tested.** One structured research context per survey, copied verbatim from the plan stage with no extra model call. Persisted (0067), versioned and invalidated when hypotheses, objective or methodology change. Each item call gets the context as a cached block plus only the passages it needs, quoted exactly. Task-aware selection: a theme change sends no questionnaire; a logic edit sends the named questions and their dependencies. Isolated per survey and organisation |
| Cost measurement | Partial (tokens and operation per event) | **Implemented.** Each call records latency, retries, characters sent and a workflow id; each generation reports its running cost |
| Download links across reloads | Bug: the link lived only in page memory; reopening regenerated the file | **Implemented and tested.** Each document is fingerprinted from everything it is made from and stored once (private bucket plus `artifacts` row). Reloading restores the card; downloading reuses the stored file with no model call; a changed fingerprint makes a new version, keeping 5. Short-lived signed URLs are minted after an access check, and the file is re-checked (`checkDocx` / `checkPptx`). Errors: 410 missing, 422 corrupt, 403/404 for another person's or project's file |
| Report themes in words | Partial: a theme name was suggested, never applied | **Implemented and tested.** Five built-in themes plus saved themes per organisation or user, versioned. The five example sentences are read without a model. Contrast is enforced and the adjustment shown. Styling only: the content is byte-identical. Tested in Word, PowerPoint, PDF (by conversion) and in-app |
| Moderated interviews and focus groups | Not implemented | **First milestone.** Guides (sections, scripts, probes, conditional probes, ground rules, exercises, consent) created and edited from words, exported to Word. Session records, recording upload (private, retryable) and transcription through the STT provider (25 MB limit stated). Transcript import (.txt, .vtt, .srt, .docx, "Speaker:") keeping speakers and timestamps. PII redaction. **Live conferencing and real-time moderation: not supported** (registry says so) |
| AI-assisted qualitative coding | Not implemented (keyword themes only) | **Implemented and tested.** Inductive or deductive codebooks. Every quote must be an exact substring of its source, otherwise it is rejected. AI-suggested and human-reviewed codes are kept distinct. Accept, reject, edit, merge, split, rename, reassign and manual codes, all with history. Cohen's kappa (checked against a hand-computed value). Frequency by group, labelled "frequency is not importance". Contradictory cases. Qualitative report in Word. Gated by the Data module |
| Hierarchical Bayes | Not implemented | **Implemented and validated, partial.** HB-MNL for CBC and MaxDiff, run as a chunked job (0066). Synthetic recovery: maximum error of the population means 0.14, individual r = 0.84 (CBC) / 0.88 (MaxDiff). Diagnostics: R̂, RLH, acceptance. Estimates withheld if R̂ > 1.1. Not selectable from the analysis plan |
| Latent Class Analysis | Not implemented | **Implemented and validated, partial.** EM with multiple starts; AIC, BIC, SABIC, entropy; profiles and membership. Log-likelihood matches stepmix within 6e-6; BIC recovers the planted 3 classes |
| SEM / CFA | Not implemented | **Implemented and validated, partial.** ML estimation with lavaan-style syntax. Estimates match semopy within 2.3e-7. Fit indices equal lavaan's published Holzinger–Swineford values (χ² 85.306, CFI .931, RMSEA .092, SRMR .065). Non-identified models are refused; Heywood cases and non-convergence report nothing |
| Capability registry | Status only | **Implemented.** Full shape: status, services, configuration, inputs, handler, validation, output, limits, tests, version. Readiness comes from the environment and is shown on `/platform`. Intelligent Mode refuses an unready capability and names the missing variable |

## 2. Measured cost effect

Source: `scripts/ai-context-benchmark.mjs`. Same 23,867-character brief, 12-item plan, fake provider, priced at claude-sonnet-4-6.

| | Before | After | Change |
|---|---|---|---|
| Input tokens | 220,434 | 189,307 | −14.1 % |
| Charge, cold cache | $2.87 | $2.66 | −7.5 % |
| Charge, warm cache | $2.14 | $1.75 | −18.5 % |

Output tokens are assumed equal, because the fake provider does not model them. The remaining largest input is the ~43k characters of cached action guides per item. Choosing guides per item is the next lever; it is not measured.

## 3. Bugs found and fixed during browser testing

- **Change history jumped tabs.** After Apply, a slow server reply moved the copilot panel from the researcher's tab to History. History now opens at Apply.
- **Restored document cards never appeared** on a saved project (React dev double-mount tore down the restore step).
- **Empty review list for a new guide.** Creating a qualitative guide showed "0 changes" in the review list and before/after view. Guide changes are now listed item by item.
- **Costs carried over between plans.** A new plan of the same brief kept adding to the previous generation's totals.
- **Earlier failures that turned out to be test expectations, not product bugs:**
  - the menu tests now include the new Qualitative tab;
  - an ordinal variable is labelled "Scale";
  - the `docx` library's default heading colour in an unthemed file;
  - a race on the invitation "re-sent" count.

## 4. Verification

- **Unit tests:** engine 2,138, access 123, media 163, schema 11, designs 99, ai 124, billing 52, templates 110, exporters 135, quality 61, analytics 603, Studio lib 670, runtime lib 20. All pass.
- **Checks:** typechecks (Studio, runtime, renderer) clean; public docs current; dependency boundaries 0 violations; auth-guard audit 210 handlers, 0 problems.
- **SQL:** 0064 and 0065 applied twice on scratch Postgres 16; `artifacts-sql-test.sql` and `qual-research-sql-test.sql` pass.
- **New browser suites, all passing:**
  - `context-summary` (5)
  - `artifact-persistence` (6)
  - `report-theme-nl` (6)
  - `qual-research` (9)
  - `advanced-models` (8): LCA K = 1..4; SEM including the refused model; HB job with progress, diagnostics and cancel
- **Regression suites, passing:** intelligent-engine, copilot, copilot-errors, phase2-nl, methods-intelligent, research-intelligence, project-platform, research-plan-docx, story-report, phase5-reporting, analysis-apply, data-export, phase3-research, analytics, analysis-plan, conjoint-p2, maxdiff-p1, analytics-navigation, analytics-ask, phase6-agent (cold and warm), dashboard-overview, collaboration, collaborators-access, intelligent-runtime, popup-p3, layout-centering, master-demo, canvas, menubar.
- **Not tested end to end (no live database):** the 403 for a member without Data access in the qualitative browser suite. It is covered by unit and SQL tests.

## 5. Deploy

**Migrations:** apply each BEFORE deploying the code. All are re-runnable.

| Migration | What it adds | If not applied |
|---|---|---|
| 0064 `artifacts_and_report_themes` | Tables plus private bucket `rescript-reports` | Code shipped first still serves files, just does not keep them |
| 0065 `qualitative_research` | Tables plus bucket `rescript-qual` | Qualitative storage unavailable |
| 0066 `analytics_model_jobs` | HB job table | HB jobs need it against a real database |
| 0067 `copilot_research_context` | Research-context table | The context lives in server memory |

0063 from the previous phase is still optional.

**Environment.** No new required variables. Optional capabilities follow the existing variables:

- transcription and AI coding: `AI_STT_*` and `AI_*`;
- translation: `TRANSLATION_PROVIDER` / `GOOGLE_TRANSLATE_API_KEY`;
- storage: the Supabase service role.

Full list: `ENVIRONMENT-CHECKLIST-2026-10-18.md`. Readiness is visible on `/platform`.

## 6. Roadmap (not yet supported)

| Priority | Item | Why it isn't done |
|---|---|---|
| 1 | HB, LCA and SEM selectable from the analysis plan | They run in Data Analytics only |
| 2 | Bootstrap indirect effects; McDonald's ω | |
| 3 | Per-item guide selection for staged generation | The next cost lever |
| 4 | Splitting long audio; transcript editing; clip playback at an excerpt; AI-written theme summaries; blind double-coding assignments | |
| 5 | Live conferencing / real-time moderation | Needs an external provider integration |
| 6 | Randomizer "even presentation" backed by a least-fill claim; balanced design-version assignment | |
| 7 | Streaming / keep-alive copilot responses | |
| 8 | A PDF download in the Studio | PDF is conversion-only today |
