# Paste Replace/Append · Option-level Auto Punch · Preview Block · Universal Media URLs

Four programmer-facing features, one architectural rule: none of them adds a
second engine. The auto punch condition is the canonical `Condition` tree,
evaluated by the one evaluator; the block preview is the one Runner entered
later; the media resolver is one pure function every renderer calls.

## 1. Paste options — Replace (default) / Append

`packages/engine/src/optionsPaste.ts` · `QuestionsPanel.tsx` (OptionRows)

An option's **code** is its identity — logic, piping, masks, punch rules and
stored answers all point at codes — so a paste must never turn "option 3" into
a different option by accident.

- **The paste box opens showing the current list** as `code<TAB>label` lines.
- **Replace** (default): the pasted list *is* the new list, in pasted order. A
  line that names an existing option — by code (`code<TAB>label`) or, failing
  that, by identical label — keeps that option: same code, flags, image, logic,
  metadata; only the label follows the paste. Unmatched lines become new
  options with fresh codes. Options the paste does not mention are removed, and
  the box says so before import (`keeps 2 · adds 1 · removes 1`, with the
  removed codes listed).
- **Append**: the list stays exactly as it is; every pasted line is added after
  it. A pasted code that collides with an existing one gets a fresh code — a
  duplicate code is never written.

`planPaste(existing, text, mode)` is the pure planner (unit-tested);
`optionsToPaste()` prints the list back; `parsePastedOptions()` moved here from
the Studio and is re-exported for old imports.

## 2. Option-level auto punch

`packages/engine/src/autoPunch.ts` · `setExpression.ts` · `carryforward.ts` ·
`apps/studio/components/studio/AutoPunchEditor.tsx` · Runner live re-punch

"If Q1 · Product A is selected → select Q2 · Product B" is stored as the
existing `PunchRule` **on the target question** (Q2):

```json
{ "source": { "kind": "codes", "codes": ["B"] },
  "when":   { "type": "rule", "source": { "kind": "question", "ref": "q1" }, "operator": "selected", "value": "A" },
  "action": "select", "recompute": "always", "mapping": [], "ignoreUnmatched": true }
```

`when` is the ordinary survey Condition — AND / OR / NOT / brackets / every
operator — evaluated by `evaluateCondition`. Nothing new is evaluated.

**Actions** (`PunchAction` enum, schema): `select`, `deselect` (answer,
additive on multis, single-select takes the code); `clear`, `set_value`
(answer; `set_value` writes non-option values too, e.g. a numeric);
`show`, `hide`, `enable`, `disable` (option **list**, applied as stage 4c of
the option pipeline after the mask — `hide` removes, `show` restores a
programmed option another stage dropped, `disable`/`enable` set
`meta.disabled`, which every choice renderer honours). Rules apply in order; a
later rule on the same code wins.

**When they run**: on page arrival (`prefillQuestions`, as before) and — new —
**live on the same page**: when an answer changes, the Runner re-runs
`applyPunches` for the other visible questions whose rules read that question
(`questionDependencies`), so a source and target side by side react as the
respondent clicks.

**Two views, one rule**:

- *Simple* row — Source question · option · is / is not selected · action ·
  target question · option(s). `optionRule()` builds the PunchRule;
  `simpleView()` reads one back **only when it is that simple** (never
  flattens a complex condition).
- *Expression* — `IF <condition> THEN SELECT Q2.B, Q2.C [AND DESELECT Q3.A]`,
  `CLEAR Q4`, `HIDE Q2.C`. `parsePunchExpression()` hands the condition to
  `parseLogicExpression` verbatim; `formatPunchExpression()` prints it back
  (round-trips). Several target questions in one THEN become one rule per
  target. Option references accept the code or the label.

The logic expression parser also learned the spelled-out forms `Q1.A IS
SELECTED`, `Q1.A = SELECTED`, `Q1.A IS NOT SELECTED`, `Q1.A SELECTED` (they
used to parse as "Q1 equals the text SELECTED").

**Where**: the **Logic tab → Auto punch** panel lists every rule survey-wide
(add simple, add by expression, edit, move between targets, remove); the same
rows appear on the target question's masking section (`AutoPunchRows`). The
older set-based punching ("FOR EACH option in Q5.Selected") is untouched and
sits below it.

## 3. Preview block

`packages/engine/src/flow.ts` (`start(def, state, counts, { startAt })`,
`findBlockStart`, `RuntimeStep.nodePath`) · `dependencies.ts`
(`blockDependencies`) · runtime `/preview` (`startAt`, `answers`) · Runner
(`startAt`, `seedAnswers`) · Studio `PreviewBlock.tsx`, `previewWindow.ts`

Every block header has **▶ Preview block**. It opens the real runtime — same
Runner, same compiled flow, same logic / piping / masking / page breaks /
punching — entered at the block's first page. `compileFlow` now stamps each
page step with `nodePath` (ids of every enclosing node), which is how the
entry step is found against the *current* answers.

