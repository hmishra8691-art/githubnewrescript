# Production intents: misreads fixed (2026-10-18)

Weakness #3, fixed by engineer E3. The evidence is the 43 operations in production `intelligent_operations`, logged 2026-10-06 to 10-17 and read with read-only SELECTs.

Researchers speak Hindi, Hinglish, Marathi and Urdu, often by voice, and speech-to-text (STT) garbles the English survey words in what they say. Every case below was checked against the code as it stood on 10-18. Some were already fixed by later patches, and each section says which.

The regression corpus is `apps/studio/lib/copilot/fixtures/productionPrompts.json`. Its test is `apps/studio/lib/copilot/productionIntents.test.ts`. E4's real-model eval reuses the corpus (see the last section).

## Cases

| # | What production showed | Root cause | Fix | Test |
|---|---|---|---|---|
| 1 | "मला हाँ पाइजे कि सारे कोश्ण टेक्सलातो मी मराठीला विचारा मराठी मदे विचारा" got a clarifying question back. The researcher then retyped it in Hindi. | `translationIntent` only knew Latin-letter language names, so the translation guide was not sent. Without it the model could not choose between replacing the wording and adding a language version, so it asked. | `spokenTranslation` (`spoken.ts`) recognises a language named in Devanagari, Urdu or Hinglish together with a translation cue: मराठीत, मराठीला, मराठी मध्ये / मदे, में कर दो, लैंग्वेज में चाहिए, اردو میں ترجمہ, "marathi mein". It covers 13 Indian languages and इंग्लिस्ट (English). The translation guide now has a **replace-or-version** rule: "make it Marathi / update it / इसे ही पूरा मराठी कर दो" means rewrite the source wording in place (`update_question` + `rename_block`). "Add Marathi / a version" means `add_language` + `set_translations`. When neither is said, the model adds the version and offers to replace. The rule says "decide, never ask". | corpus `fb4460c8`, `60462222b`, `9372e9d8`; `variants.translation` (10) and `translationNegatives` (4); the browser suite's ROUTING |
| 2 | One record read "Plan the analysis → Plan the analysis → यही सारे … मराठी में कर दो". Another read "… जावसक्रिप्ट → Please apply the changes. It is good." | This is **not** a clarify composition: no code joins a clarify answer to its question. The model already sees the question it asked in RECENT TURNS. The " → " comes from `recordProposal` (`useCopilot.ts`). While a proposal is open, each new request joins it as a revision. The researcher pressed the "Plan the analysis" chip twice, and each press added an identical step: two `propose_analysis_plan` in one change, and the record said so twice. The Marathi request then joined that open proposal. In the second record, "Please apply the changes" went to the model (a paid call). The model proposed the same two behaviours again, so the change carried four. | `proposalSteps.ts`: `withStep`, `foldPrompt` and `repeatsTail` make a step identical to the last one (same words, same actions) one step and one record line. They are used at the three places a step is appended and in `recordProposal`. **Apply said in words** ("Please apply the changes. It is good.", "ok apply", "lets implement", "हाँ लागू कर दो", "मुझे कोई और चेंजस नहीं करना है लेट्स इंप्लिमेंट") with a proposal open does what the Apply button does (destructive changes still need confirmation), with no model call. With nothing open, the sentence still goes to the model, because it may answer a question the model asked. | `productionIntents.test.ts` "#2"; `variants.apply` (12) and `applyNegatives` (9); the browser suite's ONE STEP ONCE and APPLY |
| 3 | "जो changes अभी आपने किया उसे reward back कर दो क्योंकि ये worthless है" made the model propose "Remove the custom code of survey", which was refused. | Undo had no deterministic reading. "reward back" is STT for "roll back". | `undoIntent` (`spoken.ts`) reads undo / revert / roll back / rollback / "reward back" / "take it back"; वापस कर दो, पहले जैसा कर दो, हटा दो जो अभी किया, रिवर्ट, रोलबैक, अनडू; Hinglish "wapas kar do", "undo kar do"; Marathi पूर्ववत करा; Urdu واپس کر دو. It does not fire when the request names a question or creates something ("revert Q5 to single select", "add an undo button"). `IntelligentView.ask` then calls `copilot.undoLast` with no model call. If a proposal is open, it is set aside (nothing had been applied, and it stays in History for Reapply). Otherwise the last standing change is restored the way the toolbar's "Undo AI change" restores it (`lastUndoable`: this page's newest change, else the newest restorable change in History with nothing after it). If later edits would be undone with it, nothing is done: the card says why and History opens, where "Restore…" asks first, as today. | `variants.undo` (19) and `undoNegatives` (8); "#3" `lastUndoable`; the browser suite's UNDO (both cases) |
| 4 | `set_custom_code` on "`__survey__`" and "Remove the custom code of survey" failed with "there is no question …". | `set_custom_code` only resolved questions. | Engine `optionActions.ts` `surveyCustomCode`: the targets `__survey__`, `survey`, `theme`, `the whole survey`, `global` and `all` now mean one survey-wide script (target "survey", source `copilot_custom_code`, through the authoring gate) and one scoped survey stylesheet. Setting it again replaces them. `null` removes them, together with any survey-wide `branding_custom_js`, and is destructive, so it is confirmed. Removing code that does not exist is refused precisely: "no survey-wide custom code to remove — its theme is the Branding (set_theme) …". | engine `productionIntents.test.ts` (2); browser ACCEPTED NOW |
| 5 | "“Q1 Welcome Popup” has both a script and effects — use one", four times. | **Already fixed by P0-2** (10-16, `scriptOnEvent`). The production actions were a script plus `on` / `options` with no effects. These are now wrapped in the event. They are then refused for the right reason: a hand-built `position:fixed` overlay, "use show_popup / rs.popup". | Added: a behaviour with effects **and** a script on one event becomes two behaviours: the effects, plus the script wrapped in the same event as "<label> (script)". Both are written on one snapshot, or neither is. | engine test "production popup behaviours" and "effects AND a script" |
| 6 | "Q3 pe mujhe javascript lagana hai … popup … eligible voter" proposed "Set the validation of Q3", which was refused as look-only. | **Already fixed by P0-2** (`uxOnlyInferred`, 10-16): look-only inferred from the words still allows `set_validation`. The Devanagari variant is never look-only. | Added: a researcher who says "only the UI" **and** asks to block Next until a condition holds is no longer treated as having said look-only, so validation is allowed. Hinglish stops ("jab tak 18 na ho tab tak next band rahe") count as a stop. | Studio "#6"; engine "look-only … inferred" |
| 7 | Calculations were refused: "reads R1, R2, R3, R5" (`PERC_BATTERY.R1 …`) and "reads THEN, ELSE" (`IF AGE <= 27 THEN 1 ELSE IF …`). | The calculation language writes a grid row as `VAR_<row>` and a case as `if(c, a, b)`. Worse, `create_calculation` refused even the correct `PERC_BATTERY_r1`: its name check knew only question codes, not the Variable Dictionary. | Engine `calcRewrite.ts`, a deterministic rewrite: `GRID.R1` / `GRID.r1` becomes that row's variable, through the condition language's own row resolution and the survey's naming scheme. `IF … THEN … ELSE` (with ELSE IF chains and END / END IF) becomes nested `if()`. The function form is left alone. `create_calculation` now accepts dictionary names. A name that is still unknown is refused with the fix (`calcNameHint`), and the one repair call sends that refusal to the model. The analysis guide (sent with every generation) gains a CALCULATIONS line. The system prompt had no room left under its 14,800-character test limit. | engine (4, including the runtime computing 3.5 and AGE_GROUP 3); Studio "#7"; browser ACCEPTED NOW |
| 8 | STT references: "quotient 9", "ख्योशन 3", "क्यू फाय", "क्यूबन / क्यूँ एन" (Q1), "क्यू टू / क्यूटू", the word "question" written as कोश्यन / कोशन / कॉष्णस / कुष्ण / क्वेशन; JavaScript written as जावस्यूप, जावसक्रिप्ट, जावस्ट्रिप्ट, जावस्रिप, جاوا سکرپٹ; popup written as पॉप अप, पाप अप, پاپ اپ, एलेट (alert); इंग्लिस्ट. | `referencedQuestions` read only Latin codes. The UX recogniser missed Urdu جاوا سکرپٹ / پاپ اپ and Devanagari पॉप अप. So those requests went without the UX guide, and without the named question shown in full in the outline. | `spokenQuestionNumbers` reads the question word, or "Q" spoken as क्यू / kyu, followed by a number in digits (Devanagari and Arabic digits too) or as a number word (English transliterated or Hindi; एन was heard for "one"). It also reads fused forms (क्यूबन, क्यूटू). Arithmetic does not count ("quotient of 9", "9/3"), and neither does "why" (क्यूँ followed by a word) or "question to/for". `referencedQuestions` adds those codes only when the survey has them. `uxIntent` adds `SPOKEN_SCRIPT` and `SPOKEN_POPUP` (another script, so never look-only) and Latin "java script / jawa script". | `variants.questionRefs` (22) and 10 negatives; script (9), popup (4) and uxNegatives (6) |
| 9 | Five "clarify" and three "answered" outcomes. | `e1def5f0` is the change plan, logged as clarify (correct). `9ef5958d` is the 25k brief (fixed by the long-brief work of 10-17). `a7aef125` was a transcript cut off before its objective, so that clarify was warranted. `cc95b02b` ("एक क्यू फाय से क्यू सिक्स में लगाओ"): Q5 and Q6 are now shown in full; whether the model still asks is model-dependent (see the last section). `fb4460c8` is case 1. Of the answered ones, "What depends on Q6?" was the engine's own answer. The tariff answer "already implemented" was verified correct (not a bug). "मुझे कोई और चेंजस नहीं करना है लेट्स इंप्लिमेंट" was answered correctly, with nothing open (see case 2). | Found while reviewing (below): Hindi survey-design requests were classified **mode "ux"**. "List fill" spelled the STT way was missed. Devanagari qualitative and hypothesis words sent no guide. | below |

