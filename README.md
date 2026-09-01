# Rescript — Survey Programming & Runtime Platform

A professional, JSON-driven survey programming environment for research programmers —
not a drag-and-drop form builder. Anything a survey programmer can normally program
manually should be possible through this platform.

```
Create Project → Program Questions → Variables → Logic → Piping → Calculations
→ Survey Flow → Quotas → Custom JS → Conjoint/MaxDiff/Custom Designs → Branding
→ Save Version → Test (inspector) → Export JSON / Variable Excel → Deploy (Vercel)
→ Collect Responses (Supabase) → Export Data
```

## Architecture

pnpm monorepo — the survey **definition** (one JSON document) is the product;
the runtime merely interprets it.

| Package / app | What it is |
| --- | --- |
| `packages/schema` | The survey definition model: Zod schemas + TypeScript types for questions (30+ built-in types incl. multi-column composites), options, condition trees, flow nodes, quotas, calculations, scripts, branding, design references, deployment config. Plugin registries (question types, design generators, exporters). |
| `packages/engine` | Pure-TS engine used by both apps: condition evaluator (nested AND/OR/NOT, 16 operators), flow interpreter (pages, sections, blocks, randomizers, branches, loops, quota checks, redirects, ends), piping resolver, carry-forward/dynamic options, calculation DSL (parser — no `eval`), validation, seeded randomization, variable-dictionary generator, quota evaluator, sandboxed script host, inspector snapshots. 11-test suite. |
| `packages/designs` | Research Design Generators: Conjoint (balanced overlap), MaxDiff (balanced incomplete blocks), generic custom generator. Deterministic by (config, seed); versioned; CSV export; pluggable registry for TURF/pricing/etc. 12-test suite. |
| `packages/exporters` | Variable Dictionary → styled `.xlsx` (exceljs), survey JSON export/import (validated), responses → CSV. 7-test suite. |
| `apps/studio` | The programming IDE (Next.js, port 3000): question editor incl. composite multi-column builder, visual condition builder, survey-flow tree editor, logic-flow view, variable dictionary, calculations, quota manager + live dashboard, design generator UIs, branding/theming with 4 presets, script editor, version manager with diff/restore/deploy, first-class JSON view. |
| `apps/runtime` | The respondent app (Next.js, port 3001): renders any definition, `/s/<client>/<study>` live, `/t/<client>/<study>` test with the programmer inspector (current page/question, answers, flat variables, calculated values, triggered display-logic traces, quota bars, script log), `/preview` instant in-memory preview from the Studio. Fully themable per customer via branding config. |
| `supabase/` | SQL migrations: customers, profiles+roles, surveys, immutable version snapshots, deployments (URL pinned to a version), themes, templates, design files, respondents, responses, quota counts (atomic RPC), audit logs — with tenant-isolating RLS. |

## Quick start (local)

```bash
pnpm install
pnpm -r --filter './packages/*' build
cp .env.example apps/studio/.env.local
cp .env.example apps/runtime/.env.local
#  → fill SUPABASE_SERVICE_ROLE_KEY (Dashboard → Settings → API keys → service_role)

pnpm dev:runtime   # http://localhost:3001
pnpm dev:studio    # http://localhost:3000
```

The database is already migrated and seeded with **Smartphone Brand Study (Demo)**
(`DEMO_BRAND_01`), which exercises carry-forward, piping, a 4-column composite grid,
branching, skip logic, quotas, calculations, a custom script, and a MaxDiff design.
Test it at `http://localhost:3001/t/demo/brand-study` (inspector on) or take it live
at `/s/demo/brand-study?SOURCE=email`.

```bash
pnpm test                    # package test suites
node scripts/e2e-smoke.mjs   # scripted respondent end-to-end
```

## Key concepts

**JSON first (§11, §31).** A survey is one `SurveyDefinition` document — complete
enough to reconstruct the survey. The JSON tab in the Studio is an editor, not just
an export. Import/export round-trips through Zod validation.

**Versions are immutable (§12).** Every save writes a new `survey_versions` row.
A deployment pins `client/study/mode → version_id`; editing after deploying never
changes a live survey until you redeploy.

