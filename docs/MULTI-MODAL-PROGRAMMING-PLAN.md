# Multi-Modal Survey Programming — audit and build plan

*Audit date: 2026-09-24.*

**Status — Phase 0 delivered 2026-09-24** as two commits, "Multi-modal
foundation (1/2)" (engine) and "(2/2)" (Studio). Everything in Part C's
Phase 0 exists; the mode selector shows all five environments with only
Studio enabled.

**Phase 1 (Grid) delivered 2026-09-24** — `apps/studio/components/grid/`,
`apps/studio/lib/grid/model.ts`, `scripts/grid-mode-test.mjs`. In Grid mode
the Questions tab renders the grid; every other tab is unchanged. Measured at
600 questions: 32 rows in the DOM, 413 ms to first paint, ~28 ms per long
scroll step, 17 keystrokes in a cell in 273 ms. Two shell fixes came with
it: RightPanel's click-outside deselect now exempts the grid, and the grid
toolbar never wraps (it moved rows under the cursor mid double-click).
**Phase 2 (Architect) delivered 2026-09-24** — `apps/studio/components/
architect/`, `apps/studio/lib/architect/map.ts`, `scripts/architect-mode-
test.mjs`. Map · workspace · inspector; the inspector's Dependencies section
is §12's Smart Selection; Focus (§14) shipped here as a mode-level flag.
DisplayRuleCard / CalculationCard were extracted from the Logic and
Calculations tabs so both surfaces render one component.

**Phase 3 (Flow) delivered 2026-09-24** — `apps/studio/components/flow/`,
`apps/studio/lib/flow/{layout,debug}.ts`, `scripts/flow-mode-test.mjs`.
`LogicFlowEdge.kind` added to the schema and set by `buildLogicFlow`. Layout
is hand-rolled (4 ms at 600 questions); debug mode walks the survey with
`simulateRespondent`, so skips fire. Phases 4–5 are not started.

Three things learned while building Phase 0 that the plan did not know:

- `lintSurveyLogic` was cubic in question count (5.5 s at 1 000 questions);
  fixed to linear (84 ms). The lint is affordable per keystroke now, so
  status badges can refresh on every edit without a worker.
- The store's clone-per-edit costs 15 ms at 1 000 questions. **No selector
  store is needed for Phase 1** (Part D, risk 2, resolved).
- `PropertiesPanel` violated the Rules of Hooks on every selection change
  (two hooks after early returns) — fixed; the Architect inspector will
  switch object kinds constantly and would have hit it hard.

**One Survey. One Source of Truth. Unlimited Ways to Program It.**

The brief asks for five programming environments (Studio, Grid, Architect,
Flow, Intelligent) over one schema, one engine, one runtime. §19 says inspect
first. This is that inspection, followed by the plan it implies.

---

## Part A — What exists (the §19 audit)

### A1. Survey schema — one, already

`packages/schema/src/survey.ts` `SurveyDefinition`. Conditions are a tree, never
a string: `Condition = ConditionRule | ConditionGroup{op: and|or|not, children}`
(`conditions.ts`). A multi-child `not` is NOR. Display rules, skip rules, flow
branches, loop conditions, masks, punches, validation and quotas all hold the
same `Condition` type. **Every mode edits this one tree.** Nothing needs
converting between modes because there is nothing to convert.

### A2. State management — one store, one write path

`apps/studio/components/studio/store.tsx` (744 lines). React Context around
`useState<SurveyDefinition>`. All writes go through `update(mutator)`:
`structuredClone` → mutate → `normaliseQuestionOrder` → undo stack (50 whole-
definition snapshots) → `setDef` → debounced autosave (900 ms, `baseRevision`,
409 on conflict). `readOnly` is enforced inside `update`. Selection is a
single `selectedQuestionId`.

This is already the "Shared State" layer of the brief's diagram. Any new mode
that calls `s.update` is automatically undoable, autosaved, conflict-guarded
and read-only-aware. **No new store is needed.**