## Also found and fixed in the corpus

- **"सर्वे डिजाइन करके दो" was a UX turn.** The P0 Devanagari list (10-16) made डिजाइन a look word. A Hindi request to design a survey was therefore classified `mode: "ux"`: single-shot, with the UX guide, and no plan-first. Production `e4d34ad9` (10-17) was logged with mode `ux`, and its generated survey came with a theme, an animation and a style. English "design a survey" also sent the UX guide (the weak word "design").
  - Fix: `SURVEY_CREATE` covers "design a survey", "survey design करना", "सर्वे डिजाइन करके दो" and "survey ही create करना है". It is a generation (on a survey with fewer than three questions, as before), and it is stripped before the look recognisers run. A look word that is really about the look still counts: the existing test "an animated, card-style design" still sends the guide.
  - "next question" / "नेक्स कुष्ण" is the next question, not the Next button.
  - A pasted long brief is never `mode: "ux"`, so the route's brief mode plans it first.
- **List Fill guide.** STT writes रेंडमली (with े) and प्रायॉरिटी (with ॉ), and "चार से जादा … selected" means more than N selected. These are now recognised (production `31eb34b9`, `c7ccdf3a`).
- **Research, qualitative and analysis guides** now recognise Devanagari क्वालिटेटिव, गुणात्मक, हाइपोथीसिस, परिकल्पना and विश्लेषण (production `a7aef125`, `2ea48d82`).

