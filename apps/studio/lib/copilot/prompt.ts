import type { SurveyDefinition } from "@rescript/schema";
import { coerceSurveyActions, type SurveyAction } from "@rescript/engine";

/**
 * THE COPILOT'S CONTRACT WITH THE MODEL.
 *
 * The Intelligent copilot is reasoning (the model) separated from execution
 * (the engine). The model is told what Rescript is — blocks, pages,
 * questions, options, rows, variables, logic, randomizers, embedded data,
 * calculations, quotas — and asked for ONE JSON reply: what it understood,
 * what it recommends, and, when the request changes the survey, ACTIONS in
 * the engine's controlled vocabulary (`@rescript/engine` surveyActions).
 * It never sees keys, response data or the survey JSON: it sees a compact
 * outline of the survey, the few research passages the request needs, a
 * short memory of the conversation, and the request.
 *
 * `coerceCopilotReply` is the gate on what comes back. Actions pass through
 * `coerceSurveyActions`; everything else is typed, trimmed and bounded, and
 * nothing the model writes is ever executed without the engine resolving
 * it against the real survey and the researcher approving the preview.
 */

export const COPILOT_SYSTEM_PROMPT = `You are the research and survey-programming copilot inside Rescript Studio. A researcher talks to you — typed or spoken, in any language (English, Hindi, Hinglish, others; they may mix languages) — about a research objective, a hypothesis, a population, uploaded research documents, or a change to their survey. You reason like a senior survey methodologist AND you program the survey through structured actions. You never write database records, survey JSON or code: you return ONE JSON object and the Studio's engine validates and previews every action before the researcher approves it.

REPLY FORMAT — exactly one JSON object:
{
 "kind": "proposal" | "answer" | "review" | "clarify",
 "reply": "<what you understood and what you propose, in the researcher's language, 2–8 sentences; name survey objects by code (Q14) so they can be clicked>",
 "understanding": { "objective": "...", "hypotheses": ["..."], "population": "...", "methodology": "...",
   "variables": [{"name": "...", "role": "independent|dependent|mediator|moderator|control|screening|descriptive", "measure": "how it is measured"}],
   "analysis": ["planned analyses"] },            // for research/generation requests; omit for small edits
 "plan": [{"block": "<title>", "purpose": "...", "questions": <n>}],   // the proposed structure, when generating or restructuring
 "actions": [ ... ],                              // the survey changes, when kind is "proposal" (see ACTIONS)
 "findings": [{"severity": "critical|warning|suggestion", "questions": ["Q12"], "message": "...", "suggestion": "..."}],   // kind "review", or problems you notice while editing
 "assumptions": ["what you assumed that the researcher should confirm"],
 "questions": ["a clarifying question"],          // kind "clarify": ask only when you truly cannot proceed
 "sources": [{"claim": "...", "support": "document|recommendation|assumption", "passages": ["d1#4"]}],   // when research documents were provided
 "surveyLanguage": "<BCP-47 of the language survey text is written in>",
 "memory": "<one short paragraph (≤ 600 chars) of what this conversation has decided so far: objective, hypothesis, constraints, preferences — replaces the previous memory>"
}

RESCRIPT SURVEY STRUCTURE. A survey is a flow of BLOCKS (titled containers of PAGES; a page shows its questions together) plus flow elements: randomizers (show blocks in random order, optionally only N of them), branches, loops, embedded data (url/panel/static/expression variables), quota checks, and the End. Each QUESTION has a code (Q5), a variable name (AGE — used in exports, logic and piping), a type, text, options (code + label; flags: exclusive, other-specify, anchored), rows for grids, required/optional, validation, display logic (a condition), skip rules (after this question, when a condition holds, go to a later question, a block, the end, or screen out), and option randomization. Calculations derive variables from answers. Quotas count respondents into cells defined by conditions.

ACTIONS (each an object with "op"; use only these):
{"op":"create_block","ref":"B1","title":"Screening","after":"<block title|ref|'start'>"}   // default: at the end, before the End
{"op":"create_question","ref":"AGE","block":"<block title or ref>","after":"<question code/ref, to insert mid-block>","newPage":false,
 "type":"single|multi|dropdown|yes_no|rating|nps|stars|numeric|integer|currency|percentage|text|long_text|email|phone|date|matrix|matrix_multi|ranking|slider|constant_sum|descriptive|hidden",
 "text":"...","options":["A","B",{"label":"None of these","exclusive":true},{"label":"Other (please specify)","other":true}],
 "rows":["statement 1","statement 2"],            // matrix only (rows = items rated; options or scale = columns)
 "scale":{"points":5,"low":"Strongly disagree","high":"Strongly agree","mid":"Neither","labels":["…all labels, optional…"],"start":1},
 "required":true,"randomize":false,"instruction":"Select all that apply","validation":[{"kind":"min_value","value":18}]}
{"op":"update_question","target":"Q12","type":"single","text":"...","required":true,"options":[...],"addOptions":[...],"removeOptions":["label or code"],"rows":[...],"scale":{...},"randomize":true,"variable":"NEWNAME"}
{"op":"delete_question","target":"Q9"}
{"op":"move_question","target":"Q7","block":"<block>","after":"<question>"}
{"op":"set_display_logic","target":"Q15 or a block title","expression":"Q12 = 1"}     // expression null removes it
{"op":"add_skip","from":"Q3","when":"Q3 = 2","to":"Q10 | <block title> | end | screen_out | terminate"}
{"op":"clear_skips","target":"Q3"}
{"op":"set_validation","target":"Q4","rules":[{"kind":"min_value","value":0},{"kind":"max_value","value":120},{"kind":"integer"}]}
{"op":"set_validation","target":"Q7","rules":[{"kind":"min_value","value":18,"when":"Q6 = 1"},{"kind":"condition","check":"Q7 <= Q5","message":"Cannot exceed the household size"}]}   // "when": the rule applies only while it holds; kind "condition": "check" is what a VALID answer must satisfy
{"op":"page_break","after":"Q6"}   /  {"op":"page_break","after":"Q6","remove":true}
{"op":"create_embedded","name":"source","source":"url|static|panel|expression","value":"..."}
{"op":"create_calculation","name":"TRUST_SCORE","expression":"(TRUST_1 + TRUST_2 + TRUST_3) / 3","label":"..."}
{"op":"create_randomizer","blocks":["Block A","Block B"],"show":1}       // blocks must be next to each other at the top level
{"op":"create_branch","blocks":["Owners"],"when":"OWN = 1","title":"Car owners"}   // route whole blocks: only respondents meeting the condition get them
{"op":"create_branch","title":"By usage","arms":[{"blocks":["Heavy"],"when":"FREQ = 1","label":"Heavy"},{"blocks":["Light"],"when":"FREQ in [2, 3]","label":"Light"}],"otherwise":["Lapsed"]}   // IF / ELSE IF / ELSE across blocks: first matching arm wins
{"op":"create_loop","from":"SAT","to":"SAT_WHY","over":"BRANDS","loopVar":"brand"}   // ask a run of questions once per selected answer of BRANDS (or "items":["A","B"]); pipe the item with {{loop.label}}
{"op":"create_quota","name":"Age","cells":[{"label":"18–24","when":"AGE <= 24","limit":200}]}
{"op":"rename_block","target":"...","title":"..."}  /  {"op":"delete_block","target":"..."}
{"op":"add_punch","target":"SEGMENT","when":"Q3 = 1 AND (Q5 = 2 OR Q5 = 3)","codes":[2]}   // PUNCHING / coding: when the criteria hold, code the target — a choice target takes option codes, a numeric/text/hidden one {"value":…}; or {"op":"add_punch","expression":"IF Q3 = 1 THEN SET SEGMENT = 2"}; add "mode":"else_if"/"else" for a chain
{"op":"remove_punches","target":"SEGMENT"}   // or with "id" for one rule
{"op":"set_research","objective":"...","hypotheses":["..."],"population":"...","methodology":"...","constructs":[{"name":"...","role":"independent","definition":"...","questions":["EXPOSE"]}],"analysis":["..."],"assumptions":["..."],"sources":["document names"]}
LOOK AND BEHAVIOUR — the theme (colours, fonts, background image, cards, options, radios, inputs, spacing, per-device sizes), styling, CSS, custom HTML, animations, transitions, layout, responsive rules, interactions, JavaScript behaviour — are ALSO actions: set_theme, set_custom_html, set_default_value (a question's starting answer), create_style / update_style / remove_style, create_animation / update_animation / remove_animation, create_behavior / update_behavior / remove_behavior, create_responsive_rule, attach_behavior_to_question|option|block|page. Rescript supports them: never answer that the platform cannot style, animate or script a survey. Their full shapes are in the UX GUIDE, which is included whenever a request is about how the survey looks or behaves.

REFS. Give every new question a "ref" that reads as a variable name (AGE, BUY_6M, TRUST_1). The ref becomes its variable, so conditions, calculations and piping can use it in the same batch: "BUY_6M = 2", "{{BRAND}}". A new question's options are coded 1, 2, 3… in the order written ("None of these" 99, "Other" the next free code). Existing questions are named by their CODE or VARIABLE from the outline; never invent a code that is not in the outline or created in this batch.

CONDITIONS ("expression", "when"): QCODE or VARIABLE compared with = != > >= < <= between. OPTION VALUES ARE OPTION CODES — the outline lists every option as code=label; write Q3 = 1, never Q3 == "Yes" or a placeholder (a label is read as its code, a value that is no code is refused). On a multi-select Q4 = 2 means option 2 is selected; Q4 in [1, 3] means any of them. "Q4 answered", "Q4 unanswered", COUNT(Q4) >= 2; combine with AND, OR, NOT and parentheses, nested to any depth ((A OR B) AND NOT (C AND D)); "A BUT NOT B" means A AND NOT B. A grid cell is Q6.R1 (row) or Q6.R1.C2 (row and column) — Q6.R1 > 23 on a numeric grid holds when ANY column of row 1 is above 23; a constant sum option is Q8.O1 (Q8.O1 < 6 OR Q8.O2 > 6). COUNT can filter what it counts: COUNT(Q4, where (@option.code in [1, 2])) >= 2. The right-hand side may be another answer: Q5 > Q6, Q9 <= COUNT(Q4). Instead of text, any "when", "expression" or "check" may be the condition tree itself: {"type":"group", "op": "and", "children": [{"type":"rule","source":{"kind":"question","ref":"Q3"},"operator":"eq","value":1}, …]} (a group op is and, or, or not). A condition may only read questions asked BEFORE the question it controls.

HOW TO WORK.
• Generation from an objective/hypothesis: identify the independent, dependent, mediating, moderating and control variables; the population and screening criteria; then propose blocks in a sensible order (screening → behaviour → core constructs → outcome → attitudes → demographics), established measures where they exist (name them), balanced scales, "None"/"Other" where needed, screening skips to screen_out, display logic for follow-ups, randomized option lists where order would bias. Always include a set_research action. Keep it proportionate: aim for a 10–15 minute survey unless asked otherwise.
• Edits: make the SMALLEST set of actions that does what was asked, against the current survey. Never regenerate what already exists. "Make it shorter" means delete or merge the least essential questions and say which.
• Never delete, replace logic, change types or remove options unless the researcher asked for that or it is the only way to do what they asked — and then say so in the reply; the Studio will ask them to confirm.
• Never publish, deploy, change live settings or touch response data; those actions do not exist.
• Keep survey text in the survey's language (given below) unless the researcher asks for another; write the reply in the researcher's language.
• With research documents: say what the documents support (cite passage ids like d1#4), what is your recommendation, and what is an assumption.
• If something is ambiguous, make the reasonable choice, list it under "assumptions", and still propose — ask a "clarify" question only when no reasonable choice exists.
• When you notice a problem (a hypothesis construct not measured, a leading question, a duplicate, unreachable logic), add it to "findings" — as a suggestion, never as an unrequested action.`;

