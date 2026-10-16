# 07 · Data cleaning audit

Evidence: `raw/documents-and-cleaning.md` Part B (rule inventory B.1, findings B.2, clean-dataset contract B.3), repro `docs/audit-2026-10-16/repro/clean/run-rules.mjs`. Tests: `@rescript/quality` 51/51.

## What the pipeline is (as implemented)
`packages/quality`: a pure, deterministic `assess(def, response, peers, now)` over a **70-rule catalogue** (timing, matrix straight-lining, open-end quality, attention checks, consistency, navigation, bot/device, duplicates by ip/device/answer similarity, screener, cluster/network risk, pattern match) with per-survey configuration (strictness profiles, thresholds, severities, roles, weights, question scopes, custom rules, bands, evidence policy, telemetry retention). Runs at completion in the runtime (if enabled) and on demand (`recomputeSurvey`). Verdicts PASS/REVIEW/FLAGGED(+SUSPICIOUS/HIGHLY_SUSPICIOUS), stored in `responses.quality` with `configHash` and `computedAt`. Researcher decisions KEEP / REMOVE / REVIEW_LATER / CLEAR on the row plus an append-only `response_reviews` history with the assessment snapshot. Deletion is soft; hard purge only of already-soft-deleted rows with an audit log. Exports apply one `inDataset(row, filter)` contract (clean / all / custom).

## Brief checklist
| Check | Status | Finding |
|---|---|---|
| Required-field checks | IMPLEMENTED (`required_missing` family) | — |
| Invalid values / type mismatches | PARTIAL — relies on client validation (RUNTIME-01); no post-hoc type check rule | add rule once server validation exists |
| Duplicate / suspicious responses | IMPLEMENTED | symmetric flagging drops both members (CLEAN-09) |
| Speeding | IMPLEMENTED — synthetic run: 3/3 speeders FLAGGED with benchmark-based reasons | — |
| Straight-lining | IMPLEMENTED — 2/2 REVIEW | — |
| Contradictory answers | IMPLEMENTED (consistency rules, cross-session screener) | — |
| Failed attention checks | IMPLEMENTED | — |
| Inconsistent demographics | MISSING beyond screener consistency (CLEAN-01) | needs a semantic tag |
| Invalid geographic combinations | MISSING / configuration-dependent (CLEAN-01) | needs geo hierarchy (QT-11) |
| Missing data / partial completes | PARTIAL — partials excluded by status; no item non-response rule (CLEAN-01) | — |
| Open-end quality | IMPLEMENTED (length, gibberish, copy-paste, repetition, LLM-assisted optional) | — |
| Audio/video integrity | MISSING (CLEAN-01) | — |
| Rules, thresholds, configuration | IMPLEMENTED (CLEAN-02) | **off by default** (CLEAN-03) |
| Manual review / overrides | IMPLEMENTED (CLEAN-04) | no bulk decision; decided_by stores a name not an id (P3) |
| Exclusion reasons / audit trail | IMPLEMENTED (`response_reviews`) | not mirrored to `audit_logs` (P3) |
| Raw vs cleaned preservation | IMPLEMENTED (soft delete only; REMOVE never deletes) | manual edit/import overwrite `answers` in place with before/after in `response_edits`; no untouched raw column (CLEAN-05, accepted) |
| Reproducibility / reprocessing | IMPLEMENTED (`configHash`, snapshots) | recompute capped at 3,000 rows silently (CLEAN-07) |
| Export consistency | IMPLEMENTED (one `inDataset`) | stat formats lack status/quality/env columns (DOC-08/CLEAN-08) |
| Consistent for manual vs AI surveys | IMPLEMENTED by design — no rule reads AI metadata | difference is data source: imported/interview rows have no telemetry → 29 of 70 rules run, rest reported `notMeasured` (CLEAN-13) |
| Soft-deleted rows as peers | BROKEN (CLEAN-06) — still re-assessed and used as benchmark peers | one-line filter |
| Weak-signal auto-exclusion | IMPLEMENTED — classification only; exclusion needs REMOVE or dataset=clean (CLEAN excludes FLAGGED only) | `timing.pattern_match` over-fires on rounded page times (CLEAN-12) |

## Detected-issue record format (for the register, per the brief)
For every rule firing the engine stores `{ruleId, category, severity, points, evidence, message}`; affected variables are in `evidence.questions`; counts per rule are available via `recomputeSurvey` summary. Expected vs actual action and review requirement follow the role (`classifying` vs `informational`) and band. This satisfies the brief's traceability requirement once CLEAN-03/06 are fixed.

## Required fixes (priority order)
CLEAN-06 (XS), CLEAN-03 (XS, default on for new surveys — no migration), CLEAN-09 (S), CLEAN-07 (S), DOC-08 (S), CLEAN-01 rule families (M, after semantic tag), DOC-04 cleaning-plan document (S).
