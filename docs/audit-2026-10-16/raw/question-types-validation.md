# QT — Question types & semantic validation (Phase 2)

Audit date: 2026-10-16. Repo state: `packages/*/dist` built 2026-10-16 04:27 (newer than every source read). Scratch scripts: `docs/audit-2026-10-16/repro/qt/age-validation.mjs`, `docs/audit-2026-10-16/repro/qt/integer-preset.mjs`, `docs/audit-2026-10-16/repro/qt/formats.mjs`, `docs/audit-2026-10-16/repro/qt/variants.mjs` (all import `packages/engine/dist` + `packages/schema/dist`; run with `node <file>`).

Engine tests run for this area (all green, 77/77): `cd packages/engine && node --test dist/formats.test.js dist/validationMessage.test.js dist/octoberValidation.test.js dist/repeatingFormValidation.test.js dist/surveyActions.test.js dist/actionValidation.test.js`.

Classification key (brief rule 1): IMPLEMENTED / PARTIAL / UI-ONLY / BROKEN / MISSING / UNVERIFIED.

---

## 1. Type inventory

### 1.1 How types are modelled

- `type` is an open string resolved through `questionTypeRegistry`; 42 built-in base types in `BUILTIN_QUESTION_TYPES` (`packages/schema/src/question.ts:19-92`).
- 170 presentation **variants** over those bases (`packages/schema/src/variants.ts`; enumerated by `docs/audit-2026-10-16/repro/qt/variants.mjs`). Every variant's `baseType` is a built-in; no variant has an unknown base.
- The Studio creates questions **only through variants** (`apps/studio/components/studio/VariantPicker.tsx:255` lists `variantFamilies()`; no Studio file references `BUILTIN_QUESTION_TYPES`). Base types with no variant (`matrix_dropdown`, `custom_component`) can only arrive via JSON/import.
- Renderer dispatch: variant `renderer` key → `variantRenderers` registry (`packages/renderer/src/variants/registry.tsx`) or inline switch (`QuestionRenderer.tsx:2712-2737`), else `base:<type>` registration, else base-type switch (`QuestionRenderer.tsx:2752-2798`). Verified: **every** `renderer` key declared in `variants.ts` is registered or in the inline switch (set comparison in the run above). `hidden` / `calculated` / `embedded_data` are never rendered (filtered at `packages/engine/src/flow.ts:294`).
- Export: all exporters build columns from `buildVariableDictionary` → `questionVariables` (`packages/engine/src/variables.ts:133-527`); every base type has an explicit case except `custom_component` (falls to `default:` one text column, line 526).
- Analytics: `roleFor` (`packages/analytics/src/dataset.ts:108-132`) maps dictionary entries to roles categorical / multi / scale / numeric / text / date / complex. `complex` types are excluded from the statistics picker (`analyses/statistics.ts:537`); conjoint/maxdiff have dedicated analyses (`analyses/choice.ts`).
- Intelligent Mode: `create_question.type` is a friendly name mapped by `ACTION_TYPES` (`packages/engine/src/surveyActions.ts:129-149`) or a raw variant id (`variantForActionType`, line 150). The copilot prompt advertises 23 names (`apps/studio/lib/copilot/prompt.ts:47`).

### 1.2 Table — base type × layer

Builder = selectable variant exists in the Studio picker. Runtime = renderer. Validation = engine `validateQuestion` (`packages/engine/src/validate.ts`) has type-aware checks beyond generic `required`/rules. Export = `questionVariables` case. Analytics = role in `dataset.ts`. AI = reachable from `create_question`.

