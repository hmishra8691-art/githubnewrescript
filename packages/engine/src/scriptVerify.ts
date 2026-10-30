import type { SurveyDefinition, Question } from "@rescript/schema";
import { listBlocks } from "./blocks.js";
import { scriptLiteralRefs } from "./scriptRefs.js";

/**
 * S2c — THE EXECUTION AND VERIFICATION LAYER, its pure half.
 *
 * Intelligent Mode used to describe every script it proposed as "checked … not run yet". The Studio now RUNS each
 * code item of a proposal in a test session in its own browser (the real QuestionRenderer, UxLayer, script sandbox
 * and logic frame — `apps/studio/lib/copilot/verify/`) before the proposal is offered as ready. This module is what
 * that harness needs that is not a browser:
 *
 *   · `proposalCodeItems` — which items of a proposal are code (behaviour scripts, Scripts-panel logic scripts,
 *     custom components' code), new or changed against the survey before;
 *   · `hostPage` — the page that shows an item (the page it runs on);
 *   · `scriptDeclarations` + `buildScenarios` — the scenarios, derived deterministically (seeded) from what the code
 *     declares (rs.listen events and targets, DOM listeners, a logic script's event and scope, a component's
 *     api.onChange), the trigger question's type and the questions it reads;
 *   · `itemVerdict` — the verdict of one item from its execution record, with an optional `expect` hint the model
 *     may put on a script action (`{ on: "select Q1=2", effect: "class rs-highlight on Q5" }`);
 *   · `verificationSummary` / `executionReportText` — the card's words and the report a repair turn carries.
 */

/* ------------------------------------------------------------------ items */

/** a model's statement of what its script should do (optional on create/update_behavior and the logic-script actions) */
export interface ScriptExpect {
  /** the scenario that shows it: "select Q1=2", "enter", "next", "answer Q3=17", "clear Q1" */
  on?: string;
  /** the effect: "class rs-highlight on Q5", "message", "popup", "write Q9", "error", "none" (no effect expected) */
  effect?: string;
}

export function coerceExpect(v: unknown): ScriptExpect | undefined {
  if (typeof v === "string" && v.trim()) return { effect: v.trim().slice(0, 160) };
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 160) : undefined);
  const on = s(o.on) ?? s(o.when) ?? s(o.scenario);
  const effect = s(o.effect) ?? s(o.then) ?? s(o.expect);
  return on || effect ? { ...(on ? { on } : {}), ...(effect ? { effect } : {}) } : undefined;
}

export type VerifyItemKind = "behaviour" | "logic" | "component";
export interface VerifyItem {
  /** `${kind}:${id}` */
  key: string;
  kind: VerifyItemKind;
  /** the behaviour id, logic script id, or the component question's id */
  id: string;
  label: string;
  code: string;
  questionId?: string;
  pageId?: string;
  blockId?: string;
  /** a logic script's event and scope */
  event?: string;
  scope?: string;
  ref?: string;
  expect?: ScriptExpect;
}

/** an `expect` an action carried, with what identifies the item it belongs to */
export interface ExpectHint { label?: string; id?: string; target?: string; expect: ScriptExpect }

/** the expect hints of a proposal's actions (create/update_behavior, set_custom_code, create/update_logic_script) */
export function expectsFromActions(actions: unknown[]): ExpectHint[] {
  const out: ExpectHint[] = [];
  for (const a of actions ?? []) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    const expect = coerceExpect(o.expect);
    if (!expect) continue;
    const t = typeof o.target === "string" ? o.target : o.target && typeof o.target === "object" ? String((o.target as Record<string, unknown>).questionId ?? (o.target as Record<string, unknown>).question ?? "") : undefined;
    out.push({ expect, ...(typeof o.label === "string" ? { label: o.label } : typeof o.name === "string" ? { label: o.name } : {}), ...(typeof o.id === "string" ? { id: o.id } : typeof o.script === "string" && o.op !== "create_behavior" ? { id: o.script } : {}), ...(t ? { target: t } : {}) });
  }
  return out;
}

