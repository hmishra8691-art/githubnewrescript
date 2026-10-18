/**
 * THE LIST FILL GUIDE — the model's knowledge of List Fill, as data.
 *
 * Sent with a request that is about choosing N items from a respondent's
 * answers and passing them on (`listFillIntent`). Without it the model knew
 * only masks, and the production case of 2026-10-14 — "brands rated 3–5 in
 * Q37 go to Q38; more than 5 → 4 at random; Apple always first" — came back
 * as a `set_mask` with an invented expression, corrected twice by hand.
 *
 * The engine resolves every name in these actions (question codes, variable
 * names, item labels → ids and codes) and refuses what it cannot do, so the
 * guide teaches the SHAPE and the choice, not the ids.
 */
export const COPILOT_LIST_FILL_GUIDE = `LIST FILL GUIDE.
A LIST FILL chooses items from a respondent's answers and passes them on. Use it when items must be CHOSEN — N of them, by priority, at random, least-filled first, capped per item — and then shown, piped or answered in later questions. Use a MASK (set_mask "Q5.Selected") only when the next question simply shows everything chosen, with no "only N", no random pick, no priority. Use a LOOP (create_loop) to repeat questions per item; a loop can iterate over a List Fill once it exists. Never write a mask expression that is not in the SET language (no "where", no @option.rating) — that is a List Fill. Showing a random N of a question's OWN options is that question's randomization ("show only N"), not a List Fill.
Fields: "source" a question (its selected options; a GRID's rows), {"question":"Q5","take":"selected|displayed|all"}, or {"items":["A","B"]}; "eligible" for a GRID source: {"minValue":3} / {"maxValue":2} / {"answers":["Familiar","Very familiar"]} — the rows whose answer qualifies; "eligibleWhen" {"<item>":"<condition>"} for one item; "count" a number or "all"; "allIfAtMost" n = "if more than n qualify take count, otherwise all of them"; "method" priority_random (priority first, random among the rest), random, highest_priority, least_fill (LEAST fill: the eligible items the fewest respondents have so far, no target needed — never random or balanced instead; "basis":"completed" counts finished interviews, "allocated" everyone given the item; "tieBreak":"random|sequential|priority"), selection_order (the respondent's order, e.g. ranking order); "priority" {"<item>":1} (lower first, by label or code); "always" ["<item>"] = included whatever was answered, first; "maximum"/"target" {"<item>":150} = sample-wide caps (counted across respondents); "destinations" ["Q38"] — a question with options/rows SHOWS the chosen items (they must be the same items: the engine aligns codes by label), {"question":"Q40","as":"piping","position":1} pipes item 1 ({{LISTFILL_<NAME>_1}}), "as":"answer" writes its code; "whenUnused" hide|skip|disable|blank — what a destination does when nothing qualifies (default hide); "runWhen" a condition for the whole list; "onChange" keep_valid|redecide|freeze — what a stored allocation does when the respondent goes Back and changes the source. Variables: LISTFILL_<NAME>_COUNT, _1, _1_CODE, _CODES, _LABELS. The destination must be on a LATER PAGE than the source (the list is decided when that page is submitted); a changed answer re-decides it.
Example — "Q37 rates 10 brands 1 Never heard of … 5 Very familiar; brands rated 3–5 go to Q38 (ranking); if more than 5 qualify randomly assign 4; Apple on top and in the four when it qualifies":
{"op":"create_list_fill","name":"BRANDS","source":"Q37","eligible":{"minValue":3},"count":4,"allIfAtMost":5,"method":"priority_random","priority":{"Apple":1},"destinations":["Q38"],"whenUnused":"hide"}
"Apple must be shown even if not rated 3–5" → "always":["Apple"] instead of the priority. Ambiguous counts ("more than 5 → 4": what about exactly 5?) — take the literal reading (allIfAtMost 5) and say it in the summary.
{"op":"update_list_fill","listFill":"BRANDS","count":3,"allIfAtMost":null}   // also newName, priority (replaces all), eligible, destinations (replaces all), whenUnused, runWhen (null clears), method, basis, tieBreak, onChange
{"op":"update_list_fill","listFill":"BRANDS","method":"least_fill","basis":"completed"}   // "use least fill counted on completes": only these change (least fill takes no "always"; a priority then breaks ties)
{"op":"remove_list_fill","listFill":"BRANDS"}   // destructive; refused while piping, logic or a loop still reads it
Refused by the engine (do not propose): allowDuplicates, fillToCount false, afterMaximum/fallback, a custom/script method or source, an expression count, repeatBlock (use a loop), a per-item rule written as "eligible.when", caps without sample counts (trackSample false).`;