| Base type | Builder | Runtime | Validation | Export | Analytics | AI | Evidence / notes |
|---|---|---|---|---|---|---|---|
| single_select | IMPL (22 variants) | IMPL | IMPL (required, exclusive, other-specify, selections) | IMPL `variables.ts:133` | IMPL categorical/scale | IMPL `single,radio,yes_no,rating,likert,scale,stars` | |
| multi_select | IMPL | IMPL | IMPL (min/max selections `validate.ts:609-635`) | IMPL `:153` | IMPL multi + 0/1 flags | IMPL `multi,checkbox` | |
| dropdown | IMPL | IMPL | IMPL | IMPL | IMPL | IMPL `dropdown,select` | |
| multi_dropdown | IMPL | IMPL | IMPL | IMPL | IMPL | MISSING (no friendly name; raw id `multi_select.dropdown` works) | P3 |
| numeric | IMPL (open/integer/currency/percentage/quantity) | IMPL `NumericInput` `QuestionRenderer.tsx:731` | PARTIAL — see QT-01..QT-04 | IMPL `:169` | IMPL numeric | IMPL `numeric,number,integer,currency,percentage` (`quantity` not mapped) | |
| open_text | IMPL (single_line/email/phone/url/zip/regex/company) | IMPL | IMPL (length/pattern/email/phone/url/zip rules) | IMPL `:174` | IMPL text | IMPL `text,email,phone,zip,url` | QT-05..QT-08 |
| long_text | IMPL | IMPL | IMPL (rich-text length measured on text `:869`) | IMPL | IMPL text | IMPL `long_text,…` | |
| numeric_list | IMPL (numeric_range, list, dual slider, watch_time) | IMPL `ListInput` | IMPL per-field `validateFieldValue` `:927-949` | IMPL `:184` | IMPL numeric | MISSING (no friendly name) | P3 |
| text_list | IMPL (name, address, contact, date_range, …) | IMPL | IMPL per-field | IMPL | IMPL text | MISSING (no friendly name) | P3 |
| date | IMPL (date/calendar/month_year) | IMPL `DateInput` | PARTIAL — min/max/weekday bounds `:596-607`; no "is a date" check on a scalar `date` (only via `date_min/max` or fields) | IMPL `:178` date | IMPL date→time charts | IMPL `date` | P3 |
| time | IMPL | IMPL `TimeInput`/`TimeSelects` | PARTIAL — no HH:MM format check for scalar `time` (only `fields.ts` TIME_RE for list fields) | IMPL `:181` | IMPL date role | IMPL `time` | P3 |
| ranking | IMPL (click/drag/tournament/buckets) | IMPL | IMPL completeness by `rankMode` `:1016-1034`; no duplicate-rank check | IMPL `:208` | IMPL ranking analysis | IMPL `ranking,rank` | |
| slider | IMPL (single/vertical) | IMPL | IMPL bounds via `validationBounds` `:553-566` | IMPL | IMPL scale | IMPL `slider` | |
| nps | IMPL | IMPL | IMPL bounds | IMPL | IMPL nps analysis | IMPL `nps` | |
| matrix_single | IMPL (17 variants incl. likert/swipe/buckets) | IMPL | IMPL row-required + per-cell rules `:958-1011` | IMPL `:232` | IMPL scale/categorical | IMPL `matrix,grid,likert_matrix` | |
| matrix_multi | IMPL | IMPL | IMPL | IMPL `:249` | IMPL multi | IMPL `matrix_multi` | |
| matrix_numeric | IMPL (slider/star matrix, dragscale) | IMPL | IMPL per-cell min/max via rules | IMPL `:266` | IMPL scale | IMPL `matrix_numeric` | |
| matrix_text | IMPL (chat) | IMPL | IMPL | IMPL `:272` | IMPL text | IMPL `matrix_text` | |
| matrix_dropdown | **no variant** (`matrix.dropdown` is a `composite`) | IMPL (base switch) | IMPL | IMPL `:233` | IMPL | MISSING | legacy-only base type; P3 |
| image_select | IMPL | IMPL | IMPL | IMPL `:135` | IMPL | MISSING (raw id `single_select.image` works) | P3 |
| image_ranking | IMPL | IMPL | IMPL | IMPL `:209` | IMPL ranking | MISSING | P3 |
| hotspot | IMPL | IMPL | generic only | IMPL `:324` X/Y per point | complex (excluded) | MISSING | |
| allocation | IMPL (constant_sum/slider/drag) | IMPL | IMPL sum target `:804-811` + sum_* rules | IMPL `:220` | IMPL allocation analysis | IMPL `constant_sum,allocation` | |
| composite | IMPL (matrix.numeric/text/dropdown/mixed/constant_sum) | IMPL | IMPL per-column rules, row/column sums `:839-860,1047-1073` | IMPL `:278` | complex head + per-column vars | MISSING (no friendly name) | P3 |
| custom_table | IMPL (editable_table) | IMPL | IMPL as composite | IMPL | complex | MISSING | |
| custom_component | **no variant** | PARTIAL — `CustomComponent` runs `customJs` via `new Function` and injects `customHtml` unsanitised (`QuestionRenderer.tsx:2563-2586`); the "registered plugin renderer" promised in `question.ts:45` does not exist | generic only | default text column (`:526`) | complex | MISSING | QT-13 |
| hidden | IMPL (`calculated.hidden`) | n/a (filtered) | n/a | IMPL `:372` | IMPL | IMPL `hidden` | |
| calculated | IMPL (value/score/ai.classification/ai.sentiment) | n/a | n/a | IMPL `:375` | IMPL numeric | MISSING as a question (covered by `create_calculation`) | |
| embedded_data | IMPL (`content.embedded`) | n/a | n/a | IMPL `:378` | IMPL | covered by `create_embedded` | |
| html | IMPL | IMPL | n/a | none (`:381`) | n/a | IMPL `descriptive,text_block,info,…` | |
| conjoint_task | IMPL (cbc/menu/pricing_configurator) | IMPL `DesignTasks`/`menutasks` | IMPL per-task required + menu min/max `:706-732` | IMPL `:383-452` per-task columns | IMPL `conjoint()` | MISSING (needs a design; by design) | |
| maxdiff_task | IMPL | IMPL | IMPL incl. anchored follow-up `:478-493` | IMPL | IMPL `maxdiff()` | IMPL `maxdiff` (design still required) | |
| annotation | IMPL | IMPL | IMPL min/max marks `:793-801` | IMPL `:453` | complex | MISSING | |
| media_timeline | IMPL | IMPL | IMPL | IMPL `:460` | complex | MISSING | |
| upload | IMPL (file/photo/signature/audio_recording) | IMPL | IMPL type→count→size `:775-790` | IMPL `:469` | complex | IMPL `file_upload,upload` | |
| repeating_group | IMPL (dynamic_list/repeating form) | IMPL | IMPL per-entry field types + rules `:654-698` | IMPL `:504` | complex | MISSING | |
| experiment | IMPL (ab/stimulus) | IMPL | n/a | IMPL `:519` | IMPL categorical | MISSING | |
| geo | IMPL (pin/address/radius) | IMPL | IMPL `geoAnswered`/`geoProblems` `:744-750` | IMPL `:332` LAT/LNG/… | IMPL (text + numeric columns; no map analysis of answers) | MISSING | |
| acbc_task | IMPL | IMPL | IMPL stage gating `:735-741` | IMPL `:353` | complex (no ACBC analysis in `analyses/`) | MISSING | PARTIAL analytics |
| video_interview | IMPL (qualitative + video_prompt_voice) | IMPL | IMPL watch/record gates `:760-767` | IMPL `:486` transcript/audio cols | text (transcript) | MISSING | |

