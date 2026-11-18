# Phase 3 (Intelligent Mode expansion) — status, 2026-11-18

Patches 0172–0176. Every phase-3 item is closed.

| Item | Patch | Outcome |
| --- | --- | --- |
| Intelligent-mode browser failure (from phase 2) | 0172 | **Not a product defect.** The first turn compiles a 2,900-module route on a cold dev server (55–60 s, against a 40 s wait), and this sandbox's memory limit then OOM-kills the dev server. The wait is now 120 s, with diagnostics on failure. |
| P1-02 Contradiction check | 0173 | The check already existed ("review my survey"). It now also runs at import, so impossible conditions, unreachable questions and range overlaps or gaps are reported with everything else. Deliberately hidden questions are not reported. |
| P1-01 One clarification flow | 0174 | An auto-fill with no named source goes through the import's clarification step: "Where does Q1 get its value?", with the questions before it, today's date, or leave it. Applying the answer sets the default. |
| P2-01 Model path to the planner | 0175 | The model restates the request with `plan_analysis`, and the planner decides. Same checks and clarifications; the model cannot invent a derived variable, a filter or a statistic. |
| P1-09 Injection corpus in CI | 0176 | Already in CI through five packages' unit tests. Running the corpus through the new behaviour reader found one hit ("add a hidden question…"); the rule is tightened and covered by a test. |

## Corrections to the audit

- **P1-02 was overstated.** A whole-survey contradiction and reachability review already existed (engine
  `surveyReview.ts`). The gap was only that the import did not run it.
- **P1-09 was overstated.** The prompt-injection corpus already runs in CI through the unit tests.

## Gate for phase 4

The audit's gate is "Eval accuracy published per path; 0 silent drops on the corpus".
- **Silent drops:** met. In the behaviour corpus and the real Decipher and Qualtrics corpus, every instruction is
  mapped, asked or reported.
- **Eval accuracy:** still needs the owner's model budget (P0-06). The harness is ready.
