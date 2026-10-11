import type { SurveyDefinition, Question, ResearchConstruct } from "@rescript/schema";
import { buildAnalysisFramework, hypothesisCoverage, inferRole, measurementOf, methodologyAdvice, prioritizeCrosstabs } from "./analysisFramework.js";
import { structuredHypotheses, type StructuredHypothesis } from "./hypotheses.js";
import { listBlocks } from "./blocks.js";
import { interpretRequest, standardMeasure, type OutputRequest } from "./nlIntent.js";
import type { SurveyAction } from "./surveyActions.js";
import { stripHtmlText } from "./html.js";
import { contentWords } from "./nlTargets.js";
import { wordFamily } from "./nlSemantics.js";

/*
 * THE RESEARCH AGENT'S PLANNER (Research Engine audit, Phase 6).
 *
 * One objective → the end-to-end workflow: clarify assumptions → structured
 * hypotheses → research framework → questionnaire → variables → analysis
 * plan → crosstab and test recommendations → reporting framework → design
 * document → survey structure → after fieldwork, the deck. The planner is
 * PURE: it reads the survey as it is and says, for every step, whether it
 * is done, what the engine would do next by itself (as actions the
 * researcher approves, and as the sentence the Intelligent box reads), what
 * only the researcher can answer, and where a language model is wanted —
 * with the tier a step needs so the Studio can preview the cost before a
 * call is made. Nothing here writes to the definition; nothing here calls a
 * model. In INTERNAL mode a model step becomes what the engine can do
 * instead (a standard item, the parsed reading), or a question to the
 * researcher — never a silent skip.
 */

export type WorkflowStepId = "objective" | "assumptions" | "hypotheses" | "framework" | "questionnaire" | "variables" | "analysis_plan" | "recommendations" | "reporting_framework" | "design_document" | "survey_structure" | "deck";
/** done: nothing to do · ready: the engine has the next action · needs_input: only the researcher can say · model: a language model would do it · blocked: an earlier step first */
export type WorkflowStatus = "done" | "ready" | "needs_input" | "model" | "blocked";
export type WorkflowExecutor = "engine" | "model" | "researcher" | "output";
/** none: no model call · small: a short structuring call · large: drafting */
export type ModelTier = "none" | "small" | "large";
export type ExecutionMode = "internal" | "cloud";

export interface WorkflowStep {
  id: WorkflowStepId;
  title: string;
  status: WorkflowStatus;
  executor: WorkflowExecutor;
  /** what was found, and why the step has its status — one line for the card */
  why: string;
  /** the sentence the Intelligent box reads to do the step (engine steps and outputs) */
  sentence?: string;
  /** the actions the engine takes itself, for the researcher to approve */
  actions?: SurveyAction[];
  /** what the researcher must answer, each as a sentence that records it when completed */
  questions?: { ask: string; example: string }[];
  /** the file an output step produces */
  output?: OutputRequest;
  tier: ModelTier;
  /** what a model step would be asked, for the cost preview: the prompt's size and the reply's cap */
  model?: { estimateText: string; maxTokens: number; operation: string };
  /** the step this one waits on */
  blockedBy?: WorkflowStepId;
}

export interface ResearchWorkflow {
  mode: ExecutionMode;
  steps: WorkflowStep[];
  /** the first step that is not done, or null when the workflow is complete */
  next: WorkflowStep | null;
  done: number;
  total: number;
  /** "4 of 12 steps done — next: Questionnaire (the engine can add 2 standard items)" */
  summary: string;
}

export interface WorkflowOptions {
  /** an objective given in the same breath ("start the research workflow for …") — the first step records it */
  objective?: string;
  /** fieldwork data exists: the deck can be produced */
  runAvailable?: boolean;
  /** the outputs already produced in this session (the engine cannot see a file) */
  produced?: ("design_document" | "deck")[];
  /** internal: no model is called — the engine's own alternative or the researcher's answer; cloud: model steps go to the model */
  mode?: ExecutionMode;
}

const TITLES: Record<WorkflowStepId, string> = {
  objective: "Objective", assumptions: "Assumptions", hypotheses: "Structured hypotheses", framework: "Research framework", questionnaire: "Questionnaire", variables: "Variables",
  analysis_plan: "Analysis plan", recommendations: "Crosstab and test recommendations", reporting_framework: "Reporting framework", design_document: "Design document", survey_structure: "Survey structure", deck: "Findings deck",
};
const ORDER: WorkflowStepId[] = ["objective", "assumptions", "hypotheses", "framework", "questionnaire", "variables", "analysis_plan", "recommendations", "reporting_framework", "design_document", "survey_structure", "deck"];

const plain = (s: string | undefined, n = 70): string => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;
const list = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const NOT_ASKED = new Set(["html", "custom_component", "media_timeline"]);
const asked = (def: SurveyDefinition) => def.questions.filter((q) => !NOT_ASKED.has(q.type));
const codeOf = (def: SurveyDefinition, id: string) => def.questions.find((q) => q.id === id)?.code;
const varName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "SCORE";

