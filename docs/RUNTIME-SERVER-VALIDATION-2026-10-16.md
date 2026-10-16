# Server-side validation of respondent saves (RUNTIME-01, 2026-10-16)

**Defect.** `POST /api/session/save` stored `answers`, `status` and `step_index` exactly as posted. Validation lived only in the browser (`validatePage` in `Runner.tsx`), so any respondent-side actor could write out-of-range or wrong-type answers, or mark a session `complete` from page 1, and the row flowed into quotas, analytics and exports (audit register `11-bug-register.md`, P0).

**Fix.** The engine gains `checkSubmission` (`packages/engine/src/serverValidation.ts`): it rebuilds the interview on the server from the row's seed and the posted answers, walks the compiled flow with `start`/`advance` — the same functions the browser runs — and validates every page the client claims to have passed with `validatePage`. Problems are graded:

- **hard** — the payload cannot be an honest interview: an answer failing its question's rules on a page already passed (type, range, format, required), an unknown question id, a claimed completion that does not reach an end, a malformed shape.
- **soft** — logged, never refused on their own: an answer for a question the replay never showed (display logic hid it, a loop iteration that did not exist), a final status the replay reached differently (quota timing), an in-progress index past the end.

The page the respondent is currently on is not validated (it is being filled in). `def.scripts` (unsandboxed, RUNTIME-04) and option popups are not run server-side. Quota outcomes are replayed with the current counts, which is why a status difference is soft.

**Posture.** `RUNTIME_SERVER_VALIDATION=off|log|enforce` (runtime app). Default `log`: every problem is written as one `[rescript:save] submission check` JSON line with `wouldRefuse`, and the row is stored as before. `enforce` answers a hard problem with HTTP 422 `{ error, problems }`; the Runner already treats a 4xx on the final save as terminal and shows the message with a Retry. TEST sessions are never refused (a programmer's test link may start mid-survey via `startAt`, which the replay cannot know).

**Rollout.** Deploy with `log`, watch for `wouldRefuse: true` lines from honest traffic for a few days, then set `enforce`.

**No false refusals — the test that permits enforcement.** `packages/templates/src/serverCheck.test.ts` walks every shipped template with the headless respondent (`simulateRespondent`) and the master demo through its four documented test paths (loops, nested loops, List Fill, quotas, conjoint, MaxDiff, calculations, scripts), and asserts the server check accepts the completion and the intermediate in-progress positions. The simulator was corrected on the way: it now answers questions that appear because of an answer on the same page (a carry-forward list, a sibling-gated field) — the browser shows them before Next, and the old walk produced "complete" interviews the real runtime would have refused.

**Cost.** One replay per save: ~130 ms for a mid-survey save and ~1.1 s for the completion of the 79-page master demo, in-process, no extra queries beyond the quota counts the route already needs.

**Tests.** `packages/engine/src/serverValidation.test.ts` (7: honest saves, page-being-filled, out-of-range/decimal/wrong-type refused with the engine's own message, completion must reach an end, unknown question, bad shapes, `__proto__`, not-asked soft, companion/loop keys, bounded replay); `packages/templates/src/serverCheck.test.ts` (6). Engine 1,862 and templates 104 tests green.

**Still open from the same family.** RUNTIME-02 (`session/start` ignores password mode and closed status), SCHEMA-01/RUNTIME-03 (quota increment uncapped, "full" decided client-side), RUNTIME-04 (scripts unsandboxed).