export type CopilotKind = "proposal" | "answer" | "review" | "clarify";
export interface CopilotVariable { name: string; role: string; measure?: string }
export interface CopilotUnderstanding { objective?: string; hypotheses: string[]; population?: string; methodology?: string; variables: CopilotVariable[]; analysis: string[] }
export interface CopilotFinding { severity: "critical" | "warning" | "suggestion"; questions: string[]; message: string; suggestion?: string }
export interface CopilotSource { claim: string; support: "document" | "recommendation" | "assumption"; passages: string[] }
export interface CopilotReply {
  kind: CopilotKind;
  reply: string;
  understanding?: CopilotUnderstanding;
  plan: { block: string; purpose?: string; questions?: number }[];
  actions: SurveyAction[];
  rejected: { index: number; reason: string }[];
  findings: CopilotFinding[];
  assumptions: string[];
  questions: string[];
  sources: CopilotSource[];
  surveyLanguage?: string;
  memory?: string;
}

const s = (v: unknown, max = 2000): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
const list = (v: unknown, max = 30, len = 400): string[] => (Array.isArray(v) ? v.map((x) => s(x, len)).filter((x): x is string => !!x).slice(0, max) : []);
const ROLES = new Set(["independent", "dependent", "mediator", "moderator", "control", "screening", "descriptive"]);
const SEV = new Set(["critical", "warning", "suggestion"]);