/** "among UK adults who bought a car in the last year" → the population a sentence names; null when it names none */
export function populationFromObjective(objective: string): string | null {
  const m = /((?:[A-Za-z][\w-]*\s+){0,2})(adults?|consumers?|customers?|shoppers?|buyers?|users?|owners?|drivers?|patients?|parents?|students?|employees?|staff|members?|subscribers?|visitors?|voters?|households?|respondents?|people|women|men|teens|seniors)\b((?:\s+(?:who|that|which|aged|in|with|of|from|living|working|earning)\b[^.;]*)?)/i.exec(objective);
  if (!m) return null;
  /* the modifiers before the noun that belong to it ("UK", "first-time"), not the sentence's own words ("why", "among") */
  const keep: string[] = [];
  for (const w of m[1].trim().split(/\s+/).filter(Boolean).reverse()) { if (STOP.test(w)) break; keep.unshift(w); }
  /* the relative clause ends where the sentence's own verb begins: "who bought a car | switch from Brand A" — the clause's own verb (right after who/that/which) is kept */
  const ws = m[3].replace(/\s+(?:and|to|so|because|whether|when|while|before|after|versus|vs)\b[\s\S]*$/i, "").trim().split(/\s+/).filter(Boolean);
  const skip = /^(?:who|that|which)$/i.test(ws[0] ?? "") ? 2 : 1;
  const cut = ws.findIndex((w, i) => i >= skip && VERB.test(w));
  const clause = (cut >= 0 ? ws.slice(0, cut) : ws).join(" ");
  return `${[...keep, m[2]].join(" ")}${clause ? ` ${clause}` : ""}`.trim().replace(/[,\s]+$/, "") || null;
}
const STOP = /^(?:understand(?:ing)?|why|how|whether|what|which|do|does|among|amongst|with|for|of|the|a|an|our|their|about|explore|measure|test|see|find|learn|if|that|to|and|from|by|in|on|at)$/i;
const VERB = /^(?:switch|choos|chose|prefer|buy|bought|rate|use|think|feel|perceiv|see|value|want|need|respond|react|decid|consider|leav|stay|churn|return|recommend|trust|pay|spend|shop|visit|adopt|would|will|are|is|do|does|have|has|might|could|should)\w*$/i;

/* -------------------------------------------------------------- the steps */

type Build = (def: SurveyDefinition, o: WorkflowOptions, prior: WorkflowStep[]) => WorkflowStep;
const step = (id: WorkflowStepId, s: Omit<WorkflowStep, "id" | "title" | "tier"> & { tier?: ModelTier }): WorkflowStep => ({ id, title: TITLES[id], tier: s.tier ?? "none", ...s });
const blocked = (id: WorkflowStepId, by: WorkflowStepId, why: string): WorkflowStep => step(id, { status: "blocked", executor: "engine", why, blockedBy: by });
const isDone = (prior: WorkflowStep[], id: WorkflowStepId) => prior.find((s) => s.id === id)?.status === "done";

/** "Should we cut the price of Brand A?" → "Understand whether to cut the price of Brand A"; a statement is kept as it is */
export function objectiveFromBusinessQuestion(q: string): string {
  const t = q.trim().replace(/[?.!]+$/, "");
  let m: RegExpExecArray | null;
  if ((m = /^(?:should|shall|do|does|can|could|will|would)\s+(?:we|i|the\s+\w+|\w+)\s+(.+)$/i.exec(t))) return `Understand whether to ${m[1]}`;
  if ((m = /^(?:is|are)\s+(.+)$/i.exec(t))) return `Understand whether ${m[1]}`;
  if ((m = /^(?:which|what|how|why|when|where|who)\b(.*)$/i.exec(t))) return `Understand ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  return t;
}

const objectiveStep: Build = (def, o) => {
  const had = def.research?.objective?.trim();
  if (had) return step("objective", { status: "done", executor: "engine", why: `The objective is recorded: ${quote(plain(had))}.` });
  const given = o.objective?.trim();
  if (given) return step("objective", { status: "ready", executor: "engine", why: `Record the objective ${quote(plain(given))}.`, sentence: `Set the research objective to ${quote(given)}`, actions: [{ op: "set_research", objective: given }] });
  // Phase 8: the brief's business question is the objective in the client's words — offered as the objective, for approval
  const bq = def.research?.brief?.businessQuestion?.trim();
  if (bq) { const objective = objectiveFromBusinessQuestion(bq); return step("objective", { status: "ready", executor: "engine", why: `The brief asks ${quote(plain(bq))} — recorded as the objective ${quote(plain(objective))}.`, sentence: `Set the research objective to ${quote(objective)}`, actions: [{ op: "set_research", objective }] }); }
  return step("objective", { status: "needs_input", executor: "researcher", why: "No research objective is recorded — everything else reads it.", questions: [{ ask: "What should the study find out?", example: "Set the research objective to \"Understand why customers switch from Brand A to Brand B\"" }] });
};

const assumptionsStep: Build = (def, _o, prior) => {
  if (!isDone(prior, "objective")) return blocked("assumptions", "objective", "The assumptions follow from the objective.");
  const r = def.research!;
  const objective = r.objective ?? "";
  const missing: NonNullable<WorkflowStep["questions"]> = [];
  const found: string[] = [];
  /* one action carries all the engine read, each as an assumption listed so the researcher sees what was assumed */
  const merged: Extract<SurveyAction, { op: "set_research" }> = { op: "set_research" };
  const assumptions = [...(r.assumptions ?? [])];
  if (!r.population?.trim()) {
    const pop = populationFromObjective(objective);
    if (pop) { merged.population = pop; assumptions.push(`Population read from the objective: ${pop}`); found.push(`the population ${quote(pop)} read from the objective`); }
    else missing.push({ ask: "Who is the population — who should answer?", example: "Set the population to \"UK adults who bought a car in the last 12 months\"" });
  }
  if (!r.methodology?.trim()) {
    const adv = methodologyAdvice(objective);
    if (adv) { merged.methodology = adv.recommended; assumptions.push(`Methodology chosen from the objective: ${adv.recommended}`); found.push(`the methodology ${quote(adv.recommended)} from the objective's wording`); }
    else missing.push({ ask: "Which methodology — an online panel survey, a tracker, a concept test?", example: "Set the methodology to \"Online panel survey\"" });
  }
  if (!r.sampleSize) missing.push({ ask: "How many completes are planned?", example: "Set the sample size to 400" });
  const still = () => list(missing.map((m) => m.ask.replace(/\s+—.*$/, "").replace(/\?$/, "").toLowerCase()));
  if (!found.length && !missing.length) return step("assumptions", { status: "done", executor: "engine", why: `Population, methodology and sample size are recorded${r.assumptions.length ? `; ${plural(r.assumptions.length, "assumption")} listed` : ""}.` });
  if (found.length) {
    merged.assumptions = [...new Set(assumptions)];
    return step("assumptions", { status: "ready", executor: "engine", why: `The engine can record ${list(found)}, as assumptions to confirm${missing.length ? `; it still needs ${still()}` : ""}.`, sentence: "Record the assumptions the engine read from the objective", actions: [merged], ...(missing.length ? { questions: missing } : {}) });
  }
  return step("assumptions", { status: "needs_input", executor: "researcher", why: `The engine cannot read ${still()} from the objective.`, questions: missing });
};