const qById = (def: SurveyDefinition, id: string | undefined) => (id ? def.questions.find((q) => q.id === id) : undefined);
/** a question by id, code or variable name */
export function questionByRef(def: SurveyDefinition, ref: string | undefined | null): Question | undefined {
  if (!ref) return undefined;
  const r = String(ref);
  return def.questions.find((q) => q.id === r) ?? def.questions.find((q) => String(q.code) === r) ?? def.questions.find((q) => q.variableName === r) ?? def.questions.find((q) => String(q.code).toLowerCase() === r.toLowerCase());
}

/**
 * The code items of a proposal: behaviours with a script, enabled logic scripts and custom components with code that
 * are new in `after` or whose code (or, for a logic script, event / scope) changed. Removed items are not run.
 */
export function proposalCodeItems(before: SurveyDefinition, after: SurveyDefinition, hints: ExpectHint[] = []): VerifyItem[] {
  const items: VerifyItem[] = [];
  const prevB = new Map((before.ux?.behaviors ?? []).map((b) => [b.id, b]));
  for (const b of after.ux?.behaviors ?? []) {
    if (!b.script || !b.script.trim()) continue;
    const p = prevB.get(b.id);
    if (p && p.script === b.script && JSON.stringify(p.target) === JSON.stringify(b.target) && (p.when ?? null) === (b.when ?? null)) continue;
    items.push({ key: `behaviour:${b.id}`, kind: "behaviour", id: b.id, label: b.label, code: b.script, ...(b.target.questionId ? { questionId: b.target.questionId } : {}), ...(b.target.pageId ? { pageId: b.target.pageId } : {}), ...(b.target.blockId ? { blockId: b.target.blockId } : {}) });
  }
  const prevS = new Map((before.scripts ?? []).map((s) => [s.id, s]));
  for (const s of after.scripts ?? []) {
    if (s.enabled === false || !s.code?.trim()) continue;
    const p = prevS.get(s.id);
    if (p && p.code === s.code && p.event === s.event && p.scope === s.scope && (p.ref ?? null) === (s.ref ?? null) && p.enabled !== false) continue;
    const q = s.scope === "question" ? questionByRef(after, s.ref) : undefined;
    items.push({ key: `logic:${s.id}`, kind: "logic", id: s.id, label: s.name, code: s.code, event: s.event, scope: s.scope, ...(s.ref ? { ref: s.ref } : {}), ...(q ? { questionId: q.id } : {}), ...(s.scope === "page" && s.ref ? { pageId: s.ref } : {}) });
  }
  const prevQ = new Map(before.questions.map((q) => [q.id, q]));
  for (const q of after.questions) {
    if (q.type !== "custom_component" || !q.customJs?.trim()) continue;
    if (prevQ.get(q.id)?.customJs === q.customJs) continue;
    items.push({ key: `component:${q.id}`, kind: "component", id: q.id, label: `${q.code} component`, code: q.customJs, questionId: q.id });
  }
  // the hints: by id, then by label, then by target question, then — one hint, one item — that item
  const used = new Set<number>();
  for (const it of items) {
    const code = it.questionId ? String(qById(after, it.questionId)?.code ?? "") : "";
    let i = hints.findIndex((h, k) => !used.has(k) && !!h.id && h.id === it.id);
    if (i < 0) i = hints.findIndex((h, k) => !used.has(k) && !!h.label && h.label === it.label);
    if (i < 0 && it.questionId) i = hints.findIndex((h, k) => !used.has(k) && !h.label && !!h.target && (h.target === it.questionId || h.target === code));
    if (i < 0 && hints.length === 1 && items.length === 1) i = 0;
    if (i >= 0) { used.add(i); it.expect = hints[i]!.expect; }
  }
  return items;
}

/* ------------------------------------------------------------------ the host page */

export interface HostPage { pageId: string; blockId: string; questionIds: string[]; /** the loop the page is in (its id), when it is */ loopId?: string }