## Files

- Engine (`packages/engine/src`):
  - `calcRewrite.ts` (new; exported from `index.ts`)
  - `surveyActions.ts` (the `create_calculation` case and three imports)
  - `optionActions.ts` (`set_custom_code` on the survey)
  - `uxActions.ts` (effects plus a script)
  - `productionIntents.test.ts` (new, 9 tests)
- Studio (`apps/studio`):
  - `lib/copilot/spoken.ts` (new)
  - `lib/copilot/proposalSteps.ts` (new)
  - `lib/copilot/prompt.ts`: the translation / UX / analysis intents, `referencedQuestions`, `classifyRequest`, the translation and analysis guides
  - `lib/copilot/listFillGuide.ts` and `lib/copilot/researchGuide.ts` (intents)
  - `components/intelligent/copilot/useCopilot.ts`: `recordProposal` fold, `withStep` at three sites, `undoLast` (anchored; no transport change)
  - `components/intelligent/IntelligentView.tsx`: undo and apply before `interpretRequest`; `applyCopilot` returns its result
  - `lib/copilot/fixtures/productionPrompts.json` (new)
  - `lib/copilot/productionIntents.test.ts` (new, 57 tests)
- Browser suite: `scripts/production-intents-test.mjs` (new), run as `node scripts/production-intents-test.mjs` against a Studio on :3000 with `AI_API_URL=fake:`.
- No migration, no new dependency, no route change.

## What remains model-dependent (for E4's eval)

The corpus fixes only the **deterministic** routing: the guides sent, the questions shown, and undo / apply. Whether the model then acts well is for the real-model eval. E4 should measure:

