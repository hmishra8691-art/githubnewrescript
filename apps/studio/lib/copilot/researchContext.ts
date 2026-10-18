import type { SurveyDefinition } from "@rescript/schema";
import type { ChangePlan, ChangePlanItem } from "./changePlan.ts";
import { sha256Hex } from "./operations.ts";

/**
 * THE STRUCTURED RESEARCH CONTEXT (§3, 2026-10-18) — a long brief read ONCE.
 *
 * A pasted brief (up to 60,000 characters) used to be resent whole with
 * every staged item call: a 24k brief planned into 12 items went to the
 * model 13 times. Now the plan stage, which still reads the whole brief,
 * leaves behind one structured research context, and each item call gets:
 *
 *   1  the context — objectives, business context, research questions,
 *      hypotheses (exact wording), population and sampling, methodology,
 *      questionnaire structure, ids and variables, constraints, analysis,
 *      reporting, progress — EXTRACTED VERBATIM from the brief: sentences,
 *      bullets and table rows are selected, never paraphrased, so a number,
 *      a hypothesis statement, a variable id or a constraint is never
 *      summarised away (it is either there word for word or retrievable);
 *   2  the survey outline — exact, and authoritative where they differ;
 *   3  the relevant history (memory, recent turns);
 *   4  the task (the item's own spec, the guides);
 *   5  a reference to the stored brief, with the exact passages the item
 *      needs retrieved by keyword and section (a quota table, a hypothesis,
 *      a definitions table).
 *
 * No extra model call: the extraction is deterministic, so its cost is
 * zero and its output is testable. Pure (no I/O): the route persists the
 * result per survey and owner (`researchContextStore.ts`).
 */

export const RESEARCH_CONTEXT_SCHEMA = 1;

export interface BriefSection {
  /** "s4", "s8.3": stable within one brief */
  id: string;
  /** "4. Research Objectives" or "8.3 Technology stack" */
  heading: string;
  /** the top-level heading this one sits under ("" for a top-level one) */
  parent: string;
  /** the section's text, verbatim (the normalised brief) */
  text: string;
}

export interface ResearchContext {
  schema: number;
  /** increments when the context is regenerated */
  version: number;
  status: "fresh" | "stale";
  staleReason?: string;
  derivedAt: string;
  /** what it was derived from: the brief's hash and length, the research design's hash (empty design: adopted, not stale), the plan's hash */
  fingerprint: { brief: string; briefChars: number; design: string; designEmpty: boolean; plan?: string };
  objectives: string[];
  businessContext: string[];
  researchQuestions: string[];
  /** exact wording; from the survey's research design when it has hypotheses (authoritative), else from the brief */
  hypotheses: { id: string; text: string }[];
  hypothesesSource: "design" | "brief" | "none";
  population: string[];
  methodology: string[];
  questionnaire: string[];
  variables: string[];
  constraints: string[];
  analysis: string[];
  reporting: string[];
  progress: { completed: string[]; pending: string[]; unresolved: string[] };
  /** the brief's index: what can be retrieved verbatim */
  sections: { id: string; heading: string; chars: number }[];
  /** lines left out of a category for its budget — still in the brief, retrievable */
  omitted: number;
}

/* ------------------------------------------------------------ reading the brief */

const BULLET = /^\s*(?:[-*•▪◦]|\d+[.)](?=\s))\s*/;
const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);

/** A heading line: alone between blank lines, short, not a list item or table row, no sentence ending. */
function headingOf(lines: string[], i: number): { num: string; title: string } | null {
  const l = lines[i].trim();
  if (!l || l.length > 100 || isTableRow(l) || /^[-*•▪◦]/.test(l)) return null;
  if (/[.;,!?]$/.test(l) && !/^\d+(?:\.\d+)*\.?$/.test(l)) return null;
  const prevBlank = i === 0 || !lines[i - 1].trim();
  const nextBlank = i === lines.length - 1 || !lines[i + 1].trim();
  if (!prevBlank || !nextBlank) return null;
  const m = /^(\d+(?:\.\d+)*)[.)]?\s+(\S.*)$/.exec(l);
  if (m) return { num: m[1], title: m[2].trim() };
  /* an unnumbered heading: a few words, not an instruction leading into a list ("…, ask:") */
  if (l.split(/\s+/).length > 7 || /:$/.test(l)) return null;
  return { num: "", title: l.replace(/:$/, "") };
}

