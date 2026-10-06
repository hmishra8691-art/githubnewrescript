# October 2026 review — builder sections and respondent behaviour

Sources: `02-10-2026_question.xlsx` (Sheet1, **Q** IDs) and `2_10_26.xlsx`
(sheet "prince", **P** IDs). 48 requirements, all accounted for below.

Verification legend: **E** engine unit test (`packages/engine/src/*.test.ts`),
**S** Studio unit test (`apps/studio/lib/**/*.test.ts`), **B** browser suite
(`scripts/october-review-test.mjs` unless named), **P** builder probe
(before/after diff of all 46 subtypes' builder controls), **M** mutation-checked.

## Audit

| ID | File | Sheet | Requirement | Status | What changed | Verification | If not complete, why |
|---|---|---|---|---|---|---|---|
| Q01 | 02-10-2026_question.xlsx | Sheet1 | No Search Box on Card / Image / Icon / List / Product / Statement Single Select; keep on radio | ✅ | `OPTION_SEARCH_RENDERERS` cut from 11 keys to the 3 renderers that call `useOptionFilter` | S (source scan holds set = callers), P, B | — |
| Q02 | 02-10-2026_question.xlsx | Sheet1 | No Search Box on Dropdown / Searchable Dropdown | ✅ | same set; `base:dropdown`, `base:multi_dropdown` removed | S, P, B | — |
| Q03 | 02-10-2026_question.xlsx | Sheet1 | Heart Rating: no Unit Label / steppers | ✅ | number controls follow the variant's `numberInput` policy; a non-numeric-input renderer gets none | P | — |
| Q04 | 02-10-2026_question.xlsx | Sheet1 | One Pairwise Choice | ✅ | `pairwise_set` is "Pairwise Choice"; the single form has `pickerReplacedBy`, stays loadable, switcher converts (pairs options in order) | S, B (`variants-choice-test`) | — |
| Q05 | 02-10-2026_question.xlsx | Sheet1 | Option A / Option B only; no + Option | ✅ | `builder.hide ["options","rows"]`; pair editor | P | — |
| Q06 | 02-10-2026_question.xlsx | Sheet1 | + Field adds the next pair | ✅ | `addPair` / `removePair` (removal keeps options another pair uses) | S, B | — |
| Q07 | 02-10-2026_question.xlsx | Sheet1 | No Search Box on Pairwise | ✅ | renderer not in the search set | S | — |
| Q08 | 02-10-2026_question.xlsx | Sheet1 | No Search Box on the specialised Multi Selects | ✅ | same set | S, P | — |
| Q09 | 02-10-2026_question.xlsx | Sheet1 | Currency controls only on Currency | ✅ | `numberInput.symbol` per variant (choose / fixed) | P | — |
| Q10 | 02-10-2026_question.xlsx | Sheet1 | Numeric Open End: whole/decimal, decimal places, positive/negative | ✅ | `decimalPlaces`, `numberSign` settings; keystroke refusal; validation messages | E, M, B | — |
| Q11 | 02-10-2026_question.xlsx | Sheet1 | Percentage 0–100, fixed % | ✅ | `symbol:"fixed"`, `fixedSymbol:"%"`; defaults 0–100 kept | P | — |
| Q12 | 02-10-2026_question.xlsx | Sheet1 | Quantity: min/max, whole/decimal, unit | ✅ | `numberInput {unit, stepper, format}` | P | — |
| Q13 | 02-10-2026_question.xlsx | Sheet1 | Numeric Range inputs follow the field type | ✅ | `NumericRange` draws number / decimal / integer / date / time / duration; From & To share a type (`fields.sameType`); order check per type (`rangeEndKey`) | E, M, B | — |
| P01 | 2_10_26.xlsx | prince | Image Categorization: no Columns | ✅ | already absent in code since 9b36ea2 (the screenshot is an older deploy); regression check added | P, B | — |
| P02 | 2_10_26.xlsx | prince | Image Categorization: no Search Box | ✅ | as P01 | S, P, B | — |
| P03 | 2_10_26.xlsx | prince | Images section (upload, label, replace, delete, reorder, randomize) | ✅ | rows titled "Images" with an image per row (`builder.rowsImages`), ↑↓ reorder, randomize toggle | P, B | — |
| P04 | 2_10_26.xlsx | prince | Buckets: name, description, image/icon, capacity | ✅ | option meta fields `description`, `capacity` + option image; drawn in the bucket header | P | — |
| P05 | 2_10_26.xlsx | prince | Bucket rules enforced | ✅ | `bucketRules.ts` (`dropInto`, `bucketProblems`) used by renderer and validator | E, M, B | — |
| P06 | 2_10_26.xlsx | prince | Display settings; drag images into drop zones | ✅ | new `ImageCategorize` (image chips → bucket boxes); randomize images / buckets, show labels | B (`browser-test`) | — |
| P07 | 2_10_26.xlsx | prince | Video Rating builder | 🟡 | video section, 5 rating types with range/labels, required, playback settings, optional comment (`<var>_COMMENT`), duplicate min/max and stepper removed | E, P, B | **One clip only**: the answer is one number, so several videos would need a per-clip answer model (design decision, not built) |
| P08 | 2_10_26.xlsx | prince | Video Hotspot: no Search Box | ✅ | already absent since 9b36ea2; covered by the source scan | S, P | — |
| P09 | 2_10_26.xlsx | prince | + Add Video, each with its own reactions | ✅ | `settings.videos[]` with per-clip reactions; clip tabs; marks carry `v` | E, P | — |
| P10 | 2_10_26.xlsx | prince | Auto-play on by default | ✅ | default `autoPlayVideo: true`; muted-autoplay fallback | P | — |
| P11 | 2_10_26.xlsx | prince | Require complete watch blocks Next, independent of Required | ✅ | `mediaGate` holds Next with a reason | B | — |
| P12 | 2_10_26.xlsx | prince | Watch-Time: tracking fields fixed, not editable | ✅ | `builder.hide ["fields"]`; rows derived by `watchTimeRows` | E, P | — |
| P13 | 2_10_26.xlsx | prince | Watch-Time: multiple videos, auto-play | ✅ | per-clip suffixed fields; first clip keeps existing names | E, M | — |
| P14 | 2_10_26.xlsx | prince | Drag into Buckets rules | ✅ | one/multiple, prevent/replace, min/max, require all, allow empty | E, M, B | — |
| P15 | 2_10_26.xlsx | prince | Builder order Items → Buckets → Rules → Layout | ✅ | `builder.rowsFirst`, `layoutLast` | P | — |
| P16 | 2_10_26.xlsx | prince | Date default (none / today / custom) | ✅ | `defaultDateMode`, `initialDateValue` | E | — |
| P17 | 2_10_26.xlsx | prince | Date format (8) | ✅ | `dateFormat.ts`; typed entry + calendar; stored ISO | E, M, B | — |
| P18 | 2_10_26.xlsx | prince | Time default | ✅ | `defaultTimeMode`, `initialTimeValue` | E | — |
| P19 | 2_10_26.xlsx | prince | 12/24 h, seconds | ✅ | `TimeSelects` | B | — |
| P20 | 2_10_26.xlsx | prince | Accepted types (multi-select) enforced | ✅ | `uploadTypes.ts`; picker attribute + check + validator; wording from the sheet | E, M, B | — |
| P21 | 2_10_26.xlsx | prince | Min / max files | ✅ | `minFiles`, wording from the sheet | E, M | — |
| P22 | 2_10_26.xlsx | prince | Size per file, total size, check order | ✅ | type → count → size → total | E, B (`variants-g5-test`) | — |
| P23 | 2_10_26.xlsx | prince | Photo Capture: images only (JPG/JPEG/PNG) | ✅ | accepted-files control removed; enforced on capture and validation | E | — |
| P24 | 2_10_26.xlsx | prince | Name: First/Last, Short Text fixed | ✅ | `fields {types:["text"], fixed:true}` | P | — |
| P25 | 2_10_26.xlsx | prince | Address: Short Text + ZIP | ✅ | `fields.types` | P | — |
| P26 | 2_10_26.xlsx | prince | Date Range: From/To always same type | ✅ | `fields.sameType`; order check now runs for date ranges | E, M, B | — |
| P27 | 2_10_26.xlsx | prince | Contact Form types incl. Address | ✅ | types + "+ Address section" | P | — |
| P28 | 2_10_26.xlsx | prince | Conditional Form: relevant types only | 🟡 | limited to text, long text, email, phone, number, integer, date | P | The sheet does not list the types; this list is an interpretation awaiting product confirmation |
| P29 | 2_10_26.xlsx | prince | Numeric List: Number / Decimal / Integer | ✅ | `fields.types` | P | — |
| P30 | 2_10_26.xlsx | prince | Dynamic List keeps all types | ✅ | unchanged | P | — |
| P31 | 2_10_26.xlsx | prince | Editable Table builder | 🟡 | Columns editor restored (`spreadsheet` in `CELL_COLUMN_RENDERERS`), per-column type/validation/whole/currency, allow add/delete rows, initial rows, randomize rows | P, B | "+ Add row" reveals the authored rows up to their count — new respondent-created row codes would change the data model; "allow editing rows" is the existing per-column read-only |
| P32 | 2_10_26.xlsx | prince | Phone: country-code list, fixed country, per-country validation | ✅ | `DIAL_CODES` (40), `PhoneInput`, `phoneCountryFor`; legacy loose check unchanged | E, M, B | — |
| P33 | 2_10_26.xlsx | prince | Tinder: rich cards, card & swipe settings | ✅ | `cards.ts`, `CardFace`; Card content editor; image position/aspect/size/alignment/show; buttons, randomize, require | E, B | — |
| P34 | 2_10_26.xlsx | prince | Swipe to Rate / Rank / Categorize | ✅ | `swipeResponse`; rank mode keeps options Rank 1…N | S, B | — |
| P35 | 2_10_26.xlsx | prince | Four-Direction: card frame 4:5, rich cards, editable labels | ✅ | frame + `CardFace`; direction labels edit the mapped options | P | — |

**Totals:** ✅ 45 · 🟡 3 (P07, P28, P31) · 🔴 0 · ⚠️ 0.

## Tests

- **Engine:** 1674 tests pass. New test files: `bucketRules`, `uploadTypes`,
  `dateFormat`, `videos`, `cards` and `octoberValidation`. `g5` was updated
  for the sheet's upload wording.
- **Studio unit tests:** 262 pass. New: `lib/builder/{pairwise,randomAxes,cards}.test.ts`
  and `lib/builderSections.test.ts`. The last one is a source scan: it checks
  that `OPTION_SEARCH_RENDERERS` matches the renderers that actually draw a
  search box.
- **Browser:** `scripts/october-review-test.mjs` has 15 checks, all through
  the builder's own controls and then the runtime preview. Three suites were
  updated for intended changes:
  - `browser-test` uses the new drop zones for Image Categorization.
  - `variants-choice-test` creates the single Pairwise from JSON, because it
    is no longer in the picker.
  - `variants-g5-test` covers the video list and the new upload wording.
- **Mutation:** 29 mutations, 29 caught (18 in the engine, 8 in the Studio
  unit tests, 3 in the browser suite: Next held by an unfinished clip, the
  ranks following the cards, and the "+ Add card" label).
  The first engine pass let 4 survive: decimal places, sign, date-range order
  and phone code list. `octoberValidation.test.ts` was written for them, and
  all 4 are now caught.
- **Builder probe:** all 46 subtypes' builder controls were compared before
  and after. Every difference is listed under its ID above.

**Browser corpus:** 35 suites were re-run. 33 pass. The 2 failures are older
than this work, and nothing here touches the code they test:

- `picker-taxonomy-test` expects Percentage Slider in the picker. It was
  retired in 29b505c.
- `qa-fixes-test` expects a bare emoji question to draw 5 faces. The
  renderer's fallback has been 1–10 since before this work.

## Compatibility

Every new setting is optional and absent from existing surveys, so those
surveys look and behave as they did. In particular:

- Phone checks are strict only when the new "pick" setting is chosen.
- A question that has only `mediaUrl` reads as a list with one clip. If a
  `mediaUrl` is written elsewhere (the Copilot, an import, a JSON edit), it
  wins as the first clip.
- The older single-comparison Pairwise question still renders and answers.
- The upload messages follow the sheet's wording.
- Image Categorization's old per-card bucket buttons are replaced by drop
  zones. The stored answer shape is unchanged (`{row: bucket}`).
