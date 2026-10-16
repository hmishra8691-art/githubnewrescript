# Rescript Studio — comprehensive platform audit, 2026-10-16

Audit of commit `b0dbe08` covering research workflow, survey programming, Intelligent Mode, data cleaning, analytics, document exports, runtime scripting, schema and migrations. Audit only — no source changes. Read in this order:

| # | Deliverable | What it answers |
|---|---|---|
| 01 | [Executive summary](01-executive-summary.md) | readiness, critical risks, top findings, recommendation |
| 02 | [Architecture map](02-architecture-map.md) | modules, dependencies, control vs data plane, end-to-end flow |
| 03 | [Feature inventory](03-feature-inventory.md) | supported / partial / missing / broken / unverified per feature |
| 04 | [Programming audit](04-programming-audit.md) | question types, the age test case, semantic validation, logic, matrix editor, custom setups, runtime |
| 05 | [Methodology matrix](05-methodology-matrix.md) | Conjoint, MaxDiff, List Fill, custom setups — per-stage status and gap reports |
| 06 | [Intelligent Mode audit](06-intelligent-mode-audit.md) | pipeline, structured generation, recovery, cross-mode consistency |
| 07 | [Data cleaning audit](07-data-cleaning-audit.md) | rules, overrides, raw preservation, consistency |
| 08 | [Analytics audit](08-analytics-audit.md) | bases (incl. "base of 20"), statistics, plan integration, consistency |
| 09 | [Document export gap analysis](09-document-export-gap.md) | research plan, programming spec, SAP, cleaning plan, data exports |
| 10 | [Schema and migration report](10-schema-migration-report.md) | gap → storage decision, backward compatibility, rules |
| 11 | [Bug register](11-bug-register.md) | 124 prioritised findings with evidence, fix, acceptance, effort |
| 12 | [Implementation roadmap](12-implementation-roadmap.md) | three batches, dependencies, quick wins, shared root causes |
| 13 | [Regression test plan](13-regression-test-plan.md) | unit, browser, integration, negative scenarios |
| 14 | [Readiness report](14-readiness-report.md) | blockers and the evidence still required |

Evidence: `raw/` holds the eight area reports (file:line evidence, command output, controlled-dataset numbers); `repro/` holds every reproduction script, its captured output and the browser screenshots. `AGENT-BRIEF.md` is the shared instruction the area audits followed.

Method: eight parallel code-level audits (read + unit tests + node-level repros), then orchestrator-run browser reproductions against Studio (fake AI provider) and runtime dev servers, read-only SQL against the active Supabase project, and an independent re-verification of every P0/P1 claim.