/** The brief as sections (heading → text), in its order. A brief with no headings is one section. */
export function sectionBrief(brief: string): BriefSection[] {
  const lines = brief.replace(/\r\n?/g, "\n").split("\n");
  const out: BriefSection[] = [];
  let cur: { heading: string; parent: string; num: string; body: string[] } | null = null;
  let top = "";
  let unnamed = 0;
  const flush = () => {
    if (!cur) return;
    const text = cur.body.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text || cur.heading) {
      const id = cur.num ? `s${cur.num}` : `s${out.length + 1}u${++unnamed}`;
      out.push({ id: out.some((s) => s.id === id) ? `${id}_${out.length}` : id, heading: cur.heading, parent: cur.parent, text });
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const h = headingOf(lines, i);
    if (h) {
      flush();
      const heading = h.num ? `${h.num}${h.num.includes(".") ? "" : "."} ${h.title}` : h.title;
      const level = h.num ? h.num.split(".").length : (top ? 2 : 1);
      if (level === 1) top = heading;
      cur = { heading, parent: level === 1 ? "" : top, num: h.num, body: [] };
      continue;
    }
    (cur ??= { heading: "", parent: "", num: "", body: [] }).body.push(lines[i]);
  }
  flush();
  return out;
}

/** a section's units — bullets, table rows and sentences — verbatim, whitespace collapsed */
function unitsOf(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const l = raw.replace(/\s+/g, " ").trim();
    if (!l) continue;
    if (BULLET.test(raw) || isTableRow(l) || l.length <= 240) { out.push(l); continue; }
    /* a paragraph: its sentences (never cut inside one — a number stays whole) */
    for (const s of l.split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])/)) if (s.trim()) out.push(s.trim());
  }
  return out;
}

type Category = "objectives" | "businessContext" | "researchQuestions" | "hypotheses" | "population" | "methodology" | "questionnaire" | "constraints" | "analysis" | "reporting";
/** in order: the first that matches the heading (then its parent) wins; reference material (lists, definitions, examples) is retrieval-only */
const CATEGORY_RULES: [Category | "reference" | "skip", RegExp][] = [
  ["skip", /\byour role\b|\bpersona\b|\bact as\b/i],
  ["hypotheses", /hypothes/i],
  ["researchQuestions", /research questions?/i],
  ["objectives", /objective|\baims?\b|\bgoals?\b/i],
  ["reference", /reference|definitions?|example|glossary|appendix|answer lists?/i],
  ["population", /audience|target|population|sampl|screen|quota|respondent|recruit/i],
  ["analysis", /analys|statistic|tabulation|weighting/i],
  ["reporting", /report|deliverable|output|format/i],
  ["questionnaire", /questionnaire|structure|stage-level|survey flow|\bloop/i],
  ["methodology", /method|design|approach|\bmode\b|fieldwork/i],
  ["constraints", /constraint|requirement|rules?\b|mandatory|quality|guideline|timing|budget/i],
  ["businessContext", /business|problem|background|context|decision|situation|overview/i],
];
/* per-category budgets (characters): the cross-cutting lines (constraints, hypotheses) get the most; section-specific detail (a quota table, a test list) is retrieved verbatim by the item that needs it */
const BUDGET: Record<Category, number> = { objectives: 1000, businessContext: 500, researchQuestions: 1000, hypotheses: 6000, population: 1400, methodology: 1100, questionnaire: 1400, constraints: 1500, analysis: 800, reporting: 500 };

function categoryOf(s: BriefSection): Category | "reference" | "skip" | null {
  for (const h of [s.heading, s.parent]) {
    if (!h) continue;
    for (const [c, re] of CATEGORY_RULES) if (re.test(h)) return c;
  }
  return null;
}