### 1.3 Brief's named list — present or absent

| Asked for | Status | Where |
|---|---|---|
| Email / telephone / postal / URL | IMPLEMENTED as `open_text` presets `text.email/phone/zip/url` seeding one rule each (`variants.ts:832-879`); validators in `validate.ts:279-307`, `formats.ts` | see QT-05..QT-08 |
| Sliders | IMPLEMENTED: `slider.single`, `slider.vertical`, `slider.dual` (range), `matrix.slider_matrix`, `allocation.slider_allocation`, `slider.stars/emoji` | |
| Ranking | IMPLEMENTED: click / drag / tournament / buckets / image ranking / best-worst | |
| Constant sum | IMPLEMENTED: `allocation.constant_sum` (+ slider, chips), `matrix.constant_sum` (row sums), `column_sum_*` rules | |
| Matrix variants | IMPLEMENTED: single/multi/likert/rating/semantic/numeric/text/dropdown/mixed/drag/star/slider/constant-sum | |
| **Cascading / dependent dropdowns** | **MISSING** — no type, no variant, no setting. `grep -ri cascad` in schema/engine/renderer hits only unrelated comments (`references.ts`, `branding.ts`). Emulable by hand with per-option `visibleIf`/`logic`, `mask`, `listLogic` (`question.ts:239,246,1399-1416`) but nothing links a child list to a parent value automatically. | QT-11 |
| **Geographic reference data (country→state→city)** | **MISSING** — only `packages/analytics/src/geo/regions.ts` (world/US polygons for charts) and `formats.ts` country tables (10 phone, 9 postal). No country list offered to a question, no subdivision/city data. | QT-11 |
| Date / time / duration | Date, time, date_range, calendar, month_year IMPLEMENTED. Duration only as a **field type** `hours` inside list questions (`FieldType` `question.ts:133`, `parseHours` `fields.ts`) — no scalar duration question. Combined date-time question MISSING (`validate.ts:596` tests `q.type === "datetime"`, a type that does not exist — dead branch). | QT-12 |
| File / audio / video | File, photo capture, signature, audio recording IMPLEMENTED (`upload` family); video *capture* of the respondent MISSING (video_interview records audio only — `InterviewAudio`, `question.ts:761`). | |
| Signature | IMPLEMENTED `upload.signature` (renderer `signature`) | |
| Location | IMPLEMENTED `geo` pin/address/radius | |
| Loops | Not a question type — flow `loop` nodes + `create_loop` action (`prompt.ts:66`); out of scope here | |
| Hidden / embedded / calculated | IMPLEMENTED | |
| Custom components | PARTIAL — see QT-13 | |

