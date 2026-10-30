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

## What S2b and S2c do (not started)
- **S2b:**
  - a capability registry
  - a variant catalogue with settings descriptions and question-media actions
  - Intelligent Mode write actions for Scripts-panel scripts
  - scripts in the dependency graph
- **S2c:** the Execution and Verification layer.
  - Each proposed script runs on a mirrored page before the card says it is ready.
  - Failures and "no effect" are fed into the existing repair call.