/** how much a unit must be kept: numbers, obligations, hypothesis ids, codes */
const MUST = /\b(?:must|mandatory|required?|at least|at most|maximum|minimum|no more than|not more than|do not|don't|never|only|exactly|always|exclude|include|terminate|quota|soft quota)\b/i;
const CODE = /\b(?:[QSDAB]\d{1,3}(?:[a-z]|_\d+)?|[A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/;
function weight(u: string): number {
  let w = 0;
  if (/\d/.test(u)) w += 3;
  if (MUST.test(u)) w += 3;
  if (/\bH\d{1,2}\b/.test(u)) w += 4;
  if (CODE.test(u)) w += 2;
  if (u.length > 300) w -= 1;
  return w;
}

/** select units within a budget: the heaviest first, kept in the brief's order; never cut one */
function pick(units: string[], budget: number): { kept: string[]; dropped: number } {
  const order = units.map((u, i) => ({ u, i, w: weight(u) })).sort((a, b) => b.w - a.w || a.i - b.i);
  const take = new Set<number>();
  let used = 0;
  for (const x of order) { if (used + x.u.length + 3 > budget) continue; take.add(x.i); used += x.u.length + 3; }
  return { kept: units.filter((_, i) => take.has(i)), dropped: units.length - take.size };
}

/** the hypotheses a brief states, word for word: "H1. …", "H2: …", "Hypothesis 3 — …", or the lines of a hypotheses section */
export function briefHypotheses(brief: string, sections: BriefSection[] = sectionBrief(brief)): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  const seen = new Set<string>();
  const re = /^\s*(?:[-*•]\s*)?\(?(?:(H)(\d{1,2}[a-z]?)|hypothesis\s+(\d{1,2}[a-z]?))\)?\s*[.:)\-–—]\s*(.+)$/gim;
  for (const m of brief.matchAll(re)) {
    const id = `H${(m[2] ?? m[3]).toUpperCase()}`;
    const text = m[4].replace(/\s+/g, " ").trim();
    if (!seen.has(id) && text.length > 8) { seen.add(id); out.push({ id, text }); }
  }
  if (out.length) return out.slice(0, 40);
  const sec = sections.find((s) => /hypothes/i.test(s.heading));
  if (!sec) return [];
  return unitsOf(sec.text).filter((u) => BULLET.test(u) || u.length > 20).slice(0, 40).map((u, i) => ({ id: `H${i + 1}`, text: u.replace(BULLET, "").trim() }));
}

/* ------------------------------------------------------------ fingerprints */

/** the research design a context is checked against: objective, hypotheses, methodology, population, research questions */
export function designFingerprint(def: Pick<SurveyDefinition, "research"> | null | undefined): { hash: string; empty: boolean } {
  const r = def?.research;
  const parts = r ? { objective: (r.objective ?? "").trim(), hypotheses: (r.hypotheses ?? []).map((h) => h.trim()), methodology: (r.methodology ?? "").trim(), population: (r.population ?? "").trim(), researchQuestions: (r.researchQuestions ?? []).map((q) => q.trim()) } : null;
  const empty = !parts || (!parts.objective && !parts.hypotheses.length && !parts.methodology && !parts.population && !parts.researchQuestions.length);
  return { hash: empty ? "empty" : sha256Hex(JSON.stringify(parts)).slice(0, 32), empty };
}

export const briefFingerprint = (brief: string): string => sha256Hex(brief.trim());
const planFingerprint = (plan: ChangePlan | null | undefined) => (plan ? sha256Hex(plan.items.map((i) => `${i.id}:${i.title}`).join("\n")).slice(0, 16) : undefined);

/* ------------------------------------------------------------ the context */

/**
 * The context, derived from the brief (verbatim selection), the plan (the
 * structure as planned, its assumptions) and the survey (its research design
 * is authoritative for the hypotheses). Deterministic.
 */
export function deriveResearchContext(input: { brief: string; plan?: ChangePlan | null; def?: Pick<SurveyDefinition, "research"> | null; previous?: Pick<ResearchContext, "version"> | null; now?: string; built?: string[] }): ResearchContext {
  const brief = input.brief.trim();
  const sections = sectionBrief(brief);
  const buckets: Record<Category, string[]> = { objectives: [], businessContext: [], researchQuestions: [], hypotheses: [], population: [], methodology: [], questionnaire: [], constraints: [], analysis: [], reporting: [] };
  const structure: string[] = [];
  for (const s of sections) {
    const c = categoryOf(s);
    /* the untitled opening (a title line): business context */
    if (!s.heading && !s.parent) { const first = unitsOf(s.text)[0]; if (first) buckets.businessContext.push(first); continue; }
    /* rules for the whole questionnaire ("General questionnaire rules") are constraints, not a section */
    if (s.parent && /\b(?:rules|guidelines|conventions)\b/i.test(s.heading)) { buckets.constraints.push(...unitsOf(s.text)); continue; }
    if (s.parent && s.heading && categoryOf({ ...s, heading: s.parent, parent: "" }) === "questionnaire") {
      /* a questionnaire sub-section: its heading and purpose line are the structure; its "must cover" lines stay retrievable */
      const purpose = unitsOf(s.text).find((u) => /^purpose\b/i.test(u));
      structure.push(`${s.heading}${purpose ? ` — ${purpose.replace(/^purpose:?\s*/i, "")}` : ""}`);
      continue;
    }
    if (!c || c === "skip" || c === "reference") continue;
    buckets[c].push(...unitsOf(s.text));
  }
  buckets.questionnaire = [...structure, ...buckets.questionnaire];
  let omitted = 0;
  const take = (c: Category) => { const p = pick(buckets[c], BUDGET[c]); omitted += p.dropped; return p.kept; };
  /* the ids and variables the brief names, with the line that names them */
  const varLines = unitsOf(brief).filter((u) => CODE.test(u) && !/^\|/.test(u));
  const variables = pick([...new Set(varLines)], 700);
  omitted += variables.dropped;
  const fromDesign = (input.def?.research?.hypotheses ?? []).filter((h) => h.trim());
  const hypotheses = fromDesign.length ? fromDesign.map((text, i) => ({ id: `H${i + 1}`, text: text.trim() })) : briefHypotheses(brief, sections);
  const design = designFingerprint(input.def);
  const plan = input.plan ?? null;
  const built = new Set(input.built ?? []);
  return {
    schema: RESEARCH_CONTEXT_SCHEMA,
    version: (input.previous?.version ?? 0) + 1,
    status: "fresh",
    derivedAt: input.now ?? new Date().toISOString(),
    fingerprint: { brief: briefFingerprint(brief), briefChars: brief.length, design: design.hash, designEmpty: design.empty, ...(planFingerprint(plan) ? { plan: planFingerprint(plan) } : {}) },
    objectives: take("objectives"), businessContext: take("businessContext"), researchQuestions: take("researchQuestions"),
    hypotheses, hypothesesSource: fromDesign.length ? "design" : hypotheses.length ? "brief" : "none",
    population: take("population"), methodology: take("methodology"), questionnaire: take("questionnaire"), variables: variables.kept,
    constraints: take("constraints"), analysis: take("analysis"), reporting: take("reporting"),
    progress: {
      completed: plan ? plan.items.filter((i) => built.has(i.id)).map((i) => i.title) : [],
      pending: plan ? plan.items.filter((i) => !built.has(i.id)).map((i) => i.title) : [],
      unresolved: plan ? [...plan.questions.map((q) => `question: ${q}`), ...plan.assumptions.map((a) => `assumed: ${a}`)].slice(0, 20) : [],
    },
    sections: sections.filter((s) => s.text).map((s) => ({ id: s.id, heading: s.heading || "(untitled)", chars: s.text.length })),
    omitted,
  };
}

/** the progress line brought up to date (what this stage built) — the rest of the context unchanged */
export function withProgress(ctx: ResearchContext, plan: ChangePlan, built: Iterable<string>): ResearchContext {
  const b = new Set(built);
  return { ...ctx, progress: { ...ctx.progress, completed: plan.items.filter((i) => b.has(i.id)).map((i) => i.title), pending: plan.items.filter((i) => !b.has(i.id)).map((i) => i.title) } };
}

/**
 * SAFETY: the survey definition stays authoritative. A context derived when
 * the survey had no research design adopts the first one (the build wrote it
 * from this brief); after that, a change to the design (objective,
 * hypotheses, methodology, population, research questions) makes it STALE —
 * it is not sent again until regenerated.
 */
export function reconcileContext(ctx: ResearchContext, def: Pick<SurveyDefinition, "research"> | null | undefined): { context: ResearchContext; changed: boolean; invalidated: boolean } {
  const d = designFingerprint(def);
  if (ctx.fingerprint.design === d.hash) return { context: ctx, changed: false, invalidated: false };
  if (ctx.fingerprint.designEmpty && ctx.status === "fresh") {
    /* the first design, written by the build from this brief: adopted (its hypotheses are now the authoritative wording) */
    const fromDesign = (def?.research?.hypotheses ?? []).filter((h) => h.trim());
    return { context: { ...ctx, fingerprint: { ...ctx.fingerprint, design: d.hash, designEmpty: d.empty }, ...(fromDesign.length ? { hypotheses: fromDesign.map((text, i) => ({ id: `H${i + 1}`, text: text.trim() })), hypothesesSource: "design" as const } : {}) }, changed: true, invalidated: false };
  }
  if (ctx.status === "stale") return { context: ctx, changed: false, invalidated: false };
  return { context: { ...ctx, status: "stale", staleReason: "the research design (objective, hypotheses, methodology, population or research questions) changed after this context was made" }, changed: true, invalidated: true };
}

/** the context as the model reads it (layer 1) — compact, every line verbatim from the brief or the design */
export function renderResearchContext(ctx: ResearchContext, opts: { compact?: boolean } = {}): string {
  const lines: string[] = [`RESEARCH CONTEXT v${ctx.version} — from the researcher's brief (${ctx.fingerprint.briefChars.toLocaleString("en")} characters, stored; ref ${ctx.fingerprint.brief.slice(0, 12)}). Lines are copied verbatim — numbers, hypothesis wording, ids and constraints are exact. The CURRENT SURVEY outline is authoritative wherever the two differ. Exact passages of the brief are quoted under BRIEF PASSAGES when a task needs them.`];
  const block = (label: string, xs: string[]) => { if (xs.length) lines.push(`${label}:\n${xs.map((x) => `- ${x.replace(BULLET, "")}`).join("\n")}`); };
  if (!opts.compact) {
    block("Objectives", ctx.objectives);
    block("Business context", ctx.businessContext);
    block("Research questions", ctx.researchQuestions);
  }
  if (ctx.hypotheses.length && !opts.compact) lines.push(`Hypotheses (exact wording${ctx.hypothesesSource === "design" ? ", as in the survey's research design" : ", from the brief"}):\n${ctx.hypotheses.map((h) => `${h.id}. ${h.text}`).join("\n")}`);
  if (!opts.compact) {
    block("Population, screening and sampling", ctx.population);
    block("Methodology and design", ctx.methodology);
    block("Questionnaire structure (the brief's order)", ctx.questionnaire);
    block("Question ids and variables named in the brief", ctx.variables);
  }
  block("Constraints and mandatory requirements", ctx.constraints);
  if (!opts.compact) block("Analysis plan", ctx.analysis);
  block("Reporting preferences", ctx.reporting);
  const p = ctx.progress;
  if (p.completed.length || p.pending.length || p.unresolved.length) lines.push(`Progress: completed ${p.completed.length ? p.completed.join("; ") : "nothing yet"}. Pending: ${p.pending.length ? p.pending.join("; ") : "nothing"}.${p.unresolved.length ? ` Unresolved / assumed: ${p.unresolved.join("; ")}.` : ""}`);
  lines.push(`Brief sections (retrievable verbatim): ${ctx.sections.map((s) => `§${s.id.replace(/^s/, "")} ${s.heading.replace(/^\d+(?:\.\d+)*\.?\s+/, "").slice(0, 28)}`).join(" · ")}${ctx.omitted ? ` — ${ctx.omitted} further line${ctx.omitted === 1 ? "" : "s"} are in these sections` : ""}.`);
  return lines.join("\n");
}

/* ------------------------------------------------------------ retrieval (layer 5) */

const STOP = new Set("the and for with that this from into each their they them have has are was were will would should could which what when where who whom how why not but all any can its our your you per via use used using also than then such only more most less very about over under between after before during make made build add item items survey question questions brief block blocks section sections write propose plan create new".split(" "));
const words = (s: string) => (s.toLowerCase().normalize("NFC").match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !STOP.has(w));

/** the brief as retrievable passages: each section, a long one split at paragraph boundaries (never inside a table) */
export function briefPassages(sections: BriefSection[], maxChars = 1800): { id: string; heading: string; text: string }[] {
  const out: { id: string; heading: string; text: string }[] = [];
  for (const s of sections) {
    if (!s.text) continue;
    if (s.text.length <= maxChars) { out.push({ id: s.id, heading: s.heading, text: s.text }); continue; }
    let buf = ""; let n = 0;
    for (const para of s.text.split(/\n\n+/)) {
      if (buf && buf.length + para.length + 2 > maxChars) { out.push({ id: `${s.id}.${++n}`, heading: s.heading, text: buf }); buf = ""; }
      buf = buf ? `${buf}\n\n${para}` : para;
    }
    if (buf) out.push({ id: n ? `${s.id}.${++n}` : s.id, heading: s.heading, text: buf });
  }
  return out;
}

/**
 * The exact passages of the brief a task needs — by keyword, section heading,
 * hypothesis id and number — verbatim, best first, within a budget. A
 * passage that names a hypothesis the query names always comes first.
 */
export function retrieveBriefPassages(sections: BriefSection[], query: string, opts: { k?: number; maxChars?: number; minScore?: number } = {}): { id: string; heading: string; text: string; score: number }[] {
  const passages = briefPassages(sections);
  if (!passages.length) return [];
  const q = words(query);
  if (!q.length) return [];
  const df = new Map<string, number>();
  for (const p of passages) for (const w of new Set(words(`${p.heading} ${p.text}`))) df.set(w, (df.get(w) ?? 0) + 1);
  const N = passages.length;
  const hyps = new Set((query.match(/\bH\d{1,2}\b/g) ?? []).map((h) => h.toUpperCase()));
  const scored = passages.map((p) => {
    const body = words(p.text);
    const head = new Set(words(p.heading));
    const tf = new Map<string, number>();
    for (const w of body) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of new Set(q)) {
      const idf = Math.log(1 + N / (df.get(w) ?? N));
      score += idf * (Math.min(3, tf.get(w) ?? 0) + (head.has(w) ? 3 : 0));
    }
    score = score / Math.sqrt(1 + body.length / 120);
    for (const h of hyps) if (new RegExp(`\\b${h}\\b`).test(p.text)) score += 10;
    return { ...p, score };
  }).filter((p) => p.score >= (opts.minScore ?? 1.2)).sort((a, b) => b.score - a.score);
  const out: typeof scored = [];
  let used = 0;
  const max = opts.maxChars ?? 5000;
  for (const p of scored) {
    if (out.length >= (opts.k ?? 3)) break;
    if (used + p.text.length > max) continue;
    out.push(p); used += p.text.length;
  }
  return out;
}

