# Hidden questions, auto-punch visualisation, stale preview — 2026-10-24

Client brief 19/10/2026, items **A15** (Read Only removed; Hidden means "hidden from respondents", not "hidden from the programmer"; a purple test theme; auto-punch made visible) and **A66** (preview keeps stale auto-punch data after a builder change). Engineer H2.

## Where to find it

| Feature | Where |
|---|---|
| State section, Hidden only | Studio → Questions → select a question → Properties → **State**: one `hidden` checkbox (`data-testid="state-hidden"`), with the note "hidden from live respondents · visible in Preview / Test". There is no Read Only checkbox. |
| Hidden-question theme + auto-punch status | Studio top bar → **Preview** (runtime `/preview`), and the runtime's **test mode** (test links `/t/<client>/<study>`, opened by **Test Survey**). The question card is drawn in light purple (#F3EEFF) with a dashed purple border (#9B7BEA), an info banner, an eye-slash, the badge **HIDDEN QUESTION — PREVIEW MODE** or **— TEST MODE**, **"Q6 — 🔒 HIDDEN"** and the footer **"Visibility: Hidden from live respondents"**. |
| Auto-punch visualisation | Same places, on any question with answer-side punch rules (hidden or not): punched option(s) in green with an **AUTO-PUNCHED** badge, **Auto-Punch Status** (🟢 Applied / 🟡 Waiting for Condition / 🔴 Failed / ⚪ No Matching Condition), **Selected Answer**, and an expandable **Auto-Punch Details** table (source question, condition in words, target, selected option, TRUE / FALSE / NOT REACHED, status), one block per rule in an IF / ELSE IF / ELSE chain. |
| "As a respondent" | The preview bar → **as a respondent** checkbox: the page exactly as a live link draws it (hidden questions gone, no chrome). |
| Live / published link | `/s/<client>/<study>` and every other respondent entry: hidden questions are not drawn at all. |
| Intelligent Mode | `update_question { hidden: true \| false }`. |

Environment variables: none new. Works with the in-memory sandbox (`AI_API_URL=fake:`, no `SUPABASE_*`) for the builder and Preview. Test links and live links need a database, as before.

## What changed

### 1. Read Only removed (A15 §2)
- `apps/studio/components/studio/PropertiesPanel.tsx` (State section only): the read-only checkbox is gone. The section's "active" dot no longer counts `readOnly`.
- **Old definitions are tolerated, not migrated.** A question that still carries it shows "legacy read-only is on · clear" in State. `settings.readOnly` stays in the schema (default `false`), so every saved survey still parses. A survey that already has `readOnly: true` keeps the old behaviour (inputs disabled) in the renderer. It just can't be set any more. I didn't add a normaliser migration: silently enabling input on questions in published versions would change live surveys, and a frozen version can't be rewritten anyway.
- Composite-table **column** `readOnly` (`QuestionColumn.readOnly`) is a different setting and is untouched.

### 2. Hidden = respondent visibility (A15 §3, §8, §11)
- `packages/engine/src/flow.ts`: `visibleQuestions(def, step, state, counts, { revealHidden })`. With `revealHidden`, `settings.hidden` questions are included. Display logic, display rules and List Fill still apply. Hidden-*type* questions (hidden variable, calculated, embedded data) are never drawn.
- `start / advance / goBack / resumeAt` accept the same option. In `moveForward`, "does this page have anything to show?" is answered for the viewer:
  - **Respondent:** a page holding only hidden questions is passed over. No empty page, no extra page break.
  - **Programmer:** the page is shown.
- Pruning, prefill and default values still run on the **respondent's** set only. A hidden question's answer belongs to its punch rules (`punchDerivedQuestions`, unchanged), so the programmer's view changes nothing about the data.
- `apps/runtime/components/Runner.tsx` keeps two lists:
  - `questions` is the respondent's page. It is what gets validated, pruned and punched from, so a **required hidden question never blocks Next**.
  - `pageQuestions` is what is drawn: the same list plus the hidden questions in preview / test.
  - Conversational mode walks `pageQuestions` and skips validation and acknowledgement for hidden ones. Every navigation call passes the view.
- Background logic is unchanged and still runs on live links: auto-punch, display / skip / branch logic, piping, calculations, carry-forward. The punched value is stored in the response exactly as before.

### 3. How the mode is detected (A15 §11, brief item 6)
- `revealsHiddenQuestions(mode, respondentView)` in `packages/engine/src/hiddenPreview.ts` returns true only for `"preview"` and `"test"`. Anything else, including an unknown mode, counts as live.
- `mode` is fixed by the route that serves the page:
  - `app/preview/page.tsx` sets `"preview"`.
  - `app/t/[client]/[study]/page.tsx` sets `"test"`.
  - `app/s/...` and the other respondent entries set `"live"`.
- **No query parameter is read.** The preview's "as a respondent" switch comes from the preview bar or the Studio's postMessage (`respondentView`), not the URL, and only applies in preview mode.

### 4. Theme on every question type (A15 §4, §7, §10.1, §10.4)
- `packages/renderer/src/programmerView.tsx` (new) holds `programmerCardClass`, `HiddenQuestionHead`, `ProgrammerFoot` and `autoPunchCss`. CSS is at the end of `packages/renderer/styles/questions.css`.
- `QuestionRenderer` takes an optional `programmerView` prop and draws the chrome on the **container**, for the standard card and the HTML block. That means every type gets it: single, multi, dropdown, text, numeric, grids, rating, ranking, allocation, MaxDiff / conjoint, media, custom. Without the prop (live, the builder canvas, every other caller) the DOM is exactly what it was.