/**
 * A request about choosing N items from earlier answers — the guide goes with
 * it. English, Hinglish and Devanagari, because the case that started this
 * was written in Hindi.
 */
export function listFillIntent(text: string): boolean {
  const t = text.normalize("NFC");
  if (/\blist[\s-]?fills?\b|\bleast[\s-]?fill(?:ed|s)?\b|\blistfill_|LISTFILL\(/i.test(t)) return true;
  // "randomly assign 4", "randomly select 3 brands", "pick 2 at random", "show 4 random brands", "random 4"
  const n = String.raw`(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|ek|do|teen|char|chaar|paanch|panch)`;
  if (new RegExp(String.raw`\b(?:random(?:ly)?|at random)\s+(?:\w+\s+){0,2}?(?:assign|select|pick|choose|show|allocate|take|give|chun|chuno|dikhao|dikhaye)\w*\s+(?:\w+\s+)?${n}\b`, "i").test(t)) return true;
  if (new RegExp(String.raw`\b(?:assign|select|pick|choose|allocate|take|show)\w*\s+${n}\s+(?:\w+\s+){0,2}?(?:at random|randomly|random(?:ly)? from|by priority|with priority|least)`, "i").test(t)) return true;
  if (new RegExp(String.raw`\b(?:random(?:ly)?)\s+${n}\b|\b${n}\s+(?:\w+\s+)?(?:at random|randomly)\b`, "i").test(t)) return true;
  // "carry forward 4", "carry forward only 3 of them"
  if (new RegExp(String.raw`\bcarr(?:y|ied)[\s-]?forward\s+(?:only\s+|just\s+|up to\s+|max(?:imum)?\s+)?${n}\b`, "i").test(t)) return true;
  // "assign 4 brands", "4 brands assign karo"
  if (new RegExp(String.raw`\b(?:assign|allocate)\w*\s+${n}\s+\w+|\b${n}\s+\w+\s+(?:assign|allocate)\w*\b`, "i").test(t)) return true;
  // "if more than 5 qualify / are selected …" with a smaller number taken
  if (/\b(?:if|when)\s+more\s+than\s+\d+\s+(?:\w+\s+){0,3}?(?:qualif\w*|selected|chosen|rated|eligible|picked|apply)\b/i.test(t)) return true;
  // priority among items to pass on: "priority to Apple", "Apple always on top … shown"
  if (/\bpriorit(?:y|ise|ize|ised|ized)\s+(?:to|for|on)\b|\b(?:always|hamesha)\s+(?:be\s+)?(?:shown|show|included|include|dikh\w*)\b.{0,40}\b(?:top|first|upar)\b/i.test(t)) return true;
  // Devanagari: रैंडमली / रैंडम … असाइन, लिस्ट फिल, प्राथमिकता (priority)
  if (/लिस्ट\s*फ\u093C?िल/.test(t)) return true;
  /* production intents (2026-10-18): speech-to-text writes रेंडमली (े) and प्रायॉरिटी (ॉ) as often as the dictionary spellings */
  if (/(?:रैंडमली|रैंडम|रेंडमली|रेंडम|रैन्डमली|रेन्डमली|यादृच्छिक)[\s\S]{0,40}(?:असाइन|चुन|दिखा|सेलेक्ट|सिलेक्ट)/.test(t)) return true;
  if (/(?:असाइन|चुन)[\s\S]{0,20}(?:रैंडमली|रैंडम|रेंडमली|रेंडम)/.test(t)) return true;
  if (/प्राथमिकता|प्रायोरिटी|प्रायॉरिटी|प्रायरिटी|प्रॉयोरिटी/.test(t)) return true;
  /* "अगर चार से जादा ब्रांड selected है … कोई चार" — more than N selected, N passed on (2026-10-14, a grid → carry-forward request) */
  if (/(?:\d+|एक|दो|तीन|चार|पांच|पाँच|छह|सात|आठ)\s+से\s+(?:ज़्यादा|ज्यादा|जादा|जास्त|अधिक|ज़्यादह)[\s\S]{0,40}(?:selected|select|सेलेक्ट|सिलेक्ट|सेलेक्टेड|सेलेक्टेट|चुने|चुना)/i.test(t)) return true;
  return false;
}