Two weaknesses for five renderers: (1) one Context → every consumer re-renders
on every keystroke; (2) `structuredClone` of a 1 000-question definition per
edit. Neither is a blocker today; both need a scale fixture to measure.

### A3. Logic engine — pure functions, well covered

`@rescript/engine`, 1 248 tests. Relevant exports:

| Need | Already exists |
|---|---|
| Evaluate a condition | `evaluate.ts` |
| English rendering | `conditionSummary(def, c)` in `logicSummary.ts` |
| Expression text ⇄ tree | `parseLogicExpression(def, src)` / `formatCondition(def, c)` in `logicExpression.ts` (1 240 lines, round-trips, never throws) |
| Edit a condition tree | `logicTree.ts`: `replaceAt`, `appendTo`, `groupSelection`, `setGroupConnector`, `validateLogicTree` … |
| Node/edge graph of the survey | `buildLogicFlow(def)` → `{nodes: LogicFlowNode[], edges: LogicFlowEdge[]}` with branches, randomizers, loop back-edges, skips, ends; `unreachableLogicNodes`; stored `x/y` in `def.logicFlow` |
| Question dependency graphs | `dependencies.ts`: `dependencyGraph` (forward), `dependentsGraph` (reverse), `dependentsOf` (transitive), `detectLogicCycles`, `blockDependencies`, `calculationGraph` |
| Who references question X (text evidence) | `referencesTo(def, id)` — id / code / variableName / `{{pipe}}` sweep |
| Variable lifecycle | `variableUsages`, `renameImpact`, `applyRename`, `renameVariable`, `usedNames`, `copyNames`, `buildVariableDictionary` |
| Lint | `lintSurveyLogic`, `lintStructure`, `lintLoops` → `LogicIssue{level, questionId?, path, message}`; `validateFlowStructure(flow)` → `{level, nodeId?, message}`; `runQualityCheck(def)` → areas |
| Flow tree ops | `flowTree.ts`: `moveFlowNode`, `insertFlowNode`, `removeFlowNode`, `canDropFlowNode`, `ancestorsOf`, `subtreeIds` |
| Explain visibility at runtime | `explainQuestionVisibility`, `traceCondition`, `inspect()` |

