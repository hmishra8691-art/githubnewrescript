# Building a question variant — the contract

Every "coming soon" entry in the Add Question picker is a row in
`packages/schema/src/variants.ts` with `status: "planned"`. Making one real
means five things, in this order, and nothing else. The reference
implementation is the Single / Multi Select batch:
`apps/runtime/components/variants/singleSelect.tsx` + `apps/runtime/app/variants/choice.css`
+ `scripts/variants-choice-test.mjs`.

## 1. Pick the response model first — never invent one you don't need

A variant is a **presentation** over a base type. The base type owns the
response model, and with it logic, piping, exports, the variable dictionary
and the CSV layout. Reuse an existing base type whenever the answer has the
same shape:

| Answer shape | Base type | Stored as |
| --- | --- | --- |
| one code | `single_select` | `code` |
| several codes | `multi_select` | `code[]` |
| a number | `numeric` / `slider` | `number` |
| text | `open_text` / `long_text` / `date` / `time` | `string` |
| labelled fields | `text_list` / `numeric_list` (rows = fields) | `{ rowCode: value }` |
| one value per item | `matrix_single` / `matrix_numeric` / `matrix_text` (rows = items) | `{ rowCode: value }` |
| row × column cells | `composite` / `custom_table` | `{ rowCode: { columnId: value } }` |
| an order | `ranking` | `code[]` in rank order |
| code → number, summing | `allocation` | `{ code: number }` |
| points on an image | `hotspot` | `{x,y}[]` percentages |

Added for this batch, each with variables + CSV flattening + validation already
wired in the engine (`variables.ts`, `flatten.ts`, `validate.ts`):

| Base type | Stored as | For |
| --- | --- | --- |
| `annotation` | `{ pins: {x,y,comment}[], strokes: {x,y}[][] }` | image annotation, draw-on-image |
| `media_timeline` | `{ t: seconds, code? }[]` | video hotspot / timeline reactions |
| `upload` | `{url,name,size,type}` or an array of them (`settings.maxFiles`) | file, photo, signature, audio |
| `repeating_group` | `Record<rowCode, value>[]` (rows = the field template) | repeating form, dynamic list |
| `experiment` | the assigned arm's code (derived) | A/B experiment, random stimulus |

Side data that belongs *beside* the answer — a reaction time, a pass/fail — is
stored under `<questionId>__<suffix>` exactly like the Other text
(`<id>__other`); use `setSide / getSide` from `variants/shared.tsx`.

## 2. Registry entry

Replace the `planned(...)` tuple with a `stable(...)` call:

```ts
stable(F.slider, "dual", "Dual / Range Slider", "Two handles selecting a range.", {
  baseType: "numeric_list", renderer: "rangeslider", responseModel: "fields",
  capabilities: ["numeric_bounds", "scale_labels"], validations: ["required"],
  defaults: { rows: [{ code: "from", label: "From", fieldType: "number" }, { code: "to", label: "To", fieldType: "number" }],
              settings: { rangePair: true, minValue: 0, maxValue: 100 } },
}),
```

- `renderer` is the key you register in step 3. One renderer may serve several
  registry entries (Product Choice, Product Multi-Select and Rich Cards all use
  `richcards`); the response model decides single vs multi.
- `capabilities` gate what the editor shows. Only list what the renderer
  honours.
- `defaults` land on creation only. Row-driven base types get starter rows
  automatically.

## 3. Renderer

One file per family: `apps/runtime/components/variants/<family>.tsx`, imported
once from `variants/index.ts`. Each renderer is `(p: QRProps) => JSX` and
registers itself:

```ts
registerVariantRenderer("rangeslider", RangeSlider);
// and, for a NEW base type, its default when no variant is stored:
registerVariantRenderer("base:upload", FileUpload);
```

Rules that keep the platform coherent:

- Read options/rows through `useOptions(p)` / `useRows(p)` so option logic,
  masks, sorting and randomization apply exactly as everywhere else.
- Write the answer only through `p.onChange(value)` in the base type's shape.
- Every clickable surface: `role`, `aria-checked`/`aria-pressed`, `tabIndex`,
  keyboard activation (`activate()` helper), and a `data-code` / `data-row`
  attribute so the suites can target it.
- Randomness per respondent comes from `seedFor(p)` + `rng()` — never
  `Math.random()`, or the inspector cannot reproduce what the respondent saw.
- Drag and drop is pointer-based (`usePointerDrag`, `dropTargetAt`) with a
  click/tap fallback; HTML5 DnD cannot be driven by tests or by touch.
- Styles go in `apps/runtime/app/variants/<family>.css`, `@import`ed at the top
  of `apps/runtime/app/globals.css`. Use the `--rs-*` theme variables; prefix
  classes `rs-`.
- Nothing may need a network service. Media plays from `settings.mediaUrl`;
  uploads go through `/api/upload` in the runtime (Supabase Storage), with a
  data-URL fallback in preview.

## 4. Studio authoring

`apps/studio/components/studio/variantConfig.tsx`:

- `OPTION_META_FIELDS[rendererKey]` — extra per-option inputs written to
  `option.meta.<key>` (icon, description, price, correct, region…).
- `registerVariantSettings(rendererKey, block)` — a settings block for
  `settings.*` the renderer reads (media URL, time limit, arms…). Use
  `CountInput` for anything counted.

Do not add variant-specific branches to `QuestionsPanel.tsx`.

## 5. Tests — the suite proves three things per variant

`scripts/variants-<family>-test.mjs`, using `scripts/lib/variantHarness.mjs`:

1. The picker offers it as **stable** and creates it with the right `type`,
   `variant` and seeded defaults.
2. The runtime renders it and a respondent can answer it with the mouse and
   keyboard.
3. The answer lands in the response model's shape (`h.answerOf(pv, id)` reads
   the live state), and the ordinary validators (required, min/max) apply.

Plus engine unit tests in `packages/engine/src/<family>.test.ts` for anything
the engine does for the variant (a new validation rule, a variable layout).

Run from the repo root with both servers up:
`node scripts/variants-<family>-test.mjs`. Never hand a Playwright
ElementHandle to `assert.equal` — a failure inspects it and that consumed
5.8 GB before the cgroup killed the process with no output.

## Deferred (need an outside service or a new algorithm — not in this batch)

AI Open-End Classification, AI Sentiment Analysis, AI Follow-Up, AI
Conversational Survey, AI Quality Check (LLM provider + key); Location Picker,
Address Search, Radius Selection (map tiles + geocoding); Adaptive CBC,
Menu-Based Conjoint, Pricing Configurator (new experimental designs);
Speech-to-Text, Voice Survey, Adaptive Conversation (speech + LLM);
Respondent-Specific Options from APIs. They stay `planned` and greyed out.