### 5. Auto-punch visualisation (A15 §5, §6, §10.2, §10.3)
- `explainAutoPunch(def, q, ctx, loop)` reports, per question, what its punch rules did against the current answers:
  - `status`, `punchedCodes` / `punchedRows`, `selectedAnswer`, `expectedCodes`;
  - per rule: sources, condition in words (`conditionSummary`), target, action, labels, TRUE / FALSE / not reached (via `walkPunchChain`), status.
- It is pure (reads state, writes nothing) and the Runner recomputes it on every render, so it follows the source answer as it changes.
- Status rules:
  - **applied:** a rule holds and the answer carries what it punched.
  - **waiting:** no rule holds and one of the source questions is unanswered.
  - **none:** no rule holds and the sources are answered.
  - **failed:** a rule holds but the answer doesn't carry its value (for example an unmatched code, or a `once` rule over a manual answer).
- Green is applied by a stylesheet scoped to `.rs-card[data-qid=…]` that targets the `data-rs-el="option"` / `"row"` anchors every option renderer already emits. **Manual selections are not in `punchedCodes`, so they keep the theme colour.**

### 6. Stale preview (A66)
- **Fingerprints:** `questionConfigFingerprint(q)` is an FNV-1a hash over the parts of a question that decide what its answer may hold and how it is filled:
  - included: type / variant, Hidden, Read Only, default value, expression, option codes and flags, row codes, column ids / types / codes, punch rules, display logic, carry-forward, masks, list logic, option pipeline;
  - not included: text, labels, instructions or style.
- **Invalidation:** `invalidateStalePreviewAnswers(def, answers, previousFingerprints)` drops every stored key of a changed or deleted question (`id`, `id@loop…`, `id__…`). It also drops the stored keys of every punched question that reads one, transitively. All other answers are kept.
- **Where it runs:**
  - `cachePreviewState` (runtime `lib/resume.ts`) now stores `fingerprints` with the tab's snapshot.
  - On **reopen**, the Runner invalidates, resumes on the same page, then recomputes the punches (`punchDerivedQuestions` plus the page prefill).
  - On a **live push** while the preview is open, it does the same against the fingerprints of the previous push.
  - A plain reload or Back / Next changes no fingerprint, so nothing is cleared.
  - Every invalidation is written to the debug log as `[preview] configuration changed for …`.
- Switching **as a respondent** while standing on a hidden-only page settles the position forward (or back, if nothing follows), so it never shows an empty page.

### 7. Intelligent Mode / engine
- `update_question` takes `hidden: boolean`. Its description says "hidden from respondents (shown in preview and test, auto-punch still runs)" or "shown to respondents".
- A request that names `readOnly` / `read_only` is not refused. The other changes go through and the description adds "Read Only not applied — it is no longer a question state; use hidden". A request with **only** Read Only is rejected, with the reason given.
- Capability registry entry `platform:hidden_questions` was added, and the public reference pages were regenerated (`node scripts/gen-public-docs.mjs`). The copilot system prompt is unchanged (it's at its cap).

## Tests
- `packages/engine/src/hiddenPreview.test.ts`, 10 tests:
  - mode rules;
  - the live flow skips the hidden-only page and still stores the punched value; the programmer flow shows it; Back and resume follow the same view;
  - a required hidden question doesn't block Next;
  - auto-punch status: waiting → applied → none, failed, the ELSE chain, manual vs punched on a multi-select;
  - fingerprints: what changes them and what doesn't;
  - invalidation: target change, transitive dependants, deleted question, pre-fingerprint snapshot;
  - copilot `hidden` and Read Only.
- `apps/runtime/lib/hiddenQuestionUi.test.ts`, 5 tests: the container chrome rendered with React's server renderer, per mode (live: nothing), hidden vs auto-punch-only, the scoped green CSS, status labels.
- Browser: `scripts/hidden-autopunch-test.mjs`, 9 sections (State; legacy read-only cleared; preview theme; auto-punch green / status / details; follows the source; required doesn't block; live-edit invalidation; reopen invalidation with unrelated answers kept; plain reload; respondent view = live).

- **Existing suites updated to the new contract:**
  - `scripts/codes-sync-test.mjs`: in preview, Q6 (hidden) is shown with the hidden banner and badge, its punch reads Applied, and the visible Q7 has no theme. With "as a respondent", Q6 is never shown and SEGMENT stays coded. The "Maybe + Other" case now fills the specify box; before, the page was refused and the case never left page one.
  - `scripts/listfill-test.mjs`: the hidden List Fill source is shown with the hidden theme in preview, is not rendered as a respondent, and still feeds the allocation.

## Not done / limits
- **Test links and live links are not driven in the browser suite.** `/t` and `/s` load the deployment from the database, and this environment has none. The test link uses the same `reveal` path as the preview (`revealsHiddenQuestions("test")`, unit-tested). The live behaviour is proved in the engine test and in the preview's respondent view, which is the same Runner path with `reveal = false`.
- **The builder canvas** (Studio LiveCanvas) shows a hidden question plainly, as before (it has always been visible there). The purple theme is drawn by the runtime only.
- A preview snapshot stored **before** this change has no fingerprints, so it isn't invalidated on its first reopen. The next checkpoint stores them.
- `readOnly: true` on an existing question keeps disabling its inputs until it is cleared. The State section shows "legacy read-only is on" with a **clear** button for such a question (`data-testid="state-clear-readonly"`); it never offers to set it.