/** the retrieval query for one plan item: its title, detail, reason and objects */
export const itemQuery = (item: Pick<ChangePlanItem, "title" | "detail" | "reason" | "objects">): string => [item.title, item.detail ?? "", item.reason, ...item.objects].join(" ");

/** BRIEF PASSAGES as the model reads them: labelled with their section, verbatim */
export function renderBriefPassages(passages: { id: string; heading: string; text: string }[]): string {
  if (!passages.length) return "";
  return `BRIEF PASSAGES (verbatim from the stored brief — use their exact wording, numbers, lists and logic):\n${passages.map((p) => `[§${p.id.replace(/^s/, "")} ${p.heading}]\n${p.text}`).join("\n\n")}`;
}

/* ------------------------------------------------------------ task-aware selection */

export type QuestionnaireScope = "full" | "focused" | "none";

/**
 * HOW MUCH OF THE SURVEY A REQUEST NEEDS (§3 task-aware selection). A theme
 * change needs no questionnaire; a logic change on a large survey needs the
 * questions it names and their dependencies in full (the rest by code, so a
 * reference stays valid); everything else the outline as before.
 */
export function questionnaireScope(input: { message: string; mode: string; themeOnly?: boolean; uxOnly?: boolean; focusCount: number; questionCount: number }): QuestionnaireScope {
  const t = input.message;
  if (input.themeOnly) return "none";
  const namesQuestions = input.focusCount > 0 || /\b(?:question|option|answer|row|column|grid|page|block|Q\d+)\b/i.test(t);
  if (input.uxOnly && !namesQuestions && /\b(?:theme|colou?rs?|fonts?|typography|background|brand(?:ing)?|palette|buttons?|spacing|look|style)\b/i.test(t)) return "none";
  if (input.mode === "edit" && input.focusCount > 0 && input.questionCount > 30 && /\b(?:display logic|skip|branch|show (?:only )?(?:if|when)|hide|only (?:if|when|show)|condition|logic|route|terminate|screen out|piping|pipe|mask|carry forward)\b/i.test(t)) return "focused";
  return "full";
}

