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
{"op":"set_display_logic","target":"Q15 or a block title","expression":"Q12 = Yes"}     // expression null removes it
{"op":"add_skip","from":"Q3","when":"Q3 = No","to":"Q10 | <block title> | end | screen_out | terminate"}
{"op":"clear_skips","target":"Q3"}
{"op":"set_validation","target":"Q4","rules":[{"kind":"min_value","value":0},{"kind":"max_value","value":120},{"kind":"integer"}]}
{"op":"page_break","after":"Q6"}   /  {"op":"page_break","after":"Q6","remove":true}
{"op":"create_embedded","name":"source","source":"url|static|panel|expression","value":"..."}
{"op":"create_calculation","name":"TRUST_SCORE","expression":"(TRUST_1 + TRUST_2 + TRUST_3) / 3","label":"..."}
{"op":"create_randomizer","blocks":["Block A","Block B"],"show":1}       // blocks must be next to each other at the top level
{"op":"create_branch","blocks":["Owners"],"when":"OWN = Yes","title":"Car owners"}   // route whole blocks: only respondents meeting the condition get them
{"op":"create_loop","from":"SAT","to":"SAT_WHY","over":"BRANDS","loopVar":"brand"}   // ask a run of questions once per selected answer of BRANDS (or "items":["A","B"]); pipe the item with {{loop.label}}
{"op":"create_quota","name":"Age","cells":[{"label":"18–24","when":"AGE <= 24","limit":200}]}
{"op":"rename_block","target":"...","title":"..."}  /  {"op":"delete_block","target":"..."}
{"op":"set_research","objective":"...","hypotheses":["..."],"population":"...","methodology":"...","constructs":[{"name":"...","role":"independent","definition":"...","questions":["EXPOSE"]}],"analysis":["..."],"assumptions":["..."],"sources":["document names"]}

REFS. Give every new question a "ref" that reads as a variable name (AGE, BUY_6M, TRUST_1). The ref becomes its variable, so conditions, calculations and piping can use it in the same batch: "BUY_6M = No", "{{BRAND}}". Existing questions are named by their CODE or VARIABLE from the outline; never invent a code that is not in the outline or created in this batch.

CONDITIONS ("expression", "when"): QCODE or VARIABLE compared with = != > >= < <= between; option values by code or label (Q3 = Yes, BRAND = 2); "Q4 answered", "Q4 unanswered", "Q4 contains Coke" (multi), COUNT(Q4) >= 2; combine with AND, OR, NOT and parentheses. A condition may only read questions asked BEFORE the question it controls.

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

/* ------------------------------------------------------------ what a request needs */

export type RequestMode = "generate" | "edit" | "review" | "question";

/**
 * What kind of request this is, and whether it needs the research documents
 * — decided cheaply, BEFORE the model is called, only to choose the context
 * (the model decides the answer). "Change Q18 to a matrix" sends no papers;
 * "based on the literature, add three trust questions" sends the passages
 * about trust.
 */
export function classifyRequest(message: string, surveyQuestions: number, documents: number): { mode: RequestMode; research: boolean } {
  const t = message.toLowerCase();
  // "review my survey", "check the logic", "audit this questionnaire" — not "the literature review says…"
  const review = /^(?:please\s+|can you\s+|could you\s+)?(?:review|audit|check|critique|evaluate|assess|proofread)\b(?!.*\b(?:add|create|build)\b)|\b(?:review|audit|check|critique|evaluate|assess)\s+(?:my|the|this|our)\s+(?:survey|questionnaire|questions|logic|flow|wording|routing)\b|\bwhat(?:'s| is) wrong\b|\bany (?:problems|issues)\b|survey (?:ka )?review|review (?:karo|kar do)/.test(t);
  const generate = /\b(?:create|build|design|generate|draft|make|write|prepare|develop|banana|bana do|banao)\b.{0,60}\b(?:survey|questionnaire|study|screener)\b|\b(?:survey|questionnaire|screener)\b.{0,30}\b(?:banana|banao|bana do|banani|chahiye|tayyar)\b|\bhypothes[ie]s\b|\bresearch (?:objective|question|design)\b|\btest (?:this|it|the hypothesis)\b/.test(t) && (surveyQuestions < 3 || /\b(?:new|another|from scratch|whole|complete|full)\b/.test(t) || /\bhypothes/.test(t));
  const edit = /\b(?:add|remove|delete|change|make|move|rename|randomi[sz]e|shuffle|show|hide|skip|require|mandatory|optional|split|merge|shorten|shorter|reduce|replace|convert|turn|set|insert|put|page break|scale|option|karo|kar do|hatao|jodo)\b/.test(t);
  const research = documents > 0 && (/\b(?:literature|research|paper|papers|study|studies|brief|document|documents|report|reports|findings|evidence|source|sources|uploaded|reading|according to|based on|as per|citation|scale from|validated scale|existing measure)\b/.test(t) || (generate && surveyQuestions < 3));
  const mode: RequestMode = review ? "review" : generate ? "generate" : edit ? "edit" : "question";
  return { mode, research };
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
}): string {
  const parts: string[] = [];
  parts.push(`Survey language: ${input.surveyLanguage}`);
  parts.push(`CURRENT SURVEY (outline):\n${input.outline}`);
  if (input.memory?.memory) parts.push(`CONVERSATION MEMORY:\n${input.memory.memory}`);
  if (input.memory?.history.length) parts.push(`RECENT TURNS:\n${input.memory.history.slice(-6).map((h) => `${h.role === "user" ? "Researcher" : "Copilot"}: ${h.text.slice(0, 400)}`).join("\n")}`);
  if (input.research) parts.push(`RESEARCH MATERIAL (only the passages this request needs; cite by id):\n${input.research}`);
  if (input.deterministicFindings?.length) parts.push(`THE ENGINE'S OWN CHECKS ALREADY FOUND (do not repeat these; add what only a reader of meaning would find — research alignment, hypothesis coverage, wording, bias, sequencing, analysis limits):\n${input.deterministicFindings.map((f) => `- ${f}`).join("\n")}`);
  if (input.selected) parts.push(`Selected in the Studio: ${input.selected}`);
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
