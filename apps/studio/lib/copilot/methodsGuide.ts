/**
 * THE METHODS GUIDE — MaxDiff and conjoint as research designs, for the model (Priority 5, 2026-10-17).
 *
 * Sent with a request that names a method (`methodsIntent`): without it the model knew only
 * `create_question type:"maxdiff"` (a question with no design) or wrote a matrix instead. The engine
 * (`methodActions.ts`) configures, checks with the generator, generates, attaches and describes; the
 * guide teaches the shapes, what to ASK and what to leave to the engine, and what is not available.
 * Least fill belongs to the List Fill guide (sent by `listFillIntent`). Every example line is valid
 * JSON the engine applies (`methodsGuide.test.ts`).
 */
export const COPILOT_METHODS_GUIDE = `METHODS GUIDE — MaxDiff and conjoint are RESEARCH DESIGNS, never plain questions.
IDENTIFY: most/least important of a list, best–worst → create_maxdiff. Products as attributes × levels, trade-offs, choice tasks, CBC → create_conjoint "method":"cbc"; menu-based, priced add-ons, pricing configurator → "menu"; adaptive / ACBC → "acbc". Least fill → LIST FILL GUIDE (least_fill).
NEVER SUBSTITUTE a simpler method (a matrix or ranking for a MaxDiff, plain questions for a conjoint, cbc when acbc was asked). NOT AVAILABLE — say so, offer the supported alternative, propose it only if the researcher agrees: rating- or ranking-based conjoint, labelled (alternative-specific) designs, dual-response None, numeric/linear attributes, level images, HB / latent-class / individual-level utilities (the analysis is an aggregate logit; the MaxDiff choice file and the stacked CBC file are the hand-off for HB elsewhere), worst-only MaxDiff, balanced (least-filled) version assignment.
ASK, don't invent: reply "kind":"clarify" with "questions" and NO actions when an essential is missing — the MaxDiff ITEMS (unless named, or a survey question lists them → "itemsFrom"), the conjoint ATTRIBUTES AND THEIR LEVELS ("four attributes with three levels" is a size, not the attributes), the menu items and prices. INFER the sizes: leave perTask, tasks, versions, alternatives out unless given — the engine picks them (MaxDiff 3–5 per task, ~3 shows per item, 10 versions; CBC 3 alternatives, 12+ tasks, 10 versions, efficient) and reports them as assumptions with the measured balance or D-efficiency. Never write diagnostics yourself.
THE ENGINE generates the design once (seeded), refuses an infeasible one with the reason and the fix (pass it on), attaches it, puts the question on its own page (required, order randomized per respondent) and describes it. Display logic: set_display_logic on the ref. create_question with a MaxDiff/conjoint type is refused. The outline's "Designs:" line shows each design's settings — CHANGE one with update_*, a patch of the named fields only (text, logic, the rest stay); never recreate it.
{"op":"create_maxdiff","ref":"FEAT_MD","text":"Which of these is the MOST important to you, and which the LEAST?","items":["Battery life","Camera","Price","Screen size","Storage","Durability","Weight","Warranty"]}   // or "itemsFrom":"Q5"; perTask, tasks, appearances, versions, responseMode best_worst|best_only, anchored, prohibitedPairs [["A","B"]], bestLabel, worstLabel, instructions, practice, block, after
{"op":"update_maxdiff","target":"FEAT_MD","perTask":5}   // or addItems, removeItems, addProhibitedPairs [["Camera","Price"]], removeProhibitedPairs, tasks, versions, labels, text, required
{"op":"create_conjoint","ref":"PHONE_CBC","method":"cbc","text":"If these were your only options, which would you choose?","attributes":[{"name":"Brand","levels":["Alpha","Beta","Gamma"]},{"name":"Screen","levels":["5 in","6 in","7 in"]},{"name":"Battery","levels":["1 day","2 days","3 days"]},{"name":"Price","levels":["$199","$299","$399"]}]}   // alternatives, tasks, versions, holdouts, none (true or its text), prohibitions [{"Brand":"Alpha","Price":"$199"}], design efficient|balanced
{"op":"update_conjoint","target":"PHONE_CBC","none":true,"addProhibitions":[{"Brand":"Gamma","Price":"$199"}]}   // or attributes, addAttributes, removeAttributes, levels {"Price":["$249","$349"]}, removeProhibitions, alternatives, tasks, versions
{"op":"create_conjoint","method":"menu","ref":"PLAN_MENU","items":[{"name":"Extra data","prices":["$2","$4"]},{"name":"Insurance","prices":["$5","$8"]},{"name":"Streaming","prices":["$6","$9"]}],"tasks":8}   // requiredItems (always included), minSelections, maxSelections, none
{"op":"create_conjoint","method":"acbc","ref":"ACBC","attributes":[{"name":"Brand","levels":["Alpha","Beta","Gamma"]},{"name":"Price","levels":["$199","$299","$399"]},{"name":"Battery","levels":["1 day","2 days"]}],"screeningTasks":6}   // conceptsPerScreen, tournamentAlternatives; no tasks/versions/alternatives
"A MaxDiff of the most and least important product features", no list anywhere → {"kind":"clarify","reply":"…","questions":["Which features should the MaxDiff compare? I'll size the tasks from how many there are."]}. "A CBC with four attributes, three levels each" → clarify: "What are the four attributes and their three levels?"`;

/**
 * A request about MaxDiff or conjoint — the guide goes with it. English, Hinglish and Devanagari,
 * as the List Fill and UX guides are chosen.
 */
export function methodsIntent(text: string): boolean {
  const t = text.normalize("NFC");
  if (/\bmax[\s-]?diff\b|\bbest[\s-]?(?:and[\s-]?|\/\s?|–\s?|-\s?)?worst\b|\bbws\b|\bmost[\s-]?(?:and[\s-]?|\/\s?)?least\s+(?:important|preferred|appealing|liked)\b/i.test(t)) return true;
  if (/\bconjoint\b|\bcbc\b|\bacbc\b|\bchoice[\s-]?based\b|\bchoice[\s-]?(?:tasks?|sets?|exercise|experiment|modell?ing)\b|\bdiscrete[\s-]?choice\b|\bmenu[\s-]?based\b|\bbuild[\s-]?your[\s-]?own\b|\bpricing\s+configurator\b|\badaptive\s+(?:cbc|choice)\b|\bpart[\s-]?worths?\b|\battributes?\s+(?:and|&|with)\s+(?:\w+\s+)?levels?\b|\blevels?\s+per\s+attribute\b/i.test(t)) return true;
  // Hinglish words around the method names are covered above; Devanagari spellings of them
  if (/मैक्स\s?डिफ|मैक्सडिफ|कंजॉइंट|कन्जॉइंट|कंजोइंट|बेस्ट\s?(?:और|-)?\s?वर्स्ट/.test(t)) return true;
  return false;
}