const readable = (h: StructuredHypothesis) => (h.type === "difference" ? !!h.group && !!h.dependent : !!h.independent && !!h.dependent) || (h.type === "descriptive" && !!h.dependent);

const hypothesesStep: Build = (def, o, prior) => {
  if (!isDone(prior, "objective")) return blocked("hypotheses", "objective", "The hypotheses state what the objective expects.");
  const r = def.research!;
  if (!r.hypotheses.length) {
    const model = { estimateText: `OBJECTIVE: ${r.objective}\nPOPULATION: ${r.population ?? ""}\nQUESTIONS: ${def.questions.map((q) => stripHtmlText(q.text)).join(" | ")}`, maxTokens: 700, operation: "workflow_hypotheses" };
    const sentence = `Draft hypotheses for the objective ${quote(plain(r.objective, 60))}`;
    if (o.mode === "internal") return step("hypotheses", { status: "needs_input", executor: "researcher", tier: "large", why: "No hypotheses are recorded, and internal mode calls no model to draft them.", questions: [{ ask: "What does the objective expect to find? One hypothesis per sentence.", example: "Add hypothesis: Price perception drives switching" }], model, sentence });
    return step("hypotheses", { status: "model", executor: "model", tier: "large", why: "No hypotheses are recorded — the model drafts them from the objective; you approve each.", sentence, model, questions: [{ ask: "Or state them yourself, one per sentence.", example: "Add hypothesis: Price perception drives switching" }] });
  }
  const hs = structuredHypotheses(def);
  const unread = hs.filter((h) => !readable(h));
  const parsedOnly = hs.filter((h) => readable(h) && Object.values(h.source).includes("parsed") && !Object.values(h.source).includes("recorded"));
  if (unread.length) {
    const model = { estimateText: unread.map((h) => `${h.label}: ${h.text}`).join("\n"), maxTokens: 300, operation: "workflow_structure" };
    const why = `${list(unread.map((h) => h.label))} cannot be read into a type, a direction and two sides from the words.`;
    const questions = unread.map((h) => ({ ask: `What does ${h.label} compare or relate? (${plain(h.text, 60)})`, example: `Set the reading of ${h.label}: type causal, independent "price perception", dependent "switching", direction positive` }));
    const sentence = `Structure the hypotheses ${list(unread.map((h) => h.label))}`;
    if (o.mode === "internal") return step("hypotheses", { status: "needs_input", executor: "researcher", tier: "small", why: `${why} Internal mode calls no model to read them.`, questions, model, sentence });
    return step("hypotheses", { status: "model", executor: "model", tier: "small", why: `${why} The model reads them; you approve the reading.`, sentence, model, questions });
  }
  if (parsedOnly.length) {
    const actions: SurveyAction[] = parsedOnly.map((h) => ({ op: "set_hypothesis", hypothesis: h.label, detail: { type: h.type, direction: h.direction, ...(h.independent ? { independent: h.independent } : {}), ...(h.dependent ? { dependent: h.dependent } : {}), ...(h.group ? { group: h.group } : {}), ...(h.lower ? { lower: h.lower } : {}), ...(h.moderator ? { moderator: h.moderator } : {}), ...(h.mediator ? { mediator: h.mediator } : {}) } } as SurveyAction));
    return step("hypotheses", { status: "ready", executor: "engine", why: `${list(parsedOnly.map((h) => h.label))} read from the words (${parsedOnly.map((h) => `${h.label}: ${h.type}, ${h.direction}`).join("; ")}) — record the readings so the framework can rely on them.`, sentence: `Record the parsed readings of ${list(parsedOnly.map((h) => h.label))}`, actions });
  }
  return step("hypotheses", { status: "done", executor: "engine", why: `${plural(hs.length, "hypothesis", "hypotheses")} recorded with their readings (${hs.map((h) => `${h.label}: ${h.type}`).join(", ")}).` });
};