**Not in the engine:** add / duplicate / remove question (inline mutators in
`QuestionsPanel.tsx`), a typed dependency edge ("Q7 depends on Q3 *via display
rule R2*"), a whole-survey `variable → usedBy` index, a stable object key on
`LogicIssue` for non-question objects, auto-layout for the graph.

**Bug found:** `conditionSummary` renders a multi-child NOT as `not (A and B)`
(`logicSummary.ts:88`). The evaluator and `formatCondition` treat it as
`NOT (A OR B)`. The English says the opposite of what runs, and
`buildLogicFlow` uses that English for edge labels. Fix before any mode shows
it to a user as "what this logic does".

### A4. Runtime synchronization — already live

Delivered 2026-09-23 (`5316683`): an unpinned test link serves the autosaved
draft on every request; `/api/session/build-stamp` lets an open tab notice a
change. Nothing here needs to change for multi-modal — every mode writes the
same draft.

### A5. Variable / dependency architecture

Codes and variable names are one namespace (`getQuestionByCodeOrVar`).
Duplication now mints unique names (`fd80118`). `renameImpact` classifies each
usage as `auto | review | frozen`. The reverse index exists per question
(`dependentsGraph`) but carries no edge reason; the Studio uses it only in
delete-confirm dialogs. **There is no persistent "used by / affects" display
anywhere** — the brief's §12 Smart Selection is new UI over existing data.

### A6. Persistence

`PUT /api/surveys/:id/draft` validates against zod (422), guards with
`baseRevision` (409), runs `ensureElementIds`. No lint on draft write; the
publish gate lints at version-cut. Modes do not touch this.

### A7. Testing infrastructure

~2 450 unit tests via `node --test` on compiled `dist` (build first).
134 Playwright suites in `scripts/`, orchestrated by `verify-browser.mjs`
(~35 min serial). Fixtures: Master Demo (160 questions), five starters (6–7).
**No 500+ question fixture, no perf test.** §16 cannot be verified without one.

### A8. The Studio shell today

- `Studio.tsx` (1 137 lines): 24 tabs in four groups, exclusive; centre column
  is a `{tab === x && <Panel/>}` chain; `RightPanel` is `PropertiesPanel`,
  mounted always, CSS-hidden unless Questions + selection.
- `QuestionsPanel.tsx` (2 635): nested `.map`, no virtualization, no DnD, no
  multi-select; selected card expands into a 760-line inline `QuestionEditor`.
- `FlowPanel.tsx` (772) + `FlowDnd.tsx` (305): a **nested card outline** with
  hand-written pointer DnD; no edges drawn; skips invisible.
- `LogicPanel.tsx` (595): vertical page of sections; the decision graph is a
  `<pre>`.
- `PropertiesPanel.tsx` (1 382): 17 accordion sections for a question — this
  **is** the Architect inspector, minus dependencies and minus non-question
  objects.
- `CanvasContext.tsx` (80): `SelectedEntity` union (question, option, row,
  column, cell, scalepoint …), provided above the whole `.ide-body`. The right
  seed for unified selection; today scoped to one question.
- `design-system.css` (664): `--c-*` tokens, `.ide` / `.ide-body` 3-column
  grid, `--rightpanel-w: 440px`. Light only.
- Dependencies: **none** for UI — no cmdk, no virtualizer, no table, no graph,
  no DnD library. The codebase's habit is to hand-roll.
- No command palette, no hotkey registry (only ⌘Z), no focus mode, no split
  pane, no onboarding, no "mode" concept.

### A9. AI

`packages/ai`: one OpenAI-compatible client, `completeJson(system, user)`
(json_object, no schema), metering, `AI_API_URL=fake:` deterministic fake.
Nothing turns language into a survey, question or condition. The only
propose-then-approve pattern is `/api/ai/rephrase`. `ExpressionEditor.tsx` is
the closest to a review step: text → `parseLogicExpression` → errors shown →
apply writes the tree.

---

## Part B — Capability map: brief section → reuse / build

| § | Requirement | Reuse | Build |
|---|---|---|---|
| 1 | Mode selector | top bar in `Studio.tsx` | `mode` in store, selector, `?mode=`, per-user memory |
| 2 | Studio mode | everything current | presentation pass only |
| 3 | Grid | `questionLogicSummary`, `conditionSummary`, `renameVariable`, `migrateQuestionType`, lint | virtualized grid, inline edit, multi-select, bulk edit, columns, density, keyboard |
| 4 | Architect | `PropertiesPanel` sections, `QuestionEditor`, `ConditionEditor`, `FlowNodeEditors`, flow tree | 3-pane shell with resizable panes, survey map, inspector for non-question objects, Dependencies section |
| 5 | Flow | `buildLogicFlow`, `unreachableLogicNodes`, `def.logicFlow` x/y, `moveFlowNode`/`canDropFlowNode`, `traceCondition` | SVG canvas, pan/zoom, auto-layout, edge typing, reach/affect highlighting, node DnD, debug overlay |
| 6 | Intelligent | `completeJson`, `parseLogicExpression`, `formatCondition`, `conditionSummary`, `referenceTree`, `validateLogicTree` | logic prompt + context serializer, proposal type, review panel, pure `applyLogicProposal`, no-AI fallback grammar |
| 7 | One engine | already true | keep it true: every mode → `s.update` + engine pure fns; **zero mode-local logic** |
| 8 | Cross-mode sync | one store; every mode is a view of `def` | nothing — falls out of A2 |
| 9 | Instant switch | tabs already swap without reload | mode swaps the centre renderer only; selection/scroll survive |
| 10 | Onboarding | — | first-run chooser, dismissible, remembered |
| 11 | Visual language | `--c-*` tokens | a token extension + mode-shell styling (see B2) |
| 12 | ⌘K, quick actions, smart selection | `dependentsGraph`, `referencesTo`, `variableUsages` | command registry, palette, hover actions, `dependencyIndex` with typed edges |
| 13 | Status system | lint outputs | `objectStatus(def)` memoized, stable object keys, badge → open issue |
| 14 | Focus mode | `dependentsOf`, `ancestorsOf` | dim-everything-else overlay driven by the dependency index |
| 15 | Dual-mode split | — | two renderer slots in the centre column |
| 16 | Scale | — | 600-question fixture, perf harness, windowing, memoized lint/index |
| 17 | Responsive | `.ide-body` breakpoints | panel collapse rules per mode |
| 18 | Preserve everything | — | invariant: existing tabs, panels, test ids untouched; new modes are additive |
| 19 | Architecture | A1–A9 | Part C |
| 20 | Product experience | — | copy, onboarding, selector |

### B2. Why the "shared commands" layer is the linchpin

The brief's failure mode is `Mode A → separate logic`. The Studio is *almost*
safe from it: the store is shared. But every panel today writes its own inline
`update(d => …)` closure, so "add a question" exists three times already
(Questions panel, Live View element panel, block menu). Five modes would make
it fifteen.

The fix is a **command registry** — `{ id, title, shortcut?, when(ctx),
run(ctx) }` — that wraps each mutation once as an engine-pure function and
exposes it to every renderer, the ⌘K palette, hover quick-actions and keyboard
shortcuts. Modes then contain *no mutation code at all*; they only dispatch.
This is also what makes the Intelligent mode safe: a proposal is a list of
commands, reviewed, then dispatched.

---

## Part C — Phased plan

Each phase is independently shippable, additive, and leaves every existing
tab and test id untouched. Each ships with unit tests (mutation-checked) and a
Playwright suite.

### Phase 0 — Foundation (the shared layer; no new mode visible yet)

1. **`ProgrammingMode`** in the store: `studio | grid | architect | flow |
   intelligent`; `?mode=`; remembered per user; a selector in the top bar.
   Default `studio` → the Studio is pixel-identical to today.
2. **Unified selection**: extend `SelectedEntity` with `block | page |
   flowNode | displayRule | skipRule | calculation | quota | variable`; add
   multi-select; keep `selectedQuestionId` as a derived alias so all 17
   accordion sections and 134 browser suites keep working.
3. **Command registry** (`apps/studio/lib/commands/`): wrap existing
   mutators — add/duplicate/remove/move question, add block, page break, add
   display/skip rule, add randomizer/branch/loop, rename variable, set type,
   switch mode, save, test, preview, generate test data. Existing buttons
   unchanged; they gain `data-command` and later dispatch.
4. **⌘K palette + shortcut registry** reading the registry. Fuzzy search over
   commands, questions (code/variable/text), variables, rules.
5. **Engine additions** (pure, tested):
   - `dependencyIndex(def)` → typed edges `{from, to, kind, via}` over
     questions, display rules, skips, calculations, quotas, flow conditions,
     list fills, piping; `usedBy(key)`, `dependsOn(key)`, `reach(key)`,
     `affects(key)`.
   - `objectStatus(def)` → `Map<objectKey, {level, issues[]}>`; add optional
     `objectKey` to `LogicIssue`; stop `runQualityCheck` dropping
     `FlowStructureIssue.nodeId`.
   - Question ops moved from `QuestionsPanel` into engine: `addQuestion`,
     `duplicateQuestion`, `removeQuestion`, `moveQuestion` (the panel calls
     them — behaviour identical, now one implementation).
   - Fix the `conditionSummary` NOT bug.
6. **Scale fixture**: `buildScaleSurvey(n)` (600 default) with realistic
   logic density; a perf harness asserting `update` < 50 ms and index <
   100 ms at 600.

*Deliverable:* invisible to users except the mode selector (only Studio
enabled) and ⌘K. Everything after this is a renderer.

### Phase 1 — Grid

Hand-rolled windowed rows (the codebase has no UI deps; ~150 lines of
windowing is cheaper than a dependency review). Columns: status · ID · type ·
variable · question · options · display · skip · validation · deps · block /
page. Frozen status+ID; sticky header; column chooser; three densities.
Inline edit: text, variable (via `renameVariable` with the same impact
dialog), type (via `migrateQuestionType`), required. Row multi-select with
shift/⌘; bulk: set type, required, move to block, delete (with
`referencesToMany` preview). Search/filter/sort; ↑↓←→ Enter Esc Tab; hover
quick-actions from the registry. Selecting a row selects in the store, so
the inspector (Phase 2) and Flow (Phase 3) follow it.

### Phase 2 — Architect

Three resizable panes. Left: survey map — flow tree → blocks → pages →
questions, with status dots and dependency chips, keyboard navigable.
Centre: the existing `QuestionEditor` for a question; existing
`ConditionEditor`/`FlowNodeEditors` for a rule or flow node. Right: the
existing `PropertiesPanel` sections plus a new **Dependencies** section
(`USED BY / DEPENDS ON / AFFECTS`, clickable) and inspector views for rule,
flow node, calculation, quota, variable. Focus mode (§14) ships here: dim
everything not in `reach ∪ affects` of the selection.

### Phase 3 — Flow

SVG canvas over `buildLogicFlow`. Layered auto-layout (hand-rolled
longest-path layering + barycentre ordering, ~250 lines), positions persisted
to `def.logicFlow` when the user drags. Pan/zoom/minimap, search, collapse
blocks. Edge typing (`sequence | branch | otherwise | skip | loop | quota |
data`) with the dependency index drawn as a toggleable overlay. Select a node
→ "what can reach this" and "what this affects" highlighted. Drag a node into
a container → `canDropFlowNode`/`moveFlowNode`. Add branch/randomizer/loop
from the registry. Debug mode: type hypothetical answers (reuses the
`LogicTracePanel` machinery), taken path lights up.

### Phase 4 — Intelligent

`POST /api/ai/logic`: system prompt with a compact survey context
(`referenceTree` + codes, options, types), asks for **expression text**, not
JSON logic. The Studio parses it with `parseLogicExpression`; errors and
warnings are shown as-is; the proposal panel renders the structured tree,
`formatCondition`, `conditionSummary`, the target, and the commands it will
dispatch. `Cancel` / `Apply`; Apply dispatches through the registry (so it is
undoable and labelled "Applied proposal: …"). Never writes without Apply.
Without `AI_API_KEY`, a deterministic grammar handles the common shapes
("show X when Y is/selected/greater than …") so the mode still works. Also
covers: add question from a sentence, rename, reorder, "find every question
that depends on Q3".

### Phase 5 — Product surface

Onboarding chooser ("How do you want to program your research?"), dual-mode
split (two renderer slots), responsive collapse rules per mode, mode-shell
visual language (denser type ramp, mono identifiers, restrained status
colour, panel chrome) as a token extension in `design-system.css` — no change
to the respondent renderer.

---

## Part D — Risks and decisions to confirm

1. **Third-party UI libraries.** The Studio has none. Plan assumes hand-rolled
   windowing and layout, consistent with `FlowDnd.tsx`. A virtualizer
   (`@tanstack/react-virtual`, ~10 kB) would save Phase 1 time; a layout
   engine (`elkjs`, ~1 MB) would improve Phase 3 quality. Decision needed.
2. **Store re-renders at scale.** Not measured. Phase 0's fixture decides
   whether a selector layer is needed before Phase 1.
3. **Visual language.** §11 asks for a new aesthetic; the design system was
   fixed as light-only in September. Phase 5 proposes an *extension*, not a
   replacement, so the 134 browser suites keep passing.
4. **AI provider.** Intelligent mode needs `AI_API_KEY` for the LLM path; the
   grammar fallback keeps the mode functional without it.