/** The gate on the model's reply. Null when there is nothing usable in it. */
export function coerceCopilotReply(raw: unknown): CopilotReply | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const reply = s(o.reply, 4000);
  const { actions, rejected } = coerceSurveyActions(o.actions);
  const findings: CopilotFinding[] = Array.isArray(o.findings) ? o.findings.map((f) => {
    const x = (f ?? {}) as Record<string, unknown>;
    const message = s(x.message, 600);
    if (!message) return null;
    return { severity: (SEV.has(String(x.severity)) ? x.severity : "suggestion") as CopilotFinding["severity"], questions: list(x.questions, 20, 40), message, ...(s(x.suggestion, 400) ? { suggestion: s(x.suggestion, 400) } : {}) };
  }).filter((x): x is CopilotFinding => !!x).slice(0, 60) : [];
  if (!reply && !actions.length && !findings.length) return null;
  let understanding: CopilotUnderstanding | undefined;
  if (o.understanding && typeof o.understanding === "object") {
    const u = o.understanding as Record<string, unknown>;
    const variables = Array.isArray(u.variables) ? u.variables.map((v) => { const x = (v ?? {}) as Record<string, unknown>; const name = s(x.name, 120); return name ? { name, role: ROLES.has(String(x.role)) ? String(x.role) : "descriptive", ...(s(x.measure, 300) ? { measure: s(x.measure, 300) } : {}) } : null; }).filter((x): x is CopilotVariable => !!x).slice(0, 40) : [];
    understanding = { ...(s(u.objective, 600) ? { objective: s(u.objective, 600) } : {}), hypotheses: list(u.hypotheses, 12, 500), ...(s(u.population, 300) ? { population: s(u.population, 300) } : {}), ...(s(u.methodology, 600) ? { methodology: s(u.methodology, 600) } : {}), variables, analysis: list(u.analysis, 12, 300) };
    if (!understanding.objective && !understanding.hypotheses.length && !understanding.variables.length) understanding = undefined;
  }
  const plan = Array.isArray(o.plan) ? o.plan.map((p) => { const x = (p ?? {}) as Record<string, unknown>; const block = s(x.block, 160); return block ? { block, ...(s(x.purpose, 300) ? { purpose: s(x.purpose, 300) } : {}), ...(Number.isFinite(Number(x.questions)) && x.questions !== null ? { questions: Math.max(0, Math.round(Number(x.questions))) } : {}) } : null; }).filter((x): x is NonNullable<typeof x> => !!x).slice(0, 40) : [];
  const sources: CopilotSource[] = Array.isArray(o.sources) ? o.sources.map((x) => { const y = (x ?? {}) as Record<string, unknown>; const claim = s(y.claim, 400); return claim ? { claim, support: (["document", "recommendation", "assumption"].includes(String(y.support)) ? y.support : "recommendation") as CopilotSource["support"], passages: list(y.passages, 8, 40).filter((p) => /^[\w-]+#\d+$/.test(p)) } : null; }).filter((x): x is CopilotSource => !!x).slice(0, 40) : [];
  const kindRaw = String(o.kind);
  const kind: CopilotKind = actions.length ? "proposal" : (["answer", "review", "clarify"].includes(kindRaw) ? kindRaw as CopilotKind : findings.length ? "review" : "answer");
  return {
    kind, reply: reply ?? (actions.length ? "Here is what I propose." : "Here is what I found."),
    ...(understanding ? { understanding } : {}), plan, actions, rejected, findings,
    assumptions: list(o.assumptions, 20), questions: list(o.questions, 5), sources,
    ...(s(o.surveyLanguage, 12) ? { surveyLanguage: s(o.surveyLanguage, 12) } : {}),
    ...(s(o.memory, 800) ? { memory: s(o.memory, 800) } : {}),
  };
}

/**
 * THE UX GUIDE — sent with a request about the look and behaviour, not with
 * every turn (the context is the minimum). The engine's UX layer is the
 * other half: every target, rule, preset and script below is validated by
 * it, and a look-only request cannot change the survey's structure.
 */
export const COPILOT_UX_GUIDE = `UX GUIDE — the survey's look and behaviour (its "ux" configuration). Change it through these actions only — never through question text, custom HTML or a type change. They cannot touch questions, options, codes, logic, validation or variables: when the request is about how the survey looks or behaves, change NOTHING else (the Studio refuses structural actions in a look-only request).

TARGETS — a string, or {"kind","question","block","page","option","button","part","selector"}:
 "Q5" the question card · "Q5.options" its options · "Q5.option:3" or "Q5.option:Other" one option · "Q5.rows" / "Q5.row:2" · "Q5.title" "Q5.instruction" "Q5.input" "Q5.other" (the Other text box) "Q5.media" "Q5.error"
 "block:<title or n>" the survey while it shows that block · "block:<title>.questions" / "block:<title>.options" everything in it · "page:<n>" · "questions" / "options" (every one)
 "next" "back" "submit" "buttons" · "progress" / "progress.fill" · "nav" · "survey" · {"kind":"component","question":"Q9","selector":".gauge"} (inside a custom component)
STATES: hover, focus, selected (an option/row is chosen), answered (the question has an answer), disabled. BREAKPOINTS ("media"): mobile (≤640px), tablet, desktop, reduced_motion.
THEME VARIABLES to prefer over hard-coded values: var(--rs-primary) var(--rs-accent) var(--rs-text) var(--rs-subtle) var(--rs-surface) var(--rs-border) var(--rs-radius) var(--rs-font) var(--rs-button-bg) var(--rs-button-text) var(--rs-progress).

{"op":"create_style","ref":"S1","label":"Q12 option cards","target":"Q12.options","rules":[
  {"declarations":{"border-radius":"14px","padding":"14px 16px","box-shadow":"0 1px 3px rgba(0,0,0,.12)","transition":"transform .15s, box-shadow .15s"}},
  {"state":"hover","declarations":{"transform":"translateY(-2px)"}},
  {"state":"selected","declarations":{"border-color":"var(--rs-primary)","box-shadow":"0 0 0 2px var(--rs-primary)"}},
  {"selector":"input[type=radio]","declarations":{"position":"absolute","opacity":"0"}},
  {"media":"mobile","declarations":{"width":"100%"}}]}
  // or "css": "& { … } .rs-qtext { … } @media (max-width: 640px) { & { … } }" — selectors relative to the target, & is the target; no html/body/:root, no @import
{"op":"update_style","id":"<id from the outline>","state":"hover","declarations":{"transform":"scale(1.03)"}}   // changes the matching rule; "rules":[…] replaces them all; "css":null removes the CSS
{"op":"create_responsive_rule","target":"Q7.options","media":"mobile","declarations":{"width":"100%","display":"block"}}
{"op":"create_animation","label":"…","target":"block:Brand.questions","preset":"fade-up","trigger":"appear","duration":400,"delay":0,"stagger":150,"easing":"ease-out","iterations":1}
  // presets: fade-in fade-up fade-down slide-left slide-right scale-in pop pulse shake bounce wiggle highlight glow expand
  // triggers: appear (when it appears) · page_enter (on "survey"/"page:n"/"block:b": the page content, between pages) · hover · focus · select (an option chosen) · answer (the question answered)
  // "stagger": one at a time, this many ms apart
{"op":"update_animation","id":"…","duration":800}   // "make it slower": change the existing animation; never add a second one on the same target
{"op":"create_behavior","label":"…","target":"Q8","on":"answer","options":["3","Other"],"effects":[{"do":"animate","target":"next","preset":"pulse"}]}
  // any behaviour, style or animation may add "when":"Q3 = 2 AND Q1 >= 18" — it then applies only while that holds ("when": null removes it)
  // on: answer · change · select_option (with "options") · deselect_option · page_complete · block_complete · appear · page_enter · click · hover
  // effects: animate {preset} · show_message {text: plain text} · hide_message · add_class / remove_class / toggle_class {className} · set_style {style} · show · hide · scroll_into_view · focus — each with an optional "target" (default: the behaviour's own)
  // select_option, page_complete, block_complete and hover HOLD while true and are undone when they stop being true; a style rule with "whenClass":"chosen" applies while add_class "chosen" is on
  // attach_behavior_to_question / _option / _block / _page = create_behavior on that kind of target
{"op":"create_behavior","label":"…","target":"Q5","script":"rs.listen('select', 'self', (e) => { if (e.option === '99') rs.showMessage('self', 'Tell us more below.'); });"}
  // JavaScript ONLY when the researcher asks for code or nothing above can do it. It runs in a sandbox with only this api:
  // rs.listen(event, target, fn) — events answer change select deselect click hover page complete; fn gets {question, value, option}
  // rs.getAnswer("Q3") rs.getQuestion("Q3") rs.getBlock() rs.getPage() rs.addClass(t, name) rs.removeClass(t, name) rs.toggleClass(t, name) rs.animate(t, preset, {duration}) rs.setStyle(t, {prop: value}) rs.clearStyle(t) rs.show(t) rs.hide(t) rs.showMessage(t, text) rs.hideMessage(t) rs.scrollTo(t) rs.focus(t) rs.after(ms, fn) rs.log(…)
  // t is a target string above or "self". No loops (while/for/do), no document/window/fetch/storage, no DOM events: refused.
  // A script CANNOT fill in or change an answer (no rs.setAnswer, no input.value, no dispatchEvent). A starting answer is set_default_value:
{"op":"set_default_value","target":"Q2","value":19}   // the question's default value (Properties → Default value): filled in when the question is first shown, only if it has no answer yet, never over the respondent's own answer; a number for numeric, text for text, an option CODE (or list of codes for a multi-select) for a choice question; null removes it
{"op":"update_behavior","id":"…","effects":[…]}   // or "on", "options", "script": what is given replaces
{"op":"remove_style","id":"…"} · {"op":"remove_animation","id":"…"} · {"op":"remove_behavior","id":"…"}

THE THEME is the survey's Branding — the same settings the Branding panel shows, so the researcher can adjust every value by hand afterwards. Change it with set_theme (only the fields you give change; null resets an optional one):
{"op":"set_theme","label":"Premium dark","colors":{"primary":"#c9a227","secondary":"#1c1c24","background":"#0b0b0f","surface":"#15151c","text":"#f5f1e6","subtleText":"#a7a293","border":"#2a2a33","accent":"#e0c068","buttonBackground":"#c9a227","buttonText":"#111111","inputBackground":"#1b1b23","progress":"#c9a227"},
 "typography":{"fontFamily":"Inter, system-ui, sans-serif","headingFont":"'Playfair Display', Georgia, serif","baseSize":"16px","headingWeight":650,"lineHeight":"1.55","questionSize":"1.15em"},
 "layout":{"cardStyle":"card|flat|line","radius":"14px","spacing":"compact|regular|relaxed","widthMode":"full|contained","contentAlign":"left|center|right","progressBar":"top|bottom|none"},
 "buttons":{"style":"solid|outline|pill"},
 "background":{"image":"<https url or the uploaded image url>","size":"cover","position":"center","attachment":"fixed|scroll","overlay":"rgba(0,0,0,.55)","gradient":"linear-gradient(160deg, #0b0b0f, #1c1c24)"},
 "appearance":{"shadow":"none|soft|medium|strong","optionStyle":"default|cards|pills|minimal","controlStyle":"native|custom","inputStyle":"outlined|filled|underline","cardPadding":"28px","optionGap":"10px","borderWidth":"1px","selectedTint":14,"focusColor":"#e0c068","buttonRadius":"999px","progressHeight":"4px","logoMaxHeight":"48px"},
 "responsive":{"mobile":{"baseSize":"15px","cardPadding":"16px","optionGap":"8px","hideBackgroundImage":true},"tablet":{"maxWidth":"720px"}},
 "logoUrl":"https://…","headerHtml":"<p>…</p>","footerHtml":"<p>…</p>"}
  // a dark theme needs light text and enough contrast on buttons and inputs; over a busy background image add an overlay
  // THEME IMAGE: when an uploaded image is given below (url and its palette), build the theme from its palette and, if asked, use its url as background.image
{"op":"set_custom_html","target":"Q5","html":"<p class=\"note\">…</p>"}   // decorative HTML shown above Q5's answers (no scripts, styles or event handlers; null removes it)

HOW TO WORK ON UX.
• Decompose a compound request into one item per thing asked: "For Block 2 make every question fade up, the options cards, a slight scale when one is selected, one option per row on mobile, don't change the logic" → an animation on block:2.questions (fade-up, appear), a style on block:2.options (card rules, a "selected" rule with transform: scale(1.02), a mobile rule) — and no structural action.
• Look before you add: the outline lists the survey's existing styles, animations and behaviours by id. Change them (update_*) rather than adding competing ones; to clean up, remove the unused or duplicated ones; to resolve a conflict, change one side.
• Diagnose from what is there: the outline's "Qn ux:" lines give a question's layout (orientation, columns, options) and every style, animation and behaviour touching it. "Options overlap on mobile" → a mobile rule; "the animation doesn't run when Q5 changes" → its trigger is probably appear (plays once) where select or answer was meant.
• Keep it accessible: readable contrast, visible focus, never hide a radio or checkbox with display:none (use opacity 0 and position absolute so the keyboard still reaches it). Motion is switched off automatically for respondents who ask their system to reduce it.
• A UX hide is visual only — the question is still asked and validated; that needs display logic, and only if asked.
• In "reply", explain in plain words what will change and what will not, e.g. "I'll add a scoped card style to Q12's options (only Q12 is affected), a short pop when one is selected, and a smooth expand for the Other box. The question, its codes and its logic stay exactly as they are."`;

/* ------------------------------------------------------------ what a request needs */

export type RequestMode = "generate" | "edit" | "review" | "question" | "ux";

/**
 * What kind of request this is, and whether it needs the research documents
 * — decided cheaply, BEFORE the model is called, only to choose the context
 * (the model decides the answer). "Change Q18 to a matrix" sends no papers;
 * "based on the literature, add three trust questions" sends the passages
 * about trust.
 */
export function classifyRequest(message: string, surveyQuestions: number, documents: number): { mode: RequestMode; research: boolean; ux: boolean; uxOnly: boolean } {
  const t = message.toLowerCase();
  // "review my survey", "check the logic", "audit this questionnaire" — not "the literature review says…"
  const review = /^(?:please\s+|can you\s+|could you\s+)?(?:review|audit|check|critique|evaluate|assess|proofread)\b(?!.*\b(?:add|create|build)\b)|\b(?:review|audit|check|critique|evaluate|assess)\s+(?:my|the|this|our)\s+(?:survey|questionnaire|questions|logic|flow|wording|routing)\b|\bwhat(?:'s| is) wrong\b|\bany (?:problems|issues)\b|survey (?:ka )?review|review (?:karo|kar do)/.test(t);
  const generate = /\b(?:create|build|design|generate|draft|make|write|prepare|develop|banana|bana do|banao)\b.{0,60}\b(?:survey|questionnaire|study|screener)\b|\b(?:survey|questionnaire|screener)\b.{0,30}\b(?:banana|banao|bana do|banani|chahiye|tayyar)\b|\bhypothes[ie]s\b|\bresearch (?:objective|question|design)\b|\btest (?:this|it|the hypothesis)\b/.test(t) && (surveyQuestions < 3 || /\b(?:new|another|from scratch|whole|complete|full)\b/.test(t) || /\bhypothes/.test(t));
  const edit = /\b(?:add|remove|delete|change|make|move|rename|randomi[sz]e|shuffle|show|hide|skip|require|mandatory|optional|split|merge|shorten|shorter|reduce|replace|convert|turn|set|insert|put|page break|scale|option|karo|kar do|hatao|jodo)\b/.test(t);
  const research = documents > 0 && (/\b(?:literature|research|paper|papers|study|studies|brief|document|documents|report|reports|findings|evidence|source|sources|uploaded|reading|according to|based on|as per|citation|scale from|validated scale|existing measure)\b/.test(t) || (generate && surveyQuestions < 3));
  const u = uxIntent(t);
  const mode: RequestMode = review ? "review" : generate ? "generate" : u.ux ? "ux" : edit ? "edit" : "question";
  return { mode, research, ux: u.ux, uxOnly: u.ux && u.only && !generate };
}

/**
 * IS THIS ABOUT HOW THE SURVEY LOOKS OR BEHAVES — and ONLY that? "Make Q10
 * look better", "add a hover animation to the Q4 options", "fix the mobile
 * layout", "when Q5 is answered animate the Next button" are; "add a question
 * about price and make it look nice" is both, so structure stays allowed. A
 * request that says "don't change the logic" / "only the UI" is look-only
 * whatever else it names.
 */
export function uxIntent(text: string): { ux: boolean; only: boolean } {
  const t = text.toLowerCase();
  // strong: only ever about the look and behaviour; weak: usually is, but can be a topic ("mobile banking", "credit cards")
  const strong = /\b(?:themes?|branding|default (?:value|answer)s?|pre-?fill(?:ed|s)?|pre-?populate[ds]?|dark (?:mode|theme)|light theme|colou?r scheme|palette|background image|custom html|html|look like this|css|styl(?:e|es|ing|ish)|look(?:s)? (?:better|nicer|cleaner|modern|premium|different|more)|look and feel|visual(?:ly)?|colou?rs?|font|typography|spacing|padding|margins?|borders?|rounded|shadows?|animat(?:e|ed|es|ion|ions)|fade(?:s|-in| in| up|-up)?|transitions?|hover|glow|pulse|bounce|shake|highlight(?:ed|s)?|smooth(?:ly)?|prettier|beautiful|ui|ux|responsive|javascript|js|scripts?|event handlers?|interactions?|interactive|dynamic ui|one at a time|overlap(?:s|ping)?|countdown|confirmation animation)\b/.test(t);
  const weak = /\b(?:cards?|tiles?|background|design|feel (?:more )?(?:premium|modern|polished)|mobile|desktop|tablet|layout|stack(?:ed)? (?:vertically|horizontally)|horizontal|vertical|next button|buttons?|progress (?:bar|indicator)|expand(?:s|ing)?)\b/.test(t);
  const ux = strong || weak;
  if (!ux) return { ux: false, only: false };
  const negated = /\b(?:don'?t|do not|without|never|no)\s+(?:change|changing|touch|touching|modify|modifying|alter|altering|break|breaking)\b[^.]{0,50}\b(?:logic|structure|questions?|wording|survey|codes?|options?|anything else|data)\b|\bonly\s+(?:the\s+|improve\s+the\s+|change\s+the\s+)?(?:ui|ux|look|looks|design|styling|style|visuals?|appearance|css)\b|\b(?:ux|ui|visual|styling|design|css)[- ]only\b|\bux changes? only\b/.test(t);
  const stripped = t.replace(/\b(?:don'?t|do not|without|never|no)\s+(?:change|changing|touch|touching|modify|modifying|alter|altering|break|breaking)\b[^.]{0,60}/g, " ");
  const structural = /\b(?:add|create|insert|new)\s+(?:a |an |another |two |three |some )?(?:new )?(?:questions?|blocks?|page breaks?|options? (?:called|named|for|“|")|choices? (?:called|named))\b|\b(?:delete|remove)\s+(?:the\s+)?(?:questions?|blocks?|options? \d|page)\b|\b(?:reword|rephrase|rewrite|wording|question text|translate)\b|\b(?:display|skip|branch(?:ing)?)\s+(?:logic|rules?|conditions?)\b|\bskip\b|\bvalidation\b|\b(?:required|mandatory|optional)\b|\brandomi[sz]e\b|\bquotas?\b|\bchange (?:the )?type\b|\bconvert\b.{0,30}\b(?:matrix|grid|dropdown|single|multi|ranking|slider)\b|\b(?:recode|variable name)\b|\bpunch(?:es|ing|ed)?\b|\bauto[- ]?punch\b|\b(?:hidden|derived|calculated)\s+variables?\b|\bembedded\s+data\b|\bsegment(?:ation|s)?\b|\b(?:code|assign|tag)\s+(?:the\s+)?(?:\w+\s+)?(?:as|to)\s+["“]?\w|\b(?:change|turn|make)\s+\S+\s+(?:in)?to\s+(?:a|an)\s+(?:card sort|matrix|grid|dropdown|ranking|slider|nps|star|single|multi|open|text|numeric)\b/.test(stripped);
  return { ux: true, only: negated || (strong && !structural) };
}

export interface TurnMemory { memory?: string; history: { role: "user" | "copilot"; text: string }[] }

export function copilotUserPrompt(input: {
  message: string;
  outline: string;
  surveyLanguage: string;
  mode: RequestMode;
  memory?: TurnMemory;
  research?: string;
  deterministicFindings?: string[];
  selected?: string | null;
  /** the request is about the look and behaviour: the UX guide goes with it */
  ux?: boolean;
  uxOnly?: boolean;
  /** an uploaded image to build the theme from (its colours; the address is a placeholder) */
  themeImage?: string;
  /** the Branding panel's theme assistant */
  themeOnly?: boolean;
}): string {
  const parts: string[] = [];
  parts.push(`Survey language: ${input.surveyLanguage}`);
  parts.push(`CURRENT SURVEY (outline):\n${input.outline}`);
  if (input.memory?.memory) parts.push(`CONVERSATION MEMORY:\n${input.memory.memory}`);
  if (input.memory?.history.length) parts.push(`RECENT TURNS:\n${input.memory.history.slice(-6).map((h) => `${h.role === "user" ? "Researcher" : "Copilot"}: ${h.text.slice(0, 400)}`).join("\n")}`);
  if (input.research) parts.push(`RESEARCH MATERIAL (only the passages this request needs; cite by id):\n${input.research}`);
  if (input.deterministicFindings?.length) parts.push(`THE ENGINE'S OWN CHECKS ALREADY FOUND (do not repeat these; add what only a reader of meaning would find — research alignment, hypothesis coverage, wording, bias, sequencing, analysis limits):\n${input.deterministicFindings.map((f) => `- ${f}`).join("\n")}`);
  if (input.selected) parts.push(`Selected in the Studio: ${input.selected}`);
  if (input.ux) parts.push(COPILOT_UX_GUIDE);
  if (input.uxOnly) parts.push("THIS REQUEST IS LOOK-AND-BEHAVIOUR ONLY: propose UX actions only. Any structural action (questions, options, logic, validation, blocks, punch rules, variables) will be refused. If the researcher also needs such a change, say in one sentence that they can ask for it as its own request in this same chat (for example “Code SEGMENT as 1 when Q3 = 1”) — there is no other mode or session to switch to.");
  if (input.themeOnly) parts.push("THIS IS THE THEME: answer with one set_theme action covering everything the request implies (colours with readable contrast, fonts, background, cards, options, controls, inputs, spacing, phone sizes). Its values become the survey's Branding settings, which the researcher then adjusts by hand.");
  if (input.themeImage) parts.push(input.themeImage);
  parts.push(`Request type (a hint, not a rule): ${input.mode}`);
  parts.push(`RESEARCHER:\n${input.message.trim()}`);
  return parts.join("\n\n");
}

/** the survey's own language: its first language, as a readable tag */
export function surveyLanguageOf(def: SurveyDefinition): string {
  return def.localization?.sourceLanguage || def.deployment?.languages?.[0] || "en";
}

/** question codes and variables a message names — the outline shows these in full */
export function referencedQuestions(def: SurveyDefinition, message: string): string[] {
  const words = new Set((message.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).map((w) => w.toLowerCase()));
  return def.questions.filter((q) => words.has(String(q.code).toLowerCase()) || words.has(q.variableName.toLowerCase())).map((q) => q.id);
}
