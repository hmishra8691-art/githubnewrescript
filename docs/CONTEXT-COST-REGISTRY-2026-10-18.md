# Research context, AI cost and the capability registry (2026-10-18)

Engineer E1, brief §3 (structured research-context summary and cost optimisation), §11 (capability registry) and §10 (environment checklist, in `ENVIRONMENT-CHECKLIST-2026-10-18.md`).

**Principles:**

- Additive and backward compatible.
- One migration (0067), optional: without it the context lives in server memory.
- No new dependency and no new environment variable.
- Fake AI provider only.

## 1. Audit: the state before this change

| Area | What existed | Gap |
|---|---|---|
| Staged generation | Plan once, then one call per approved item (≤ 90 s a stage). The plan prompt carries no guides | **The whole brief went with every item call.** The browser resends `message` (the brief) with each execute request, and the route built each item prompt as `copilotUserPrompt({ message: brief, … }) + executeItemPrompt(…)`. A 24k brief planned into 12 items was sent 13 times |
| Prompt caching | `copilotCall` lifts the guides into cached system blocks (AI cost audit 10-17) | The brief is variable text, never cached |
| Persistence | Operation log (20k chars of the prompt plus SHA-256, migration 0063). Conversation memory rebuilt from it (AI-05). Research documents (0045) with BM25 retrieval | Nothing kept a derived structure of a brief. Research documents would change later turns' retrieval and the Research panel |
| Outline (`copilotOutline`) | Exact; up to 150 questions in full (60 above 150), named questions' logic in full | Not task-aware: a theme change got the whole questionnaire, and a logic edit on a large survey got everything |
| Measurement | Usage event metadata: `operation`, tokens (input, cached, write, output), requests | No latency, no retries, no workflow id, no cost per generation |
| Capability registry (`capabilities.ts`, D, 10-17) | Methodologies, question types, analyses, qualitative, exports. Status supported / partial / not supported. Derived from the real registries | No services, configuration, handler, inputs, outputs, tests or version. Nothing knew whether an installation could run a capability (speech-to-text, translation, embeddings) |
| Diagnostics | `/api/platform` + `/platform`: presence flags for database, mail, AI, cron. `/api/ai/health` for provider lanes | No speech-to-text, translation or storage readiness. Not connected to what Intelligent Mode offers |

## 2. Design

### 2.1 The structured research context (`lib/copilot/researchContext.ts`, pure)

**Derived, not generated.** After the plan stage has read the brief whole, `deriveResearchContext({ brief, plan, def })` produces one context. There is no extra model call, so it costs $0, the same brief always gives the same context, and it is testable.

**How it is built:**

1. `sectionBrief` splits the normalised brief into its sections (numbered and unnumbered headings).
2. Each section is classified by its heading, then its parent heading, into:
   - objectives, business context, research questions, hypotheses;
   - population and sampling, methodology, questionnaire structure;
   - constraints, analysis, reporting.
   Reference material (answer lists, definitions, examples) is retrieval-only.
3. Within each category, **units** (bullets, table rows, sentences) are **selected verbatim, never paraphrased**.
   - Numbers, obligations (must, at least, maximum, do not…), hypothesis ids and codes are weighted first.
   - A unit is never cut.
   - What does not fit the category's budget stays retrievable, and the count is shown.

**Fields:**

- objectives, business context, research questions;
- hypotheses with exact wording: from the survey's research design when it has one (authoritative), otherwise from the brief (`H1.`, `H2:`, `Hypothesis 3 —`, or a hypotheses section's lines);
- population and screening (the quota table rows);
- methodology;
- questionnaire structure: the brief's sub-sections in order, with their purpose line;
- question ids and variables named in the brief;
- constraints and mandatory requirements;
- analysis plan, reporting;
- progress: completed and pending items, and unresolved or assumed points from the plan;
- the brief's section index;
- version, status (fresh / stale), and a fingerprint: brief SHA-256 and length, research design hash, plan hash.

**Persisted per survey AND owner** (`researchContextStore.ts`, table `copilot_research_context`, migration 0067):

- The owner is `org:<customer>`, otherwise `user:<id>`.
- The row holds the brief, so exact passages are retrievable after a reload, plus the workflow's measured totals.
- When the table is missing (and in the sandbox) the server's memory is used, the same `storeWithFallback` pattern as the other copilot stores.
- Why not an existing store: the operation log is one capped row per turn, and a research document would change every later turn's retrieval and the Research panel.