/** the pages of the survey, in order, with their block and the loop that encloses them */
export function surveyPages(def: SurveyDefinition): HostPage[] {
  const loopOf = new Map<string, string>();
  const walk = (nodes: unknown[], loop: string | undefined) => {
    for (const n of nodes ?? []) {
      if (!n || typeof n !== "object") continue;
      const o = n as { type?: string; id?: string; children?: unknown[]; questionIds?: string[]; branches?: { children?: unknown[] }[]; then?: unknown[]; else?: unknown[] };
      if (o.type === "page" && o.id && loop) loopOf.set(o.id, loop);
      const inner = o.type === "loop" ? o.id : loop;
      for (const k of ["children", "then", "else", "nodes", "pages"] as const) { const v = (o as Record<string, unknown>)[k]; if (Array.isArray(v)) walk(v, inner); }
      if (Array.isArray(o.branches)) for (const b of o.branches) if (b && Array.isArray(b.children)) walk(b.children, inner);
    }
  };
  walk(def.flow as unknown[], undefined);
  const out: HostPage[] = [];
  for (const b of listBlocks(def.flow as unknown[])) for (const p of b.pages) {
    const id = String(p.node.id);
    out.push({ pageId: id, blockId: b.id, questionIds: [...(p.node.questionIds ?? [])], ...(loopOf.has(id) ? { loopId: loopOf.get(id) } : {}) });
  }
  return out;
}

/** the page a code item runs on: its question's page, its page, its block's first page, else the survey's first page */
export function hostPage(def: SurveyDefinition, item: Pick<VerifyItem, "questionId" | "pageId" | "blockId">): HostPage | null {
  const pages = surveyPages(def);
  if (!pages.length) return null;
  if (item.questionId) { const p = pages.find((x) => x.questionIds.includes(item.questionId!)); if (p) return p; }
  if (item.pageId) {
    const p = pages.find((x) => x.pageId === item.pageId) ?? (questionByRef(def, item.pageId) ? pages.find((x) => x.questionIds.includes(questionByRef(def, item.pageId)!.id)) : undefined);
    if (p) return p;
  }
  if (item.blockId) { const p = pages.find((x) => x.blockId === item.blockId); if (p) return p; }
  return pages[0]!;
}

/* ------------------------------------------------------------------ declarations */

export interface ScriptDeclarations {
  /** rs.listen(event, target) — target as written ("self" when absent) */
  listens: { event: string; target: string }[];
  /** element.addEventListener("input" | "change" | "click" …) */
  domEvents: string[];
  /** question ids named by [data-qid="…"] hooks */
  hooks: string[];
  /** literal reads and writes (rs.getAnswer / get / setAnswer / set …) */
  reads: string[];
  writes: string[];
  /** rs.error / error( — a rule the script raises */
  raisesErrors: boolean;
  /** api.onChange (a custom component) */
  componentOnChange: boolean;
}

