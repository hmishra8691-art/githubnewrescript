# 06 · Intelligent Mode audit

Evidence: `raw/intelligent-mode.md` (pipeline trace, 70-op catalogue, provider error paths, repros `docs/audit-2026-10-16/repro/ai/*.mjs`), `raw/question-types-validation.md` §2–4, orchestrator browser run `age-e2e.mjs`. Tests executed: Studio copilot/architect/builder 91 pass; engine action layer 90; coverage/blockers 9; analytics planBridge 17; AI provider client 42.

## Pipeline trace (where context lives)
brief → `def.research.brief/objectives/hypotheses/constructs/KPIs` (persisted in the definition) → `create_question` with `analysis.hypotheses` tags → `propose_analysis_plan` → `research.analysisPlan` (crosstabs/tests/hypotheses) → `planned` analyses in the workspace → `runAnalysis` verdicts per hypothesis. Every hop is in the saved definition except **conversation memory** (module-level Map, AI-05). The chain is linked end to end; there is no second source of truth for the questionnaire.

## Structured generation
70 ops; each coerced (`coerceSurveyActions`), applied on a clone, re-parsed by the schema; conditions strict with forward/self-reference refusal; JavaScript through the lexer allow-list + sandbox gate; no `eval`/`new Function` on model output; no raw JSON applied. **Exceptions found:** `set_custom_code.css` applied without the CSS gate and injected unscoped (AI-06); validation `message` dropped (AI-02); intrinsic type rules overwritten (AI-01 = QT-01).

## Research understanding
Objectives, hypotheses, population, demographics, quotas, methodology, analysis objectives are all representable and generated through typed actions. Weak spots: no semantic tag on questions (so validation, geo, cleaning and SAP variable coding cannot be inferred — QT-02/QT-11/CLEAN-01/DOC-03); methodology configs limited to task shells (METHOD-08); no validation-script op (LOGIC-13).

## Generation quality (controlled 25-action brand tracker, `brand-tracker.mjs`)
Applies cleanly; engine raises the expected warnings for label-typed conditions; **no validation attached beyond what the model sent** — the age question stores `[min,max]` (no integer), the email question loses `email` when `required` is added; hypothesis renumbering via `set_research` leaves question tags pointing at the wrong H (AI-03); a 4-row matrix accepted as scalar t-test outcome without warning (AI-09).

## Error recovery
Provider client: bounded retries (3 provider-level), 429/5xx backoff, json mode, usage accounting; browser-level 5 retries; plan-first generation checkpoints per item (`resume.ts`), no double-build/double-charge; truncation of a single-reply generation keeps only the prompt (AI-07, by design). **Researcher-facing gap:** route refusals without a `failure` object (401 "Not signed in.", 400s) render as "THE AI SERVICE COULD NOT PROCESS THIS REQUEST … tell your administrator", and the client catch-all shows raw exception text (AI-04) — the "unexplained technical error" the brief describes. Fix is a message map, not a retry change.

## Cross-mode consistency
AI and manual surveys share one store path (`replace` → `withOptionCodes` → legacy migrations → draft save → readback repair); no AI-only fields beyond provenance markers (`source:` on behaviours, `analysis` tags). Regeneration applies actions, never replaces the definition wholesale; manual edits survive. **Asymmetry in the other direction:** the engine action path retargets logic on recode (`update_option`) while the Studio hand editor does not (LOGIC-01) — manual mode is the weaker one here. Test and live builds use the deployed version (`decideTestBuild` draft-first for test links by design).

## Required outcomes vs status
| Brief requirement | Status |
|---|---|
| Schema-valid configs for types/validation/logic/quotas/embedded/randomisation | IMPLEMENTED |
| Custom setups / methodology configs | PARTIAL (shells; no designs; no scripts) |
| Analysis plans, derived variables, statistical measures | IMPLEMENTED (plan), PARTIAL (variable coding) |
| Data-cleaning rules from generation | MISSING (quality config is separate and off by default) |
| Reporting/export requirements | PARTIAL (proposal doc; no SAP/cleaning plan) |
| No free-form code without validation | IMPLEMENTED except CSS path |
| Preserve valid work, report partial, allow retry | IMPLEMENTED (plan-first) |
| No unexplained technical error | BROKEN for 401/400 |
| Manual edits preserved, regeneration non-destructive | IMPLEMENTED |
| Works in manual but not AI | designs, validation scripts, 12 question types without friendly names |
| Works in AI but not manual | recode retargeting (LOGIC-01) |