### 2.2 The context layers of one call

| Layer | Content | Where in the request |
|---|---|---|
| 1 | The research context (`renderResearchContext`): full for the build of its own brief, compact for an edit (constraints, reporting, progress, the section index) | Third **cached** system block (`copilotCall(text, extraStable)`); unchanged across a build's items |
| 2 | The survey outline, exact and **authoritative**; task-aware (§2.3) | User text |
| 3 | Memory and recent turns | User text |
| 4 | The task: the item's own spec (`executeItemPrompt`) and the guides (still chosen from the brief, so every guide the brief named still goes) | Guides in the cached block; task in user text |
| 5 | A reference to the stored brief (length and ref) in place of the brief, plus **BRIEF PASSAGES**: the exact passages this item needs, by keyword, heading, hypothesis id and number (`itemPassagesFor`, k = 3, ≤ 4,500 characters) | User text |

What each item receives, from the benchmark run:

- The screener item gets the regional quota table verbatim.
- The design item gets §5 (the hypotheses) and §11 (the analysis plan).
- The technology-stack item gets §8.3 and the §9 tool lists.

An ordinary turn that names something in a stored brief gets that passage too (score ≥ 6, ≤ 2 passages).

### 2.3 Task-aware selection (`questionnaireScope`, `contextLayersFor`, `copilotOutline({ questionnaire })`)