---

## 2. The age-decimal defect (mandatory)

### 2.1 How a numeric question's validation is represented

Two parallel representations, both read by the engine:

1. **Rules** `validation[]` with `kind` ∈ `min_value | max_value | integer | …` (`question.ts:263-362`), checked in `checkScalarRules` (`validate.ts:225-231, 322-325`).
2. **Settings** `settings.minValue / maxValue` (checked through `validationBounds`, `validate.ts:553-566`), `settings.decimalPlaces` (0–10) and `settings.numberSign` (`question.ts:1262-1263`, checked at `validate.ts:574-586`).

The "Integer" and "Quantity" variants are presets of `numeric.open` whose only difference is `defaults.validation: [{ kind: "integer" }]` (`variants.ts:937-943, 971-977`). Nothing seeds `decimalPlaces`.

There is **no "is this a number at all" check** for a scalar `numeric` question: `min_value`/`max_value` compare `Number(value)`; `Number("abc")` is `NaN` and both comparisons are false, so a non-numeric string passes unless an `integer` rule is present (`Number.isInteger(NaN)` is false).

### 2.2 What Intelligent Mode generates

- The prompt lists both `numeric` and `integer` as types (`prompt.ts:47`) and shows a validation example `[{"kind":"min_value","value":18}]` on a question whose `ref` is `AGE` (`prompt.ts:46-51`). It never says "age is a whole number"; the `integer` rule appears only in a generic `set_validation` example (`prompt.ts:58`).
- `coerceOne` → `validations()` passes through any of the known kinds (`surveyActions.ts:158,186-201`). No semantic inference.
- `create_question` → `createQuestionFromVariant` (seeds the preset's `integer` rule) → `shapeQuestion` (`surveyActions.ts:1118-1130`).
- `grep -ri "integer|whole number|decimal"` in `apps/studio/lib/copilot`, `packages/ai/src`, `surveyActions.ts`, `actionValidation.ts`, `surveyReview.ts`, `qualityCheck.ts`: no code infers integer-ness from question text or from the word "age". **Prompt-only.**

### 2.3 Repro — `docs/audit-2026-10-16/repro/qt/age-validation.mjs`

Builds a survey through `coerceSurveyActions` + `applySurveyActions`, then runs `validateQuestion` with `blockingErrors`. Expected = whole number inside the bounds.

Case A — AI-style `{type:"numeric", validation:[min_value 18, max_value 100]}` (no integer rule):

| input | expected | actual | message |
|---|---|---|---|
| 1 | REJECT | REJECT | Value must be at least 18. |
| 100 | ACCEPT | ACCEPT | |
| 0 | REJECT | REJECT | |
| -1 | REJECT | REJECT | |
| **25.5** | REJECT | **ACCEPT** | — |
| 101 | REJECT | REJECT | |
| "" | REJECT | REJECT | This question is required. |
| **"abc"** | REJECT | **ACCEPT** | — (NaN passes both bounds) |
| " 42 " | ACCEPT | ACCEPT | |
| "1e2" | (debatable) | ACCEPT | treated as 100 |

Case B — `{type:"numeric", min_value 1, max_value 100}`: identical pattern (25.5 ACCEPT, "abc" ACCEPT, "1e2" ACCEPT; 0/-1/101 rejected).

Case C — `{type:"integer", min_value 1, max_value 100}`: **identical to B** — the preset's `integer` rule is gone (25.5 ACCEPT, "abc" ACCEPT). Resulting question: `variant numeric.integer, validation = [min_value:1, max_value:100]`.

Case D — `{type:"numeric", min 1, max 100, integer}` (the fixture in `surveyActions.test.ts:19`): 25.5 → "Please enter a whole number."; "abc" → "Please enter a whole number."; only "1e2" accepted (as 100).

`docs/audit-2026-10-16/repro/qt/integer-preset.mjs` isolates the cause:

```
"integer"  no validation            -> validation = ["integer"]
"integer"  validation [min_value]   -> validation = ["min_value:18"]      <- integer rule dropped
"email"    no validation            -> validation = ["email"]
"email"    validation [max_length]  -> validation = ["max_length:80"]     <- email rule dropped
"text"     "What is your email address?" -> validation = []               <- no semantic inference
"numeric"  "What is your age?"      -> validation = []
"quantity"                          -> "not a question type the Studio knows"
```

### 2.4 Runtime input and server-side re-validation

- The runtime number box is `<input type="text" inputMode={decimals === 0 ? "numeric" : "decimal"}>` (`NumberField`, `QuestionRenderer.tsx:686-690`); `whole` is derived from an `integer` rule or `decimalPlaces === 0` (`:765`), and `step` is only a `data-step` attribute (`:726`). With no `integer` rule (cases A–C) the keyboard is `decimal` and "25.5" is accepted at the keystroke (`:708` regex allows `\d*\.?\d*` and `e`); it commits `Number(text)` so the stored value is a number. Letters are refused at the keystroke, so "abc" can only arrive via a posted/resumed payload.
- **Server-side: no re-validation.** `apps/runtime/app/api/session/save/route.ts` stores `answers: answers ?? {}` as posted (line 63) and runs only the quality assessment on completion (line 119+). `validatePage` is called only in the client (`apps/runtime/components/Runner.tsx:1148,1265,1416`). No other `apps/runtime/app/api/**` route imports `validatePage`/`validateQuestion`.

---

## 3. Semantic validation registry

Validators (engine): `email` regex (`validate.ts:280`), a *second* email regex for list fields `EMAIL_RE` (`fields.ts:76`), `checkPhone` / `checkPostal` / `checkUrl` with `PHONE_FORMATS` (10 countries) and `POSTAL_FORMATS` (9 countries) (`formats.ts:38-49, 129-139, 155-193`), `DIAL_CODES` (40 entries, respondent-facing picker only), `CURRENCIES` (10). Percentage = `numeric.percentage` preset (`minValue 0, maxValue 100, "%"`); currency = `numeric.currency` preset (symbol only, no decimal enforcement unless `decimalPlaces` set). Date: `date_min/date_max` rules + `settings.minDate/maxDate/disabledWeekdays`. No validator for: IBAN, credit card, national ID, SSN, age-from-DOB, geographic hierarchy.

Repro `docs/audit-2026-10-16/repro/qt/formats.mjs`:

**Email** (scalar rule vs field type):

| value | scalar | field |
|---|---|---|
| a@b.co | ACCEPT | ACCEPT |
| first.last+tag@sub.example.museum | ACCEPT | ACCEPT |
| x@y | REJECT | REJECT |
| no-at | REJECT | REJECT |
| a@b | REJECT | REJECT |
| a..b@c.com | ACCEPT | ACCEPT (invalid per RFC 5322 dot-atom) |
| ü@example.com | ACCEPT | ACCEPT (reasonable: EAI) |
| a@b.c | **ACCEPT** | **REJECT** — the two regexes disagree |
| a@b..com | ACCEPT | ACCEPT |
| a@-b.com | ACCEPT | ACCEPT |

**Postal** (country-aware): US 90210 ✓, 90210-1234 ✓, 9021 ✗; GB SW1A 1AA ✓, sw1a1aa ✓, SW1A 1A ✗; CA K1A 0B1 ✓, K1A0B1 ✓, 90210 ✗; DE 10115 ✓, 1011 ✗; IN 110001 ✓, 010001 ✗. Country-aware checks are correct for the 9 listed countries. An **unlisted country code falls back silently to the loose check** (`postalFormat()` returns undefined → `looksLikeAnyPostal`): `postalCountry: "JP"` accepts `100-0001`, and would accept `"ABC"` too. Same for phone (`phoneCountry: "JP"` → loose).

**Phone**: US `(415) 555-0132` ✓, `415-555-013` ✗, `123-456-7890` ✗ (NANP area-code rule); GB `07700 900123` ✓ (trunk 0 stripped); IN `12345 67890` ✗; loose (no country) accepts any 7+ digits.

**URL**: `example.com` ✓, `http://localhost` ✗, `ftp://x.com` ✗, **`mailto:a@b.com` ✓** (no `//` so it is prefixed to `https://mailto:a@b.com`, which parses with host `b.com`).

**Geographic reference dataset**: none (see §1.3). `apps/runtime/lib/geocode.ts` exists for the `geo` address mode only (provider-backed, not a hierarchy).

---

## 4. Does Intelligent Mode derive validation from semantics?

**No — prompt-only.** Evidence:

- The only mapping from meaning to validation is the variant preset: `type:"email"` → `text.email` → `defaults.validation [{kind:"email"}]` (`ACTION_TYPES` `surveyActions.ts:136`, `variants.ts:832`). It requires the model to choose the `email` type; `type:"text"` with the text "What is your email address?" yields `validation = []` (`docs/audit-2026-10-16/repro/qt/integer-preset.mjs`).
- And that mapping is **lost** whenever the model also supplies a `validation` array (QT-01), which the prompt encourages (`prompt.ts:51` example).
- No code in `apps/studio/lib/copilot/*`, `packages/ai/src/*`, `surveyActions.ts`, `actionValidation.ts` (the action lint), `surveyReview.ts`, `qualityCheck.ts` or `nlIntent.ts` inspects question text for "email", "age", "phone", "zip" etc. to add or suggest rules. `actionValidation.ts:521-590` only checks that a supplied rule kind fits the response model.
- `nlIntent.ts:434-440` maps the *words* "integer", "e-mail", "phone" to action type names when the researcher types a type — still a type choice, not inference from the question's meaning.

---

## 5. Findings

| ID | Severity | Class | Finding | Evidence | Fix |
|---|---|---|---|---|---|
| QT-01 | **P1** | BROKEN (repro'd) | `create_question` with any `validation[]` **replaces** the variant preset's seeded rules: `type:"integer"` loses `integer`, `type:"email"` loses `email` (and `phone`/`zip`/`url` likewise). An AI "integer age 18–100" is stored as a decimal-accepting numeric. | `surveyActions.ts:1127` `q.validation = a.validation.map(...)` overwrites what `createQuestionFromVariant` (`questionCreate.ts:44`) seeded; same at `:553` (`validationFromSpecs`). Repro: `docs/audit-2026-10-16/repro/qt/integer-preset.mjs`, `docs/audit-2026-10-16/repro/qt/age-validation.mjs` case C (25.5 ACCEPT). No test covers `type:"integer"`/`"email"` + validation. | Merge instead of replace: keep preset rules whose `kind` is not in the supplied list (`q.validation = [...q.validation.filter(r => !supplied.has(r.kind)), ...supplied]`). Add tests for integer+bounds and email+max_length. |
| QT-02 | **P1** | PARTIAL | AI-generated numeric age (`type:"numeric"`, min/max only — the shape the prompt example shows) accepts `25.5`. Nothing infers "whole number" from "age"; the prompt does not instruct it. | `prompt.ts:46-51`; repro case A/B (25.5 ACCEPT, renderer `inputMode="decimal"` `QuestionRenderer.tsx:690`). | (a) Prompt: "ages, counts, household size, number of children → type `integer`"; (b) engine: `shapeQuestion` adds `integer` when `a.type` is `integer`/`quantity` **after** QT-01 fix; (c) optional lint in `actionValidation.ts`: numeric question whose text matches `/\b(age|how many|number of)\b/i` without `integer`/`decimalPlaces:0` → warning with a one-click suggestion. |
| QT-03 | **P2** | PARTIAL | Scalar `numeric`/`slider`/`nps` validation never checks that the value *is* a number; `"abc"` passes min/max (NaN compares false). Only reachable through a posted/resumed payload because `NumberField` refuses letters, but the server does not re-validate (QT-04). | `validate.ts:225-231, 553-566`; repro cases A–C ("abc" ACCEPT). | In the `numeric`/`slider`/`nps` block: `if (!Number.isFinite(Number(value))) push(uiText(ctx.ui,"number_required"))` and skip the bounds. |
| QT-04 | **P2** | MISSING | No server-side re-validation of answers: `/api/session/save` stores whatever the client posts; validation is client-only. A crafted or stale client can store out-of-range / wrong-type answers that exports and analytics then trust. | `apps/runtime/app/api/session/save/route.ts:32,63`; `Runner.tsx:1148`. | On the final save (status ≠ in_progress) run `validatePage` over every answered visible question server-side and reject (or flag in `flags`) blocking errors. |
| QT-05 | P3 | PARTIAL | Two different email regexes: scalar rule (`validate.ts:280`) accepts `a@b.c`; list-field `EMAIL_RE` (`fields.ts:76`) rejects it. Both accept `a..b@c.com`, `a@b..com`, `a@-b.com`. | `docs/audit-2026-10-16/repro/qt/formats.mjs` | Export one `checkEmail()` from `formats.ts` and use it in both places; tighten to no leading/trailing/double dots in the local part and a label-valid domain. |
| QT-06 | P3 | PARTIAL | `phoneCountry` / `postalCountry` set to a country **not** in `PHONE_FORMATS`/`POSTAL_FORMATS` (e.g. JP, BR, NL, or any of the 30 `DIAL_CODES` without a format) silently degrades to the loose check; the author gets no warning and the respondent no country message. | `formats.ts:141-144,155-157,171-173`; repro: JP postal `100-0001` ACCEPT under either check. | Lint: country setting without a format entry → warning "checked loosely". Extend tables (JP, BR, NL, IT, ES, MX…) with sourced patterns. |
| QT-07 | P3 | PARTIAL | `checkUrl` accepts `mailto:a@b.com` (and any `scheme:...` without `//`) because the `https://` prefix turns the scheme into userinfo. | `formats.ts:186`; repro. | Reject when `/^[a-z][a-z0-9+.-]*:/i.test(v)` and the scheme is not http/https before prefixing. |
| QT-08 | P3 | UNVERIFIED→PARTIAL | `otherSpecifyFormat`, `pattern` fail-closed, `custom_script` and `condition` rule kinds are implemented in the engine; their Studio editing surface and the Intelligent Mode coercion of `custom_expression`/`custom_script` (not in `VALIDATION_KINDS`, `surveyActions.ts:158`) were not exercised. | `validate.ts:261-371` | Add `custom_expression` to the AI gate or document the omission. |
| QT-09 | P3 | PARTIAL | AI-supplied `min_value`/`max_value` land only in `validation[]`, never in `settings.minValue/maxValue`. Consequences: the builder's "Range" fields show empty for an AI-built question, `NumberField` cannot refuse the minus sign (`QuestionRenderer.tsx:716` reads `settings.minValue`), box width (`numericBoxCh`) is the default. Two representations of one fact. | `surveyActions.ts:1127`; `QuestionsPanel.tsx:1709`. | In `shapeQuestion`, mirror `min_value`/`max_value` into `settings.minValue/maxValue` for `numeric_bounds` variants (or make the engine read one source). |
| QT-10 | P3 | MISSING | AI `create_question` has no friendly names for `quantity`, `multi_dropdown`, `numeric_list`, `text_list`, `image_select`, `image_ranking`, `composite`, `repeating_group`, `geo`, `annotation`, `media_timeline`, `experiment`, `video_interview`, `signature`, `audio`, `date_range`, `calendar`, `month_year`. Raw variant ids work (`variantForActionType` fallback) but the prompt does not say so. | `surveyActions.ts:129-154`; `prompt.ts:47`. | Extend `ACTION_TYPES` and the prompt's type list; state that any variant id is accepted. |
| QT-11 | P2 | MISSING | No cascading / dependent dropdown and no geographic hierarchy dataset (country → state → city). Author must hand-build per-option `visibleIf` on the child list. | §1.3; grep results. | Either a `dependsOn: { questionId, map: code → codes[] }` on `dropdown`, or a `listLogic`-style "filter options by parent answer" + a bundled ISO-3166-2 subdivision table. |
| QT-12 | P3 | MISSING | No scalar duration question (only the `hours` list field) and no combined date-time question; `validate.ts:596` references a non-existent `"datetime"` type. | `question.ts:133`, `variants.ts:2314-2350`. | Add `numeric.duration` preset (hours/minutes affix + `parseHours`) and `datetime.datetime`. |
| QT-13 | P2 | PARTIAL | `custom_component` has no Studio variant (cannot be created in the builder), no plugin registry despite the schema comment, and its renderer runs author JS via `new Function` and injects `customHtml` without `sanitizeHtml`. Export falls to a single text column; analytics `complex`. | `QuestionRenderer.tsx:2563-2586`; `question.ts:45`; `variables.ts:526`. | Decide: retire the type (fold into `customJs` on any question) or ship a real `registerQuestionRenderer()` API + a variant, and sanitise `customHtml` the way `html` blocks are. |
| QT-14 | P3 | PARTIAL | Analytics has no analysis for `acbc_task`, `geo` (no map/distance), `hotspot`, `annotation`, `media_timeline`, `repeating_group`, `upload`; these are `complex` and excluded from the picker. | `dataset.ts:111`; `analyses/index.ts`. | Out of scope for Phase 2; note for the analytics area. |

### What is verified IMPLEMENTED (for the record)

- All 42 base types render (every variant renderer key resolves) — verified by set comparison, not by browser.
- Engine validation for required / selections / exclusive / other-specify / sums / column sums / matrix per-cell / ranking modes / uploads / geo / interview / repeating-group field types / date bounds — code read; 77 related engine tests pass.
- Country-aware phone and postal checks correct for the 9–10 listed countries (repro).
- Variant preset → validation seeding works when the AI supplies **no** `validation` (repro).

### Not run / UNVERIFIED

- Studio builder interaction (which validation kinds each variant's properties panel offers) — not exercised; needs the dev server. BROWSER-REPRO NEEDED for QT-02 end-to-end: Intelligent Mode → "add an age question 18–100" → preview → type `25.5` → Next (expected: accepted, which is the defect).
- DB-side constraints on `responses.answers` (jsonb, no validation by declaration).