/** what context layers a turn gets, by task: a theme turn none of the research context, a generation all of it, an edit the compact form */
export function contextLayersFor(input: { mode: string; themeOnly?: boolean; uxOnly?: boolean; stage?: "plan" | "execute" | null; hasContext: boolean; stale: boolean }): { researchContext: "full" | "compact" | "none" } {
  if (!input.hasContext || input.stale || input.themeOnly || input.uxOnly) return { researchContext: "none" };
  if (input.stage === "execute" || input.mode === "generate") return { researchContext: "full" };
  return { researchContext: "compact" };
}

/* ------------------------------------------------------------ measurement (per call, per workflow) */

/** one model call as the route measured it */
export interface CallMeasure {
  operation: string;
  /** characters sent: system blocks + user text */
  promptChars: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** of the input: written into the provider's prompt cache (2026-10-18; absent on measures made before) */
  cacheWriteTokens?: number;
  requests: number;
  retries: number;
  latencyMs: number;
  /** the customer charge of the call */
  charge: number;
}

/** a workflow (one brief's plan and build on one survey): every call summed, and whether it completed */
export interface WorkflowTotals {
  id: string;
  calls: number;
  requests: number;
  promptChars: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** cache writes summed (2026-10-18; absent on totals kept before) */
  cacheWriteTokens?: number;
  retries: number;
  latencyMs: number;
  charge: number;
  byOperation: Record<string, { calls: number; promptChars: number; inputTokens: number; charge: number }>;
  completed: boolean;
  startedAt: string;
  updatedAt: string;
}

