import type { Condition, ConditionRule, Question, SetExpr, SurveyDefinition } from "@rescript/schema";
import type { SurveyAction } from "./surveyActions.js";
import type { OptionAction } from "./optionActions.js";
import { resolveOption } from "./optionActions.js";
import { buildDependencyIndex, objectKey, parseObjectKey, type DependencyEdge, type DependencyIndex, type EdgeKind, type ObjectKey, type ObjectKind } from "./dependencyIndex.js";
import { forEachRuleIn } from "./actionValidation.js";
import { forEachRule } from "./conditionWalk.js";
import { formatCondition } from "./logicExpression.js";
import { setExpressionSummary } from "./setExpression.js";
import { analysisDependencies } from "./analysisFramework.js";
import { variableUsages, type VariableUsage } from "./variableUsage.js";
import { operatorsForQuestion } from "./lintLogic.js";
import { getQuestionByCodeOrVar } from "./state.js";
import { orderIndex } from "./dependencies.js";
import { listBlocks } from "./blocks.js";
import { stripHtmlText } from "./html.js";

/**
 * THE IMPACT REPORT — what else notices when this changes, in the words the
 * review screen shows beside each change.
 *
 * Three modules already answer parts of this question: `references.ts` says
 * what deleting a question prunes, `variableUsage.ts` what a rename rewrites,
 * `actionValidation.ts` what an action left broken. The dependency index
 * knows every reader of every object, typed. None of them answers the
 * reviewer's question, which is one list: "if this proposal goes through,
 * what depends on the thing it changes, how badly, and is it a direct
 * dependency or something three steps away?" — the same list for a deleted
 * question, a recoded option, a retyped scale, a moved question and a renamed
 * variable, so the UI renders one shape.
 *
 * `impactOf` is that list for a SCOPE (questions, options, blocks, variables,
 * embedded fields, calculations) under a KIND of change. `impactOfAction`
 * derives the scope and the kind from a survey action, so the review can call
 * it per applied action. Severity is decided here and nowhere else:
 *
 *   breaks   a reference that would stop resolving or stop firing — a rule
 *            reading a deleted question, a quota cell comparing with a code
 *            that no longer exists, an operator the new type cannot take, a
 *            reader that would now run before the question it reads
 *   changes  behaviour changes and the survey is still valid — a carried-
 *            forward list that gains or loses an option, a translation whose
 *            source moved from under it, anything reached transitively
 *   informs  metadata to look at, not logic that fails — piping, the analysis
 *            plan, a construct, a language, a dependent of a wording edit
 *
 * The report never evaluates anything and never mutates either survey. It is
 * built from the (extended) dependency index for every edge the survey has,
 * from the rule walker for option comparers (a code is compared by VALUE, so
 * no edge carries it), from `analysisDependencies` as a second reading of the
 * plan, and from `variableUsages` for the places a NAME is held by value.
 */

export type ImpactSeverity = "breaks" | "changes" | "informs";

export interface ImpactItem {
  /** what is affected */
  object: { kind: ObjectKind | "option" | "quota" | "block" | "page"; id: string; code: string; label: string; questionId?: string };
  /** how it is affected: the dependency edge kind, or "analysis plan" | "construct" | "translation" | "export column" */
  via: string;
  /** researcher words: "Q9 — display logic reads Q7 = 3" */
  text: string;
  severity: ImpactSeverity;
  /** reached transitively */
  indirect?: boolean;
  path?: string;
}

export interface ImpactScope {
  questions?: string[];
  options?: { questionId: string; codes: (string | number)[] }[];
  blocks?: string[];
  variables?: string[];
  embedded?: string[];
  calculations?: string[];
}

export interface ImpactReport {
  items: ImpactItem[];
  count: number;
  byVia: Record<string, number>;
  bySeverity: Record<ImpactSeverity, number>;
  /** "Impact: 5 dependent objects — Q9 display logic, Q11 skip logic, calculation SCORE, construct Satisfaction, German translations" */
  summary: string;
}

export type ImpactChange = "delete" | "recode" | "retype" | "move" | "edit";

export interface ImpactOptions { change?: ImpactChange; index?: DependencyIndex }

/* ------------------------------------------------------------ words */