- The draft is flushed first; the preview bar shows `Preview block · <name> ·
  rev N`. The tab is opened synchronously in the click (popup blockers).
- `blockDependencies(def, blockId)` = the earlier questions the block reads
  (display logic, piping, masks, punches, branch/loop conditions on every
  container around it) minus its own. When non-empty, a dialog offers **Set
  test values** for exactly those questions (choice → checkboxes / select,
  numeric → number, else text); "Preview without test values" is one click.
- A block that is **not reachable** with those values (its display logic or an
  enclosing branch hides it) is reported in the preview (`rs-start-note`) and
  the preview starts at the first page — never silently somewhere else.
- One preview tab is shared by Preview and Preview block (`previewWindow.ts`);
  live edits keep pushing to it with the entry point intact.

## 4. Universal media URL rendering

`packages/engine/src/media.ts` · `apps/runtime/components/Media.tsx`
(`SafeImage`, `MediaEmbed`) · Studio `MediaUrlInput.tsx`

`resolveMediaUrl(url) → { kind, provider, url, id?, mimeType?, reason?, note? }`

| input | kind | rendered as |
|---|---|---|
| `youtube.com/watch?v=ID`, `youtu.be/ID`, `/embed/ID`, `/shorts/ID` (+`t=1m30s`) | embed / youtube | `youtube-nocookie.com/embed/ID?rel=0[&start=90]` iframe |
| `vimeo.com/123` | embed / vimeo | `player.vimeo.com/video/123` |
| `drive.google.com/file/d/ID/view`, `open?id=ID`, `uc?id=ID` | embed / google_drive | `drive.google.com/file/d/ID/preview` + note "must be shared: Anyone with the link" |
| `.jpg .jpeg .png .gif .webp .avif .svg` (query strings ignored), `?format=jpg` hints, extension-less CDN URLs | image | `<img>` with graceful "Unable to load image" on error |
| `.mp4 .webm .ogg .mov` | video | `<video controls>` with the right MIME |
| `javascript:`, `vbscript:`, `file:`, non-image `data:`, unknown scheme | unsupported | an explicit note with the reason — never rendered |

Only hosts on `EMBED_ALLOWLIST` are ever put in an iframe (`isAllowedEmbed`).
Iframes are sandboxed and lazy.

Where it is used: every option image (`o.imageUrl`) across QuestionRenderer
and the variant files (`SafeImage`; clickable stimuli — hotspot, regions,
annotation — pass `imageOnly`), the survey logo, the media family's stimulus
(direct video keeps the tracked `<video>`; an embed plays but tells the
programmer playback tracking is unavailable), experiment arms, and two new
slots: **question media** (`settings.mediaUrl`, shown under the question text
for every non-media-variant question) and **block media** (`mediaUrl` on
`page`/`block` flow nodes, resolved page → block, shown under the block name).

The Studio's `MediaUrlInput` prints the resolver's verdict as you type
("✓ YouTube · embedded player", "⚠ “javascript:” URLs are not allowed").

## Tests

- `packages/engine/src/autoPunch.test.ts` (17): simple form ↔ PunchRule,
  additive select / deselect, single-select punch, same-page re-punch, CLEAR /
  SET, list actions through the pipeline, SHOW restores, expression parse /
  errors / round-trip, `start({startAt})` reachable and unreachable,
  `blockDependencies`, media resolver for every provider and every refusal.
- `packages/engine/src/optionsPaste.test.ts` (5): parser, replace by code, by
  label, append without duplicates, print → plan identity.
- `scripts/autopunch-media-test.mjs` (browser): paste box pre-fill / Replace /
  Append; visual rule → stored PunchRule → runtime punch; expression rules
  (complex condition, two targets, errors); same-page live punch; HIDE /
  DISABLE; Preview block dialog → seeded popup starting at the block →
  through the page break; unreachable block; YouTube / Drive / CDN / mp4 /
  `javascript:` / `data:text` rendering with the host allow-list; Studio
  verdicts.
- Existing suites updated for the new behaviour: `studio-test` (paste box
  opens pre-filled, Append), `variants-g6-test` (shared media test ids).

## Acceptance criteria → where proven

| criterion | proof |
|---|---|
| Paste shows existing options, Replace default, Append explicit | studio-test, autopunch-media-test §1 |
| Logic referencing kept options survives a paste | optionsPaste.test "replace keeps identity by code" |
| Q1.A selected → Q2.B auto-selected (visual + expression) | autopunch-media-test §2–3, autoPunch.test |
| Complex AND/OR/NOT conditions via the existing parser | autoPunch.test "several targets…", browser §3 |
| No second logic engine | `autoPunch.ts` imports `evaluateCondition` / `parseLogicExpression`; no evaluator added |
| Preview block starts at the block with all behaviour intact | browser §6 (punch fires, page break, end) |
| Dependencies detected, test values offered | browser §6 dialog, `blockDependencies` test |
| Preview uses the latest saved revision | draft flushed before push; bar shows `rev N` |
| YouTube / Drive / image / mp4 render; bad URLs refused | autoPunch.test media, browser §7 |
