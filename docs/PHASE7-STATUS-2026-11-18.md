# Phase 7 (Future AI, 2027–2029): status, 2026-11-18

Patches 0192–0195, plus this note (0196).

The audit's gate for this phase is **"tool registry and provenance live before any autonomous step"**. Both are now
built. No autonomous step was added: the fieldwork agent only proposes, and a person decides every time.

The audit also makes this phase depend on the gates of phases 3 and 6. Those are still open: published eval
accuracy needs the model budget, and SSO and the 10,000-respondent load test need staging. So this phase built the
foundations those later steps will stand on, not the autonomous features themselves.

| Item | Patch | Outcome |
| --- | --- | --- |
| P3-01 Tool registry | 0192 | Every questionnaire action is a typed tool (one per op, generated from the action layer, so a new op becomes a tool automatically). The analytics, quality, data, deployment, translation and recruitment engines are declared with their routes. Each tool has a risk class and an approval level: none / confirm / explicit, where the dry run can raise the level but never lower it. A dry run shows what the tool would do and the diff, and writes nothing. Explicit approval must say what was acknowledged. An agent can propose; only the signed-in person approves. Every call is audited as `tool.called`, refusals included. `/api/surveys/{id}/tools` lists, dry-runs and executes, with the edit lock and the revision guard. |
| P3-02 Provenance graph | 0193 | One graph from what is already recorded: source file → source item → question → setting (the instruction that set it) → variable → analysis (with its input hash and versions) → table → claim, plus the dataset. `explainClaim` walks any claim back to its tables, data and questionnaire line. `/api/surveys/{id}/lineage` serves the questionnaire half. |
| P3-03 Fieldwork agent | 0194 | Watches pace, quota cells, the quality flag rate and suppliers. It proposes, with the numbers it saw, why, and the registry tool that would make the change (dry run first). It never acts. Accept and reject both need a reason, and both are logged. A rejected proposal is not raised again until the situation changes. The proposals appear on the live fieldwork dashboard. |
| P3-05 Synthetic pre-testing | 0195 | Simulated respondents were already TEST data, coded SIM-…, and never mixed into live data, reports, quotas or deliverables. **New:** a comparison with real responses, question by question (total variation distance). Unless the verdict is "close", the simulation is labelled as good for testing logic only, not for population evidence or power. |
| P3-04 Adaptive questionnaires | — | **Not built.** Adaptive *conjoint* exists already (ACBC, adaptive CBC). General per-respondent item selection is an XL item, and its acceptance criterion ("simulated studies keep measurement validity") needs a psychometric design decision first: which constructs, which item banks, which stopping rule. |
| P3-06 Voice and video research | — | **Partly in place.** The AI-moderated interview already speaks, listens, transcribes and runs in real time (runtime `ai-interview/*`). Productising it as an end-to-end voice study depends on P2-15's providers: TURN, SFU and speech keys. The health check added in phase 6 now reports what is missing. |
| P3-07 Recruitment intelligence | — | **Partly in place.** Feasibility, pricing, an allocation optimiser and reallocation exist (`packages/recruitment`, Recruitment → Plan / Optimise / Reallocate). The audit's acceptance criterion, "beats the baseline in a back-test", needs live vendor volume, which the platform does not have yet. |

## Gates and tests

- **Tool contracts:** every questionnaire op is a tool. Every change needs a person. Publish, data, external, spend and destructive tools need explicit approval. A dry run changes nothing. A destructive dry run escalates the approval. Records keep questionnaire input and only hash route input, so an email being erased never appears in the log.
- **Lineage:** every claim in a planned run's deck reaches a table and the data. A key finding walks back to the imported questionnaire line and the behaviour that line set. Removing a source leaves the claims that cited it reported as orphaned.
- **Fieldwork simulation:** a 10-day, 500-complete field under healthy, stalled, slow, lagging-quota, quality-spike and bad-supplier scenarios raises exactly the expected proposals, and only those. Every tool a proposal names exists, and the questionnaire tool dry-runs.
- **Synthetic validation:** two samples from one population compare as "close". A skewed simulation is flagged on the questions it skews.
- **Suites:** engine 2,923, analytics 887 and Studio 1,300 unit tests pass. `audit:code` reports 0 problems: every new route is guarded, no new direct database calls, RLS everywhere.

## Not tested

- **The tools, lineage and fieldwork-agent endpoints have not been run against a real database.** Execution writes the draft, and the live database is read-only for me. The logic they call is unit-tested.
- **The Suggestions panel has not been checked in a browser.** The fieldwork dashboard needs response data.