/** the workflow id of a brief on a survey: the plan and every stage of its build share it (no browser change needed) */
export const workflowIdFor = (surveyId: string, owner: string, brief: string): string => `wf_${sha256Hex(`${surveyId}\u0000${owner}\u0000${brief.trim()}`).slice(0, 16)}`;

export function addCalls(totals: WorkflowTotals | null | undefined, id: string, calls: readonly CallMeasure[], opts: { completed?: boolean; now?: string } = {}): WorkflowTotals {
  const now = opts.now ?? new Date().toISOString();
  const t: WorkflowTotals = totals && totals.id === id ? { ...totals, byOperation: { ...totals.byOperation } } : { id, calls: 0, requests: 0, promptChars: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, retries: 0, latencyMs: 0, charge: 0, byOperation: {}, completed: false, startedAt: now, updatedAt: now };
  for (const c of calls) {
    t.calls++; t.requests += c.requests; t.promptChars += c.promptChars; t.inputTokens += c.inputTokens; t.outputTokens += c.outputTokens;
    t.cachedInputTokens += c.cachedInputTokens; t.cacheWriteTokens = (t.cacheWriteTokens ?? 0) + (c.cacheWriteTokens ?? 0); t.retries += c.retries; t.latencyMs += c.latencyMs; t.charge = Math.round((t.charge + c.charge) * 1e6) / 1e6;
    const k = c.operation.replace(/^copilot_(?:generate|edit|ux|review|question)_item$/, "copilot_item");
    const o = t.byOperation[k] ?? { calls: 0, promptChars: 0, inputTokens: 0, charge: 0 };
    t.byOperation[k] = { calls: o.calls + 1, promptChars: o.promptChars + c.promptChars, inputTokens: o.inputTokens + c.inputTokens, charge: Math.round((o.charge + c.charge) * 1e6) / 1e6 };
  }
  if (opts.completed) t.completed = true;
  t.updatedAt = now;
  return t;
}

