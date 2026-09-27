# Super Intelligent Mode — survey import, reverse engineering and migration

*Built 2026-09-27.* The brief: "Rescript Studio — Super Intelligent Mode: Survey
Import, Reverse Engineering, Migration & Intelligent Programming Engine" (44
sections, phases 1–6).

**Status.** Phases 1–3 (foundation, reconstruction, logic) and the parts of
4–6 that sit on them are in: detection, six source adapters, the canonical
model, mapping into Rescript with identity preserved, the migration report,
the Intelligent-mode import flow, "what could not be migrated?", Deep custom
logic analysis through the proposal pipeline, "why is Q25 not showing?",
estimated/actual metering and the audit records. What is not done is listed
at the end.

## Architecture (§40–§42)

```
file bytes
  │  packages/import/src/detect.ts        content-based detection (§3)
  ▼
Source Adapter Layer                      packages/import/src/adapters/
  qsf.ts        Qualtrics .qsf (JSON)
  decipher.ts   Decipher/Forsta XML, Python conditions → expressions
  docx.ts       Word → paragraphs, lists (numbering), tables, page breaks
  document.ts   questionnaire prose → questions, options, instructions, logic
  table.ts      Excel / CSV questionnaire tables (header anywhere, wide/long)
  + pdf.ts (text layer), xml.ts, zip.ts — hand-rolled readers, no new deps
  │  sources.ts: readSource(bytes, fileName) → CanonicalSurvey
  ▼
Canonical Survey Model                    canonical.ts — platform-neutral:
  questions (26 kinds), options/rows with source ids and codes, CExpr logic
  (group / cmp / raw / const), skips, flow (block, embedded, branch,
  randomizer, group, loop, quota check, end, unsupported), quotas, custom
  code, issues with location/type/severity/suggestion/autoAttempted
  │
  ▼
Mapping Engine + Logic Translation        map.ts: mapCanonical(c, { existing?, scope })
  kind → Rescript type/variant; ids and variables preserved, clashes renamed
  _Imported with the reason in the map; conditions translated where they are
  readable, raw parts never approximated (reported, source kept in notes);
  choice ids → recodes; piping; loops with references; quota checks placed
  after the block that asks what they count; custom code → DISABLED scripts
  │
  ▼
Validation Engine                         SurveyDefinition.safeParse + runQualityCheck
  │
  ▼
Migration report                          report.ts: buildReport → detected vs created,
  converted, review, risks by severity, confidence, merge summary, §39
  sentences, §38 audit lines; workload() for the estimate
  │
  ▼
Studio                                    /api/import/analyze → ImportCard (Intelligent)
```

Parsing runs on the server (`@rescript/import`, node:zlib, exceljs). The map
step is pure and importable separately (`@rescript/import/map`).

## Decisions

- **Nothing guessed (§36).** An instruction the document reader cannot tie to
  a question and answer ("ASK ONLY IF EXISTING CUSTOMER") is an *ambiguous,
  high* issue, and no logic is written. A condition with an unreadable part
  (Qualtrics GeoIP, Decipher `hasMarker()`) is not converted at all — half a
  condition is not the condition — and the source text is kept in the
  question's notes.
- **Identity (§6, §7, §28).** `QID15` stays `QID15`; export tags / Decipher
  labels are the variable names; recodes are the option codes. A clash is
  `QID15_Imported`, and every rename is a map entry with its reason. The
  project stores the map in `def.imports[]` (option/row entries only where the
  code changed, so stored versions stay small); the API response carries the
  full map.
- **Merge never overwrites (§24, §27).** Into an existing survey, identical
  questions are reused (not duplicated), changed ones are added renamed, and
  everything imported goes in before the survey's own End. Applied in the
  editor as one `store.replace` — one undo takes it all back. A preview made
  against an older state of the survey is refused, not applied over edits.
- **Custom code is kept, never run (§9–§12).** Qualtrics JavaScript, Decipher
  `exec`/`validate`: `def.scripts[]` with `enabled: false` and a note of what
  it reads. Qualtrics' empty `addOnload` template is not custom code.
- **Deep analysis goes through the proposal pipeline.** `/api/import/custom-
  logic` asks the model to explain one item and, optionally, propose ONE
  intent in the Intelligent mode's shapes. `coerceCustomLogic` gates the reply;
  `planProposal` parses the condition against the real survey; the result is
  an ordinary proposal card with Apply. The model never writes the survey.
- **Billing (§33–§35) uses existing events.** The estimate prices
  `FILE_UPLOAD` (per MB) and, separately, the optional deep analysis
  (`AI_REQUEST` × items) with `meter.estimate` — nothing charged. The run
  records `FILE_UPLOAD` and `DATA_PROCESSING` (non-billable by default,
  configurable, metadata carries the workload) and returns the actual charge.
  Scopes: Full, Structure only, Questions only; deep analysis is per item.
  No new billable event type was added.
- **Strict creation.** `POST /api/surveys` with `strict: true` refuses an
  invalid definition with 422 *before* creating the project row (it used to
  fall back to a blank survey silently). `import` detail writes
  `survey.imported`; a merge is audited by `/api/import/record` after Apply.

## Intelligent mode (§29–§32, §39)

- Paperclip beside the microphone, a welcome card, drag-and-drop onto the
  conversation, or "import this file" → ImportCard: estimate → preview →
  Create project / Add to this survey. The sandbox cannot create projects;
  the button says so.
- "What could not be migrated?" answers from `def.imports[].review` — any
  later session — with each line selecting its question, and the kept scripts
  offered for Analyze.
- "Why is Q25 not showing?", "Why is Q20 unreachable?", "Why can't
  respondents see Q12?" → `diagnose` intent → engine `diagnoseQuestion`: type
  and settings, not placed, graph-unreachable, branches (and earlier arms that
  win), otherwise paths, randomizer subsets, loops, container conditions,
  display logic and survey rules — with the conditions that can *never* be
  true named (a later answer, a missing question, a constant false, one
  single choice asked for two answers) — earlier skips past it, and the
  quality check. Verdict never / sometimes / always.

## Tests

- `packages/import/src/import.test.ts` (17) — detection, readers, each
  adapter, mapping, merge, scopes, scripts, review record; every fix
  mutation-checked: 23 mutants caught; one survivor is equivalent (the
  mapper's raw-condition guard is also enforced by the tree walk).
- `packages/engine/src/diagnose.test.ts` (6; 12 mutants caught).
- `apps/studio/lib/import/import.test.ts` (4), `lib/intelligent` diagnose
  grammar/planner (2; 4 mutants caught).
- `scripts/import-engine-test.mjs` (8 browser checks).

## Not done yet

- OCR for scanned PDFs (reported as "no text layer; OCR is not configured").
- Legacy binary .doc / .xls (detected and refused with the reason).
- Decipher quota sheets (not in the XML; reported) and Qualtrics
  WebService/Authenticator flow elements (reported as unsupported).
- Re-import diff UI (§26): the fingerprint and the map are stored; a
  side-by-side "what changed since the last import" view is not built.
- The model's deep analysis is per item; there is no batch "analyze all".
