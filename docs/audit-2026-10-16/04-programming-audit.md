# 04 · Programming audit — question types, validation, logic, custom setups, runtime

Evidence: `raw/question-types-validation.md`, `raw/logic-engine.md`, `raw/schema-and-runtime.md` Part B, plus the orchestrator's browser runs (`docs/audit-2026-10-16/repro/browser/*.mjs`, screenshots `mobile-360/390/768.png`, `matrix-selector.png`).

## 1. The mandatory numeric test case (age 1–100, whole numbers)

**Engine-level result** (`docs/audit-2026-10-16/repro/qt/age-validation.mjs`, run twice — by the agent and by the orchestrator):

| input | expected | A: AI shape (`numeric`, min 18/max 100) | B: `numeric` 1–100 | C: `integer` 1–100 (AI-style) | D: `numeric` + explicit `integer` rule |
|---|---|---|---|---|---|
| 1 | accept (B–D) | reject (<18) ✓ | ✓ | ✓ | ✓ |
| 100 | accept | ✓ | ✓ | ✓ | ✓ |
| 0 / -1 / 101 | reject | ✓ | ✓ | ✓ | ✓ |
| 25.5 | reject | **ACCEPT** | **ACCEPT** | **ACCEPT** | ✓ "Please enter a whole number." |
| "" | reject (required) | ✓ | ✓ | ✓ | ✓ |
| "abc" | reject | **ACCEPT** | **ACCEPT** | **ACCEPT** | ✓ |
| " 42 " | accept | ✓ | ✓ | ✓ | ✓ |
| "1e2" | reject | **ACCEPT** (=100) | **ACCEPT** | **ACCEPT** | **ACCEPT** |

**Browser, end to end** (`age-e2e.mjs`): Intelligent Mode (fake provider) → `create_question type:"integer"` with min/max → Apply → stored kinds `[min_value,max_value]` (integer gone) → runtime preview renders `<input type=text inputmode=decimal data-step=any>` → `25.5` → Next → **page advances**. Identical for the `numeric` shape.

**Root causes.** (1) `shapeQuestion` replaces validation instead of merging (QT-01). (2) No semantic inference layer; the prompt's numeric example has no integer rule (QT-02). (3) No "is a number" check in scalar numeric validation (QT-03). (4) No server-side re-validation (QT-04 = RUNTIME-01). Renderer uses `inputmode=decimal` unless an `integer` rule or `decimalPlaces:0` is present — correct once (1)/(2) are fixed.

**Required behaviour** (brief §4B) is achievable without hard-coding: a `semantic` tag (`age`) → `{integer, min, max, decimals:0, inputmode numeric}` from a registry; explicit range remains explicit.

## 2. Semantic validation (email, phone, postal, geo, other)
- Email: `validate.ts:280` regex (accepts `a@b.c`), `fields.ts:76` regex (rejects it); both accept `a..b@c.com`, `a@-b.com`; neither claims existence. → unify (QT-05).
- Telephone: `PHONE_FORMATS` country table with dial codes; correct for US/GB/CA/DE/IN cases; unlisted country falls back to a loose check silently (QT-06).
- Postal: `POSTAL_FORMATS` for 9–10 countries incl. alphanumeric UK/CA; format only, never existence (correct); unlisted → loose (QT-06).
- URL: `mailto:` and other schemes accepted (QT-07).
- Country/state/city: **no reference dataset, no dependent dropdown**; authors hand-build per-option `visibleIf` (QT-11). Nothing invents geography (good) because nothing provides it.
- Dates/ranges, percentages, currency, rating ranges: rules exist (`date_min/max`, `percentage` variant, `currency` variant, bounds). Consent/eligibility: ordinary single-select + skip; no semantic marker.
- Automatic generation from semantics: **prompt-only**; the only type→rule mapping is the variant preset, and QT-01 loses it.

## 3. Logic engine
IMPLEMENTED with tests: condition trees, operators, display/skip/branch, masking, carry-forward, piping, embedded, quotas (evaluation), randomisation, loops, auto-punch, list logic, page/block navigation, termination/redirect, `pruneReferencesTo` on delete.
Defects: LOGIC-01 (hand recode), LOGIC-02 (question code rename), LOGIC-03 (calc code resolution), LOGIC-04 (Back ignores skips), LOGIC-05 (bad skip targets), LOGIC-07/08/09 (reference grammar edges), LOGIC-10 (lint false positive), LOGIC-11 (`on_submit` before blocking check). Matrix answer shapes the runtime stores: per-row grid `{rowCode: optionCode}` / `{rowCode: [codes]}`; composite `{rowCode: {columnId: value}}` — references resolve against these (verified).

## 4. Matrix logic editor (browser-verified, `matrix-selector.mjs`)
- Rating matrix, operator "is": `cond-row` (any/Service/Price), `cond-column` (1…5), **no** `cond-value` — correct.
- Operator "≥": `cond-column` gone, `cond-value` = `1: 1 | 2: 2 | 3: 3 | 4: 4 | 5: 5` — the reported "duplicate" (OR-04).
- Dropdown matrix (composite): `cond-column` = `any col | col: Choice`; after picking the column `cond-value` = `1: Choice 1 …`; operator list is the full 40-item catalogue including dates/ranks/regex (OR-05).
- Source picker: questions followed by ~45 `SYSTEM_*` entries (OR-06).
- Stale references: a stored rule keeps `columnId`/`value`; the conflict chip appears for legacy double-spelled rules (LOGIC-16); copy/paste of a composite column-only rule does not round-trip (LOGIC-07).

## 5. Custom setups inventory (raw/logic-engine.md §Custom setups)
| Setup | Config | Persist | Runtime | Errors | AI can create |
|---|---|---|---|---|---|
| Design generators: CBC, MaxDiff, custom | plugin registry (`packages/designs`) | `designs[]` inline | task renderers | diagnostics discarded (METHOD-05) | shells only (METHOD-08) |
| Custom generator form | UI-ONLY (LOGIC-12) | — | — | — | no |
| `def.scripts` (on_validate/on_complete/on_submit) | Studio script editor | yes | unsandboxed main thread (RUNTIME-04) | console | no (LOGIC-13) |
| UX behaviours/scripts | Studio + AI (gated) | `ux.behaviors` | sandbox + mirror DOM | console + inspector | yes |
| `custom_component` | JSON only (QT-13) | yes | `new Function`, raw HTML | console | `set_custom_code` (component path) |
| Validation rule kinds `custom_script`, `condition`, `pattern` | engine ok | yes | yes | messages | coercion unverified (QT-08) |
| Custom Form / Editable Table variants | ordinary variants | yes | yes | ordinary | yes |

## 6. Runtime (code-level + browser)
- Resume/double-submit/pending replay: IMPLEMENTED (RUNTIME-12). Back not persisted (RUNTIME-06). Same-token second device → duplicate partial (RUNTIME-05, needs DB to prove).
- Server trust: RUNTIME-01 (P0), RUNTIME-02.
- Scripts: a UX script can hide/disable Next permanently — reproduced (`hidden:true, disabled:true`, respondent stuck) (RUNTIME-08); `def.scripts` unguarded loops (RUNTIME-04). No path where a script error breaks navigation otherwise (unified pipeline suite green).
- Mobile: no page overflow at 360/390/768; the 5-point matrix scale is clipped in a scroll wrapper without affordance (OR-02); eight distinct breakpoints (RUNTIME-10).
- Accessibility: matrix inputs without accessible names, no arrow-key radio groups (RUNTIME-09).