/* ------------------------------------------------------------ the store's contract and its memory half */

/** what is kept per survey and owner: the context, the brief it came from (retrievable), the workflow's totals */
export interface StoredResearchContext {
  surveyId: string;
  /** the organisation (customer) id, else the user id — a survey's context is never served to another owner */
  owner: string;
  context: ResearchContext;
  brief: string;
  workflow?: WorkflowTotals | null;
  updatedAt: string;
}

export interface ResearchContextStore {
  durable: boolean;
  get(surveyId: string, owner: string): Promise<StoredResearchContext | null>;
  put(rec: Omit<StoredResearchContext, "updatedAt">, meta?: { userId?: string | null }): Promise<StoredResearchContext>;
}

/** the owner key: the organisation, else the person, else the sandbox tab */
export const contextOwner = (ids: { customerId?: string | null; userId?: string | null }): string => (ids.customerId ? `org:${ids.customerId}` : ids.userId ? `user:${ids.userId}` : "sandbox");

/** this server's memory, keyed by survey AND owner (the fallback until migration 0067 is applied, and the sandbox) */
export class MemoryResearchContextStore implements ResearchContextStore {
  durable = false;
  private readonly map: Map<string, StoredResearchContext>;
  constructor(map: Map<string, StoredResearchContext>) { this.map = map; }
  private key(surveyId: string, owner: string) { return `${surveyId}\u0000${owner}`; }
  async get(surveyId: string, owner: string) { const r = this.map.get(this.key(surveyId, owner)); return r && r.surveyId === surveyId && r.owner === owner ? structuredClone(r) : null; }
  async put(rec: Omit<StoredResearchContext, "updatedAt">) {
    const stored = { ...structuredClone(rec), updatedAt: new Date().toISOString() };
    this.map.set(this.key(rec.surveyId, rec.owner), stored);
    if (this.map.size > 500) this.map.delete(this.map.keys().next().value!);
    return structuredClone(stored);
  }
}

/* ------------------------------------------------------------ the layers one item call gets (shared by the route and the benchmark) */

/** how many passages, and how much of the brief, one item may quote */
export const ITEM_PASSAGES = { k: 3, maxChars: 4500 } as const;

/** an item's exact passages of the stored brief: the text to append (empty when none scored) and their ids */
export function itemPassagesFor(sections: BriefSection[], item: Pick<ChangePlanItem, "title" | "detail" | "reason" | "objects">): { text: string; ids: string[] } {
  const hits = retrieveBriefPassages(sections, itemQuery(item), ITEM_PASSAGES);
  return { text: hits.length ? `\n\n${renderBriefPassages(hits)}` : "", ids: hits.map((h) => h.id) };
}

/** the prompt options that put the stored brief's layers in place of the brief (layer 1 and the layer-5 reference) */
export function briefLayerOptions(ctx: ResearchContext): { researchContext: string; briefRef: { chars: number; ref: string } } {
  return { researchContext: renderResearchContext(ctx), briefRef: { chars: ctx.fingerprint.briefChars, ref: ctx.fingerprint.brief.slice(0, 12) } };
}
