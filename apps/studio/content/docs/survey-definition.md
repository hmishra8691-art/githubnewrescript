# The survey definition

The definition is one JSON object validated by a schema (`@rescript/schema`, `SurveyDefinition`). The Studio's *JSON* tab shows it and accepts it back; the Intelligent-mode actions write it; the runtime renders it; the exporters read it. Fields with defaults can be left out — a minimal document needs only `meta`, `questions` and `flow`.

## Top level

| Field | What it holds |
|---|---|
| `meta` | `id`, `code` (e.g. `SURVEY_001`), `title`, `description?`, `version` (`"1.0"`), `status` (`draft` \| `testing` \| `live` \| `closed`), `createdAt?`, `updatedAt?`, `schemaVersion` (1) |
| `branding` | theme and look: `themeId`, `logoUrl`, `colors{…}`, `typography{…}`, `layout{…}`, `buttons{style, nextLabel, backLabel, submitLabel, showBack}`, `voice{readAloud, dictation, lang}`, `responsive{tablet, mobile}`, `headerHtml`, `footerHtml`, `customCss`, `customJs` |
| `questions` | the questions, in no particular order — the flow decides where they are asked |
| `flow` | the order of the survey: blocks, pages, sections, branches, randomizers, loops, embedded-data nodes, quota checks, redirects and ends |
| `displayRules` | named show/hide rules on any target (question, page, section, block, option, row, column) |
| `calculations` | derived variables with an expression and a trigger |
| `namedExpressions` | reusable conditions by name (`IS_ADULT`), usable in any logic |
| `embeddedData` | the embedded fields the survey expects (`name`, `source`, `dataType`, `defaultValue`) |
| `quotas` | quotas with their cells and what happens when one is full |
| `scripts` | survey, page and question scripts with their event |
| `listFills` | List Fill allocators (which items each respondent gets) |
| `designs` | conjoint / MaxDiff / ACBC experimental designs referenced by task questions |
| `localization` | languages, translations, glossary, audio, routing |
| `research` | the research design: objective, hypotheses, constructs, KPIs, audience, the analysis plan — see [The Research Engine](research-engine) |
| `ux` | styles, animations and behaviours — see [Custom code](custom-code) |
| `variables`, `namingTemplates`, `variableNaming` | the generated variable dictionary and the naming conventions in force |
| `deployment`, `quality`, `imports`, `meta_extensions`, `logicFlow` | deployment settings, data-quality rules, import provenance, a free bag for extensions, the logic graph the Logic tab draws |

## A question

```json
{
  "id": "q_sat", "code": "Q7", "variableName": "SAT",
  "type": "matrix_single", "variant": "matrix.likert",
  "text": "How much do you agree with each statement about {{Q4}}?",
  "instruction": "One answer per row.",
  "rows": [{ "code": "r1", "label": "Good value for money" }, { "code": "r2", "label": "Easy to use" }],
  "options": [{ "code": 1, "label": "Strongly disagree" }, { "code": 2, "label": "Disagree" }, { "code": 3, "label": "Neither" }, { "code": 4, "label": "Agree" }, { "code": 5, "label": "Strongly agree" }],
  "required": true,
  "randomization": { "enabled": true, "scope": "rows", "method": "shuffle" },
  "displayLogic": { "type": "rule", "source": { "kind": "question", "ref": "q_pref" }, "operator": "answered" },
  "analysis": { "role": "dependent", "measurement": "ordinal", "hypotheses": ["H1"], "construct": "Satisfaction" }
}
```

The fields a question can carry: `id`, `code`, `variableName`, `type`, `variant?`, `text`, `instruction?`, `description?`, `options[]`, `rows[]`, `columns[]`, `validation[]`, `required`, `settings{}`, `randomization?`, `optionGroups[]`, `groupOrdering?`, `carryForward?`, `listLogic[]`, `optionPipeline[]`, `mask?`, `rowMask?`, `columnMask?`, `punches[]`, `attentionCheck?`, `probe?`, `ai?`, `spoken?`, `displayLogic?`, `skipLogic[]`, `customJs?`, `customCss?`, `customHtml?`, `analysis?`, `notes?`, `meta?`. Which of `options`, `rows`, `columns`, `scale` and the numeric bounds apply is decided by the type — see [Question types](question-types).

**An option** is `{ code, label, value?, imageUrl?, flags[], visibleIf?, logic? }`. Codes are numbers or strings and are what the data stores; labels are what respondents see and what logic may name (`Q3 = Female` is read as the code). Flags: `exclusive` (clears the others when chosen — *None of these*), `other_specify` (adds a text box; the text lands in `VAR_other`), `anchor_top` / `anchor_bottom` (kept in place when the list is randomized).

**A row** (`rows`, for grids and lists) is `{ code, label, fieldType?, validation[], required, placeholder?, visibleIf?, logic? }`. **A column** (`columns`, for composite tables) is `{ id, label, responseType, variableStem, options[], validation[], visibleIf?, readOnly, defaultValue?, expression?, min?, max?, step? }` with `responseType` one of `single, multi, dropdown, multi_dropdown, text, longtext, numeric, date, time, rank, slider, checkbox, none`.