const RANK: Record<ImpactSeverity, number> = { breaks: 3, changes: 2, informs: 1 };
const worse = (a: ImpactSeverity, b: ImpactSeverity): ImpactSeverity => (RANK[a] >= RANK[b] ? a : b);
const plain = (s: string | undefined, n = 120): string => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** the edge kinds whose reference is metadata, not runtime logic */
const INFORMS: Set<string> = new Set(["piping", "analysis", "construct", "translation", "analysis plan", "export column"]);
/** the edge kinds whose reference is a condition tree — the ones a type change can make unfit */
const CONDITIONAL: Set<string> = new Set(["display", "skip", "validation", "randomization", "optionLogic", "quotaCell", "flowCondition", "namedExpression", "listLogic", "listOperation", "listFillGate", "carryForward", "mask", "punch", "calculation"]);

/** the via a dependency edge reports under */
const viaOf = (kind: EdgeKind): string => (kind === "analysis" ? "analysis plan" : kind);

/** "display logic", "skip logic", … — the via as the summary line says it */
const VIA_WORDS: Record<string, string> = {
  display: "display logic", skip: "skip logic", validation: "validation", randomization: "randomization", carryForward: "carry-forward",
  listLogic: "list logic", listOperation: "list operation", mask: "masking", punch: "auto punch", optionLogic: "option logic", piping: "piping",
  calculation: "expression", quotaCell: "quota cell", flowCondition: "condition", loopSource: "loop source", listFillSource: "source", listFillGate: "gate",
  namedExpression: "definition", target: "routing", placement: "placement", "analysis plan": "analysis", construct: "construct", translation: "translations", "export column": "export",
};

/* ------------------------------------------------------------ reading the definition by path */

/** the value at a dotted path — `questions[3].skipLogic[0].when` — or undefined */
function atPath(def: SurveyDefinition, path: string): unknown {
  let cur: unknown = def;
  for (const tok of path.split(/\.|\[|\]\.?/).filter(Boolean)) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[tok];
  }
  return cur;
}

const isConditionNode = (v: unknown): v is Condition => !!v && typeof v === "object" && ((v as { type?: string }).type === "rule" || (v as { type?: string }).type === "group");
const isSetExpr = (v: unknown): v is SetExpr => !!v && typeof v === "object" && ["codes", "ref", "listFill", "loopItem", "expr", "complement", "op"].includes(String((v as { kind?: string }).kind));

/** the root condition an edge's path sits in, when it sits in one */
function rootConditionAt(def: SurveyDefinition, path: string): Condition | undefined {
  const cut = path.search(/\.children\[|\.source\.|\.value$|\.value\[/);
  const c = atPath(def, cut >= 0 ? path.slice(0, cut) : path);
  return isConditionNode(c) ? c : undefined;
}

/** "reads Q7 = 3", "reads what Q5 selected", "= SPEND * 12" — what the reference at `path` says, or "" */
function detailAt(def: SurveyDefinition, e: DependencyEdge): string {
  try {
    const root = rootConditionAt(def, e.path);
    if (root) { const s = formatCondition(def, root, { width: 400 }).replace(/\s+/g, " "); return s ? `reads ${s}` : ""; }
    const v = atPath(def, e.path);
    if (isSetExpr(v)) return `reads ${setExpressionSummary(def, v)}`;
    if (typeof v === "string") {
      if (e.kind === "piping") return "pipes its answer";
      if (getQuestionByCodeOrVar(def, v) || def.questions.some((q) => q.id === v)) return "";
      return e.kind === "calculation" ? `= ${plain(v, 80)}` : `reads ${plain(v, 80)}`;
    }
  } catch { /* a half-formed definition must not take the review down */ }
  return "";
}

/** the question node / skip rule owner a key belongs to */
function objectOf(ix: DependencyIndex, key: ObjectKey): ImpactItem["object"] {
  const info = ix.nodes.get(key) ?? { key, ...parseObjectKey(key), code: parseObjectKey(key).id, label: key };
  const o: ImpactItem["object"] = { kind: info.kind, id: info.id, code: info.code, label: plain(info.label) };
  if (info.kind === "question") o.questionId = info.id;
  if (info.kind === "skipRule") o.questionId = info.id.split("/")[0];
  return o;
}

/* ------------------------------------------------------------ the report */

class Report {
  readonly items: ImpactItem[] = [];
  private readonly at = new Map<string, number>();
  /** one row per (object, via); a second reason for the same pair keeps the worse severity and the direct reading */
  add(item: ImpactItem): void {
    const k = `${item.object.kind}:${item.object.id}|${item.via}`;
    const i = this.at.get(k);
    if (i === undefined) { this.at.set(k, this.items.length); this.items.push(item); return; }
    const had = this.items[i];
    const direct = !item.indirect && !!had.indirect;
    this.items[i] = { ...(direct ? item : had), severity: worse(had.severity, item.severity), ...(direct || !had.indirect ? {} : { indirect: true }) };
  }
}

/** does this rule read the question — by id, code or variable, as the parser and the runtime both accept */
const reads = (def: SurveyDefinition, src: { kind?: string; ref?: string } | undefined, q: Question): boolean =>
  !!src && (src.kind === "question" || src.kind === "variable") && (src.ref === q.id || src.ref === String(q.code) || src.ref === q.variableName || getQuestionByCodeOrVar(def, src.ref ?? "")?.id === q.id);

/** the literal codes a rule compares with: value, value2 (never a rank) and a COUNT's option lists */
function comparedCodes(r: ConditionRule): string[] {
  if (r.source.count) return [...(r.source.count.only ?? []), ...(r.source.count.responseIn ?? [])].map(String);
  const lits = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x) => x !== undefined && x !== null && x !== "" && typeof x !== "object" && typeof x !== "boolean").map((x) => String(x).trim());
  return [...lits(r.value), ...(String(r.operator).startsWith("rank") ? [] : lits(r.value2))];
}