/** "satisfied" → Satisfaction, "switched" → Switching: the noun a construct is named by */
const NOUNS: [RegExp, string][] = [[/^satisf/i, "Satisfaction"], [/^switch/i, "Switching"], [/^aware/i, "Awareness"], [/^loyal/i, "Loyalty"], [/^trust/i, "Trust"], [/^recommend/i, "Likelihood to recommend"], [/^(?:purchase|buying)\s+intent|^intent(?:ion)?\s+to\s+(?:buy|purchase)|^likel\w*\s+to\s+(?:buy|purchase)/i, "Purchase intent"], [/^(?:price|value)\s+percept|^value\s+for\s+money/i, "Price perception"], [/^important|^importance/i, "Importance"]];
export function constructName(side: string): string {
  const t = side.trim().replace(/^(?:the|their|our|a|an)\s+/i, "");
  for (const [re, name] of NOUNS) if (re.test(t)) return name;
  return cap(t);
}

/**
 * The questions that already measure a construct named in words: every
 * content word of the name (as its family of synonyms) found in the
 * question's text or variable name — "Switching" in "Have you switched
 * brands" (SWITCHED), "Price perception" in "better value for money"
 * (PRICE_PERC) — or the text matching the standard measure's own words.
 */
export function questionsMeasuring(def: SurveyDefinition, name: string, limit = 3): Question[] {
  const fams = contentWords(name).filter((w) => w.length > 2).map((w) => [...wordFamily(w)]);
  if (!fams.length) return [];
  const measure = standardMeasure(name);
  const hit = (toks: string[], fam: string[]) => fam.some((f) => toks.some((t) => t === f || (t.length >= 4 && f.startsWith(t)) || (f.length >= 4 && t.startsWith(f))));
  const scored = asked(def).filter((q) => q.type !== "open_text").map((q) => {
    const text = stripHtmlText(q.text);
    const toks = contentWords(`${text} ${q.variableName}`);
    const byWords = fams.every((f) => hit(toks, f));
    const byMeasure = !!measure && measure.re.test(text);
    return { q, s: byWords ? 2 : byMeasure ? 1 : 0 };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.q);
}

/** the construct a hypothesis side would need, by role */
function sidesOf(h: StructuredHypothesis): { name: string; role: ResearchConstruct["role"] }[] {
  const out: { name: string; role: ResearchConstruct["role"] }[] = [];
  if (h.type === "difference") { if (h.group && !h.constructs.independent) out.push({ name: groupingName(h), role: "independent" }); if (h.dependent && !h.constructs.dependent) out.push({ name: h.dependent, role: "dependent" }); }
  else { if (h.independent && !h.constructs.independent) out.push({ name: h.independent, role: "independent" }); if (h.dependent && !h.constructs.dependent) out.push({ name: h.dependent, role: "dependent" }); }
  if (h.moderator && !h.constructs.moderator) out.push({ name: h.moderator, role: "moderator" });
  if (h.mediator && !h.constructs.mediator) out.push({ name: h.mediator, role: "mediator" });
  return out;
}
/** "Women are more satisfied than men" → the grouping the comparison needs: gender; else the group's words */
function groupingName(h: StructuredHypothesis): string {
  const g = `${h.group ?? ""} ${h.lower ?? ""}`.toLowerCase();
  if (/\b(?:women|men|female|male)\b/.test(g)) return "Gender";
  if (/\b(?:younger|older|under|over|aged?|\d+s|millennial|gen z|boomer)\b/.test(g)) return "Age group";
  if (/\b(?:north|south|east|west|urban|rural|region|city|london)\b/.test(g)) return "Region";
  if (/\b(?:customers?|users?|buyers?|owners?|non-)\b/.test(g)) return "Customer status";
  return h.independent ?? h.group ?? "Group";
}

const frameworkStep: Build = (def, _o, prior) => {
  if (!isDone(prior, "hypotheses")) return blocked("framework", "hypotheses", "The framework names the constructs the hypotheses relate.");
  const r = def.research!;
  const hs = structuredHypotheses(def);
  const have = new Map(r.constructs.map((c) => [c.name.trim().toLowerCase(), c]));
  const add = new Map<string, { name: string; role: ResearchConstruct["role"] }>();
  for (const h of hs) for (const s of sidesOf(h)) { const name = constructName(s.name); const k = name.toLowerCase(); if (!have.has(k) && !have.has(s.name.trim().toLowerCase()) && !add.has(k)) add.set(k, { name, role: s.role }); }
  if (!add.size) return step("framework", { status: "done", executor: "engine", why: `${plural(r.constructs.length, "construct")} cover every hypothesis side (${r.constructs.map((c) => `${c.name} · ${c.role}`).join(", ")}).` });
  /* a new construct takes the questions that already measure it, so the questionnaire step adds only what is missing */
  const named = [...add.values()].map((c) => ({ ...c, questions: questionsMeasuring(def, c.name).map((q) => String(q.code)) }));
  const constructs = [...r.constructs.map((c) => ({ name: c.name, role: c.role, ...(c.definition ? { definition: c.definition } : {}), questions: c.questionIds.map((id) => codeOf(def, id)).filter((x): x is string => !!x) })), ...named];
  return step("framework", { status: "ready", executor: "engine", why: `${plural(named.length, "construct")} named by the hypotheses and not yet in the framework: ${named.map((c) => `${c.name} (${c.role}${c.questions.length ? `, measured by ${c.questions.join(", ")}` : ", not yet measured"})`).join(", ")}.`, sentence: `Add the constructs ${list(named.map((c) => quote(c.name)))} to the research framework`, actions: [{ op: "set_research", constructs }] });
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const questionnaireStep: Build = (def, o, prior) => {
  if (!isDone(prior, "framework")) return blocked("questionnaire", "framework", "The questionnaire measures the framework's constructs.");
  const r = def.research!;
  const unmeasured = r.constructs.filter((c) => !c.questionIds.some((id) => def.questions.some((q) => q.id === id)));
  if (!unmeasured.length) return step("questionnaire", { status: "done", executor: "engine", why: `Every construct is measured (${plural(asked(def).length, "question")} asked).` });
  const subject = /\b(Brand\s+[A-Z]\b|[A-Z][\w&]+(?:\s+[A-Z][\w&]+)*)(?=\s*$)/.exec(r.objective ?? "")?.[1] ?? "the brand";
  const standard: { c: ResearchConstruct; label: string; text: string; actions: SurveyAction[] }[] = [];
  const bespoke: ResearchConstruct[] = [];
  for (const c of unmeasured) {
    const m = standardMeasure(c.name);
    const item = m?.items(subject)[0];
    const read = item ? interpretRequest(def, item.text) : null;
    if (item && read && read.kind === "actions" && read.actions.length === 1 && read.actions[0].op === "create_question") {
      const ref = varName(c.name).slice(0, 20);
      standard.push({ c, label: item.label, text: item.text, actions: [{ ...read.actions[0], ref}] });
    } else bespoke.push(c);
  }
  if (standard.length) {
    /* the questions, then the constructs pointing at them by their batch refs */
    const constructs = r.constructs.map((c) => { const s = standard.find((x) => x.c === c); return { name: c.name, role: c.role, ...(c.definition ? { definition: c.definition } : {}), questions: [...c.questionIds.map((id) => codeOf(def, id)).filter((x): x is string => !!x), ...(s ? [(s.actions[0] as { ref: string }).ref] : [])] }; });
    const actions: SurveyAction[] = [...standard.flatMap((s) => s.actions), { op: "set_research", constructs }];
    return step("questionnaire", { status: "ready", executor: "engine", why: `${list(standard.map((s) => `${s.c.name} (${s.label})`))} ${standard.length === 1 ? "has" : "have"} a standard item the engine can add${bespoke.length ? `; ${list(bespoke.map((c) => c.name))} ${bespoke.length === 1 ? "needs" : "need"} bespoke wording` : ""}.`, sentence: standard.length === 1 ? standard[0].text : `Add the standard items for ${list(standard.map((s) => s.c.name))}`, actions, ...(bespoke.length ? { questions: bespoke.map((c) => ({ ask: `How should ${quote(c.name)} be asked?`, example: `Add a required single-select question "…" with options … to measure ${c.name}` })) } : {}) });
  }
  const model = { estimateText: `OBJECTIVE: ${r.objective}\nAUDIENCE: ${r.audience?.description ?? r.population ?? ""}\nCONSTRUCTS: ${bespoke.map((c) => `${c.name} (${c.role}${c.definition ? `: ${c.definition}` : ""})`).join("; ")}`, maxTokens: 400 * bespoke.length, operation: "workflow_questionnaire" };
  const questions = bespoke.map((c) => ({ ask: `How should ${quote(c.name)} be asked?`, example: `Add a required single-select question "…" with options … to measure ${c.name}` }));
  const sentence = `Write the questions that measure ${list(bespoke.map((c) => c.name))}`;
  if (o.mode === "internal") return step("questionnaire", { status: "needs_input", executor: "researcher", tier: "large", why: `${list(bespoke.map((c) => c.name))} ${bespoke.length === 1 ? "has" : "have"} no standard item; internal mode calls no model to write one.`, questions, model, sentence });
  return step("questionnaire", { status: "model", executor: "model", tier: "large", why: `${list(bespoke.map((c) => c.name))} ${bespoke.length === 1 ? "has" : "have"} no standard item — the model writes the questions; you approve each.`, sentence, model, questions });
};

const variablesStep: Build = (def, _o, prior) => {
  const r = def.research!;
  const measured = (r?.constructs ?? []).filter((c) => c.questionIds.some((id) => def.questions.some((q) => q.id === id)));
  if (!isDone(prior, "framework") || (!measured.length && !isDone(prior, "questionnaire"))) return blocked("variables", "questionnaire", "Derived variables are built from the questions that measure the constructs.");
  const derived = r.analysisPlan?.derived ?? [];
  const actions: SurveyAction[] = [];
  const names: string[] = [];
  for (const c of measured) {
    const qs = c.questionIds.map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q && ["ordinal", "interval", "ratio"].includes(measurementOf(q)));
    if (qs.length < 2) continue;
    const vars = qs.map((q) => q.variableName);
    if (derived.some((d) => d.kind === "mean_score" && d.from.length === vars.length && d.from.every((v) => vars.includes(v)))) continue;
    const name = `${varName(c.name).slice(0, 26)}_SCORE`;
    if (def.questions.some((q) => q.variableName === name) || derived.some((d) => d.name === name)) continue;
    actions.push({ op: "add_derived_variable", name, kind: "mean_score", from: vars, reason: `the mean of the ${qs.length} items that measure ${c.name}` } as SurveyAction);
    names.push(`${name} (mean of ${vars.join(", ")})`);
  }
  if (!actions.length) return step("variables", { status: "done", executor: "engine", why: derived.length ? `${plural(derived.length, "derived variable")} planned; every multi-item construct has its score.` : "No construct is measured by several scale items — nothing to derive." });
  return step("variables", { status: "ready", executor: "engine", why: `${list(names)} ${actions.length === 1 ? "is" : "are"} the score${actions.length === 1 ? "" : "s"} a multi-item construct needs.`, sentence: `Plan the derived variables ${list(actions.map((a) => (a as { name: string }).name))}`, actions });
};

const analysisPlanStep: Build = (def, _o, prior) => {
  if (!asked(def).length) return blocked("analysis_plan", "questionnaire", "The plan reads the questions.");
  const plan = def.research?.analysisPlan;
  if (plan && (plan.crosstabs.length || plan.tests.length)) return step("analysis_plan", { status: "done", executor: "engine", why: `The plan holds ${plural(plan.crosstabs.length, "crosstab")}, ${plural(plan.tests.length, "test")}, ${plural(plan.derived.length, "derived variable")} and ${plural(plan.segments.length, "segment")}.` });
  const fw = buildAnalysisFramework(def, { now: "" });
  if (!fw.crosstabs.length && !fw.tests.length) return step("analysis_plan", { status: "needs_input", executor: "researcher", why: "The engine finds nothing to plan — no outcome against a segmentation, no pair a hypothesis relates. Tag the questions' roles or add the measures first.", questions: [{ ask: "Which question is the outcome, and which cut the results?", example: "Plan a crosstab of SAT by GENDER" }] });
  if (!isDone(prior, "questionnaire")) return step("analysis_plan", { status: "ready", executor: "engine", why: `The engine's framework proposes ${plural(fw.crosstabs.length, "crosstab")} and ${plural(fw.tests.length, "test")} from the questions as they are — the constructs still unmeasured will join when their questions exist.`, sentence: "Plan the analysis", actions: [{ op: "propose_analysis_plan" } as SurveyAction] });
  return step("analysis_plan", { status: "ready", executor: "engine", why: `The engine's framework proposes ${plural(fw.crosstabs.length, "crosstab")}, ${plural(fw.tests.length, "test")} and ${plural(fw.derived.length, "derived variable")} from the hypotheses and the questions' levels.`, sentence: "Plan the analysis", actions: [{ op: "propose_analysis_plan" } as SurveyAction] });
};

const recommendationsStep: Build = (def, _o, prior) => {
  if (!isDone(prior, "analysis_plan")) return blocked("recommendations", "analysis_plan", "Recommendations complete a plan.");
  const plan = def.research!.analysisPlan!;
  const fw = buildAnalysisFramework(def, { now: "" });
  const cov = hypothesisCoverage(def);
  const actions: SurveyAction[] = [];
  const why: string[] = [];
  const sameTest = (a: { method: string; outcome?: string; variables: string[]; groupBy?: string }, b: { method: string; outcome?: string; variables: string[]; groupBy?: string }) => a.method === b.method && (a.outcome ?? "") === (b.outcome ?? "") && (a.groupBy ?? "") === (b.groupBy ?? "") && a.variables.length === b.variables.length && a.variables.every((v) => b.variables.includes(v));
  for (const h of cov.filter((c) => c.status === "partly")) {
    const derivedNames = new Set(plan.derived.map((d) => d.name));
    /* the framework's test for it — one on a construct's score, else the one that takes all its items (the regression), before one on a single item */
    const score = (x: { outcome?: string; variables: string[] }) => ([x.outcome, ...x.variables].some((v) => v && derivedNames.has(v)) ? 1000 : 0) + x.variables.length;
    const t = fw.tests.filter((x) => x.hypotheses.includes(h.label) && x.method !== "reliability" && !plan.tests.some((p) => sameTest(p, x))).sort((a, b) => score(b) - score(a))[0];
    if (t) { actions.push({ op: "add_analysis_test", method: t.method, ...(t.outcome ? { outcome: t.outcome } : {}), variables: t.variables, ...(t.groupBy ? { groupBy: t.groupBy } : {}), ...(t.moderator ? { moderator: t.moderator } : {}), ...(t.mediator ? { mediator: t.mediator } : {}), priority: 1, hypotheses: [h.label], reason: `${h.label} is measured but nothing in the plan tests it` } as SurveyAction); why.push(`a ${t.method.replace(/_/g, " ")} for ${h.label} (measured, untested)`); continue; }
    const x = fw.crosstabs.find((c) => c.hypotheses.includes(h.label) && !plan.crosstabs.some((p) => p.rows.join() === c.rows.join() && p.columns.join() === c.columns.join()));
    if (x) { actions.push({ op: "add_crosstab", rows: x.rows, columns: x.columns, priority: 1, hypotheses: [h.label], reason: `${h.label} is measured but nothing in the plan reads it` } as SurveyAction); why.push(`a crosstab of ${x.rows.join(", ")} by ${x.columns.join(", ")} for ${h.label}`); }
  }
  for (const x of prioritizeCrosstabs(def, 5, fw).filter((c) => c.priority === 1 && !plan.crosstabs.some((p) => p.rows.join() === c.rows.join() && p.columns.join() === c.columns.join()))) {
    if (actions.some((a) => a.op === "add_crosstab" && (a as { rows: string[] }).rows.join() === x.rows.join() && (a as { columns: string[] }).columns.join() === x.columns.join())) continue;
    actions.push({ op: "add_crosstab", rows: x.rows, columns: x.columns, priority: 1, ...(x.hypotheses.length ? { hypotheses: x.hypotheses } : {}), reason: x.reason ?? "a priority-1 crosstab the framework recommends" } as SurveyAction);
    why.push(`the priority-1 crosstab ${x.rows.join(", ")} by ${x.columns.join(", ")}`);
  }
  const unmeasured = cov.filter((c) => c.status === "unmeasured" || c.status === "unlinked");
  if (!actions.length) return step("recommendations", { status: "done", executor: "engine", why: `Every measured hypothesis has a test or a table${unmeasured.length ? `; ${list(unmeasured.map((c) => c.label))} ${unmeasured.length === 1 ? "is" : "are"} not measured yet (the questionnaire step)` : ""}.` });
  return step("recommendations", { status: "ready", executor: "engine", why: `The plan lacks ${list(why)}.`, sentence: `Add the recommended ${actions.length === 1 ? "analysis" : "analyses"} to the plan`, actions });
};

const MEASURE_WORDS: Record<string, string> = { ordinal: "top-2-box share", interval: "mean", ratio: "mean", nominal: "share", multi: "share" };
const reportingStep: Build = (def, _o, prior) => {
  const r = def.research!;
  const measuredDependent = (r?.constructs ?? []).filter((c) => c.role === "dependent" && c.questionIds.some((id) => def.questions.some((q) => q.id === id)));
  if (!isDone(prior, "framework") || !measuredDependent.length) return blocked("reporting_framework", "questionnaire", "The KPIs are the outcomes the questionnaire measures.");
  const audienceQ = r.audience ? [] : [{ ask: "Who reads the questionnaire — and who reads the report? (optional)", example: "Set the audience to \"first-time buyers — plain language\"" }];
  if (r.kpis.length) return step("reporting_framework", { status: "done", executor: "engine", why: `${plural(r.kpis.length, "KPI")} recorded (${r.kpis.map((k) => k.name).join(", ")})${r.audience ? `; audience ${quote(plain(r.audience.description, 40))}` : "; no audience recorded (optional)"}.`, ...(audienceQ.length ? { questions: audienceQ } : {}) });
  const kpis: { name: string; variable: string; measure: string; direction: "higher" | "lower" }[] = [];
  for (const c of measuredDependent) {
    const derived = (r.analysisPlan?.derived ?? []).find((d) => d.kind === "mean_score" && d.from.every((v) => c.questionIds.some((id) => def.questions.find((q) => q.id === id)?.variableName === v)));
    if (derived) { kpis.push({ name: c.name, variable: derived.name, measure: "mean", direction: "higher" }); continue; }
    const q = c.questionIds.map((id) => def.questions.find((x) => x.id === id)).find((x): x is Question => !!x);
    if (!q) continue;
    const measure = q.type === "nps" ? "NPS" : MEASURE_WORDS[measurementOf(q)] ?? "share";
    kpis.push({ name: c.name, variable: q.variableName, measure, direction: /\b(?:churn|switch|complain|dissatisf|price sensitiv|effort|wait)/i.test(c.name) ? "lower" : "higher" });
  }
  if (!kpis.length) return step("reporting_framework", { status: "needs_input", executor: "researcher", why: "No dependent construct's question can be read as a KPI.", questions: [{ ask: "Which number does the study report on?", example: "Set the KPIs: Satisfaction (SAT, top-2-box share)" }] });
  return step("reporting_framework", { status: "ready", executor: "engine", why: `${plural(kpis.length, "KPI")} read from the dependent constructs: ${kpis.map((k) => `${k.name} (${k.measure} of ${k.variable})`).join(", ")}.`, sentence: `Record the KPIs ${list(kpis.map((k) => k.name))}`, actions: [{ op: "set_research", kpis }], ...(audienceQ.length ? { questions: audienceQ } : {}) });
};

const designDocumentStep: Build = (def, o, prior) => {
  if (!isDone(prior, "objective") || !isDone(prior, "hypotheses")) return blocked("design_document", "hypotheses", "The design document is written from the objective and the hypotheses.");
  const produced = o.produced?.includes("design_document");
  const output: OutputRequest = { type: "proposal_docx", audience: "client", words: "the research proposal (Word)" };
  const pending = prior.filter((s) => ["framework", "questionnaire", "analysis_plan"].includes(s.id) && s.status !== "done").map((s) => s.title.toLowerCase());
  if (produced) return step("design_document", { status: "done", executor: "output", why: "The research proposal was produced this session." + (pending.length ? ` Produce it again after ${list(pending)}.` : ""), sentence: "Create the client-ready research proposal", output });
  return step("design_document", { status: "ready", executor: "output", why: `The proposal is written from the design as it stands${pending.length ? ` — ${list(pending)} not yet done, so it will say so` : ""}.`, sentence: "Create the client-ready research proposal", output });
};

const surveyStructureStep: Build = (def) => {
  const qs = asked(def);
  if (!qs.length) return blocked("survey_structure", "questionnaire", "There are no questions to arrange.");
  const blocks = listBlocks(def.flow as unknown[]);
  if (!blocks.length) return blocked("survey_structure", "questionnaire", "The survey has no block.");
  const blockOf = (id: string) => blocks.find((b) => b.pages.some((p) => p.node.questionIds.includes(id)));
  const first = blocks[0], last = blocks[blocks.length - 1];
  const actions: SurveyAction[] = [];
  const why: string[] = [];
  const title = (b: typeof first) => b.title?.trim() || b.id;
  const screening = qs.filter((q) => inferRole(def, q) === "screening" && (q.skipLogic ?? []).some((s) => s.target.kind === "terminate" || s.target.status === "screened"));
  for (const q of screening) { const b = blockOf(q.id); if (b && b !== first) { actions.push({ op: "move_question", target: String(q.code), block: title(first) }); why.push(`${q.code} screens out but sits in ${quote(title(b))}`); } }
  const demos = qs.filter((q) => inferRole(def, q) === "segmentation" && !q.analysis?.role);
  const needLast = demos.filter((q) => { const b = blockOf(q.id); return b && b !== first && b !== last; });
  if (needLast.length && blocks.length >= 2) for (const q of needLast) { actions.push({ op: "move_question", target: String(q.code), block: title(last) }); why.push(`${q.code} (${q.variableName}) is a demographic asked mid-survey`); }
  if (needLast.length && blocks.length < 2) { actions.push({ op: "create_block", ref: "about_you", title: "About you" }); for (const q of needLast) actions.push({ op: "move_question", target: String(q.code), block: "about_you" }); why.push(`${list(needLast.map((q) => String(q.code)))} ${needLast.length === 1 ? "is a demographic" : "are demographics"} with no closing block to sit in`); }
  if (!actions.length) return step("survey_structure", { status: "done", executor: "engine", why: `${plural(blocks.length, "block")}: screening questions first, demographics last.` });
  return step("survey_structure", { status: "ready", executor: "engine", why: `${list(why)}.`, sentence: actions.length === 1 && actions[0].op === "move_question" ? `Move ${actions[0].target} to ${quote(actions[0].block!)}` : "Arrange the survey: screener first, demographics last", actions });
};

const deckStep: Build = (def, o, prior) => {
  const output: OutputRequest = { type: "findings_pptx", audience: "client", words: "the findings presentation (PowerPoint, client edition)" };
  if (!isDone(prior, "analysis_plan")) return blocked("deck", "analysis_plan", "The deck reports the plan's findings.");
  if (o.produced?.includes("deck")) return step("deck", { status: "done", executor: "output", why: "The findings deck was produced this session.", sentence: "Create the final findings presentation", output });
  if (!o.runAvailable) return step("deck", { status: "blocked", executor: "output", why: "After fieldwork: the deck needs respondents.", blockedBy: "analysis_plan", sentence: "Create the final findings presentation", output });
  return step("deck", { status: "ready", executor: "output", why: "Fieldwork data exists — the deck is built from a fresh run of the plan.", sentence: "Create the final findings presentation", output });
};

const BUILDERS: Record<WorkflowStepId, Build> = { objective: objectiveStep, assumptions: assumptionsStep, hypotheses: hypothesesStep, framework: frameworkStep, questionnaire: questionnaireStep, variables: variablesStep, analysis_plan: analysisPlanStep, recommendations: recommendationsStep, reporting_framework: reportingStep, design_document: designDocumentStep, survey_structure: surveyStructureStep, deck: deckStep };

/** the workflow as it stands: every step with its status, and what comes next */
export function researchWorkflow(def: SurveyDefinition, opts: WorkflowOptions = {}): ResearchWorkflow {
  const mode: ExecutionMode = opts.mode === "internal" ? "internal" : "cloud";
  const o = { ...opts, mode };
  const steps: WorkflowStep[] = [];
  for (const id of ORDER) steps.push(BUILDERS[id](def, o, steps));
  const next = steps.find((s) => s.status !== "done") ?? null;
  const done = steps.filter((s) => s.status === "done").length;
  const what = !next ? "" : next.status === "ready" ? (next.executor === "output" ? "the file is one click away" : `the engine has ${plural(next.actions?.length ?? 0, "action")} ready`) : next.status === "model" ? `the model is asked (${next.tier} call)` : next.status === "needs_input" ? "you are asked" : `waits on ${TITLES[next.blockedBy!].toLowerCase()}`;
  return { mode, steps, next, done, total: steps.length, summary: next ? `${done} of ${steps.length} steps done — next: ${next.title} (${what})` : `All ${steps.length} steps done.` };
}

/** one line per step for the card: "✓ Objective — …", "→ Questionnaire — …" */
export function describeWorkflow(wf: ResearchWorkflow): string {
  const mark: Record<WorkflowStatus, string> = { done: "✓", ready: "→", needs_input: "?", model: "✱", blocked: "·" };
  return [wf.summary, ...wf.steps.map((s) => `${mark[s.status]} ${s.title} — ${s.why}`)].join("\n");
}

/** the steps a model would be asked for, with the tier — what the cost preview prices */
export function modelSteps(wf: ResearchWorkflow): { id: WorkflowStepId; tier: ModelTier; estimateText: string; maxTokens: number; operation: string }[] {
  return wf.steps.filter((s) => s.model).map((s) => ({ id: s.id, tier: s.tier, ...s.model! }));
}

export const WORKFLOW_STEP_IDS = ORDER;
export const WORKFLOW_TITLES = TITLES;
