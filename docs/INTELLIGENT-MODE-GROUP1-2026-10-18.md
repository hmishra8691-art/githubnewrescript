# Intelligent Mode — the five most urgent weaknesses (2026-10-18)

The five items in group 1 of the weakness list, fixed or built and tested. Each has a detail doc.

| # | Weakness | What was done | Detail doc |
|---|---|---|---|
| 1 | No automated testing against a real AI model | Evaluation harness: 23 golden scenarios, 10 injection cases and the production prompts. It drives the real `/api/copilot/turn` handler in-process. It runs on the fake provider in CI and on a real provider when `EVAL_AI_API_KEY` is set (locally, in the `ai-eval` GitHub workflow, or from `/platform` by a platform admin, with a cost cap) | `AI-EVAL-AND-CACHE-2026-10-18.md` |
| 2 | Prompt-caching savings measured only on the fake provider | Measured from production billing (`usage_events`). A report function, `/platform` panel and `pnpm report:ai-cache`. Every AI path now records the cache split | `AI-EVAL-AND-CACHE-2026-10-18.md` |
| 3 | Intent misreads on unusual phrasing | All 43 production operations reviewed; 9 cases fixed or verified; a production regression corpus (58 cases) | `PRODUCTION-INTENTS-2026-10-18.md` |
| 4 | No response streaming | Opt-in NDJSON stream from the copilot route: live reply text, progress, heartbeats every 8 s, checkpoints, one terminal result. Native streaming from Anthropic and OpenAI-compatible providers, BYOK included | `COPILOT-STREAMING-2026-10-18.md` |
| 5 | No prompt-injection audit for uploaded documents | Every path audited; untrusted text fenced; a scanner; a provenance gate for high-risk actions; script exfiltration refused; output checks on probes and translations | `PROMPT-INJECTION-AUDIT-2026-10-18.md` |

## Measured production cache effect

Read 2026-10-18 from `usage_events`. These are the first 9 calls carrying the token split, all on 2026-10-17, from one user on two surveys. The sample is small.

| | Value |
|---|---|
| Calls that read the cache | 7 of 9 |
| Input tokens | 91,002 |
| Read from cache | 42,583 (46.8 %) |
| Input cost saving | 38.6 % |
| Total provider cost | $0.5518 (would be $0.6571 uncached) |
| Total saving | 16.0 % |

Output tokens are 58 % of the cost; caching does not reduce them. The 0067 research-context code has no real traffic yet.

## Production findings

- **Custom Component JavaScript ran unsandboxed** on the respondent page, and the copilot could write it with no check. Code that could send data off the page is now refused. Hand-written or imported code is still not checked.
- **Hindi "सर्वे डिजाइन करके दो" was routed as a look-and-feel turn** (since 10-16), not a survey generation. Fixed.
- **"Please apply the changes" with a proposal open** cost a second model call that proposed the same changes again. It now applies the open proposal, with no model call.
- **Undo by voice** ("reward back", "वापस कर दो", …) went to the model. It now reverts the last change through History.
- **Grid-row calculations** (`PERC.R1`, `IF … THEN … ELSE`) were refused. They are now rewritten; the correct spelling `PERC_r1` was also being refused.
- **Fixed notices** ("Nothing was changed: …") were always in English. They now follow the researcher's language (English, Hindi, Hinglish, Marathi, Urdu).

## Verification

- **Unit tests, all passing:**
  - engine 2,160, ai 144, billing 57, access 123, designs 99, templates 110, exporters 135, quality 61, analytics 605, schema 11, media 163, import 51, interviews 178;
  - Studio lib 784, runtime lib 20.
- **Checks:** typechecks (Studio, runtime, renderer) clean; public docs current; dependency boundaries 0 violations; auth-guard audit 213 handlers, 0 problems.
- **Evaluation on the fake provider:** 45/45 by default, 75/75 with the full production corpus, and the same with `--stream`.
- **New browser suites, passing:** `copilot-streaming`, `prompt-injection`, `production-intents`, `ai-eval-platform`.
- **Regression browser suites:** see the commit message.

## Not done

- **No real-model numbers yet.** No API key exists in the build sandbox. The first real run sets the baseline: run the `ai-eval` workflow with the `EVAL_AI_API_KEY` secret, or the `/platform` panel. Then record cassettes and commit `--update-baseline`.
- **Streaming:** the repair and coverage passes do not stream text. When two requests share one model call, only the first gets text. A broken stream rebuilds the item in flight. Whether Vercel reports a client disconnect is unverified.
- **Injection:** a document can still bias ordinary proposals (wording, plan); these go to a reviewed preview. The scanner is pattern-based. The intent check is lexical.
- **Intents:** typed requests can still join a proposal that a chip opened. That is deliberate, so that follow-ups keep working.

## Deploy

1. Apply **0068** (`ai_eval_runs`) before the code. It is optional: without it, admin eval runs live in memory and the panel says so.
2. Deploy the code. No new required environment variables.
3. Optional settings:
   - `COPILOT_STREAMING` = `on` / `off` / `auto`;
   - `NEXT_PUBLIC_COPILOT_STREAMING=off` to turn streaming off in the page;
   - the `EVAL_AI_API_KEY` repository secret for the eval workflow.
