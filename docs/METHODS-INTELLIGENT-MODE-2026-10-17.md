# Intelligent Mode × research methods: MaxDiff, conjoint, LEAST List Fill (2026-10-17)

Engineer I. Priority 5: Intelligent Mode treats MaxDiff, conjoint (CBC, menu-based, ACBC) and List Fill / LEAST as
structured research designs, not as question text. Read first: `MAXDIFF-AUDIT-2026-10-17.md`,
`CONJOINT-AUDIT-2026-10-17.md`, `LIST-FILL-LEAST-AUDIT-2026-10-17.md`, `P0-2-INTELLIGENT-MODE-SCRIPTS-AND-LIST-FILL-2026-10-16.md`.
Every number below came from running the code.

## 1. Gaps found (before this change)

| # | Gap | Evidence |
|---|---|---|
| G1 | No design action. The copilot's only route to a MaxDiff/CBC was `create_question type:"maxdiff"/"cbc"`. That made a `maxdiff_task`/`conjoint_task` question with **no design**, so the quality check said "no design is selected" and the respondent saw nothing. | `ACTION_TYPES` maxdiff/cbc/acbc → variants; no op wrote `def.designs[]` |
| G2 | Nothing configured, validated, generated or attached a design except the Studio's Design Generators panel. | `DesignsPanel.tsx` `generate`/`attach` |
| G3 | The engine cannot import `@rescript/designs` because designs depends on the engine (rule R3). | `scripts/dependency-boundaries.mjs`, both `package.json` files |
| G4 | No guide. The model had no way to know items/attributes are essentials to ask for, what to infer, or what is unsupported. Nothing stopped a matrix being used for a MaxDiff. | `prompt.ts` |
| G5 | The outline did not show design questions' settings, so "make it 5 items per task" had nothing to patch. | `outline.ts` |
| G6 | The engine grammar read "add a None option to the conjoint" as an option for a question named "the conjoint" and **refused it** without asking the model. | `interpretRequest` probe |
| G7 | List Fill actions could not set least fill's `basis` (allocated or completed), `tieBreak`, or `selection.onChange`. "Least fill counted on completes" was not expressible. The guide still described least fill as "needs sample counts" only. | `listFillActions.ts` line 653 hard-coded `basis` |
| G8 | The open proposal panel showed only diff lines ("Add design …"), never a design's measured diagnostics. | `CopilotPanel.tsx` |

## 2. Actions (engine `packages/engine/src/methodActions.ts`, gated like `listFillActions.ts`)

Ops: `create_maxdiff`, `update_maxdiff`, `create_conjoint`, `update_conjoint`. The full shapes are in
`apps/studio/content/docs/actions-reference.md` (regenerated) under "Research method actions".

- **Generators through the registry.** The engine calls `designGeneratorRegistry.get(kind)` from `@rescript/schema`. This is the same registry the panel uses, and it is filled by `registerBuiltinDesignGenerators()`. The copilot route and the browser replay (`lib/copilot/client.ts`) both register the generators. If they are not loaded, the action is refused in words and nothing changes. The boundaries audit stays clean: 0 violations.
- **Create:**
  1. Resolve the items: given directly, or `itemsFrom` a question's options or a grid's rows, with None and Other left out.
  2. Resolve the attributes, levels and prohibitions to their canonical spellings (case-insensitive).
  3. Infer the sizes that were not stated:
     - MaxDiff: 3–5 items per task (about a third of the list), enough tasks for about 3 shows per item, 10 versions, `optimized`.
     - CBC: 3 alternatives, `max(12, ceil(params/(alts−1)))` tasks, 10 versions, `efficient`.
     - Menu: 8 tasks, 10 versions.
  4. Run the generator's own `validateConfig`, which gives the panel's refusals word for word. Then generate once from `(config, seed)`.
  5. Pin the design in `def.designs[]` and create the question with the right variant (`maxdiff.best_worst`, `conjoint.cbc`, `conjoint.menu`, `conjoint.pricing_configurator` or `conjoint.acbc`). The question gets its own page and is required. Point `settings.designRef` at the design.
  6. Describe the result: the measured diagnostics, what was assumed, and the data columns.
- **Seed.** The seed is the action's `seed` if given, otherwise the stored seed on an update, otherwise `hashString(kind + generation config) % 100000`. The server preview and the Apply replay therefore produce identical rows. This is tested on every path.
- **Update** is a patch:
  - Only the named fields change. `addItems`, `removeItems`, `addProhibitedPairs`, `removeProhibitedPairs`, `addAttributes`, `removeAttributes`, `levels{}`, `addProhibitions` and `removeProhibitions` cover list edits.
  - The design is regenerated in place (same id, version +1) only when a generation key changes. Labels, instructions and the None text are read at render time and do not trigger regeneration.
  - Question text and logic are untouched. Sizes are never re-inferred, and a design made in the panel is never given settings it did not have.
  - A prohibited pair or prohibition that names a removed item or level is dropped, and the description says so.
  - Regenerating on a `live` or `closed` survey is flagged destructive and comes with a warning.
