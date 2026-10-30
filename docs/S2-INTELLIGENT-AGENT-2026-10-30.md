# S2a — Intelligent Mode as an agent, part A: it reads requests correctly and can reach what the platform already has (2026-10-30)

Branch `feat/persistent-execution-engine`, from `b86204e`. Audit: `SCRIPT-STUDIO-AUDIT-2026-10-30.md` §4 D9, D10, D13, D16 and §6; auditor evidence S3 §2.2, §2.5, §4, §8. The owner's 15 sentences are Phase 4.4.

Part A does **not** add an execution/verification layer or new script stores. It fixes how a request is read and lets Intelligent Mode reach native features that already existed. S2b and S2c are listed at the end.

## What changed

### D9: the look-only classifier no longer blocks native solutions
Files: `apps/studio/lib/copilot/prompt.ts` (`uxIntent`, `classifyRequest`, `copilotUserPrompt`, `policyRefusal`) and `packages/engine/src/surveyActions.ts` (`applySurveyActions`).

- **Behaviour words.** These words now mean *behaviour*: script, scripting, JavaScript, js, event handler, prefill / pre-populate, default value / answer, interaction(s), interactive, dynamic ui, countdown, timer, timed.
  - They send the UX guide.
  - They never make a request look-only (`uxOnly`).