- **Theme turn** (the theme assistant, or a look-only request about colours, fonts or buttons that names no question): **no questionnaire**. The outline is the title, the question count, the theme and the UX items. No research context.
- **Logic edit** (display logic, skip, branch, mask, piping…) on a survey with more than 30 questions that names questions: the named questions **plus their dependencies** (what their logic reads, and what reads them; `withDependencies` uses the engine's `questionDependencies`) in full, the rest by code. On a 40-question test survey the outline is under 60 % of the full one.
- **Everything else:** the outline as before.

### 2.4 Safety

- **The definition is authoritative.** The hypotheses come from the survey's research design once it has them. The rendering says the outline wins where they differ.
- **Invalidation** (`reconcileContext`, checked on every turn):
  - A context derived while the survey had no design **adopts** the first design, which the build wrote from this brief. Its wording becomes the context's.
  - Afterwards, any change to the objective, hypotheses, methodology, population or research questions makes it **stale**.
  - A stale context is not sent. It is **regenerated on demand**: the next build of its brief, or `POST /api/copilot/context { action: "regenerate" }`. The version goes up by 1.
- **No leakage:**
  - The store is keyed by survey AND owner (tested: another survey, another organisation, and the person outside their organisation's key all get nothing).
  - Outside the build of its own brief, a context is used only once its design has been adopted, so a survey started over (or the shared sandbox) is not given an earlier brief.
  - The context endpoint never returns the brief, only its length and ref.
- **Failure-tolerant.** A store that cannot answer logs one line and the brief is sent whole, as before.

### 2.5 Measurement

**Per call** (`measured` in the route, which calls `meteredAi`; `meteredCore` `meta`). The usage event metadata now carries:

- `latencyMs` for every metered call;
- `providerLatencyMs` (the ai package now reports `latencyMs` per request);
- `workflowId`, `promptChars`, `retries`;
- `researchContextVersion`;
- the existing `operation`, `requests` and `tokens {input, cachedInput, cacheWrite, output}`.

**Per workflow** (`addCalls`): the workflow id is `wf_` plus a hash of (survey, owner, brief), shared by the plan and every stage of its build with no browser change. It sums calls, requests, characters, input / output / cached tokens, retries, latency and charge, broken down by operation, and marks the workflow completed when the build finishes with nothing pending. It is kept with the context and returned as `context.workflow` on the plan, progress and executed responses. That is the **cost per completed generation**.

Every response also carries `context.calls` (per call) and `context.researchContext` (status, version, size, layer). On the fake provider only, `context.sent` holds what each call sent; this is the browser suite's seam.

**SQL for production**, from the usage events:

```sql
select metadata->>'workflowId' as workflow, count(*), sum(input_units), sum(output_units), sum((metadata->>'retries')::int), sum((metadata->>'latencyMs')::int), sum(customer_charge)
from usage_events
where metadata ? 'workflowId'
group by 1;
```

## 3. Measured: before and after

Command: `node --experimental-strip-types --no-warnings scripts/ai-context-benchmark.mjs` (`--json` for the rows).

**The setup:**

- The 23,867-character brief fixture, a fixed 12-item plan (design, 10 sections, logic and analysis), an empty survey.
- Each stage's prompt is built with the route's own builders.
- Each stage is **sent through the fake provider** inside `collectUsage`. The fake reports input tokens as ceil(chars / 4) + 60.
- BEFORE is the old assembly (the brief in every item), as the builder without the new options.

**Pricing:** the billing package's `priceSpec` and default rates, claude-sonnet-4-6. Output is not measured (the fake answers `{}`), so both runs are priced with the **same assumed output**: 2,500 tokens for the plan and 3,000 per item.

| | Before | After |
|---|---|---|
| Plan call | 40,855 chars · 10,274 tokens | identical (the plan must read the brief) |
| One item call, user (variable) text | 25,568–26,232 chars | 3,491–7,223 chars |
| One item call, total sent | 69,456–70,120 chars · ≈17,500 tokens | 58,180–61,912 chars · ≈14,600–15,500 tokens |
| Research context (cached block) | — | 10,799 chars (once per build; 45 % of the brief) |
| Input tokens, 13 calls | 220,434 | 189,307 (**−14.1 %**; items **−14.8 %**) |
| Variable characters, 13 calls | 337,150 | 83,031 (**−75.4 %**) |
| Charge without prompt caching | $2.8736 | $2.6575 (**−7.5 %**) |
| Charge with prompt caching (cache warm from the previous stage) | $2.1448 | $1.7476 (**−18.5 %**) |

**Reading the numbers:**

- The brief's share of an item call fell from about 26k to 3.5–7k characters.
- The total fell less, because an item call still carries about 43k characters of action guides chosen from the brief (analysis, translation, quota, List Fill, methods, findings, research, qualitative, reporting).
- Those guides are cached at 10 % and are the remaining large input.
- Output is the larger share of the charge (assumed equal in both runs).
- These are the only percentages claimed. No production measurement was made; the per-call and per-workflow instrumentation now records it live.

## 4. The capability registry (§11)

**Shape** (`Capability` as written; `CapabilityRecord` as returned, every field filled with kind defaults):

- `id`, `name` (display), `kind` / `category`;
- `status`: supported / partial / **requires_configuration** / not_supported;
- `services` (required dependencies, keys of `SERVICES`) and `configuration` (the env var NAMES those services need; "A | B" means either);
- `inputs`;
- `handler` (`actions:create_maxdiff,…`, `analysis:t_test`, `route:POST /api/ai/transcribe`, `export:@rescript/exporters#responsesToSav`);
- `validation`, `outputSchema`, `limitations`, `tests`;
- `version` (`REGISTRY_VERSION` 2026-10-18 unless given).

**Kinds** add `reporting` and `platform`. **Adding entries** (E2, E3, E4): `EXTRA_CAPABILITIES`, or the existing lists. A new dependency is a `SERVICES` entry: id, name, purpose, variables, apps, and `readiness(env)` returning names only. `capabilitiesReadiness.test.ts` checks the shape of every entry.

**Services:**

| Service | Ready when (presence only) |
|---|---|
| Language model | `AI_API_URL` |
| Speech-to-text | `AI_STT_API_URL`, or `AI_API_URL` when not Anthropic (Anthropic has no audio API) |
| Text-to-speech | `AI_API_URL`, not Anthropic |
| Translation | Google key or a language model; a pinned `TRANSLATION_PROVIDER` needs its own |
| Embeddings | `AI_EMBEDDINGS_MODEL` + `AI_API_URL` |
| Database | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` |
| Media storage | All four R2 settings, otherwise Supabase Storage |
| Mail | `RESEND_API_KEY` + `MAIL_FROM` |
| Scheduled jobs | `CRON_SECRET` |
| Report narration | `REPORT_NARRATION_ENABLED` |
| Geocoding | `GEOCODE_API_URL` |

**Entries that need configuration:**

| Entry | Status | Needs | Configuration |
|---|---|---|---|
| Intelligent Mode model reasoning | requires configuration | Language model | `AI_API_URL` |
| Spoken requests (Intelligent Mode, Design with AI) | requires configuration | Speech-to-text | `AI_STT_API_URL` |
| Machine translation (Studio button / batch) | requires configuration | Translation | `GOOGLE_TRANSLATE_API_KEY \| AI_API_URL` |
| Semantic retrieval over documents | requires configuration | Embeddings | `AI_EMBEDDINGS_MODEL`, `AI_API_URL` |
| Transcription of recorded answers | requires configuration | Speech-to-text, Media storage | `AI_STT_API_URL`, `R2_BUCKET \| SUPABASE_URL` |
| Narrated video reports | requires configuration | Narration switch, Text-to-speech | `REPORT_NARRATION_ENABLED`, `AI_API_URL` |
| Address search on location questions | requires configuration | Geocoding | `GEOCODE_API_URL` |
| Video / voice responses (methodology) | partial | Speech-to-text, Media storage | as above |
| Recorded audio answers (qualitative) | partial | Speech-to-text, Media storage | as above |
| AI probes · AI conversational interviewer | supported | Language model (+ Text-to-speech) | `AI_API_URL` |

**Registry size today:** 120 entries.

- Methodologies: 13 supported, 6 partial.
- Question types: 37 supported, 3 partial.
- Analyses: 19 supported, 8 partial, 5 not supported.
- Qualitative: 4 supported, 2 partial, 2 not supported.
- Exports: 14.
- Platform: 7 requiring configuration.

E2, E3 and E4 had not yet added entries at this run.

**Readiness:**

- `capabilityReadiness(env, override)` returns, per entry: ready, missing variable names, missing services, a reason, and whether it is requestable.
- `not_supported` is never ready.
- `override` marks a service ready that the acting user's own connection provides. The copilot passes `{ ai_chat: true }`.
- Pure, in the engine.

**Diagnostics:**

- `lib/capabilityStatus.ts` feeds `/api/platform`:
  - `capabilities: { services, capabilities }`;
  - critical gaps (speech-to-text, translation, storage) appended to `warnings`; the language model already had its own warning.
- `/platform` shows a "Capabilities and services" card: ready / not configured, variable names only.
- The migration probe list gains 0067.

**Intelligent Mode consults it:**

1. **Refusal, deterministic.** A short request (≤ 600 characters) that names an unready capability needing configuration gets `capabilityRefusal`: "… is not available on this installation: Speech-to-text provider is not configured (an administrator sets AI_STT_API_URL). Nothing was changed and nothing was charged."
   - No model call, no charge; `context.scope: "unavailable"`.
   - Never for a long brief.
   - Never for "a question about X".
   - Never for translation, because the copilot writes translations itself.
2. **Availability.** `availabilityNote` names the unready requestable capabilities ("do not offer, plan or substitute") as a cached block on every call.
3. **Guides.** `capabilityBrief({ readiness })` lists only ready methodologies and names the rest as not configured. Called with everything ready it is unchanged, so the research guide stays cacheable.

`not_supported` procedures (HB, latent class, SEM, moderated focus groups…) are still handled by the research guide: the model writes the specification into assumptions and says it is not executable.

## 5. Tests and what to run

**Unit tests** (all pass; numbers at E1's final run):

- engine **2,137** (was 2,122; +5 `capabilitiesReadiness.test.ts`, plus others' additions);
- ai **124** (+1 `usageMeasure.test.ts`);
- billing 52;
- Studio lib **646 / 647**. The one failure is `copilot.test.ts:193`: E3's new `create_qual_guide` action is not yet documented in a guide.

**New Studio tests** (`researchContext.test.ts`, 9):

- verbatim extraction: 8 hypotheses, quota and method numbers, every rendered line a substring of the brief;
- hypothesis forms;
- item calls get the context in a cached block, a variable part under 40 % of before, and the quota table for the screener;
- retrieval returns exact passages (quota row, H5, a definitions row);
- invalidation: adopt, then stale, then regenerate v2 with the design's wording;
- no cross-survey or cross-organisation leakage;
- task-aware selection (theme, logic with dependencies, compact);
- workflow aggregate;
- the readiness report never leaks values.

`providerBilling.test.ts` was updated: the route's calls go through `measured`, which is asserted to call `meteredAi`.

**Typechecks and checks:**

- runtime clean.
- Studio: clean in E1's files. The remaining errors are in E4's `components/analytics/AnalysisBuilder.tsx` (missing `hb`, `lca`, `sem`) and E2's `lib/artifacts/artifacts.test.ts`.
- `dependency-boundaries`: 0 violations.
- `gen-public-docs --check`: current (regenerated: `capabilities.md` gains the platform-services table).
- `auth-guard-audit`: 0 problems.

**Browser.** New: `scripts/context-summary-test.mjs` (Studio on :3000, `AI_API_URL=fake:`):

1. A brief becomes a plan and leaves a context (one model call).
2. Four staged items, each far smaller than the brief, with the context cached and the quota passage verbatim; workflow totals completed.
3. After a reload the context persists and the applied design is adopted.
4. A changed hypothesis makes it invalidated (not sent), then it is regenerated as v + 1.
5. An unready capability is refused, naming its variables, and `/platform` shows it not ready. If everything is configured on the server, this scenario says so and defers to the unit tests.

The orchestrator should run it with the regression set:

- `intelligent-engine-test`
- `copilot-test`
- `copilot-errors-test`
- `phase2-nl-test`
- `methods-intelligent-test`
- `research-intelligence-test`
- `project-platform-test`, because `/platform` changed

## 6. Limits

- **Output is not reduced.** Output is the larger share of a generation's charge. The fake cannot measure it.
- **The guides dominate an item call** (about 43k characters, cached). Selecting guides per item would cut more, but each distinct set is a new cache write. Not done and not measured.
- **The plan call still reads the whole brief.** It must.
- **Context size.** The context is 45 % of this brief. Budgets favour exactness over size. A brief without headings is one section: its context is thinner and retrieval works on paragraphs.
- **Heading detection is heuristic** (numbered headings, or short lines between blank lines). An instruction line can occasionally be taken for a heading; that is harmless (it becomes a retrievable section).
- **Readiness reads presence, not reachability.** A wrong key is "ready" until `/api/ai/health` POST probes it.
- **Overrides.** Readiness overrides come only from the copilot's own language model. A user's own speech-to-text connection does not mark speech-to-text ready for the refusal.
- **Without 0067**, the context lives in the memory of one server instance. On serverless, a stage served by another instance re-derives it (deterministically), and workflow totals may then be split.

## 7. Files

**Engine:**

- `src/capabilities.ts`: the shape, `SERVICES`, `PLATFORM_CAPABILITIES`, `EXTRA_CAPABILITIES`, normalisation, readiness, refusal, availability, brief and markdown;
- `src/researchValidation.ts`: only partial / not supported are flagged;
- `src/capabilitiesReadiness.test.ts`.

**ai:**

- `src/usage.ts` (`latencyMs`, summed);
- `src/index.ts` (per-request latency);
- `src/usageMeasure.test.ts`.

**Studio:**

- `lib/copilot/researchContext.ts` (+ test);
- `lib/copilot/researchContextStore.ts`;
- `lib/copilot/prompt.ts`: options `researchContext`, `briefRef`, `briefPassages`, `availability`;
- `lib/copilot/outline.ts`: `questionnaire` scope, `withDependencies`;
- `lib/aiPromptCache.ts`: extra cached blocks;
- `lib/meterRun.ts`, `lib/metering.ts`, `lib/aiEstimate.ts`: latency and `meta`;
- `lib/capabilityStatus.ts`;
- `app/api/copilot/turn/route.ts`;
- `app/api/copilot/context/route.ts` (new);
- `app/api/platform/route.ts`;
- `app/platform/page.tsx`;
- `lib/providerBilling.test.ts`;
- `content/docs/capabilities.md` (generated).

**Database:** `supabase/migrations/0067_copilot_research_context.sql`.

**Scripts:** `scripts/ai-context-benchmark.mjs`, `scripts/context-summary-test.mjs`.

**Docs:** this file, `docs/ENVIRONMENT-CHECKLIST-2026-10-18.md`.

## 8. Deploy

1. Deploy the code. No environment variable is needed.
2. Apply **0067** (re-runnable) when convenient. Until then the context is kept in memory, and `/platform` lists 0067 as not applied.
3. Live check:
   1. Paste a long brief, plan it and build it.
   2. The usage events of the build share one `metadata.workflowId`.
   3. Item events show `promptChars` well below the brief's length.
   4. `GET /api/copilot/context?surveyId=…` returns `context.status: fresh`.
   5. `/platform` lists the services, with variable names only.