1. **Translation:** for `fb4460c8`, `60462222b` and `9372e9d8`, with the guide, does the model act without asking, and does it choose replace or version as the rule says?
2. **Calculations:** do generations (`4fa13d01`, `c7b1f0d1`) now write `if()` and `VAR_r1`? The rewrite catches both spellings, so measure only how often the repair hint is needed.
3. **`cc95b02b`:** with Q5 and Q6 shown, does the model build the loop from the context, or still ask?
4. **Popups:** on `ab39e1baa`, `d4e85632` and `ec98384b`, does the model write `show_popup` / `rs.popup` and not a hand-made overlay, which the gate refuses?
5. **Survey code:** on `2e0ca1da`, does the model use `set_theme` for a background or a 3D look, and `set_custom_code` on the survey only for real code?
6. **Long brief:** on `9ef5958d`, the full 25k text (not the 1,500-character excerpt in the corpus) is planned first. Its quality is the plan's.

Each case's `prompt` and `context` (survey size; `survey` is the 30-question fixture) are what E4 sends. `expect` is the routing E4 can assert before scoring the model.

## Not done

- **A typed request still joins an open proposal that a chip or fix opened.** An unrelated request after a chip therefore applies together with it, as one change. The Changes panel lists every request, so this is visible. The step is no longer duplicated. A rule of "never the chip's proposal" was not made, because it would break real revisions: a quota import followed by "make the age quota soft", or a review fix followed by an adjustment.
- **Undo works on the last change only, and from the conversation only.** "Undo the last three changes" does the last one. The route has no undo of its own: an older page, or another caller, sends the sentence to the model as before.
- **Apply in words needs a proposal open.** With nothing open, the sentence goes to the model as before.
- **STT word lists are hints and will miss new garbles.** The refusal plus the one guided repair remains the safety net.
- **Not run here** (the orchestrator runs these): the browser suite `scripts/production-intents-test.mjs` and the regression suites that touch the changed paths: `history-test`, `copilot-test`, `ux-copilot-test`, `style-script-p0-test`, `age-script-p0-test`, `popup-p3-test`, `intelligent-engine-test`, `translation-copilot-test`, `listfill-intelligent-test`, `phase2-nl-test`.

## Follow-ups from the orchestrator (2026-10-18)

### Calculations read as a question

E4's eval found that "Create a calculation SUPPORT_SCORE as the average of the Q5 rows" was classified as `mode: "question"`.

- **Cause:** `classifyRequest`'s edit words had no create / compute / calculate / derive / define / build / recode, and no Hindi, Hinglish, Marathi or Urdu equivalents.
- **Added:**
  - Hindi: बनाओ / बना दो, जोड़ो, निकालो, कैलकुलेट, लगाओ.
  - Hinglish: bana do, calculate karo, nikalo, lagao.
  - Marathi: काढा, तयार करा, जोडा.
  - Urdu: بناؤ, نکالو, کیلکولیٹ.
- **Generations are unaffected:** they are decided first.
- **Corpus:** `variants.modes` has 14 cases. Two production cases now read as edits, which is correct:
  - `cc95b02b` "… क्यू सिक्स में लगाओ"
  - `c7ccdf3a` "दो क्वेशन बनाओ …"
- **Side effect:** a how-to question such as "How do I create a calculation?" now reads as an edit. That was already true of "add" and "make", so it is consistent with existing behaviour.

### The Studio's own notices are now in the researcher's language

New `lib/copilot/notices.ts`:

- `replyLanguage(message)` returns en, hi, hinglish, mr or ur.
  - The script decides Urdu and Devanagari.
  - Marathi is told from Hindi by marker words (आहे, मला, पाहिजे, मध्ये, करा …).
  - Hinglish is told from English by the density of everyday Hindi words.
- `NOTICES` holds every fixed sentence the Studio adds to a copilot reply:
  - "Nothing was changed: …" and "(Nothing has been changed yet …)" (`honestReply`, which takes an optional `lang`; it defaults to English, as before)
  - "Nothing was built …"
  - the outside-the-platform note
  - the unsupported-request sentence (in the route, and on the engine-first card in `useCopilot.local`)
  - the long brief's one question back

Everything is wired in `route.ts` through `const lang = replyLanguage(message)`. English output is unchanged byte for byte. The engine's refusal reasons quoted inside a notice stay as the engine wrote them.

`honestReply` now also catches a claimed change in Indic words ("जोड़ दिया है", "add kar diya hai", "شامل کر دیا ہے").

**Tests:** `lib/copilot/notices.test.ts` (5) and the corpus (58). Studio lib passes 784 of 784, and `tsc` is clean.