**Validation** is a list of rules `{ kind, value?, message?, severity?: "error" | "warning", when?: Condition, check?: Condition }`. Kinds: `required, min_value, max_value, min_length, max_length, min_selections, max_selections, sum_equals, sum_max, sum_min, pattern, email, phone, url, zip, date_min, date_max, integer, column_sum_equals, column_sum_max, column_sum_min, custom_expression, custom_script, condition`. A rule with `when` applies only while that condition holds; `kind: "condition"` with `check` makes any condition a validation (true = invalid).

**Settings** (`settings`) hold per-type presentation and limits: `minValue`, `maxValue`, `step`, `minSelections`, `maxSelections`, `sumTarget`, `placeholder`, `rankMode`, `optionOrder`, `columnsLayout`, scale end labels (`npsLeftLabel`, `sliderRightLabel`…), currency and number formats, date and time formats, media (`mediaUrl`, `mediaItems`), upload limits, timers (`timeLimitSeconds`, `onTimeout`), experiment arms, geo settings, interview settings, and `hidden`, `readOnly`, `defaultValue`, `expression` (for a calculated question). The full key list is in the generated [question types](question-types) page's source schema.

## The flow

The flow is a tree of nodes. Only a `page` asks questions; everything else arranges pages.

| Node | Fields | What it does |
|---|---|---|
| `page` | `id, title?, showTitle?, mediaUrl?, questionIds[], visibleIf?` | one screen; its questions in order |
| `block` | `id, title?, showTitle?, mediaUrl?, children[], visibleIf?` | a named group of pages (and nested nodes) — what the editor shows as a block |
| `section` | `id, title?, children[], visibleIf?` | a grouping with no own title screen |
| `branch` | `id, branches: [{ id, label?, when: Condition, children[] }], otherwise?: children[]` | the first branch whose condition holds runs; else `otherwise` |
| `randomizer` | `id, children[], show?: number, evenPresentation?` | the children in random order; `show` presents N of them |
| `loop` | `id, source, loopVar, children[], count?, order?, eligibleIf?, skipIf?, breakIf?, aggregates?, references?` | the children once per item — see [Piping, lists and loops](piping-and-lists) |
| `embedded_data` | `id, fields: [{ name, source: url \| panel \| static \| expression, value?, dataType?, defaultValue?, when? }]` | sets embedded fields at that point |
| `quota_check` | `id, quotaIds[], onFull: { kind: terminate \| redirect \| continue \| flag, url? }, when?` | checks quotas here — see [Localization and quotas](localization-and-quotas) |
| `redirect` | `id, url, newWindow?, when?` | sends the respondent to a URL (pipeable: `{{ed.PANEL_ID}}`) |
| `end` | `id, status: complete \| screened \| quota_full \| terminated, message?, redirectUrl?` | an end of the survey with its status |

A survey has at least one `end` with status `complete`; skip logic and quota checks can send a respondent to any end status. A question that appears in no page is never asked (hidden and calculated questions are usually placed on a page all the same, so the runtime evaluates them in order).

## Calculations, named expressions, embedded data

```json
"calculations": [{ "id": "c1", "targetVariable": "SCORE", "expression": "sum(Q7_r1, Q7_r2) / 2", "trigger": "on_page_submit", "dataType": "numeric" }],
"namedExpressions": [{ "id": "n1", "name": "IS_ADULT", "when": { "type": "rule", "source": { "kind": "question", "ref": "q_age" }, "operator": "gte", "value": 18 } }],
"embeddedData": [{ "name": "PANEL_ID", "source": "url", "dataType": "string" }, { "name": "WAVE", "source": "static", "defaultValue": "3" }]
```

A calculation runs at its trigger (`on_change`, `on_page_submit`, `on_complete`) and writes `targetVariable`, readable everywhere as `calc.SCORE` and piped as `{{calc.SCORE}}`. A named expression is a condition with a name, usable in any logic as `IS_ADULT` and in a calculation as 1 or 0. Embedded data comes from the link (`?PANEL_ID=…`), a panel, a static value or an expression, and is read as `ed.PANEL_ID`.

## Scripts, UX, localization, quotas, research

Each has its own page: [Custom code](custom-code) for `scripts`, `ux`, `branding.customJs`; [Localization and quotas](localization-and-quotas) for `localization` and `quotas`; [The Research Engine](research-engine) for `research`.

## Validating a definition

The schema is strict about shape and lenient about defaults: unknown question types are accepted (the type registry resolves them), old option flags are folded into `exclusive`, and missing defaults are filled. The Studio's *validate & apply* reports the first schema issues by path (`questions.3.displayLogic: Expected object`). Beyond the schema, the engine's review (`reviewSurvey`) checks logic that reads a later question, unreachable questions, empty texts, leading wording, overlapping ranges, research gaps and more; Intelligent mode runs it on request (*review my survey*) and the apply gate runs the logic checks on every change.
