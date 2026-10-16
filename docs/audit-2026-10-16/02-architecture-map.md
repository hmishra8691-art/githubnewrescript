# 02 · Architecture map

Full inventory with LOC, test counts, exports, dependents, every table/RLS policy/RPC, and the Intelligent-Mode file map: **`raw/architecture.md`** (188 lines, evidence-grade). This page is the orientation layer.

## Shape
pnpm monorepo, Node ≥ 20, Next.js 14. The product is one JSON document — `SurveyDefinition` (`packages/schema`, Zod) — and everything else interprets it.

```
                       control plane (authoring)                     data plane (respondents)
┌────────────────────────────────────────────────┐   ┌─────────────────────────────────────────┐
│ apps/studio :3000  (93k LOC, 127 API routes)   │   │ apps/runtime :3001 (5.4k LOC, 14 routes)│
│  store.tsx ─ draft autosave ─ versions ─ deploy│   │  /s /t /preview → Runner.tsx 1,885 LOC   │
│  Intelligent Mode: lib/copilot, architect,     │   │  session/start, session/save, media, ai  │
│  builder → engine actions                      │   │                                          │
│  analytics router → lib/analytics → cache      │   │ apps/interviews :3002 (video product)    │
└───────────────┬────────────────────────────────┘   └───────────────┬─────────────────────────┘
                │                                                      │
        ┌───────▼───────────── packages ───────────────────────────────▼────────┐
        │ schema ← engine ← { renderer(React, 0 tests, source-shipped), analytics │
        │ (17k, 465 tests), designs, exporters, import, quality, ai, templates,   │
        │ interviews }    storage ← { media, interviews, renderer }   access, mail│
        └──────────────────────────────┬───────────────────────────────────────┘
                                       │ service-role only (RLS on all 92 tables)
                     ┌─────────────────▼───────────────────┐
                     │ Supabase/Postgres, 54 migrations     │
                     │ surveys(draft_definition, revision)  │
                     │ survey_versions (immutable)          │
                     │ deployments(client,study,mode→ver)   │
                     │ respondents, responses(answers jsonb,│
                     │   quality, review_*, deleted_*)      │
                     │ quota_counts, listfill_*             │
                     │ analytics_* (runs, cache, plan, story)│
                     └──────────────────────────────────────┘
```

## End-to-end flow (one hop per line; file:line in raw §4)
1. Editor state `store.tsx` → `PUT /api/surveys/[id]/draft` → `rescript_save_draft` (revision CAS) → `surveys.draft_definition`.
2. `POST …/versions` → Zod parse → `buildVariableDictionary` → `publishGate` (lint as gate) → insert `survey_versions` → `rescript_finalize_version` (repoint `current_version_id`, clear draft). Not atomic across the two steps (ARCH-13).
3. `POST …/deploy` → `deployments(client_slug, study_slug, mode) → version_id`.
4. Runtime page → `loadDeployment` → frozen version definition → `<Runner>` (engine `advance`, `validatePage`, `resumeStep`; renderer `QuestionRenderer`, `UxLayer`).
5. `POST /api/session/start` → `responses` row (token/unique-link handling). `POST /api/session/save` every page → verbatim write (**RUNTIME-01**); on completion `increment_quota_counts` RPC, List Fill confirm, quality assessment (if enabled), billing meter.
6. Analytics: router → `lib/analytics.ts` (`loadRows` chunked, `buildDataset`, `compute`) → `analytics_result_cache` keyed by input hash (count + newest `updated_at`, version, engine, definition hash).
7. Exports: `GET …/responses?format=` → `@rescript/exporters`; questionnaire .docx; analytics pptx/xlsx/docx; story pptx/mp4.

## Intelligent Mode pipeline (raw §5)
`IntelligentView` → `useCopilot` → `POST /api/copilot/turn` → `lib/copilot/prompt.ts` (system prompt, 14.8k chars cap) + outline → `@rescript/ai completeJson` (retries, json mode, usage) → reply schema → `coerceSurveyActions` (70 ops) → `applySurveyActions` on a clone → re-parse → proposal card → Apply → store `replace` → `withOptionCodes` + legacy migrations → draft save. Plan-first generation checkpoints per item (`resume.ts`). Research state lives in `def.research` (brief, hypotheses, constructs, KPIs, analysisPlan) and `question.analysis` tags.

## Dependency rules — what is actually enforced
- pnpm resolution and `tsc` only. No ESLint, no import-boundary lint, no ADRs (ARCH-03). Documented "engine is env-free" rule has one leak.
- Layering observed from imports: no package imports an app; no cycles; `renderer` is consumed from source via `transpilePackages`; `analytics` ships a test fixture that imports a devDependency (ARCH-06).
- Auth: static `scripts/auth-guard-audit.mjs` covers Studio routes only (ARCH-05/SCHEMA-10). All DB access is service-role; RLS is defence in depth.
- Three copies of `lib/admin.ts`/`supabaseFetch.ts`/`mediaRoute.ts` across apps have diverged (ARCH-04).

## Test infrastructure (raw §6)
Unit: `node --test dist/*.test.js` per package (tests `dist`, not `src` — ARCH-11); Studio `lib/**/*.test.ts` via `--experimental-strip-types`. Browser: 148 Playwright suites in `scripts/*-test.mjs`, run by `scripts/verify-browser.mjs` (serial by default; 4 declared "needs Postgres"); the harness imports Playwright from an absolute machine path (ARCH-10). Fixtures: `packages/import/fixtures`, `packages/templates` master demo, `packages/analytics/src/analyses/fixture.ts`. No DB-backed CI.

## Technical risks (evidenced, raw §7)
Renderer and both non-Studio apps have zero tests; four files over 2,800 LOC; 15 GB of stale `.next-*` directories inside `tsconfig.include`; duplicated concepts in TS and SQL (question count, two quota loops); methodology support hand-threaded through ~12 touch points (see `05-methodology-matrix.md`).