/**
 * The object a rule-walker location belongs to: the question, quota, display
 * rule, calculation, named expression, list fill or flow node whose path it
 * starts with — with the via the field implies.
 */
function ownerAt(def: SurveyDefinition, ix: DependencyIndex, path: string): { object: ImpactItem["object"]; via: string } | null {
  const head = /^(questions|quotas|displayRules|calculations|namedExpressions|listFills|flow)\b/.exec(path)?.[1];
  if (!head) return null;
  const via = /\.displayLogic\b/.test(path) || head === "displayRules" ? "display"
    : /\.skipLogic\[/.test(path) ? "skip"
    : /\.validation\[/.test(path) ? "validation"
    : /\.punches\[/.test(path) ? "punch"
    : /\.(?:mask|rowMask|columnMask)\b/.test(path) ? "mask"
    : /\.randomization\b/.test(path) ? "randomization"
    : /\.carryForward\b/.test(path) ? "carryForward"
    : /\.listLogic\[/.test(path) ? "listLogic"
    : /\.optionPipeline\[/.test(path) ? "listOperation"
    : /\.(?:options|rows|columns)\[/.test(path) ? "optionLogic"
    : head === "quotas" ? "quotaCell"
    : head === "calculations" ? "calculation"
    : head === "namedExpressions" ? "namedExpression"
    : head === "listFills" ? "listFillGate"
    : head === "flow" ? "flowCondition" : "display";
  if (head === "flow") {
    // the deepest flow node on the path that the index knows — a branch, a loop, a conditional page or block
    const tokens = path.split(/\.|\[|\]\.?/).filter(Boolean);
    let node: { type?: string; id?: string; title?: string } | undefined;
    let cur: unknown = def;
    for (const t of tokens) {
      if (cur === null || typeof cur !== "object") break;
      cur = (cur as Record<string, unknown>)[t];
      const c = cur as { type?: string; id?: string } | undefined;
      if (c && typeof c === "object" && typeof c.type === "string" && typeof c.id === "string") node = c;
    }
    if (!node?.id) return null;
    const key = objectKey("flowNode", node.id);
    const object = ix.nodes.has(key) ? objectOf(ix, key) : { kind: "flowNode" as const, id: node.id, code: node.title || `${node.type} ${node.id}`, label: node.type === "page" ? "Page" : node.type === "block" ? "Block" : String(node.type) };
    return { object, via };
  }
  const i = Number(/\[(\d+)\]/.exec(path)?.[1]);
  if (!Number.isInteger(i)) return null;
  if (head === "questions") {
    const q = def.questions[i];
    if (!q) return null;
    // a skip rule is its own node in the index: the same object whichever way it was found
    const sk = via === "skip" ? q.skipLogic?.[Number(/skipLogic\[(\d+)\]/.exec(path)?.[1])] : undefined;
    if (sk) return { object: objectOf(ix, objectKey("skipRule", `${q.id}/${sk.id}`)), via };
    return { object: { kind: "question", id: q.id, code: String(q.code), label: plain(q.text), questionId: q.id }, via };
  }
  if (head === "quotas") { const qt = def.quotas[i]; const cell = Number(/cells\[(\d+)\]/.exec(path)?.[1]); return qt ? { object: { kind: "quota", id: qt.id, code: qt.name, label: qt.cells[cell]?.label ?? qt.name }, via } : null; }
  if (head === "displayRules") { const r = def.displayRules[i]; return r ? { object: objectOf(ix, objectKey("displayRule", r.id)), via } : null; }
  if (head === "calculations") { const c = def.calculations[i]; return c ? { object: objectOf(ix, objectKey("calculation", c.id)), via } : null; }
  if (head === "namedExpressions") { const e = def.namedExpressions[i]; return e ? { object: objectOf(ix, objectKey("namedExpression", e.id)), via } : null; }
  if (head === "listFills") { const lf = def.listFills[i]; return lf ? { object: objectOf(ix, objectKey("listFill", lf.id)), via } : null; }
  return null;
}

/** "Q9 display logic", "quota “Region”", "construct Satisfaction", "German translations" — one item, for the summary line */
export function impactPhrase(item: ImpactItem): string {
  const { object: o, via } = item;
  const w = VIA_WORDS[via] ?? via;
  switch (o.kind) {
    case "question": return via === "translation" ? `${o.code} translations` : `${o.code} ${w}`;
    case "skipRule": return `${o.code.replace(/ skip \d+$/, "")} skip logic`;
    case "displayRule": return `display rule “${o.code}”`;
    case "calculation": return `calculation ${o.code}`;
    case "quota": return `quota “${o.code}”`;
    case "flowNode": return `${o.label.toLowerCase()} “${o.code}”`;
    case "namedExpression": return `expression ${o.code}`;
    case "listFill": return `list fill ${o.code}`;
    case "embedded": return `embedded ${o.code}`;
    case "analysis": return `planned ${o.code.replace(/ \S+$/, "")} ${o.label}`.replace(/\s+/g, " ");
    case "construct": return `construct ${o.code}`;
    case "translation": return `${o.label} translations`;
    case "option": return `${o.code} option`;
    case "block": return `block “${o.code}”`;
    case "page": return `page “${o.code}”`;
    default: return `${o.code} ${w}`;
  }
}

function finish(items: ImpactItem[]): ImpactReport {
  const byVia: Record<string, number> = {};
  const bySeverity: Record<ImpactSeverity, number> = { breaks: 0, changes: 0, informs: 0 };
  for (const it of items) { byVia[it.via] = (byVia[it.via] ?? 0) + 1; bySeverity[it.severity]++; }
  // the direct dependents, worst first, each object once however many reasons it has; the plan as one phrase when it is several tables
  const direct = items.filter((i) => !i.indirect).sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const plan = direct.filter((i) => i.object.kind === "analysis");
  const phrases: string[] = [];
  for (const it of direct) {
    const p = it.object.kind === "analysis" && plan.length > 1 ? `${plan.length} planned analyses` : impactPhrase(it);
    if (!phrases.includes(p)) phrases.push(p);
  }
  const shown = phrases.slice(0, 8);
  const n = items.length;
  const rest = n - direct.length + (phrases.length - shown.length);
  const summary = !n ? "Impact: nothing else depends on it"
    : `Impact: ${n} dependent object${n === 1 ? "" : "s"} — ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
  return { items, count: n, byVia, bySeverity, summary };
}

/* ------------------------------------------------------------ impactOf */

/**
 * Everything that depends on the scope, with how badly a `change` of that
 * kind hits it. `index` is reused when the caller has one — building it is
 * the expensive part on a large survey.
 */
export function impactOf(def: SurveyDefinition, scope: ImpactScope, opts: ImpactOptions = {}): ImpactReport {
  const ix = opts.index ?? buildDependencyIndex(def);
  const change = opts.change ?? "edit";
  const report = new Report();
  const order = orderIndex(def);
  const byId = new Map(def.questions.map((q) => [q.id, q]));
  const questionIds = new Set<string>(scope.questions ?? []);
  // a block goes with its questions: its internal wiring is not impact, what reads it from outside is
  for (const bid of scope.blocks ?? []) {
    const b = listBlocks(def.flow as unknown[]).find((x) => x.id === bid);
    for (const qid of b?.pages.flatMap((p) => p.node.questionIds) ?? []) questionIds.add(qid);
  }
  const inScope = (o: ImpactItem["object"]) => (o.questionId && questionIds.has(o.questionId)) || (o.kind === "question" && questionIds.has(o.id));

  /** severity of a direct edge into a question, for this kind of change */
  const severityFor = (e: DependencyEdge, q: Question): ImpactSeverity => {
    const via = viaOf(e.kind);
    if (via === "translation") return change === "delete" ? "informs" : "changes";
    if (INFORMS.has(via)) return "informs";
    switch (change) {
      case "delete": return "breaks";
      case "retype": {
        // the operators the rules use must still fit the question's new shape
        if (!CONDITIONAL.has(e.kind)) return "changes";
        const root = rootConditionAt(def, e.path);
        if (!root) return "changes";
        const allowed = new Set<string>(operatorsForQuestion(q));
        let unfit = false;
        forEachRule(root, (r) => { if (reads(def, r.source, q) && !r.source.count && !allowed.has(r.operator)) unfit = true; });
        return unfit ? "breaks" : "changes";
      }
      case "move": {
        // a reader that now sits before what it reads runs on an empty answer
        const from = parseObjectKey(e.from);
        const readerQ = from.kind === "question" ? from.id : from.kind === "skipRule" ? from.id.split("/")[0] : undefined;
        if (readerQ && readerQ in order && q.id in order && order[readerQ] < order[q.id]) return "breaks";
        return "changes";
      }
      case "recode": return "changes";
      default: return "informs";
    }
  };

  /** the direct readers of a question, then everything that reads them */
  const walkFrom = (start: ObjectKey, q: Question | undefined, keep: (e: DependencyEdge) => boolean = () => true) => {
    const seen = new Set<ObjectKey>([start]);
    const queue: { key: ObjectKey; depth: number; through?: string }[] = [{ key: start, depth: 0 }];
    while (queue.length) {
      const { key, depth, through } = queue.shift()!;
      for (const e of ix.usedBy(key)) {
        if (!keep(e)) continue;
        const via = viaOf(e.kind);
        // a language or the plan is about the intermediate question, not about what changed
        if (depth > 0 && (via === "translation" || via === "construct" || via === "analysis plan")) continue;
        const object = objectOf(ix, e.from);
        if (inScope(object)) continue;
        const d = detailAt(def, e);
        const item: ImpactItem = depth === 0
          ? { object, via, text: `${e.label}${d ? ` ${d}` : ""}`, severity: q ? severityFor(e, q) : change === "delete" ? "breaks" : "changes", path: e.path }
          : { object, via, text: `${e.label} — through ${through}`, severity: "changes", indirect: true, path: e.path };
        report.add(item);
        if (seen.has(e.from)) continue;
        seen.add(e.from);
        // what the next ring is reached through: the first direct dependent on the way
        queue.push({ key: e.from, depth: depth + 1, through: through ?? object.code });
      }
    }
  };

  /* ---- questions (and blocks') */
  for (const qid of questionIds) {
    const q = byId.get(qid);
    if (!q) continue;
    walkFrom(objectKey("question", qid), q);
    // the plan, read a second way: anything the index resolved differently still lands here, deduped by object + via
    const deps = analysisDependencies(def, qid);
    const sev: ImpactSeverity = "informs";
    for (const x of deps.crosstabs) report.add({ object: objectOf(ix, objectKey("analysis", x.id)), via: "analysis plan", text: `crosstab ${x.rows.join(" + ")} by ${x.columns.join(" + ")} — analysis plan`, severity: sev });
    for (const t of deps.tests) report.add({ object: objectOf(ix, objectKey("analysis", t.id)), via: "analysis plan", text: `${t.method.replace(/_/g, " ")}${t.outcome ? ` on ${t.outcome}` : ""} — analysis plan`, severity: sev });
    for (const d of deps.derived) report.add({ object: objectOf(ix, objectKey("analysis", `derived:${d.name}`)), via: "analysis plan", text: `derived variable ${d.name} — analysis plan`, severity: sev });
    for (const s of deps.segments) report.add({ object: objectOf(ix, objectKey("analysis", `segment:${s.name}`)), via: "analysis plan", text: `segment “${s.name}” — analysis plan`, severity: sev });
    for (const c of deps.constructs) report.add({ object: objectOf(ix, objectKey("construct", c)), via: "construct", text: `${c} — construct`, severity: sev });
    // the saved export settings for its variable are keyed by name
    if (change === "delete" || change === "retype") {
      for (const u of variableUsages(def, q.variableName)) {
        if (u.kind === "override") report.add({ object: { kind: "question", id: q.id, code: String(q.code), label: plain(q.text), questionId: q.id }, via: "export column", text: `${u.where}${change === "delete" ? " — no column to hold them" : ""}`, severity: "informs", path: u.path });
      }
    }
  }

  /* ---- blocks: what reads the block itself from outside (a skip jumping to it, a condition on it) */
  for (const bid of scope.blocks ?? []) {
    walkFrom(objectKey("flowNode", bid), undefined, (e) => e.kind !== "placement");
  }

  /* ---- options: the comparers of those codes, by value */
  for (const { questionId, codes } of scope.options ?? []) {
    const q = byId.get(questionId);
    if (!q || !codes.length) continue;
    const wanted = new Set(codes.map((c) => String(c).trim()));
    const labelOf = (c: string) => { const o = (q.options ?? []).find((x) => String(x.code) === c); return o ? `${c} “${plain(o.label, 40)}”` : c; };
    // a comparer of a removed or recoded code is never true again; of a relabelled one it is unaffected and only worth a look
    const sev: ImpactSeverity = change === "delete" || change === "recode" ? "breaks" : change === "edit" ? "informs" : "changes";
    forEachRuleIn(def, (rule, loc, at) => {
      const ofQ = reads(def, rule.source as { kind?: string; ref?: string }, q)
        || (at.inCountWhere && rule.source?.kind === "option" && (rule.source.ref ?? "code") === "code" && reads(def, at.countOwner?.source as { kind?: string; ref?: string }, q));
      if (!ofQ) return;
      const hit = comparedCodes(rule).filter((c) => wanted.has(c));
      if (!hit.length) return;
      // its own skip rule comparing its own answer is a comparer like any other: a recode silences it just the same
      const owner = ownerAt(def, ix, loc.path);
      if (!owner) return;
      const root = rootConditionAt(def, loc.path) ?? atPath(def, loc.path);
      let shown = "";
      try { shown = isConditionNode(root) ? formatCondition(def, root, { width: 400 }).replace(/\s+/g, " ") : ""; } catch { shown = ""; }
      report.add({ object: owner.object, via: owner.via, text: `${loc.where} compares ${q.code} with ${hit.map(labelOf).join(", ")}${shown ? ` — ${shown}` : ""}`, severity: sev, path: loc.path });
    });
    // the question's own code lists that name the option
    (q.punches ?? []).forEach((p, i) => {
      const src = p.source as { kind?: string; codes?: (string | number)[] };
      const hit = (src.kind === "codes" ? src.codes ?? [] : []).map(String).filter((c) => wanted.has(c));
      if (hit.length) report.add({ object: { kind: "question", id: q.id, code: String(q.code), label: plain(q.text), questionId: q.id }, via: "punch", text: `${q.code} — auto punch codes ${hit.map(labelOf).join(", ")}`, severity: sev, path: `questions[${def.questions.indexOf(q)}].punches[${i}].source` });
    });
    // what inherits its option list: a carried-forward list, a mask, a loop, a punch source —
    // and a planned analysis that crosses or groups by this question: its categories (a crosstab's columns, a test's groups) are these options
    for (const e of ix.usedBy(objectKey("question", q.id))) {
      if (e.kind === "analysis") {
        report.add({ object: objectOf(ix, e.from), via: "analysis plan", text: `${e.label} — its categories are ${q.code}'s options, so ${change === "edit" ? "its labels change" : "its groups change"}`, severity: change === "edit" ? "informs" : "changes", path: e.path });
        continue;
      }
      if (!["carryForward", "mask", "punch", "listLogic", "listOperation", "loopSource", "listFillSource"].includes(e.kind)) continue;
      const d = detailAt(def, e);
      report.add({ object: objectOf(ix, e.from), via: e.kind, text: `${e.label}${d ? ` ${d}` : ""} — its list follows ${q.code}'s options`, severity: "changes", path: e.path });
    }
    // translations keyed to those codes
    const loc = def.localization;
    for (const [lang, table] of Object.entries(loc?.translations ?? {})) {
      if (lang === loc?.sourceLanguage) continue;
      const n = [...wanted].filter((c) => { const t = table?.[`q:${q.id}:opt:${c}`]; return t && t.status !== "not_translated" && t.text.trim(); }).length;
      if (!n) continue;
      const key = objectKey("translation", lang);
      const name = ix.nodes.get(key)?.label ?? lang;
      report.add({ object: objectOf(ix, key), via: "translation", text: `${name} — ${n} option translation${n === 1 ? "" : "s"} keyed to ${q.code}'s ${n === 1 ? "code" : "codes"} ${[...wanted].filter((c) => table?.[`q:${q.id}:opt:${c}`]).join(", ")}`, severity: change === "recode" || change === "delete" ? "breaks" : "changes", path: `localization.translations.${lang}.q:${q.id}` });
    }
  }

  /* ---- variables: every place a NAME is held by value, with whether a rename can follow it */
  for (const name of scope.variables ?? []) {
    for (const u of variableUsages(def, name)) {
      if (u.kind === "question_variable" || u.kind === "calc_target") continue; // the thing itself
      const owner = ownerAt(def, ix, u.path.replace(/^survey\./, ""));
      const object = owner?.object ?? (u.kind === "override" || u.kind === "derived_column" ? { kind: "question" as const, id: name, code: name, label: u.where } : u.kind === "analysis" ? { kind: "analysis" as const, id: u.path, code: u.where.replace(/^Analysis plan — /, ""), label: u.where } : { kind: "question" as const, id: name, code: name, label: u.where });
      const via = u.kind === "pipe" ? "piping" : u.kind === "analysis" ? "analysis plan" : u.kind === "override" || u.kind === "derived_column" ? "export column" : u.kind === "script" ? "script" : owner?.via ?? "expression";
      const severity: ImpactSeverity = change === "delete" ? "breaks" : u.rewrite === "frozen" ? "breaks" : u.rewrite === "review" ? "changes" : via === "analysis plan" || via === "export column" ? "informs" : "changes";
      report.add({ object, via, text: `${u.where}${u.detail ? ` (${plain(u.detail, 80)})` : ""}`, severity, path: u.path });
    }
  }

  /* ---- embedded fields and calculations: their readers, straight from the index */
  for (const name of scope.embedded ?? []) {
    const start = objectKey("embedded", name);
    for (const e of ix.usedBy(start)) {
      const d = detailAt(def, e);
      const via = viaOf(e.kind);
      report.add({ object: objectOf(ix, e.from), via, text: `${e.label}${d ? ` ${d}` : ""}`, severity: change === "delete" ? (via === "piping" ? "informs" : "breaks") : "changes", path: e.path });
    }
  }
  for (const ref of scope.calculations ?? []) {
    const c = def.calculations.find((x) => x.id === ref || x.targetVariable === ref);
    if (!c) continue;
    walkFrom(objectKey("calculation", c.id), undefined);
  }

  return finish(report.items);
}

/* ------------------------------------------------------------ impactOfAction */

/** the question an action names, in `def`: by the touched id first, then by code or variable */
function questionFor(def: SurveyDefinition, touched: string[], ref: string | undefined): Question | undefined {
  for (const id of touched) { const q = def.questions.find((x) => x.id === id); if (q) return q; }
  return ref ? getQuestionByCodeOrVar(def, ref) ?? def.questions.find((q) => String(q.code).toLowerCase() === ref.toLowerCase() || q.variableName.toLowerCase() === ref.toLowerCase()) : undefined;
}

/** Items from several reports as one: one row per (object, via), the worse severity kept. */
export function impactReport(items: ImpactItem[]): ImpactReport {
  const r = new Report();
  for (const it of items) r.add(it);
  return finish(r.items);
}

const merge = (...reports: ImpactReport[]): ImpactReport => impactReport(reports.flatMap((r) => r.items));

const EMPTY = (): ImpactReport => finish([]);

/**
 * The impact of ONE applied action, with the scope and the kind of change
 * read off the action: a deletion scopes the question (or the block's
 * questions) as `delete`; removing or replacing options scopes the codes
 * that went; recoding an option scopes the old code as `recode`; a type
 * change is `retype` against the survey AFTER it (the operators must fit the
 * new shape); a move is `move` against the survey after it (the new order is
 * what matters); renaming a variable or code scopes the OLD name. Actions
 * that only add — a new question, a block, a quota, a translation — depend
 * on nothing yet and report nothing.
 */
export function impactOfAction(before: SurveyDefinition, after: SurveyDefinition, action: SurveyAction | OptionAction, touched: string[]): ImpactReport {
  const a = action as { op: string } & Record<string, unknown>;
  try {
    switch (a.op) {
      case "delete_question": {
        const q = questionFor(before, touched, a.target as string);
        return q ? impactOf(before, { questions: [q.id] }, { change: "delete" }) : EMPTY();
      }
      case "delete_block": {
        const blocks = listBlocks(before.flow as unknown[]);
        const id = touched.find((t) => blocks.some((b) => b.id === t)) ?? blocks.find((b) => (b.title ?? "").trim().toLowerCase() === String(a.target).trim().toLowerCase())?.id;
        return id ? impactOf(before, { blocks: [id] }, { change: "delete" }) : EMPTY();
      }
      case "update_question": {
        const prev = questionFor(before, touched, a.target as string);
        if (!prev) return EMPTY();
        const next = after.questions.find((q) => q.id === prev.id);
        const parts: ImpactReport[] = [];
        if (a.type && next && (prev.type !== next.type || prev.variant !== next.variant)) parts.push(impactOf(after, { questions: [prev.id] }, { change: "retype" }));
        if ((a.removeOptions || a.options || a.scale) && next) {
          const now = new Set((next.options ?? []).map((o) => String(o.code)));
          const gone = (prev.options ?? []).map((o) => o.code).filter((c) => !now.has(String(c)));
          if (gone.length) parts.push(impactOf(before, { options: [{ questionId: prev.id, codes: gone }] }, { change: "delete" }));
        }
        if (a.variable && next && prev.variableName !== next.variableName) parts.push(impactOf(before, { variables: [prev.variableName] }, { change: "edit" }));
        if (a.code && next && String(prev.code) !== String(next.code)) parts.push(impactOf(before, { variables: [String(prev.code)] }, { change: "edit" }));
        if (a.text !== undefined || a.instruction !== undefined || a.required !== undefined || a.randomize !== undefined || a.addOptions || a.rows) parts.push(impactOf(after, { questions: [prev.id] }, { change: "edit" }));
        return merge(...parts);
      }
      case "update_option": {
        const prev = questionFor(before, touched, a.target as string);
        if (!prev) return EMPTY();
        const o = resolveOption(prev, a.option as string | number);
        if (typeof o === "string") return EMPTY();
        if (a.code !== undefined && String(a.code) !== String(o.code)) return impactOf(before, { options: [{ questionId: prev.id, codes: [o.code] }] }, { change: "recode" });
        return impactOf(before, { options: [{ questionId: prev.id, codes: [o.code] }] }, { change: "edit" });
      }
      case "move_question": {
        const q = questionFor(after, touched, a.target as string);
        return q ? impactOf(after, { questions: [q.id] }, { change: "move" }) : EMPTY();
      }
      case "set_display_logic": {
        // the target's visibility decides what its readers see; nothing stops resolving
        const q = questionFor(after, touched, a.target as string);
        return q ? impactOf(after, { questions: [q.id] }, { change: "edit" }) : EMPTY();
      }
      case "update_embedded": {
        const name = String(a.name);
        return a.newName && a.newName !== name ? impactOf(before, { embedded: [name] }, { change: "edit" }) : EMPTY();
      }
      case "remove_embedded": return impactOf(before, { embedded: [String(a.name)] }, { change: "delete" });
      default: return EMPTY();
    }
  } catch {
    // the review must render even when a half-applied action left the definition odd
    return EMPTY();
  }
}