export function scriptDeclarations(code: string): ScriptDeclarations {
  const src = String(code ?? "");
  const listens: { event: string; target: string }[] = [];
  for (const m of src.matchAll(/\brs\s*\.\s*listen\s*\(\s*(["'])([\w-]{1,40})\1\s*(?:,\s*(["'])([^"']{0,80})\3)?/g)) listens.push({ event: m[2]!, target: m[4] ?? "self" });
  const domEvents = [...new Set([...src.matchAll(/\.addEventListener\s*\(\s*(["'])([\w-]{1,30})\1/g)].map((m) => m[2]!))];
  const refs = scriptLiteralRefs(src);
  return {
    listens,
    domEvents,
    hooks: [...new Set(refs.filter((r) => r.via === "hook").map((r) => r.name))],
    reads: [...new Set(refs.filter((r) => r.via === "call" && !r.write).map((r) => r.name))],
    writes: [...new Set(refs.filter((r) => r.via === "call" && r.write).map((r) => r.name))],
    raisesErrors: /\b(?:rs\s*\.\s*)?error\s*\(/.test(src),
    componentOnChange: /\bapi\s*\.\s*onChange\s*\(/.test(src),
  };
}

/* ------------------------------------------------------------------ scenarios */

export type ScenarioStep =
  | { do: "answer"; questionId: string; value: unknown; label: string }
  | { do: "clear"; questionId: string; label: string }
  /** fill every question of the page with a valid-looking answer (valid) or leave / break them (invalid) */
  | { do: "fill"; valid: boolean; label: string }
  | { do: "next"; label: string };
export interface Scenario {
  id: string;
  label: string;
  /** every scenario starts by entering the page; 1 = the loop's second iteration */
  iteration?: number;
  steps: ScenarioStep[];
}

export type AnswerShape = "single" | "multi" | "numeric" | "text" | "other";
export function answerShape(q: Question): AnswerShape {
  const opts = (q as { options?: unknown[] }).options ?? [];
  if (/^(?:hidden|embedded_data|html|content|display|descriptive|experiment|custom_component)$/.test(q.type)) return "other";
  if (/matrix|grid|constant_sum|ranking|maxdiff|conjoint|allocation|list/.test(q.type)) return "other";
  if (opts.length && /multi|checkbox|multiple/.test(q.type)) return "multi";
  if (opts.length) return "single";
  if (/numeric|number|slider|age|year|integer|decimal|percent|currency/.test(q.type)) return "numeric";
  if (/text|open|essay|email|phone|comment|string/.test(q.type)) return "text";
  return "other";
}

/** a small seeded PRNG (mulberry32), so a scenario set is reproducible */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/** the numeric bounds a question declares (validation min/max, settings), else 0–100 */
export function numericBounds(q: Question): { min: number; max: number; declared: boolean } {
  const rules = ((q as { validation?: { kind?: string; value?: unknown }[] }).validation ?? []);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const s = ((q as { settings?: Record<string, unknown> }).settings ?? {});
  const min = num(rules.find((r) => r.kind === "min_value")?.value) ?? num(s.min) ?? num((q as { min?: unknown }).min);
  const max = num(rules.find((r) => r.kind === "max_value")?.value) ?? num(s.max) ?? num((q as { max?: unknown }).max);
  return { min: min ?? 0, max: max ?? (min != null ? min + 100 : 100), declared: min != null || max != null };
}

/** a valid-looking answer for a question (the first option, a typical number, a short text); undefined = none to give */
export function typicalAnswer(q: Question, rnd: () => number = () => 0.5): unknown {
  const shape = answerShape(q);
  const opts = ((q as { options?: { code: string | number }[] }).options ?? []);
  if (shape === "single") return opts[0]?.code;
  if (shape === "multi") return opts[0] ? [opts[0].code] : undefined;
  if (shape === "numeric") { const b = numericBounds(q); return Math.round(b.min + (b.max - b.min) * (0.25 + rnd() * 0.5)); }
  if (shape === "text") return "A typical answer";
  return undefined;
}

const optLabel = (o: { code: string | number; label?: string }) => (o.label ? String(o.label).replace(/<[^>]*>/g, "").slice(0, 40) : String(o.code));

export interface ScenarioOptions { seed?: number; maxOptions?: number; maxTriggers?: number }

/**
 * THE SCENARIOS for one item, deterministic for a given seed:
 *   · always: enter the page (page / load scripts, and what a script does on its own at start);
 *   · each trigger question (what it listens to — rs.listen targets, its own question for "self" and DOM listeners,
 *     [data-qid] hooks, a logic on_change script's question or page, a component's api.onChange, the questions it
 *     reads that are on the page): a choice → select each option once (≤ 6) and a select-then-clear; a number →
 *     empty, min, max, typical; a text → empty, one character, typical;
 *   · validate / submit (rs.listen validate/submit, a logic on_validate / on_submit / on_complete script, or a rule
 *     the script raises with error()): Next once with valid answers and, where a rule exists, once with invalid-looking ones;
 *   · a page in a loop: entering it in the first two iterations.
 */
export function buildScenarios(def: SurveyDefinition, item: VerifyItem, opts: ScenarioOptions = {}): Scenario[] {
  const seed = (opts.seed ?? 1) ^ hash(item.key);
  const rnd = prng(seed);
  const maxOptions = opts.maxOptions ?? 6;
  const maxTriggers = opts.maxTriggers ?? 3;
  const page = hostPage(def, item);
  const onPage = new Set(page?.questionIds ?? []);
  const decl = scriptDeclarations(item.code);
  const out: Scenario[] = [{ id: "enter", label: "enter the page", steps: [] }];
  if (page?.loopId) out.push({ id: "enter-2", label: "enter the page (loop iteration 2)", iteration: 1, steps: [] });

  // the trigger questions, in the order the code names them
  const triggers: string[] = [];
  const add = (q: Question | undefined) => { if (q && onPage.has(q.id) && !triggers.includes(q.id) && triggers.length < maxTriggers) triggers.push(q.id); };
  const own = qById(def, item.questionId);
  const ANSWER_EVENTS = /^(?:change|answer|select|deselect|input|focus|blur|click)$/;
  for (const l of decl.listens) if (ANSWER_EVENTS.test(l.event)) add(l.target === "self" || !l.target ? own : questionByRef(def, l.target));
  if (decl.domEvents.some((e) => /^(?:input|change|click|keyup|keydown)$/.test(e))) { for (const h of decl.hooks) add(questionByRef(def, h)); add(own); }
  if (item.kind === "logic" && item.event === "on_change") { if (own) add(own); else for (const id of page?.questionIds ?? []) add(qById(def, id)); }
  if (item.kind === "component" && decl.componentOnChange) add(own);
  for (const r of decl.reads) add(questionByRef(def, r));

  for (const qid of triggers) {
    const q = qById(def, qid)!;
    const shape = answerShape(q);
    const code = String(q.code);
    const opts2 = ((q as { options?: { code: string | number; label?: string }[] }).options ?? []).slice(0, maxOptions);
    if (shape === "single" || shape === "multi") {
      for (const o of opts2) out.push({ id: `select-${code}-${o.code}`, label: `select “${optLabel(o)}” in ${code}`, steps: [{ do: "answer", questionId: q.id, value: shape === "multi" ? [o.code] : o.code, label: `select ${code}=${o.code}` }] });
      if (opts2[0]) out.push({ id: `clear-${code}`, label: `select then clear ${code}`, steps: [{ do: "answer", questionId: q.id, value: shape === "multi" ? [opts2[0].code] : opts2[0].code, label: `select ${code}=${opts2[0].code}` }, { do: "clear", questionId: q.id, label: `clear ${code}` }] });
    } else if (shape === "numeric") {
      const b = numericBounds(q);
      const typical = Math.round(b.min + (b.max - b.min) * (0.25 + rnd() * 0.5));
      out.push({ id: `empty-${code}`, label: `${code} empty`, steps: [{ do: "answer", questionId: q.id, value: typical, label: `answer ${code}=${typical}` }, { do: "clear", questionId: q.id, label: `clear ${code}` }] });
      for (const [k, v] of [["min", b.min], ["max", b.max], ["typical", typical]] as const) out.push({ id: `${k}-${code}`, label: `${code} = ${v} (${k})`, steps: [{ do: "answer", questionId: q.id, value: v, label: `answer ${code}=${v}` }] });
    } else if (shape === "text") {
      out.push({ id: `empty-${code}`, label: `${code} empty`, steps: [{ do: "answer", questionId: q.id, value: "x", label: `answer ${code}=x` }, { do: "clear", questionId: q.id, label: `clear ${code}` }] });
      out.push({ id: `short-${code}`, label: `${code} one character`, steps: [{ do: "answer", questionId: q.id, value: "x", label: `answer ${code}=x` }] });
      out.push({ id: `typical-${code}`, label: `${code} typical text`, steps: [{ do: "answer", questionId: q.id, value: "A typical answer", label: `answer ${code}=text` }] });
    }
  }

  const lifecycle = decl.listens.some((l) => /^(?:validate|submit)$/.test(l.event)) || (item.kind === "logic" && /^on_(?:validate|submit|complete)$/.test(item.event ?? ""));
  if (lifecycle) {
    out.push({ id: "next-valid", label: "Next with valid answers", steps: [{ do: "fill", valid: true, label: "fill the page" }, { do: "next", label: "Next" }] });
    const rule = decl.raisesErrors || (page?.questionIds ?? []).some((id) => ((qById(def, id) as { validation?: unknown[]; required?: boolean } | undefined)?.validation?.length ?? 0) > 0);
    if (rule) out.push({ id: "next-invalid", label: "Next with invalid-looking answers", steps: [{ do: "fill", valid: false, label: "leave the page empty / out of range" }, { do: "next", label: "Next" }] });
  }
  return out;
}

/** the answer for each page question under a `fill` step (valid: typical answers; invalid: below the minimum, or empty) */
export function fillAnswers(def: SurveyDefinition, questionIds: string[], valid: boolean, seed = 1): Record<string, unknown> {
  const rnd = prng(seed);
  const out: Record<string, unknown> = {};
  for (const id of questionIds) {
    const q = qById(def, id);
    if (!q) continue;
    if (valid) { const v = typicalAnswer(q, rnd); if (v !== undefined) out[id] = v; continue; }
    if (answerShape(q) === "numeric") { const b = numericBounds(q); out[id] = b.declared ? b.min - 1 : null; }
    else out[id] = null;
  }
  return out;
}

/* ------------------------------------------------------------------ the record and the verdict */

/** one observable effect a script had: a class, a style, a message, an element made, a popup, a write, a validation error */
export interface ObservedEffect { kind: string; target: string; detail?: string }

export interface ScenarioRecord {
  id: string;
  label: string;
  /** thrown errors and rejections, with the line when the message names one */
  errors: { message: string; line?: number }[];
  effects: ObservedEffect[];
  writes: { call: string; target?: string; ok: boolean; reason?: string; value?: unknown }[];
  logs: string[];
  /** Next pressed: did it stop (and with which errors), and did the script raise them */
  next?: { blocked: boolean; errors: string[]; byScript: number };
}

export interface ItemRecord {
  key: string;
  kind: VerifyItemKind;
  label: string;
  /** at least one scenario ran (the frame started) */
  ran: boolean;
  /** why it could not run here (no page shows it, the harness cannot mount it) — not a fault of the script */
  notRun?: string;
  /** the code gate refused it at run time */
  gateRefusal?: string;
  /** refusals of DOM ops or navigation by the host */
  hostRefusals: string[];
  /** watchdog / rate-limit stops */
  watchdog: string[];
  /** the per-item time limit was reached */
  timedOut: boolean;
  scenarios: ScenarioRecord[];
  durationMs: number;
  /** the save payload check: problems in words (empty: every accepted write is in the state and the payload) */
  payload?: { checked: number; problems: string[] };
}

export type Verdict = "ran-ok" | "ran-no-effect" | "ran-error" | "blocked" | "timeout" | "not-run";
export interface ItemVerdict {
  key: string;
  label: string;
  verdict: Verdict;
  /** one line for the card */
  summary: string;
  /** the reasons, for the card's detail and the repair report */
  detail: string[];
  /** the expect hint's outcome, when there was one */
  expectMet?: boolean;
  scenarios: number;
}

const effectWords = (e: ObservedEffect) => {
  switch (e.kind) {
    case "add_class": return `added class ${e.detail ?? ""} to ${e.target}`.replace("  ", " ");
    case "remove_class": return `removed class ${e.detail ?? ""} from ${e.target}`.replace("  ", " ");
    case "toggle_class": return `toggled class ${e.detail ?? ""} on ${e.target}`.replace("  ", " ");
    case "message": return `showed a message on ${e.target}`;
    case "popup": return `opened a popup${e.detail ? ` “${e.detail}”` : ""}`;
    case "create": return `added an element to ${e.target}`;
    case "write": return `wrote ${e.target}${e.detail ? ` = ${e.detail}` : ""}`;
    case "validation": return `stopped Next with “${(e.detail ?? "").slice(0, 60)}”`;
    case "navigate": return `asked to go to ${e.target}`;
    default: return `${e.kind.replace(/_/g, " ")} on ${e.target}`;
  }
};

/** does the expect hint hold on this record? */
export function expectHolds(rec: ItemRecord, expect: ScriptExpect): { met: boolean; why: string } {
  const on = (expect.on ?? "").trim();
  const m = /^(select|answer|clear)\s+([\w.-]+)\s*(?:=\s*(.+))?$/i.exec(on);
  const scen = rec.scenarios.filter((s) => {
    if (!on) return true;
    if (/^(?:enter|load|page)$/i.test(on)) return s.id === "enter";
    if (/^(?:next|submit|validate)$/i.test(on)) return s.id.startsWith("next-");
    if (m) {
      const [, verb, q, v] = m;
      return s.id.toLowerCase().startsWith(`${verb!.toLowerCase() === "answer" ? "" : verb!.toLowerCase() === "clear" ? "clear" : "select"}`) && s.id.toLowerCase().includes(q!.toLowerCase()) && (v == null || s.id.toLowerCase().endsWith(`-${v.trim().toLowerCase()}`) || s.label.toLowerCase().includes(`= ${v.trim().toLowerCase()} `) || s.label.toLowerCase().includes(`“${v.trim().toLowerCase()}”`));
    }
    return s.label.toLowerCase().includes(on.toLowerCase());
  });
  const effect = (expect.effect ?? "").trim();
  const all = scen.flatMap((s) => s.effects);
  if (!scen.length) return { met: false, why: `no scenario matches “${on}”` };
  if (!effect) return { met: all.length > 0, why: all.length ? "" : `no effect on “${on}”` };
  if (/^(?:none|nothing|no effect)$/i.test(effect)) return { met: true, why: "" };
  const cls = /^class\s+([\w-]+)(?:\s+on\s+([\w.-]+))?/i.exec(effect);
  const write = /^write\s+([\w.@-]+)/i.exec(effect);
  let met: boolean;
  if (cls) met = all.some((e) => /class$/.test(e.kind) && e.kind !== "remove_class" && (e.detail ?? "").replace(/^rs-ux-/, "") .includes(cls[1]!.replace(/^rs-ux-/, "")) && (!cls[2] || e.target.toLowerCase() === cls[2].toLowerCase()));
  else if (write) met = all.some((e) => e.kind === "write" && e.target.toLowerCase().startsWith(write[1]!.toLowerCase()));
  else if (/^(?:message|text)/i.test(effect)) met = all.some((e) => e.kind === "message" || e.kind === "create");
  else if (/^popup/i.test(effect)) met = all.some((e) => e.kind === "popup");
  else if (/^(?:error|validation|stop|block)/i.test(effect)) met = all.some((e) => e.kind === "validation");
  else met = all.some((e) => effectWords(e).toLowerCase().includes(effect.toLowerCase()));
  return { met, why: met ? "" : `expected “${effect}”${on ? ` on “${on}”` : ""} — saw ${all.length ? all.slice(0, 3).map(effectWords).join("; ") : "nothing"}` };
}

/**
 * THE VERDICT of one item:
 *   not-run       the harness could not run it here (the reason) — the card says so; not a fault of the script
 *   blocked       refused at run time: the code gate, a DOM op or navigation the host refused, a write the engine refused
 *   timeout       the per-item limit or the watchdog stopped it
 *   ran-error     it threw (scenario, message, line), or an accepted value is missing from the state / save payload
 *   ran-no-effect it ran and did nothing observable in any scenario — or not what its `expect` said
 *   ran-ok        no error, and an observable effect (or "no effect" expected)
 */
export function itemVerdict(rec: ItemRecord, expect?: ScriptExpect): ItemVerdict {
  const n = rec.scenarios.length;
  const base = { key: rec.key, label: rec.label, scenarios: n };
  const errors = rec.scenarios.flatMap((s) => s.errors.map((e) => ({ ...e, scenario: s.label })));
  const refusedWrites = rec.scenarios.flatMap((s) => s.writes.filter((w) => !w.ok).map((w) => `${w.call} refused: ${w.reason ?? "not allowed"} (on “${s.label}”)`));
  if (rec.notRun && !rec.ran && !rec.gateRefusal) return { ...base, verdict: "not-run", summary: `Could not be run here: ${rec.notRun}`, detail: [rec.notRun] };
  if (rec.gateRefusal) return { ...base, verdict: "blocked", summary: `Refused when run: ${rec.gateRefusal}`, detail: [rec.gateRefusal] };
  if (rec.timedOut || rec.watchdog.length) return { ...base, verdict: "timeout", summary: `Stopped in the test session: ${rec.watchdog[0] ?? "it did not finish within the time limit"}`, detail: [...rec.watchdog, ...(rec.timedOut ? ["the per-item time limit (5 s) was reached"] : [])] };
  if (errors.length) {
    const e = errors[0]!;
    return { ...base, verdict: "ran-error", summary: `Ran in a test session: error on “${e.scenario}”: ${e.message}${e.line ? ` (line ${e.line})` : ""}`, detail: errors.slice(0, 6).map((x) => `on “${x.scenario}”: ${x.message}${x.line ? ` (line ${x.line})` : ""}`) };
  }
  if (refusedWrites.length || rec.hostRefusals.length) {
    const detail = [...refusedWrites, ...rec.hostRefusals].slice(0, 8);
    return { ...base, verdict: "blocked", summary: `Ran in a test session, but the survey refused it: ${detail[0]}`, detail };
  }
  if (rec.payload?.problems.length) return { ...base, verdict: "ran-error", summary: `Ran in a test session, but a written value would not be saved: ${rec.payload.problems[0]}`, detail: rec.payload.problems };
  const effects = rec.scenarios.flatMap((s) => s.effects.map((e) => ({ e, s: s.label })));
  const ex = expect ? expectHolds(rec, expect) : null;
  const noneExpected = !!expect?.effect && /^(?:none|nothing|no effect)$/i.test(expect.effect.trim());
  const saved = rec.payload?.checked ? `; ${rec.payload.checked} written value${rec.payload.checked === 1 ? "" : "s"} in the save payload` : "";
  if (ex && !ex.met) return { ...base, verdict: "ran-no-effect", summary: `Ran in a test session (${n} scenario${n === 1 ? "" : "s"}), but not as expected: ${ex.why}`, detail: [ex.why], expectMet: false };
  if (!effects.length && !noneExpected) return { ...base, verdict: "ran-no-effect", summary: `Ran in a test session (${n} scenario${n === 1 ? "" : "s"}), no errors — but it did nothing visible in any of them (a selector, event or condition that never matches?)`, detail: [`no observable effect in: ${rec.scenarios.map((s) => s.label).join("; ")}`] };
  const first = effects[0];
  const said = first ? `${effectWords(first.e)}${first.s !== "enter the page" ? ` on “${first.s.replace(/^select “(.+)” in .+$/, "$1")}”` : " when the page opened"}` : "no effect, as expected";
  return { ...base, verdict: "ran-ok", summary: `Ran in a test session: ${n} scenario${n === 1 ? "" : "s"}, ${said}, no errors${saved}`, detail: [], ...(ex ? { expectMet: true } : {}) };
}

export const VERDICT_NEEDS_REPAIR = (v: ItemVerdict) => v.verdict === "ran-error" || v.verdict === "ran-no-effect" || v.verdict === "blocked" || v.verdict === "timeout";

export interface VerificationReport {
  /** a fingerprint of the code items verified (what the card's result belongs to) */
  signature: string;
  at: string;
  durationMs: number;
  items: ItemRecord[];
  verdicts: ItemVerdict[];
  /** the whole proposal's limit (20 s) was reached: the remaining items were not run */
  truncated?: boolean;
}

/** the fingerprint of a proposal's code items — a changed script is verified again */
export function codeItemsSignature(items: VerifyItem[]): string {
  return items.map((i) => `${i.key}#${hash(`${i.code}|${i.event ?? ""}|${i.scope ?? ""}|${i.ref ?? ""}|${i.questionId ?? ""}|${i.pageId ?? ""}|${JSON.stringify(i.expect ?? null)}`).toString(36)}`).join(",");
}

/** the card's one line for the whole proposal */
export function verificationSummary(r: Pick<VerificationReport, "verdicts">): { ok: boolean; text: string } {
  const bad = r.verdicts.filter(VERDICT_NEEDS_REPAIR);
  const notRun = r.verdicts.filter((v) => v.verdict === "not-run");
  if (bad.length) return { ok: false, text: `${bad.length} of ${r.verdicts.length} script${r.verdicts.length === 1 ? "" : "s"} did not pass the test session` };
  if (notRun.length === r.verdicts.length) return { ok: true, text: `Checked; could not be run here: ${notRun[0]?.detail[0] ?? ""}` };
  return { ok: true, text: `${r.verdicts.length - notRun.length} script${r.verdicts.length - notRun.length === 1 ? "" : "s"} ran in a test session without a problem` };
}

/** THE EXECUTION REPORT a repair turn carries (plain words, bounded) */
export function executionReportText(r: Pick<VerificationReport, "verdicts" | "items">, max = 3000): string {
  const lines: string[] = [];
  for (const v of r.verdicts) {
    const rec = r.items.find((i) => i.key === v.key);
    lines.push(`- ${v.label} [${v.verdict}]: ${v.summary}`);
    for (const d of v.detail.slice(0, 5)) lines.push(`    · ${d}`);
    const logs = rec ? [...new Set(rec.scenarios.flatMap((s) => s.logs))].slice(0, 4) : [];
    for (const l of logs) lines.push(`    log: ${l.slice(0, 200)}`);
    if (rec) lines.push(`    scenarios: ${rec.scenarios.map((s) => `${s.label} → ${s.effects.length ? s.effects.slice(0, 2).map(effectWords).join(", ") : s.errors.length ? "error" : "no effect"}`).join("; ").slice(0, 600)}`);
  }
  return lines.join("\n").slice(0, max);
}