- **Look words stay look-only:** colour, font, theme, style, "look better/modern/premium…", "appear as/like". New in this pass: "look like … premium / modern / professional / polished / sleek / app / application / web app / website" (owner #11 now gets the UX guide).
- **`classifyRequest` returns `uxBehaviour`.** It is true when the sentence asks for behaviour: something shown, hidden, punched, skipped or terminated *when* something happens, or any behaviour word.
  - The route sets `uxBehaviour = uxOnlyInferred && classified.uxBehaviour` and passes it to every `applySurveyActions` call (first pass, retries, repair, staged).
  - It is also sent in `context` and replayed by the browser (`useCopilot` → `ProposalStep.uxBehaviour` → `client.ts`).
- **Gate.** Under inferred look-only with `uxBehaviour`, these native behaviour ops pass:
  - `update_option` (visibleIf only)
  - `add_skip`
  - `create_embedded`
  - `set_default_value`
  - `add_punch`
  - `set_validation`
  - `set_navigation`
  - `update_question`, with type/settings only and the **same response model**. This is checked after the op is applied, so single choice → timed single choice passes and single → multi is refused.

  New questions, blocks, wording and codes stay refused. A look-only request the researcher *said* ("don't change the logic") still refuses all of them.
- **Repairable refusal.** An *inferred* look-only refusal has its own wording: "this request reads as look-and-behaviour only (inferred from its words, not said) … native behaviour actions …".
  - `policyRefusal` only matches the *said* wording, so an inferred refusal now goes to the one repair call with its reason instead of ending the turn.
- **Prompt line.** When look-only and behaviour are both set, the user prompt says "THE LOOK AND A BEHAVIOUR: … prefer the native actions … over a script". The system prompt is unchanged (it is at its cap).
- **Prefill from a URL parameter.** `set_default_value` accepts a piped default (`"{{age}}"`) whose names exist as a question, a variable or embedded data. Before, it was refused on a numeric question as "must be a number". The runtime already resolved piped defaults (`defaultValue.ts`). Unknown names are refused with "create the embedded data first".
- **Intended test changes.** Two production-corpus cases (`75def4c7`, `41fac26c`, both "…JavaScript…") are now `uxOnly: false`. "Set the default value of Q2 to 19" is now UX-guided but not look-only. `classifyRequest`'s shape gained `uxBehaviour`.

### D10: debug / why / explain a script
New file: `packages/engine/src/scriptExplain.ts`.

- **What it does:**
  - `scriptQuestion` recognises a debug / why / explain / diagnose / "what does" / "the script … does not work" sentence that names a script (script, JavaScript, js, code, behaviour, component, or a script's own name).
  - `findScripts` resolves which scripts it means: by name, by "on/of Qx", by the selection, or all of them when there are 5 or fewer.
  - `scriptReadsWrites` lists what a script reads, writes, which events it listens to, its effects and its page hooks.
  - `scriptCheckOf` gives the check verdict: the authoring gate for a behaviour script, `codeGate("logic")` for a Scripts-panel script.
  - `scriptDossier` is what the copilot receives: each script **in full** (up to the schema's 20,000 characters, not the 600 / 4,000-character excerpt), its verdict and warnings, reads/writes, and field health.
  - `explainScripts` is the engine's own answer when there is no model.
  - `sanitizeScriptHealthLite` bounds the health summary the page sends.
- **Engine (`nlIntent.ts`).** These sentences are no longer `DEFER_TO_GRAMMAR`. The engine returns `kind: "model"`, reason `SCRIPT_QUESTION_REASON`, and a new `fallbackAnswer`. `InterpretContext.scriptHealth` is optional.
- **Studio (`IntelligentView.tsx`).** For a script question:
  1. It loads the script-health summary through `loadScriptHealthSummary` (new, `components/studio/ScriptHealth.tsx`; the same cache as the chips; 2.5 s timeout).
  2. With a model, it asks the copilot and sends `scriptHealth` in the turn body (`useCopilot.ask` gained an `extra` body argument).
  3. With no model (none configured, or internal mode), or when the model returns nothing usable, it shows the engine's answer card.
  4. The grammar's "I could not find …" is never reached.
- **Route and outline.** The route sanitises `body.scriptHealth`. `copilotOutline(…, { scriptQuestion })` appends the dossier.

### D16 / IM-22: native settings Intelligent Mode could not reach
- **Soft validation (owner #7).** `set_validation` rules carry `severity: "warning"` (also accepted as `warn` / `soft`) through coercion into the stored rule. Without it a rule blocks the respondent, as before.
- **Randomization method.** `set_option_randomization` carries `method`: `rotate`, `reverse_half` or `shuffle`. "balanced" and "latin square" map to `rotate`. Any other value is refused. The description says "rotated (each in each position equally often across respondents)".
- **Variant settings.** `update_question` takes `settings`.
  - Coercion keeps plain values only, at most 12 keys.
  - When applied (`applyVariantSettings`), only the keys the variant declares in the registry (`defaults.settings`) are allowed.
  - Each value is checked against the question schema's own field. The new `questionSettingField(key)` in `packages/schema/src/question.ts` does this, so an `onTimeout` enum is enforced. Numbers are bounded (`timeLimitSeconds` 1–3600).
  - The refusal lists the keys the variant does allow.
- **"Equally" (owner #8).** The randomization recogniser reads equally / evenly / balanced / "equal exposure" / rotate / बराबर / समान रूप से as `method: "rotate"` and strips "across respondents". "These four concepts" resolves to the selection. Block randomizers were already balanced (`evenPresentation`, `balance.exact` with `show`).
- **Owner #9.** "add a 30-second countdown to Q5" becomes `update_question type "gamified.timed" settings {timeLimitSeconds: 30, onTimeout: "lock"|"advance"}` when Q5 is single choice; see the engine recognisers below.
- **UX guide.** One line now covers "native settings before a script": soft warning, rotate, timed variant, countdown script shape, URL prefill. `actions-reference.md` was regenerated.

### D13 / IM-18 / IM-24: gate accuracy (`packages/engine/src/uxScriptGuard.ts`)
- **Refused, with the native route named:**
  - `.click()` on Next / Back. The fix offered is `rs.goToPage` / `rs.goToSection`, the timed variant with `onTimeout: "advance"`, or validation. The receiver is matched directly or through the variable it was assigned from.
  - `.click()` on an option or input. The fix offered is `set_default_value`, `add_punch`, or `rs.setAnswer` into a hidden variable.
  - `preventDefault` in code that names navigation or a submit / keydown event. The fix offered is validation.

  A `.click()` on an element the script created itself is allowed.
- **Tick vs polling.** A function that re-schedules itself with `rs.after` / `setTimeout` is refused as polling only if it **looks an element up inside the loop** (querySelector / getElementById / getElementsBy… / closest). A countdown tick that updates its own element passes.
- **Static image: decision.** It is **kept refused**, with a new message.
  - The host mirror cannot show an image a script makes: `packages/renderer/src/uxDom.ts` `CREATE_TAGS` has no `img`, and `DROP_ATTR` drops `src` / `srcset` on every created element.
  - Allowing it would let the card say "checked" for an image that never appears.
  - When a script creates an `<img>` and every `src` is a literal `https:` string, the reason now says "a script cannot show an image … Show it natively: a content question holding the image with display logic …, or the option's own image" instead of the exfiltration wording.
  - `new Image()`, computed or concatenated addresses, template literals and answers in the URL keep the exfiltration wording.
- **491-script corpus.** **0 entries changed.** Runtime verdict texts and authoring refusals are byte-identical, so `src/fixtures/script-corpus.json` was not touched. During development one entry (`837599df766e`, the `this["Ima"+"ge"]` pixel probe in `ux-copilot-test.mjs`) briefly changed wording. The static-image rule was narrowed (it must create an `<img>`, with no computed member access) so that entry keeps the exfiltration wording.

### Engine recognisers without a model (`nlIntent.ts` `ownerIntents`, read whole before an "and" split)
- **#2.** "(automatically) punch / select option N when option M is selected" uses the selected question or "of / in / at Qx". Both word orders work. Devanagari: पंच / ऑप्शन / चुना / सिलेक्ट.
  - It produces `add_punch {target, when: "Qx = M", codes: [N]}`.
  - On a single-choice question it is refused, and the reason points to a hidden variable instead.
  - A missing option is named.
- **#9.** A countdown with a length (seconds, minutes, सेकंड; "then go to the next page" sets `onTimeout: "advance"`) becomes the timed variant.
  - With no length, it offers a choice card: 10 / 30 / 60 seconds, each a sentence the engine reads.
  - On a question that is not single choice it goes to the model, with the honest reason (a countdown script) and a card.
- **#5 / #15.** "Create a drag-and-drop ranking question" and "Create an (interactive) video-testing experience" (English and Hindi) go to the model with a fallback card.
  - The card names the variant (`ranking.drag`, `media.video_rating`) and asks only for the wording.
  - No failure card is shown without a model.
- `withFallback` no longer overwrites a recogniser's own `fallback` / `fallbackAnswer`.

### `ux-copilot-test.mjs`: the line-244 timeout was environmental
- **Cause.** The box's memory cgroup (`claude-code-bash`, `memory.limit_in_bytes` = 6,270,050,304) covers every process started here.
  - With the dev Studio, the dev runtime and Chromium running together, dmesg shows "Memory cgroup out of memory: Killed process … next-server" (anon-rss 2.8 GB on run 1, 3.5 GB on run 2).
  - This happened while the Studio compiled `/sandbox` and its routes after the runtime half.
  - The supervisor restarted the Studio cold, and the first turn then compiled `/api/copilot/turn` inside `say()`'s 30 s. The log shows the turn itself returned 200.
- **Changes to the test:**
  - It warms the Studio (page plus copilot routes) before the runtime half.
  - The first turn gets 120 s.
  - `UX_COPILOT_HALF=runtime|studio` runs one half. The Studio half needs no runtime: `UX_COPILOT_HALF=studio /tmp/p0/fresh.sh --no-runtime ux-copilot-test.mjs`.
- **Result:**
  - The Studio half alone passes **6/6**, including the said look-only refusal, Apply, "make it slower", JavaScript on request, the UX tab and undo.
  - The runtime half was 7/7 in both full runs. Both full runs ended in the OOM kill.

## The owner's 15 sentences: before / after
Fixture: S3's fixture (Q1 brand … Q8 concepts) plus Q9 numeric age and a behaviour script on Q5. The tests are in `apps/studio/lib/copilot/ownerSentences.test.ts`.

**Column meanings:**
- **Class** = `classifyRequest` (mode / `ux` / `uxOnly`).
- **Engine** = `interpretRequest` with no model.
- **Native path** = the model-shaped native reply passed through `coerceSurveyActions` → `applySurveyActions` under that class, which is exactly what `route.ts` does.

| # | Sentence | Before (S3 §4.2) | After S2a |
|---|---|---|---|
| 1 | Answer options as interactive cards | ux, uxOnly; model; native path OK | ux, **uxOnly** (look: "appear as"); model; `set_theme` cards + scoped style **accepted** |
| 2 | Punch option 5 when option 2 is selected (Q7) | edit; model (no recogniser) | edit; **engine: `add_punch Q7 when Q7 = 2 codes [5]`, applied — works without a model** |
| 3 | Show Q5 only when Q2 = 1 and Q3 > 5 | works without a model | unchanged: works without a model |
| 4 | Matrix → responsive mobile (Q4) | ux; model | ux (not only); model; responsive rule (→ `create_style` mobile) **accepted** |
| 5 | Drag-and-drop ranking question | edit; model; no fallback | edit; model **with a card naming `ranking.drag` and asking for the wording**; `create_question ranking` accepted |
| 6 | Automatically rank selected answers (Q7) | question; model; ambiguous | unchanged (question; model); `create_question ranking` + `set_mask Q7.Selected` accepted |
| 7 | Warning when the total exceeds 100% (Q6) | **partial**: `severity` dropped | ux (not only); model; `set_validation … severity "warning"` **accepted and stored as a soft warning** |
| 8 | Randomize four concepts equally (Q8) | **misread**: "equally" dropped → shuffle | edit; **engine: `set_option_randomization Q8 method "rotate"` — works without a model** |
| 9 | Countdown timer on this question (Q5) | **blocked** (uxOnly) and impossible | ux (**not only**); engine: **choice of 10/30/60 s**, each → `update_question gamified.timed timeLimitSeconds`; the model's `update_question … settings` **accepted and stored** |
| 10 | Image when a brand is selected (Q1) | question; model; script route refused as exfiltration | question; model; content question + display logic accepted; the script route's refusal now **names that native route** |
| 11 | Premium modern web application look | **at risk**: no UX guide | **ux, uxOnly** (UX guide sent); model; `set_theme` accepted |
| 12 | Interactive conjoint exercise | **blocked** (uxOnly refuses `create_conjoint`) | ux (**not only**); model (methods); `create_conjoint` **accepted** |
| 13 | Highlight unanswered before submission | ux, uxOnly; model; partial | unchanged (look-only is right); `set_navigation sectionNav free` accepted |
| 14 | Add a custom validation rule (Q5) | edit; model | unchanged; `set_validation condition` accepted |
| 15 | Interactive video-testing experience | **blocked** (uxOnly refuses `create_question`) | ux (**not only**); model **with a card naming `media.video_rating`**; `create_question video_timeline` **accepted** |

**Summary.**
- **Before:** 1 worked without a model, 1 was misread, 3 were blocked, 1 was at risk, 1 was partial, 8 needed a model.
- **After:** all 15 have a non-blocked path. 3 work without a model (#2, #3, #8). 3 more get a deterministic choice card without a model (#5, #9, #15). #7's soft warning, #8's rotation and #9's timer length are now reachable. 0 are blocked.

**S3's stand-ins:**

| Stand-in | Before | After |
|---|---|---|
| "Write a JavaScript that hides option 3 of Q5 when Q2 is 1" | uxOnly; `update_option visibleIf` refused | ux, **not only**; accepted |
| "terminate respondents under 18" | uxOnly; `add_skip terminate` refused | not only; accepted |
| "Prefill Q1 with the URL parameter age" | uxOnly; `create_embedded` and the piped default refused | ux, not only; `create_embedded url` + `set_default_value "{{age}}"` accepted and stored |
| Debug / why / explain the script on Q5 | `defer:grammar` → "I could not find …" | the copilot, with the script in full + check + health; with no model, the engine's explanation |

## Where to find it
- **Intelligent Mode** (Studio → Intelligent).
  - Type "Debug the script on Q5" (or select Q5 and say "why does the script not work").
  - With no model or in internal mode, the card explains the script: what it does, what it reads and writes, its check, and "In the field: …".
  - With a model, the turn carries the dossier. Look for `SCRIPTS THIS REQUEST IS ABOUT` in the prompt.
- **Script health on the card** comes from `GET /api/surveys/[id]/script-health?env=live`. In the sandbox it uses the sandbox token.
- **The Changes card for an inferred look-only turn.** A refused native op now shows the new "reads as look-and-behaviour only (inferred …)" reason, and the repair call runs.
- **New engine exports:**
  - `scriptQuestion`, `findScripts`, `scriptReadsWrites`, `scriptCheckOf`, `scriptDossier`, `explainScripts`, `sanitizeScriptHealthLite`, `SCRIPT_QUESTION_REASON`
  - `applySurveyActions(…, { uxBehaviour })`
- **New schema export:** `questionSettingField`.
- No environment variables were added. No migrations.

## Verification (2026-10-30)

| What | Command | Result |
|---|---|---|
| Engine units | `cd packages/engine && pnpm -s build && node --test dist/*.test.js` | **2480/2480** (new: scriptExplain 4, nativeSettings 3, gateAccuracy 4, ownerIntents 4, ux.test +1) |
| Studio lib | `cd apps/studio && node --experimental-strip-types --no-warnings --test 'lib/**/*.test.ts'` | **1076/1076**, 0 skipped (owner acceptance `ownerSentences.test.ts` 27/27, no skips left) |
| Runtime lib | `cd apps/runtime && node --experimental-strip-types --no-warnings --test 'lib/*.test.ts'` | **57/57** |
| Typecheck | `npx tsc --noEmit -p .` in apps/studio, apps/runtime, packages/renderer | **0 / 0 / 0** errors |
| Public docs | `node scripts/gen-public-docs.mjs --check` | current (actions-reference regenerated) |
| Boundaries | `node scripts/dependency-boundaries.mjs` | 0 violations |
| Auth guard | `node scripts/auth-guard-audit.mjs` | 259 handlers, 0 problems |
| Script corpus | `scriptChecks.test` #14 | 491 scripts, 0 changed |
| Browser `ux-copilot-test.mjs` | `fresh.sh ux-copilot-test.mjs` ×2, then `UX_COPILOT_HALF=studio fresh.sh --no-runtime …` | full runs: runtime half 7/7, then **OOM kill of the Studio** (dmesg) both times; **Studio half alone 6/6** |
| Browser `production-intents-test.mjs` | `fresh.sh --no-runtime` | **7/7** |
| Browser `copilot-test.mjs` | `fresh.sh --no-runtime` | **11/11** |
| Browser `style-script-p0-test.mjs` | `fresh.sh` | 1st run FAIL at the intended D9 change (the "Q3 pe mujhe javascript lagana hai…" turn asserted `uxOnly: true`); the assertion updated to `uxOnly: false`, `ux: true`; re-run **11/11** |
| Browser `age-script-p0-test.mjs` | `fresh.sh` | **10/10** |
| Browser `methods-intelligent-test.mjs` | `fresh.sh` | **14/14** |

OOM deaths recorded (dmesg, memory cgroup 6.27 GB): Studio `next-server` killed twice during the two full `ux-copilot-test` runs (anon-rss 2,828,816 kB and 3,526,524 kB; the second also killed Chromium's headless_shell). No other suite was affected.

## Honest limits
- **Nothing is executed before it is proposed.** The card still says "checked, not run yet". This is S2c.
- **A model's own output quality was not measured.** There is no provider key here, so only the gate's handling of model-shaped replies and the deterministic paths are verified.
- **The behaviour flag reads words, not meaning.** "Style Q5 so option 3 is hidden when Q2 is 1" is behaviour. A behaviour sentence phrased without a when/if/hide/show word still reads as look-only, but its refusal is now repaired once with the reason.
- **The explanation is read from the text** (rs api calls, `get`/`set`, `[data-qid]` hooks). An alias such as `var g = rs.getAnswer` is not followed. Health is only as recent as the cache (60 s) and only for the live environment (the sandbox: test).
- **Variant settings are limited.** Only keys present in a variant's registry `defaults.settings` are settable. Variants without declared settings get none. A full settings catalogue is S2b.
- **#11 without a model** is still read by the engine as `survey_creation` (fallback text), although the server class is right.
- **#6 and #10 are unchanged.** They are model-dependent and ambiguous. A model must ask "which brand" or "rank how".
- **A countdown on a non-single-choice question** is only possible as a script written by a model (the tick is now allowed). There is no native page or question timer for other types.
- **`while(true)` is still accepted** at authoring. It is loop-guarded at run time, as before.

## What S2b and S2c do
S2b is done (Part B below). S2c (the Execution and Verification layer) is done (Part C below).

- **S2c:** the Execution and Verification layer.
  - Each proposed script runs on a mirrored page before the card says it is ready.
  - Failures and "no effect" are fed into the existing repair call.

---

# S2b — part B: a capability registry it consults, and the actions it was missing (2026-10-30)

Commits on `feat/persistent-execution-engine` after `7ab9bdd`: item 1 `1d90ebe`, item 2 `fd7fafe`, item 3 `b80968b`, item 4 `b2a9e65`, item 5 `63dadf2`, item 6 (this doc, the browser check).

## What changed

### 1. The JavaScript capability registry — layer 2, as data (`packages/engine/src/capabilityRegistry.ts`)
- **Native features** (`NATIVE_FEATURES`): validation (every kind any variant offers plus the universal four, `severity: "warning"`), punch, calculation, default value / prefill, display logic, skip / terminate, randomizer (shuffle / rotate / reverse_half, block randomizer with exact balance), section navigation, timers, assessments, question media, variants and their settings, embedded data, loops, popups, logic scripts. Each lists the actions that reach it.
- **The sandbox** (`SANDBOX_API`, `SANDBOX_EVENTS`, `SANDBOX_LIMITS`): every `rs.*` method with its effect (keyed by `UX_SCRIPT_API` — a method added there and not here is a type error and a failed test), every `rs.listen` event including `validate` (rs.error stops Next) and `submit`, the four write requests, the S1 write-scope rule, and the limits (no network, no storage, no layout of its own, `rs.after` ≤ 60 s, a mirror page).
- **What a script cannot do** (`NATIVE_ROUTES`, 13 entries): press Next, choose an answer, stop the respondent, inject CSS, show an image, know a clip was watched, network, storage, polling, timers > 60 s, layout, skip/terminate, the window — each with the native route and its actions.
- **`nativeRouteFor(need)`**: deterministic; a "cannot" route wins over a feature. Used by:
  - `uxScriptGuard.ts` — the press-Next, choose-an-answer, preventDefault, `<style>` and static-image refusals now end with `nativeRoute(id)` (byte-identical text for the first four; the static-image route now also names `set_question_media`).
  - `scriptExplain.ts` — a refused script's explanation gains "Native route: …" when its refusal does not already name one.
- **`variantCatalogue()`**: all **173** variants — id, family, base type, one-line purpose, settable settings with type and limits read from the question schema's own field (`questionSettingField`) and `SETTING_BOUNDS`.
- **`settableSettings(variant)` / `settingProblem(variant, key, value)`**: the gate's rule for settings — the variant's declared keys (`defaults.settings`), the keys its capabilities imply (`layout_columns` → `columnsLayout`, `min_max_selections`, `numeric_bounds`, `sum`, `search`, `other_specify`, `speech_input`, `geo_settings`), its family's presentation keys, and `validationPosition`; keys another action owns (hidden, defaultValue, expression, the stimulus, a design) are excluded.
- **Renderings**: `capabilityGuideText()` (7.8k chars) and `variantCatalogueText({families})`.

### 2. Variant catalogue guide + settings
- `apps/studio/lib/copilot/variantGuide.ts` (re-exported by `guideSelect.ts`): `variantFamiliesNamed(message, selectedVariant)` reads interaction words (hotspot / heatmap, swipe, quiz / timer / countdown, map / location, video / audio, card, slider / stars / NPS, annotate / draw, signature / upload, drag / sort / rank, carousel, date, matrix, constant sum, compare, chat, attention check, image / picture / pack shot, "interactive") and a selected question whose variant is interactive. `variantGuide(families)` sends those families in full and an id-only index of the rest — about 3–9k characters for one family, under 16k for six; the whole catalogue (34k) is never sent.
- `copilotUserPrompt` adds it (not in plan-only prompts; `variants: false` turns it off); the route passes `selectedVariant`.
- `update_question.settings` reaches every settable key with per-variant validation; **`create_question` accepts `settings`**, checked against the variant it makes; coercion keeps lists of plain values (tools, weekdays, time slots).

### 3. `set_question_media` (D16 / AQ-05 / MM2-16) — `packages/engine/src/mediaActions.ts`
- Sets or clears a question's stimulus: `items [{url, alt, title}]` (≤ 10) → `settings.mediaItems` with `mediaUrl` = the first; `layout`; `altText` / `decorative` → `settings.accessibility`; `requireComplete` (watch-to-continue) **only on the media variants**, where the renderer locks the rating and the engine refuses Next until the clip has finished — elsewhere refused with the route (`update_question type "media.video_rating"` first); option images `options [{option, imageUrl | null, imageAlt}]`; `clear`.
- URLs: https without credentials or private hosts (`safeHttpsUrl`) that `resolveMediaUrl` can show (the editor's rule: known video providers, direct image / video; never `javascript:` or a non-image `data:`), or the survey's media library `/api/media/<id>…`. A piped address is refused (set it in the editor). An option picture must be an image.
- Documented in the UX guide (`copilot.test` docs check), the variant guide header, `actions-reference.md` (new generator block) and the registry.

### 4. Scripts-panel (logic) scripts (IM-17) — `packages/engine/src/logicScriptActions.ts`
- `create_logic_script {name, scope, ref, event, code}`, `update_logic_script {script, code | edits [{find, replace}], event, scope/ref, name, notes}`, `remove_logic_script {script}`, `set_logic_script_enabled {script, enabled}`.
- Every code change, and switching a script on, goes through `codeGate(code, "logic")`; a refused script is never stored. `script` resolves by name or id; question scope `ref` by code / variable; page scope by page id or a question on the page; the event is validated (aliases change / validate / submit …). A second script with the same name is refused with "update it instead".
- The UX guide documents the four ops, **native first** (punch / calculation / validation), when a logic script is right (a computation across loop iterations or a list of answers, inspecting a loop), ctx only, and the S1 write-scope rule.
- The outline lists Scripts-panel scripts as writable ("change them by name with update_logic_script") and shows a script **the request names** with its full code (≤ 20,000), so `edits` can quote it.

### 5. Scripts in the dependency graph (D18 / MM-10) — `packages/engine/src/scriptRefs.ts`
- `scriptLiteralRefs(code)`: `rs.getAnswer / setAnswer / getCalc / setCalc / getEmbedded / setEmbedded`, the logic ctx's `get / set / getCalc / setCalc / getEmbedded / setEmbedded`, and `[data-qid="…"]`. **Literal strings only**: `get("Q" + i)` and `m.get("Q1")` are not references.
- `dependencyIndex.ts` gains object kind `script` and edge kind `script` (behaviour scripts and logic scripts), so `impactOf`, the inspector's "used by" and IM impact text say `script “Spend check” — reads Q3` (a delete is "breaks"). The nl dependency answer lists them under "Scripts".
- `delete_question`'s destructive text names the scripts that read the question ("literal references; not changed").
- Renaming a code or variable (`update_question code/variable`) **rewrites the literal references** in scripts' api calls (`rewriteScriptReferences`) and says so ("1 literal script reference to Q2 rewritten (“Age note”)"). Other strings are left alone.

## Where to find it
- Intelligent Mode: "Turn Q1 into a video rating of the ad, watched to the end" → `update_question` + `set_question_media`; "add a hotspot question on the pack shot" → the variant guide is in the prompt (look for `QUESTION VARIANTS (from the capability registry)`); "change the Spend total script to …" → `update_logic_script` with `edits`; "delete Q3" → the Changes card names the scripts that read Q3.
- Engine exports: `NATIVE_FEATURES`, `NATIVE_ROUTES`, `nativeRoute`, `nativeRouteFor`, `SANDBOX_API`, `SANDBOX_EVENTS`, `SANDBOX_LIMITS`, `variantCatalogue`, `variantCatalogueText`, `capabilityGuideText`, `settableSettings`, `settingProblem`, `validationKinds`, `jsCapabilityRegistry`; `coerceMediaAction`, `applyMediaAction`, `mediaUrlProblem`; `LOGIC_SCRIPT_ACTION_OPS`, `coerceLogicScriptAction`, `applyLogicScriptAction`; `scriptLiteralRefs`, `surveyScripts`, `rewriteScriptReferences`; `settingsIn`.
- Public docs: `apps/studio/content/docs/actions-reference.md` (Options and design now 19 ops; "Question media" and "Scripts-panel (logic) scripts" blocks).
- No environment variables, no migrations, no new dependencies.

## The three layers after S2b (audit §6)
| Layer | Before S2b | After S2b |
|---|---|---|
| 1. Research capability registry (`capabilities.ts`) | in place (methodologies, types, analysis, exports) | unchanged |
| 2. JavaScript capability registry | prose in the UX guide; `UX_SCRIPT_API` a bare list | **data** (`capabilityRegistry.ts`), test-synced with `UX_SCRIPT_API`, `UX_SCRIPT_EVENTS`, `variants.ts` and `SURVEY_ACTION_OPS`; gate refusals and explanations read routes from it; the variant guide is rendered from it |
| 3. Execution / verification | "checked, not run yet" | unchanged — **S2c** (done: Part C) |

## Verification (S2b, 2026-10-30)

| What | Command | Result |
|---|---|---|
| Engine units | `cd packages/engine && pnpm -s build && node --test dist/*.test.js` | **2509/2509** (new: capabilityRegistry 11, variantSettings 3, mediaActions 6, logicScriptActions 5, scriptRefs 4; nativeSettings expectation updated — the settings list grew) |
| Studio lib | `cd apps/studio && node --experimental-strip-types --no-warnings --test 'lib/**/*.test.ts'` | **1081/1081** (new: variantGuide.test.ts 5) |
| Runtime lib | `cd apps/runtime && node --experimental-strip-types --no-warnings --test 'lib/*.test.ts'` | **57/57** |
| Schema units | `cd packages/schema && node --test dist/*.test.js` | 18/18 (schema unchanged) |
| Templates units | `cd packages/templates && node --test dist/*.test.js` | 111/111 |
| Typecheck | `npx tsc --noEmit -p .` in apps/studio, apps/runtime, packages/renderer | **0 / 0 / 0** errors |
| Public docs | `node scripts/gen-public-docs.mjs --check` | current (actions-reference regenerated; two new blocks) |
| Boundaries | `node scripts/dependency-boundaries.mjs` | 0 violations |
| Auth guard | `node scripts/auth-guard-audit.mjs` | 259 handlers, 0 problems |
| Browser `im-media-test.mjs` (new) | `fresh.sh im-media-test.mjs` | 1st run: 3 ok then FAIL in the test's own second section (it read the JSON tab and did not return to Intelligent Mode — a test bug, fixed); re-run **4/4** |
| Browser `copilot-test.mjs` | `fresh.sh --no-runtime` | **11/11** |
| Browser `production-intents-test.mjs` | `fresh.sh --no-runtime` | **7/7** |
| Browser `methods-intelligent-test.mjs` | `fresh.sh` | run 1 FAIL after 5 ok (menu-panel timeout) and run 2 FAIL after 8 ok (menubar hover timeout) — both coincide with **OOM kills of the Studio next-server** (dmesg, memory cgroup); run 3 (my runtime supervisor stopped, fresh.sh's own runtime only) **14/14** |
| Browser `logic-scripts-sandbox-test.mjs` | `fresh.sh` | **10/10** |
| Browser `variants-g5-test.mjs` (media) | `fresh.sh` | **ALL PASSED** (22 ✔ lines) |
| Browser `ux-copilot-test.mjs` | `UX_COPILOT_HALF=runtime fresh.sh …`, then `UX_COPILOT_HALF=studio fresh.sh --no-runtime …` | runtime half exit 0 (its log was overwritten by the studio half, so its count was not kept); studio half **6/6** |

OOM deaths recorded (dmesg, memory cgroup): Studio `next-server` killed at uptime 5,999 s, 6,256 s and 6,787 s (anon-rss 4.2–4.3 GB each); the second and third coincide with the two failed `methods-intelligent` runs. No unit test or other suite was affected.

## Honest limits (S2b)
- **Literal references only.** The dependency graph and the rename rewrite see `get("Q3")`, `rs.getAnswer("Q3")`, `[data-qid="…"]`; a name built at run time (`get("Q" + i)`) or an aliased api (`var g = rs.getAnswer`) is not seen. A rename rewrites only the recognised api calls' first argument, never other strings.
- **Custom components are not indexed**: their code is not in the survey definition.
- **The Studio's rename dialog does not yet offer the script rewrite**; the rewrite happens on Intelligent Mode's `update_question code/variable` (and is listed on the card for approval). The Studio's inspector / impact text shows script readers because they come from the same index.
- **Piped media addresses** (`{{ImageURL}}`) are refused by `set_question_media`; set them in the editor.
- **Watch-to-continue** is only where the runtime enforces it (the media variants). With a clip that cannot load (no network here, or a broken address) the runtime deliberately does not lock the answer; the browser check proves the lock with the runtime's own local clip and proves the stored https address is the `<video>` drawn.
- **Settings coverage is a registry decision**: declared keys, capability keys, family presentation keys and `validationPosition`. A schema setting no variant is mapped to stays unreachable by actions (e.g. `scalePointLabels`, `swipeDirections` objects). `matrix.constant_sum` declares `sumTotalPosition`, which the question schema does not have — it is not settable (the schema would strip it).
- **The variant guide is chosen by words**: a sentence that names an interaction in other words gets no catalogue (the gate still refuses an undeclared setting with the declared list, and the repair call carries the reason).
- **Nothing is executed before it is proposed** — logic scripts included ("checked by the logic-script gate, not run yet"). That is S2c.
- **A model's own output was not measured**: fake provider only; the deterministic paths and the gate's handling of model-shaped replies are what is verified.

---

# S2c — part C: the Execution and Verification layer (2026-10-30)

Commits on `feat/persistent-execution-engine` after `1c9c1fa`: item 1 `2909ef1`, item 2, item 3, item 4, item 5, item 6 (this doc) — see `git log`.

The owner's requirement: "Execution and Verification Engine: writes code, executes it safely, checks actual survey behaviour, and verifies that responses are saved correctly." A proposal that contains code is no longer presented as ready until it has run.

## How it works

1. **Which items run** (`packages/engine/src/scriptVerify.ts` `proposalCodeItems`). Every behaviour script, enabled Scripts-panel (logic) script and custom component code that is new or changed in the proposal's clone against the survey before it. Removed items are not run. Model proposals and engine-only proposals go through the same path (the hook watches the open proposal, not who wrote it).
2. **Where they run** (`apps/studio/lib/copilot/verify/harness.tsx`, browser-side, no new dependency). An off-screen container in the Studio's own page (`data-testid="cp-verify-stage"`, removed when done) draws the page that hosts the item (`hostPage`: its question's page, its page, its block's first page, else the first page) with:
   - the real `QuestionRenderer` for each question of the page, in a survey shell with the theme;
   - the real `UxLayer` — its sandboxed frames, mirror DOM, write channel (`onScriptWrite` → `applyScriptWrite` with the scope the Runner gives), validate/submit lifecycle (`lifecycleRef`);
   - for a logic script, the real `LogicFrameHost` with `prepareLogicScripts` / `logicSnapshot` (the Runner's `runLogicEvent`, for exactly this script); its writes go through `applyScriptWrite` with `logicScriptScope`.
   Only the item's own script runs on the stage (other scripts would blur what it did). The state is in memory (`createResponseState`), nothing is posted, no store is written, the draft is never touched. Limits: **5 s per item, 20 s per proposal**; a pause that takes > 2 s longer than asked means the page's thread was blocked (`timeout`).
3. **Scenarios** (`buildScenarios`, seeded with mulberry32 so a set is reproducible). Always "enter the page" (page/load scripts). Trigger questions are read from the code: `rs.listen` events and targets ("self" = its question), DOM listeners (`addEventListener` input/change/click/key…) on `[data-qid]` hooks and its own question, a logic `on_change` script's question/page, a component's `api.onChange`, and the questions it reads (`scriptLiteralRefs`) that are on the page (≤ 3 triggers). For a choice: each option once (≤ 6) and select-then-clear; a number: empty, min, max, typical (declared `min_value`/`max_value`, else 0–100); a text: empty, one character, typical. `validate` / `submit` listeners and logic `on_validate` / `on_submit` / `on_complete`: Next with valid answers and — where a rule exists (the script raises `error()`, or a question of the page has validation) — with invalid-looking ones. A page in a loop: the first two iterations. Answers are **played as a respondent gives them**: a click on the option's input, typing into the box with React's own setter and `input` + `change` events, so a script that listens to the page's DOM events hears what it would hear in the survey; only what has no control (clearing a single choice) is set directly.
4. **What is recorded per scenario** (renderer `UxLayer` new prop `onTrace`, `DomBridge` option `onOp`, sandbox `fail` now reports the error's line): the frame starting; every effect the host applied with the number of elements it actually changed (a removal of an absent class counts nothing); every mirror op (class / style / attr / create / replace / remove) and the question it touched; refusals (an unresolved target, a refused style, a hide of an answer input, refused navigation, a DOM op the bridge refused); thrown errors and rejections with the line; `rs.log` lines; write requests accepted (with the state's value afterwards) or refused (with the engine's reason); Next's outcome (built-in `validatePage` errors, the script's `validate` errors, a logic script's `error()`); watchdog / rate-limit stops and the sandbox's endless-loop and endless-promise-chain guards; duration.
5. **Verdict** (`itemVerdict`):

| Verdict | When | Repair? |
|---|---|---|
| `ran-ok` | no error and at least one observable effect, or `expect.effect: "none"` | no |
| `ran-no-effect` | it ran and did nothing observable in any scenario, or not what its `expect` said | yes |
| `ran-error` | it threw (scenario, message, line), or an accepted value is missing from the state / save payload | yes |
| `blocked` | refused at run time: the code gate, a DOM op / navigation the host refused, a write the engine refused | yes |
| `timeout` | the watchdog, the rate limit, the loop / promise-chain guard, a logic frame that never answered, a blocked page thread | yes |
| `not-run` | the harness could not run it here (no page shows it, its frame did not start, its event never happens in a playable scenario, the 20 s limit) — not the script's fault | no |

   When the 5 s budget runs out between scenarios, the scenarios played stand and the summary says how many were not played — a harness limit is never reported as the script's timeout.
6. **"Responses are saved correctly"** (`packages/engine/src/savePayload.ts`). The Runner's save body is now built by `responseSavePayload(state)` (`Runner.tsx` `saveBody` spreads it). For every accepted write, `savedWriteProblems` checks the value is in the response state, equals what the harness saw, is in the payload exactly as it would be serialised and posted, and is labelled in `scriptWrites` (the server's replay reads that label). A miss is `ran-error`.
7. **`expect`** — an optional field on `create_behavior` / `update_behavior` (coerced in `behFields`) and `create_logic_script` / `update_logic_script`: `{ on: "select Q1=2" | "enter" | "next" | "answer Q3=17" | "clear Q1", effect: "class rs-highlight on Q5" | "message" | "popup" | "write Q9" | "error" | "none" }`. Matched to its item by id, label, target question, or — one hint, one item — directly; checked by `expectHolds`; **never stored** in the definition. The UX guide says scripts are run and names the field.
8. **In the turn** (`useCopilot`): whenever the open proposal's code items change (their signature: code, event, scope, target, expect), the harness runs; `VerifyCard` on the turn card and in *Changes* says "Running in a test session…", then per item "Ran in a test session: 5 scenarios, added class rs-highlight to Q5 on “Brand B”, no errors" / the error / "Could not be run here: …". Apply waits (`verifyBlocks`; `apply()` also refuses while it runs). A failing verdict asks the copilot for **one** repair turn (`Repair the script … that did not pass the test session: “…”`) whose body carries `verifyRepair` — the route sanitises it (`sanitizeVerifyRepair`, ≤ 4,000 characters, ≤ 10 items), fences it as untrusted (it quotes what scripts printed), adds `executionRepairNote` after the guides (new repair reason `"execution"`, `context.repairReason`), and the reply becomes a revision of the open proposal, which is run again. Still failing (or the repair answered in words): "Still failing after one repair — review before applying" and Apply needs the explicit **Apply anyway**. The gate's "checked … not run yet — try it in Preview" is shown as "checked and run in a test session" / "… it did not pass" / "checked, could not be run here: <reason>" (`withRunNote`).
9. **History**: the report is written to the open operation (`intelligent_operations`): `intent.verify` (the summary), `intent.verifyVerdicts`, `intent.verifyMs`, `intent.verifyRepairs`, and one `warnings` line per item ("Test session: <label> — <summary>").
10. **The human preview** (`UxPreview`) now passes `onLog` to `UxLayer` and lists what the scripts say (`data-testid="cp-ux-log"`, audit SE-12 / IM-13).

## Where to find it
- Intelligent Mode → any request whose proposal contains a script ("highlight Q5 when Brand B is picked in Q1", "warn when the total of Q6 and Q7 exceeds 100%"): the card and *Changes* show the test session (`data-testid="cp-verify"`, items `cp-verify-item` with `data-verdict`); after a failed repair, `cp-apply-anyway`. *History* → the operation's warnings carry the verdicts.
- Engine exports: `proposalCodeItems`, `expectsFromActions`, `coerceExpect`, `hostPage`, `surveyPages`, `scriptDeclarations`, `buildScenarios`, `fillAnswers`, `answerShape`, `numericBounds`, `typicalAnswer`, `itemVerdict`, `expectHolds`, `verificationSummary`, `executionReportText`, `codeItemsSignature`, `VERDICT_NEEDS_REPAIR`; `responseSavePayload`, `savedWriteProblems`.
- Renderer: `UxLayerProps.onTrace` / type `UxTrace`; `DomBridgeOptions.onOp`.
- Studio: `lib/copilot/verify/harness.tsx` (`runVerification`, `ITEM_LIMIT_MS`, `PROPOSAL_LIMIT_MS`), `components/intelligent/copilot/VerifyCard.tsx`, `prompt.ts` (`executionRepairNote`, `sanitizeVerifyRepair`, `EXECUTION_REPAIR_REASON`).
- Route: `/api/copilot/turn` body `verifyRepair: { report, items }`; response `context.repairReason: "execution"`, `context.verifyRepair.items`. TEST SEAM: under the fake provider an execution repair without a scripted reply answers `unusable` at once.
- Public docs: `apps/studio/content/docs/intelligent-mode.md` ("Scripts are run before they are offered"); `actions-reference.md` regenerated (the logic-script types show `expect`).
- No environment variables, no migrations, no new dependencies.

## Limits (what the test session cannot show)
- **Layout-dependent effects.** The stage is off-screen at 820 px: a script that measures positions, scroll or visibility, depends on the viewport or phone width, or animates, is judged by what it changed (classes, styles, elements), not by how it looks.
- **Time.** Each item has 5 s: `rs.after` timers longer than about a second, countdowns and effects after a delay are not observed; a script with many trigger questions may have scenarios left unplayed (said in the summary).
- **Network-dependent media** cannot load (no network in the sandbox, and the stage does not fetch media); what a script does when a clip ends is not simulated.
- **Not simulated:** other respondents' data (quota counts are empty), the server's replay and its checks after the save, URL parameters and embedded data from the panel, cross-page navigation (`rs.goToPage` is answered "would go to …" and counted as an effect), the respondent's language switch, loop iterations beyond the second, a loop's own context for UX scripts (the iteration is re-entered, not re-keyed), custom components whose element is not on the hosting page.
- **The verdict reads effects, not intent.** A script that changes the wrong thing still "ran" — unless the model's `expect` names what it should do. `expect` is optional; without it, "did something visible without an error" is `ran-ok`.
- **The browser is the Studio's.** Verified in headless Chromium; another browser may differ. A script that freezes a frame sharing the page's thread would freeze the Studio for as long as the sandbox's guards allow (the loop guard and the promise-chain guard stop the common cases; verified).
- **One automatic repair** per proposal (the hook counts); a model's own repair quality was not measured (fake provider only).

## Verification (S2c)
VERIFICATION_TABLE

## The owner's 10 steps and 3 layers after S2
| Step | Audit (before S2) | After S2 (a + b + c) |
|---|---|---|
| 1 Understand | partial | **present**: behaviour vs look read correctly (S2a D9), debug/why/explain a script (D10), owner's 15 sentences all with a non-blocked path |
| 2 Inspect | partial | **present**: script dossier in full with check and field health (D10), logic scripts in the outline, scripts in the dependency graph (S2b) |
| 3 Plan (native vs script) | partial (guide text only) | **present as data**: the capability registry's native routes (`nativeRouteFor`) drive refusals and explanations; the guide remains prose for the model |
| 4 Check compatibility | present (static, with gaps) | present: static gate + the variant settings rule; plus the run-time check (step 7/9) |
| 5 Generate | partial | partial (by design: no libraries, no integrations): + logic-script actions, media, every declared variant setting |
| 6 Integrate | present | present |
| 7 **Execute** | **missing** | **present**: every code item runs on the real page / sandbox / logic frame in a test session before the proposal is ready |
| 8 Validate | partial (static only) | **present**: static gate + run-time verdicts, refused writes and DOM ops with reasons, the save-payload check |
| 9 **Test** | **missing** | **present**: deterministic, seeded scenarios per item (options, bounds, Next valid/invalid, loops); `expect` checked; one automatic repair |
| 10 Report | present (static only) | present: per-item verdicts on the card and in History; "checked and run in a test session" replaces "not run yet" |

| Layer | Before S2 | After S2 |
|---|---|---|
| 1 Survey Understanding | partial | **present** (S2a: classification, script questions, owner sentences; S2b: logic scripts and scripts in the graph) |
| 2 JavaScript Capability | partial | **present** (S2b: `capabilityRegistry.ts`, test-synced with the sandbox API, events, variants and actions) |
| 3 Execution and Verification | missing | **present** (S2c), with the limits above |