**Conditions are universal (§6).** One condition-tree model drives display logic,
skip logic, branches, option/row/column visibility, quota cells, calculation guards
and carry-forward filters — arbitrary nesting of AND/OR/NOT over eq/ne/gt/lt/gte/lte/
between/in/notIn/contains/selected/answered/matches….

**Carry-forward is a primitive (§4).** Any question (or individual composite column)
can source its options/rows from another question's selected / not-selected /
displayed answers, with an optional per-option filter condition — works into
matrices, grids and loops.

**Options are programmable individually.** Every option can carry its own
visibility (always show / always hide / show when / hide when), eligibility,
exclusion, prioritisation, randomisation pinning and carry forward / back — and
a question's whole option list can be built with set operations (intersection,
union, difference, remaining, dedupe, filter, sort, randomize) across any number
of earlier questions. One deterministic pipeline produces the result, with a
debugger that says why each option appeared or disappeared.
See [docs/OPTION-LOGIC.md](docs/OPTION-LOGIC.md).

**Composite questions (§3).** One question, many columns; every column has its own
response type, variable stem, codes, validation, visibility, width, read-only state
or calc expression. Variables export as `STEM_<row>` (and `STEM_<row>_<code>` for
multi columns).

**Calc DSL (§13–14), not raw eval.** `Q1 + Q2 + Q3`, `sum(ALLOC_*)`,
`countif(RATING_*, '>', 3)`, `pct(SCORE, 200)`, `if(TOTAL > 100, 'high', 'low')`,
`weighted(Q1,0.5,Q2,0.3)` — parsed and interpreted, wildcards over the flat
variable map. Custom scripts run in a controlled host with an explicit API
(`get/set/getCalc/setCalc/expr/pipe/flag/log/error/loop`).

**Variables are generated, never hand-maintained (§9–10).** The dictionary is derived
from the instrument on every save and stored in the version snapshot; the one-click
Excel export reflects the exact programmed state.

**Extensibility (§30).** `questionTypeRegistry.register(...)` adds a question type to
the editor and the dictionary; `designGeneratorRegistry.register(...)` adds a design
methodology to the Studio UI. The runtime renders unknown types via the
custom-component pathway.

## Deployment on Vercel (§21)

Two Vercel projects from this repo:

| Project | Root directory | Env vars |
| --- | --- | --- |
| `rescript-studio` | `apps/studio` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_RUNTIME_URL=https://<runtime-domain>` |
| `rescript-runtime` | `apps/runtime` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |

Vercel auto-detects Next.js; pnpm workspaces build the shared packages via
`transpilePackages`. Point `survey.yourdomain.com` at the runtime project — URLs are
`https://survey.yourdomain.com/s/<client>/<study>`. Customer-specific domains map to
the same runtime without code changes (add the domain in Vercel; deployments are
resolved by slug).

## Security model (§27)

- The Supabase **service-role key is server-only** (API routes / server components);
  the browser never receives a database credential.
- RLS isolates tenants: every business table is scoped to a customer via `profiles`;
  respondents/responses have **no** anon policies — writes go through server routes.
- Respondent sessions are 128-bit unguessable tokens; a finalized session refuses
  further writes. Unique-link surveys validate per-respondent tokens server-side.
- Quota increments are an atomic SQL RPC. Audit log rows record survey/version/deploy actions.
- ⚠️ MVP note: the Studio itself does not yet enforce login — put it behind Vercel
  protection / SSO, and wire Supabase Auth into `profiles` (schema + roles are ready)
  before multi-tenant production use.

## Repository layout

```
apps/studio        # programming IDE
apps/runtime       # respondent runtime + inspector
packages/schema    # survey definition (Zod) + registries
packages/engine    # logic/flow/piping/calc/validation/quota engine
packages/designs   # conjoint / maxdiff / custom design generators
packages/exporters # xlsx / json / csv
supabase/          # migrations (applied to the linked project)
scripts/           # demo survey builder + e2e smoke test
docs/              # subsystem references (option logic, list ops, piping)
```