- **Refused, with the reason and the alternative (no silent substitution):**
  - rating-based, ranking-based, CVA and ACA conjoint
  - labelled (alternative-specific) designs
  - dual-response None
  - numeric/linear attributes
  - level images
  - HB, latent-class or individual-level estimation
  - worst-only MaxDiff
  - CBC fields on ACBC or menu designs, and the reverse
  - changing the method of an existing design
  - `create_question` or `update_question` to a MaxDiff/conjoint type (the refusal names `create_maxdiff` / `create_conjoint`)
  - a missing item list or missing attributes (the refusal says "ask the researcher … rather than inventing")
- **Wired** into `coerceSurveyActions`, `applySurveyActions` (the question is made through `create_question`'s own maker), `describeAction` and `diffSurveys` ("Add design …", "Regenerate design … (vN)").
- **Grammar hand-off** (G6): `interpretRequest` hands a request that *configures* a MaxDiff or conjoint to the model. Questions about the method ("why maxdiff scores?") stay with the grammar.
- **List Fill** (G7): `basis` (auto, allocated or completed; aliases include completes and starts), `tieBreak` (random, sequential or priority) and `onChange` (keep_valid, redecide or freeze). A least-fill setting on another method is refused with the reason. The description names the basis ("fewest completed interviews") and the on-change rule.

## 3. Guide (`apps/studio/lib/copilot/methodsGuide.ts`, 4,380 characters)

- **When it is sent.** `methodsIntent` sends the guide only when the request names one of these methods, in English, Hinglish or Devanagari: MaxDiff, best–worst, conjoint, CBC, ACBC, choice tasks, discrete choice, menu-based, build-your-own, pricing configurator, part-worths, or "attributes and levels".
- **Caching.** The guide is in `COPILOT_STABLE_GUIDES`, so it sits in the cached system prefix like the List Fill and UX guides.
- **System prompt.** Unchanged at 14,793 characters (cap 14,800).
- **What it teaches:**
  - how to identify the method
  - NEVER SUBSTITUTE
  - the not-available list
  - ASK vs INFER
  - what the engine does
  - the `Designs:` outline line and patching through `update_*`
  - six worked action lines (each is valid JSON, and the engine applies it in a test)
  - two `clarify` examples
- **Repair.** `repairPrompt` adds this guide when a refusal names `create_maxdiff`/`create_conjoint` and the guide was not sent.
- **Least fill** stays in the List Fill guide, which `listFillIntent` already selects. That guide now teaches least fill (no target, never random or balanced instead, `basis`, `tieBreak`), `onChange`, and an example of "least fill counted on completes" that keeps every other setting.
- **Outline.** Every turn now carries a `Designs:` line. The List Fill line shows least fill's basis and tie rule.
- **Panel.** A "Research design — measured on the generated tasks" block (`cp-designs`) lists the engine's description of each method action before Apply.

## 4. Ask vs infer

| Must ASK (`kind:"clarify"`, no actions) | May INFER (engine; reported under "Assumed (not stated)") |
|---|---|
| MaxDiff items, unless they are named or a survey question lists them (then use `itemsFrom`) | items per task, tasks, versions, algorithm (`optimized`) |
| conjoint attribute names and their levels ("four attributes × three levels" is only a size) | alternatives (3), tasks (12+ and identifiable), versions (10), design (`efficient`) |
| menu items and their price points | menu tasks (8), versions (10) |
| anything the request leaves ambiguous about the method itself (offer the supported alternative) | question text (a neutral default per method), own page, required |

## 5. Tested example configurations (real generators, `packages/designs/src/methodActions.test.ts`)

| Request (as the guide answers it) | Measured description (engine, verbatim excerpt) | ms |
|---|---|---|
| MaxDiff, 12 features, sizes not given | 12 items, 4 per task, 9 tasks, 10 versions; each respondent sees every item 3 times; within a version every pair shares a task 0–1 times; across the 10 versions 7–9 times (near-balanced). Assumed: 4 per task, 9 tasks, 10 versions | 191 |
| "make it 5 items per task" | items per task 4 → 5 — regenerated (v2): each respondent sees every item 3–4 times; pairs 0–3 per version, 13–15 across (near-balanced). Everything else unchanged | 148 |
| prohibit Battery life + Price | 1 prohibited pair never shown together (checked on the rows); pairs 7–10 across (uneven) + the generator's warning | 180 |
| CBC, 4 attributes × 3 levels | 3 alternatives, 12 tasks, 10 versions, efficient; D-efficiency 99% per version (worst 98.6%), 99.9% pooled; each level 120 times; overlap 0%; 0 duplicate concepts | 271 |
| "add a None option" | None option not set → on; 3 alternatives + None; same efficiency; 120 None rows | 120 |
| + prohibit Gamma at $199 | D-efficiency 95.3% (worst 94%), 96.2% pooled; prohibitions leave 72 of 81 concepts (88.9%); Brand × Price two-way warning | 643 |
| ACBC, the same attributes | 81 possible concepts; BYO → 6 screens × 4 → rules → tournament in 3s; adaptive, no estimator (transcripts exported) | — |
| MaxDiff 20 items, 3 tasks × 5 | **refused**: "3 tasks of 5 items cannot show all 20 items even once. Use at least 4 tasks per version." (the panel's own text) | — |
| CBC 2×2 levels, 5 alternatives | **refused**: "These attributes make only 4 different concepts, and each task needs 5 …" | — |
| rating-based conjoint | **refused at the gate**: "rating-based (ratings) conjoint is not implemented. Rescript runs choice-based (cbc), menu-based (menu) and adaptive (acbc) …" | — |
| LEAST List Fill, counted on completes | `least_filled`, `leastFilled {basis: completed}`; items, caps, priority and destinations untouched | — |

The design attached by the copilot is byte-identical to `plugin.generate(config, seed)`, which is what the panel would make. A respondent's answers validate against their own version (a missing task and best = worst are both refused). They flatten to `<VAR>_VERSION`, `_T<n>_BEST/_WORST/_ORDER` and `<VAR>_T<n>`, and the stacked CBC file has one chosen concept per task.

## 6. Tests

- Engine `methodActions.test.ts` (18 tests, stand-in generators):
  - the gate refusals and the not-loaded refusal
  - create (attached, pinned, defaults said), the inferred sizes, deterministic replay, `itemsFrom`
  - patch-only update and no regeneration for a label
  - prohibited pairs: add, remove, dropped with a removed item
  - an infeasible design refused with the generator's words
  - `create_question`/`update_question` refusals and the live-survey flag
  - CBC create and update, ACBC and menu fields
  - least fill `basis`/`tieBreak`/`onChange`
  - the grammar hand-off; an update never adds settings
- Designs `methodActions.test.ts` (9 tests, real generators): the configurations in §5, identical to the panel's output; respondent data, validation and the stacked file.
- Studio `lib/copilot/methodsGuide.test.ts` (6 tests):
  - the brief's three requests pick their guides (plus yes/no word lists)
  - sizes and the cached prefix
  - every worked example passes the gate and applies (with diagnostics)
  - the List Fill least-fill example applies and keeps every other setting
  - repair adds the guide
  - the outline `Designs:` line, and the browser replay generates the identical design
- Also updated: `copilot.test.ts` (every advertised op is documented, now including this guide) and `aiPromptCache.test.ts` (the guide is lifted verbatim).
- Browser suite (written, **not run here**): `scripts/methods-intelligent-test.mjs`, covering:
  - Studio:
    - MaxDiff with no list → a question back
    - features given → proposal with diagnostics → Apply → identical design
    - "Make it 5 items per task" → only that changes
    - CBC with no attributes → a question back; attributes given → applied
    - "Add a None option" → only that changes
    - an infeasible MaxDiff → refused with the reason, nothing applied
    - a rating-based conjoint → refused at the gate
    - LEAST List Fill → `least_filled` on completes, the rest untouched
  - Runtime: least fill picks the brand with the fewest completes; the MaxDiff shows the version's 9 × 5 tasks in seeded order and records best/worst; the CBC shows 12 × (3 + None) with the design's levels and records design alternatives; the flattened columns are correct.

Counts: engine 2,052 (was 2,034); designs 98 (was 89); Studio lib 583 (was 577). Type checks pass for Studio, runtime, engine, designs, renderer, analytics, exporters, templates, import and quality. `audit:code` is clean. Public docs were regenerated and are current.

**The orchestrator must run** (Studio on :3000 with `AI_API_URL=fake:`, runtime on :3001): `node scripts/methods-intelligent-test.mjs`, plus the regressions `listfill-intelligent-test.mjs`, `copilot-test.mjs`, `intelligent-mode-test.mjs` and `ux-copilot-test.mjs`. `maxdiff-p1-test.mjs`, `conjoint-p2-test.mjs` and `listfill-least-test.mjs` are worth running too.

## 7. Limitations

- **ACBC** is configured and attached, and the runtime runs it adaptively. There is no ACBC estimator, and the description says so. **Menu-based** analysis is take-rate counts only.
- **Version assignment** is still a hash of the seed, not least-filled, as in both audits. If a researcher asks for balanced version assignment, the guide tells the model to say it is not available.
- **Generation runs synchronously in the browser's replay.** `evaluateProposal` runs twice per render of an open proposal. Typical designs take 0.1–0.7 s. Very large configurations (for example MaxDiff with 300 versions, or efficient CBC above about 40 versions) take seconds.
- **Some unsupported requests are only refused at the gate.** If the model writes the action anyway, the card shows the reason, but no repair call is made. The guide tells the model to explain and not propose. The one repair call does not cover gate rejections; this is unchanged platform behaviour.
- **Live-survey warning only.** On a live or closed survey, a regeneration is flagged destructive and warned about, not refused. The codebase has no per-design version cut. Old answers stay tied to the previous design only through the per-response definition versions.
- **Fixed-wording MaxDiff warning.** With prohibited pairs, the designs package's pair warning can still say "Use the optimized algorithm" when the design is already optimized. This wording belongs to the MaxDiff P1 generator and was not changed here.
- **The copilot does not edit attribute types, images or descriptions, fixed attributes, or the conjoint holdout layout.** These are refused, or absent from the generators (see the conjoint audit §7).
