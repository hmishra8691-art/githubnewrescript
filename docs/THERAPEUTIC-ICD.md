# Therapeutic ICD Survey — programming spec

Programmed from `Therapeutic_ICD_Survey.docx` (624 paragraphs, 115 review comments)
against the Rescript `SurveyDefinition` schema at `234c40e`.

| | |
|---|---|
| Respondent-facing questions | **75** (`countRespondentQuestions`) |
| Hidden derived variables | 15 |
| Info / storyboard screens | 32 |
| Pages | 54 authored; each audience walks 51 |
| Flow nodes | 6 sections, 11 blocks, 54 pages, 1 branch, 1 randomiser, 1 quota check, 4 ends |
| Quota cells | 6 (country × audience, n=270) |

## Verification — all against the repo's own code, not a hand-rolled checker

| Check | Result |
|---|---|
| `SurveyDefinition.safeParse` | parses |
| `lintSurveyLogic` + `lintStructure` | **0 errors, 0 warnings, 0 info** |
| Engine walk, implanter (`start` → `visibleQuestions` → `advance`) | 51 pages, 51 questions, ends `complete` |
| Engine walk, referrer | 51 pages, 50 questions, ends `complete` |
| Audience separation | 25 implanter-only, 24 referrer-only, zero leakage |
| Engine test suite after the lint fix | 2904 pass, 0 fail (+4 new) |

The only pages with no answerable question are the five intentional info screens
(welcome, qualified, module A intro, module B intro, thank-you).

---

## 1. Engine features used

| Document instruction | Implementation |
|---|---|
| `(SELECT ONE; ALPHABETIZE)` | `settings.optionOrder: "az"` — a presentation sort applied before randomisation that never rewrites the programmed order, so it stays alphabetical in German and Italian too |
| `(RANDOMIZE)` | `randomization: { scope, method: "shuffle" }` — 16 questions |
| `(ANCHOR)` | option flag `anchor_bottom`, held in place by both sort and shuffle |
| `(please specify)` | flag `other_specify` |
| `None of the above` | `exclusive` + `none_of_above` |
| `(TERMINATE)` | `skipLogic` → `{ kind: "terminate", status: "screened" }` — 9 rules |
| `(ASK IF …)` | `displayLogic` condition trees |
| `(ASK IF … & B1c_Concept1 > 0)` | **cell-addressed conditions** — `source.rowCode` + `source.columnId`, 20 of them. No helper variables |
| Grid column `SHOW IF S12_n > 0` | **`QuestionColumn.visibleIf`** — 3 columns of S13, each reading its own S12 cell |
| `EACH DISPLAYED COLUMN MUST TOTAL 100%` | `settings.sumAxis: "column"` + `columnSumTarget: 100` — 5 questions. Read-only columns are excluded from the check by the engine |
| "Current %" / "Current #" columns | **read-only columns** (26) — per-row values as piped `cellDefaults` (52 rows), scalar values as a column `expression` |
| `(INSERT A4)`, `(insert S11_4)` | piping; grid cells as `{{S11[4:c_s11_n].value}}` |
| `AUTOPOPULATE 0s` | `cellDefaults` / `settings.defaultValue` |
| `CANNOT EXCEED …` | `custom_expression` validation |
| `CALCULATE …` | 15 `calculated` questions |
| `RANDOMLY ASSIGN … 1 OF 2 PATHS` | `randomizer` node, `show: 1`, two `embedded_data` arms |
| Quota table | one quota, 6 cells, `mode: hard`, `onFull: terminate` |

**No page carries an authored `visibleIf`.** `flow.ts` already passes over a page
with nothing visible on it, so the audience split needs no page-level plumbing.

---

## 2. Structure

```
00 Introduction              1 page
01 Screener                 17 pages → qualification branch → quota check
02 Current environment (A)   5 pages
03 Concept exercises (B)     1 intro + randomiser + 4 × 6 pages
04 CRT-D shift (C)           1 page
05 Final profiling (D)       5 pages
```

One question per page through the screener, so a terminate fires on the screen
that causes it. Elsewhere questions share a page only when they are mutually
exclusive by audience (B1b for implanters and B1e for referrers occupy one slot)
or are a natural set (D2–D4, D5–D6). Any question whose rule depends on an
earlier answer sits on a later page than that answer.

Each concept block is six pages: reaction (Ba) → volume (Bb/Be) → indicated but
untreated (Bc/Bj) → which patients (Bg/Bh) → EF expansion (Bd/Bf) → information
needed (Bi), with the concept recap at the top of all six.

---

## 3. The cumulative allocation chain

```
B1b  6 baseline ICD types (from the S11/S12/S13 mix calculations) + C1    7 rows
B2b  the same rows, each prefilled from B1b's own entries          + C2    8 rows
B3b  … from B2b                                                    + C3    9 rows
B4b  … from B3b                                                    + C4   10 rows
```

Each block is a two-column `composite`: a **read-only** "Current %" column whose
cells are per-row piped `cellDefaults`, and an entry column held to 100 by
`sumAxis: "column"`. The current figures are therefore real numeric variables —
they export, total and chart.

Bounded elsewhere by `custom_expression`: `ΣBnc ≤ A4`,
`ΣBnd(EF 40–50) ≤ A2_3`, `ΣBnd(EF >50) ≤ A2_4`, `C1 ≤ S11_5`, `C2 ≤ S17_4`.

## 4. Concept rotation

| | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| **Path 1** | CCM-D | RSA | CMIC | CMIC-D |
| **Path 2** | CCM-D | CMIC | RSA | CMIC-D |

A `randomizer` (`show: 1`, even presentation) picks one of two `embedded_data`
arms, which set `C1_LABEL`…`C4_LABEL` and `CONCEPT_PATH`. One set of B-series
questions serves both paths; every concept reference is `{{ed.CnLABEL}}`.
Adding a path is an edit to the randomiser alone.

## 5. Quotas

Hard quota, country × audience, target 270, terminate on full: US implanters 75,
US referrers 75, Italy 30/30, Germany 30/30. The check sits after the
qualification branch, so only eligible respondents are counted. Comment 0 ("this
adds up to 270 — did we mean to increase the sample size?") is unresolved in the
source; 270 is programmed as drawn.

---

## 6. Decisions and deviations

**Reconstructed.** *A1* is missing but A2 is specified as "TOTAL MUST EQUAL A1"
and inserts the calculated heart-failure count — so A1 is that derived figure,
shown back as the base before the respondent splits it. *A3, S14, S15, S19* are
numbering gaps: nothing references them.

**Repaired.** The fourth block's open end was coded `B3i`, a duplicate of block
3 — renumbered `B4i`. B3b/B4b print "(PIPE (CONCEPT 1) % FROM B2b)" against the
concept 2 and 3 rows; each row pipes its own concept. A6a is labelled
"(SELECT ALL THAT APPLY)" but prints percentage boxes and mirrors A5a — it is a
constant-sum allocation. The two "competitive share" formulas are written
`(1 − Medtronic) / S11_4`, mixing a fraction with a percentage and dividing by
the count twice; implemented as `(100 − Medtronic%) × S12_type / S11_4`.

**Aligned.** B1a asks likelihood to use; B2a–B4a are printed as favourability.
Comments 83–86 record both agency and client settling on likelihood to
use/adopt, because that is what compares with past studies. All four blocks use
the B1a scale. *Reverting 2–4 to favourability is a one-line change.*

**Preserved exactly.** A2's row codes are 1, 3, 4, 5 — the document skips 2, and
later questions address `A2_3` and `A2_4` by those codes.

**N/A cells.** S13's Abbott and Biotronik cells in the non-transvenous column
are prefilled 0 (`cellDefaults`), which is the document's "N/A"; the column still
reaches 100 from the three manufacturers that make the device.

**Open items for the client.** Only Vermont is excluded at S5 — the document asks
whether other states apply. Module C's placement is questioned in comments
119–120. The concept storyboards are placeholders pending client artwork. SL1's
"show only the languages for this country" needs wiring to the sample feed.

---

## 7. One engine fix shipped alongside

Programming this questionnaire surfaced a real defect in `lintLogic.ts`: the
pipe lint compared the whole bracket of `{{Q[row:column].value}}` against the row
codes, so every correct grid-cell pipe was reported as a missing row
(`S11 has no row "4:c_s11_n"`) while the token resolved perfectly at runtime —
`piping.ts` splits on the first colon. The lint now splits the same way and
checks each axis against its own list. Four tests added; 2904 existing tests
unaffected.

---

## 8. Importing

Studio → any project → **JSON** tab → import
`docs/therapeutic-icd/therapeutic-icd-survey.json`
(`meta.code = THERAPEUTIC_ICD_SURVEY`, `deployment.studySlug = therapeutic-icd-survey`).

Two earlier drafts titled "THERAPEUTIC ICD SURVEY" (`SURVEY_MWDKN63W`,
`SURVEY_MVZOX44H`) stalled at 13 single-select questions and can be archived.
