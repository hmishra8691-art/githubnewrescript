import type { FlowNode, Question, SurveyDefinition } from "@rescript/schema";
import { listBlocks } from "./blocks.js";
import { insertFlowNode, locateNode } from "./flowTree.js";
import { branchBlockChoices, moveBlockIntoBranch, nameBranch, splitBranchByQuestion, uniqueName } from "./branchLogic.js";
import { buildTernary, dynamicOutcomes, lintDynamicLogic } from "./dynamicLogic.js";

/**
 * BRANCHES AND DYNAMIC TEXT FOR INTELLIGENT MODE (2026-11-07).
 *
 * The copilot's vocabulary for the Workflow Builder improvements — each op a thin wrapper over the SAME engine
 * functions the Studio's flow card and question editor call (branchLogic.ts, dynamicLogic.ts), so a branch the
 * copilot builds is named, split and filled exactly as one built by hand, and an expression it writes passes the
 * same lint the editor shows:
 *
 *   split_branch          one path per answer of a question, named after each answer; existing blocks into paths
 *   rename_branch         the branch's name and/or its paths' labels
 *   add_block_to_branch   an EXISTING block into a path (or OTHERWISE) — whole blocks only; a question is refused
 *   set_dynamic_text      the question's text by ternary: an expression, or cases by an earlier answer
 *   set_dynamic_options   which options show (codes) and/or option labels, by ternary — codes never change
 */
export type FlowLogicAction =
  | { op: "split_branch"; question: string; codes?: (string | number)[]; title?: string; after?: string; blocks?: Record<string, string[]>; otherwise?: string[] }
  | { op: "rename_branch"; branch: string; title?: string; paths?: Record<string, string> }
  | { op: "add_block_to_branch"; branch: string; path: string; block: string }
  | { op: "set_dynamic_text"; target: string; expression?: string | null; by?: string; cases?: Record<string, string>; otherwise?: string }
  | { op: "set_dynamic_options"; target: string; expression?: string | null; by?: string; cases?: Record<string, (string | number)[]>; otherwise?: (string | number)[]; labels?: Record<string, string | null> };

export const FLOW_LOGIC_ACTION_OPS = ["split_branch", "rename_branch", "add_block_to_branch", "set_dynamic_text", "set_dynamic_options"] as const;
const OPS = new Set<string>(FLOW_LOGIC_ACTION_OPS);
export const isFlowLogicOp = (op: string): boolean => OPS.has(op);

const str = (v: unknown, max = 400): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : undefined);
const codeList = (v: unknown): (string | number)[] | undefined =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" || typeof x === "number").slice(0, 200) as (string | number)[]
    : typeof v === "string" && v.trim() ? v.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : undefined;
const record = <T>(v: unknown, val: (x: unknown) => T | undefined, max = 60): Record<string, T> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, max)) { const y = val(x); if (y !== undefined) out[k.slice(0, 120)] = y; }
  return Object.keys(out).length ? out : undefined;
};

/** The gate: the model's JSON as a typed action, a reason, or null when the op is not one of these. */
export function coerceFlowLogicAction(op: string, o: Record<string, unknown>): FlowLogicAction | string | null {
  if (!OPS.has(op)) return null;
  switch (op) {
    case "split_branch": {
      const question = str(o.question ?? o.by ?? o.target, 120);
      if (!question) return "split_branch needs the question to split by";
      const blocks = record(o.blocks ?? o.paths, (x) => (Array.isArray(x) ? x.map((b) => String(b)).slice(0, 20) : typeof x === "string" ? [x] : undefined));
      return { op, question, ...(codeList(o.codes) ? { codes: codeList(o.codes) } : {}), ...(str(o.title, 120) ? { title: str(o.title, 120) } : {}), ...(str(o.after, 120) ? { after: str(o.after, 120) } : {}), ...(blocks ? { blocks } : {}), ...(Array.isArray(o.otherwise) ? { otherwise: o.otherwise.map(String).slice(0, 20) } : {}) };
    }
    case "rename_branch": {
      const branch = str(o.branch ?? o.target, 120);
      if (!branch) return "rename_branch needs the branch (its name or id)";
      const paths = record(o.paths, (x) => str(x, 120));
      const title = str(o.title ?? o.name, 120);
      if (!title && !paths) return "rename_branch needs a title or paths ({ old label: new label })";
      return { op, branch, ...(title ? { title } : {}), ...(paths ? { paths } : {}) };
    }
    case "add_block_to_branch": {
      const branch = str(o.branch, 120), path = str(o.path ?? o.arm ?? o.when, 120), block = str(o.block ?? o.target, 120);
      if (!branch || !path || !block) return "add_block_to_branch needs branch, path (its label, number or \"otherwise\") and block";
      return { op, branch, path, block };
    }
    case "set_dynamic_text": {
      const target = str(o.target ?? o.question, 120);
      if (!target) return "set_dynamic_text needs the target question";
      if (o.expression === null || o.remove === true) return { op, target, expression: null };
      const expression = str(o.expression, 4000);
      const cases = record(o.cases, (x) => str(x, 600));
      const by = str(o.by ?? o.source, 120);
      if (!expression && !(by && cases)) return "set_dynamic_text needs an expression, or by + cases ({ answer: text })";
      return { op, target, ...(expression ? { expression } : {}), ...(by ? { by } : {}), ...(cases ? { cases } : {}), ...(str(o.otherwise ?? o.fallback, 600) ? { otherwise: str(o.otherwise ?? o.fallback, 600) } : {}) };
    }
    case "set_dynamic_options": {
      const target = str(o.target ?? o.question, 120);
      if (!target) return "set_dynamic_options needs the target question";
      if (o.expression === null || o.remove === true) return { op, target, expression: null };
      const expression = str(o.expression, 4000);
      const cases = record(o.cases, (x) => codeList(x));
      const by = str(o.by ?? o.source, 120);
      const labels = record(o.labels, (x) => (x === null ? null : str(x, 2000)));
      if (!expression && !(by && cases) && !labels) return "set_dynamic_options needs an expression, by + cases ({ answer: [codes] }), or labels ({ code: expression })";
      return { op, target, ...(expression ? { expression } : {}), ...(by ? { by } : {}), ...(cases ? { cases } : {}), ...(codeList(o.otherwise) ? { otherwise: codeList(o.otherwise) } : {}), ...(labels ? { labels } : {}) };
    }
  }
  return null;
}

export interface FlowLogicEnv {
  question(ref: string): Question | undefined;
  /** a block's id from its title / id / "Block 3" */
  block(ref: string): string | undefined;
  ids(prefix: string): string;
}
export interface FlowLogicApplied { description: string; warnings: string[]; touched: string[] }

class ActionError extends Error {}
const fail = (m: string): never => { throw new ActionError(m); };
type BranchNode = Extract<FlowNode, { type: "branch" }>;

function branches(flow: FlowNode[]): BranchNode[] {
  const out: BranchNode[] = [];
  const walk = (ns: FlowNode[]) => { for (const n of ns ?? []) { if (n.type === "branch") { out.push(n); n.branches.forEach((b) => walk(b.children)); walk(n.otherwise ?? []); } else if ((n as { children?: FlowNode[] }).children) walk((n as { children: FlowNode[] }).children); } };
  walk(flow);
  return out;
}
function findBranch(def: SurveyDefinition, ref: string): BranchNode {
  const all = branches(def.flow as FlowNode[]);
  const r = ref.trim().toLowerCase();
  return all.find((b) => b.id.toLowerCase() === r) ?? all.find((b) => (b.title ?? "").trim().toLowerCase() === r)
    ?? (all.length === 1 && /^(the )?branch$/.test(r) ? all[0] : undefined)
    ?? fail(all.length ? `no branch “${ref}” — the branches are ${all.map((b) => `“${b.title ?? b.id}”`).join(", ")}` : "the survey has no branch yet — split_branch or create_branch first");
}
function pathSlot(b: BranchNode, ref: string): string {
  const r = ref.trim().toLowerCase();
  if (r === "otherwise" || r === "else") return "otherwise";
  const n = /^(?:path\s*)?(\d+)$/.exec(r);
  if (n && b.branches[Number(n[1]) - 1]) return `branch:${b.branches[Number(n[1]) - 1].id}`;
  const p = b.branches.find((x) => (x.label ?? "").trim().toLowerCase() === r) ?? b.branches.find((x) => (x.label ?? "").toLowerCase().includes(r));
  return p ? `branch:${p.id}` : fail(`branch “${b.title ?? b.id}” has no path “${ref}” — its paths are ${b.branches.map((x, i) => `${i + 1}. “${x.label ?? "?"}”`).join(", ")} and OTHERWISE`);
}
/** an answer named by code or label → the option's label (what the ternary compares) */
function answerKey(src: Question, key: string): string {
  const k = key.trim();
  const o = (src.options ?? []).find((x) => String(x.code) === k) ?? (src.options ?? []).find((x) => x.label.replace(/<[^>]*>/g, "").trim().toLowerCase() === k.toLowerCase());
  return o ? o.label.replace(/<[^>]*>/g, "").trim() || String(o.code) : fail(`${src.code} has no answer “${key}” — its options are ${(src.options ?? []).map((x) => `${x.code} ${x.label.replace(/<[^>]*>/g, "")}`).join(", ")}`);
}

function refuseOnLint(def: SurveyDefinition, q: Question, field: "text" | "options" | "label"): string[] {
  const ps = lintDynamicLogic(def, q).filter((p) => p.field === field);
  const errs = ps.filter((p) => p.severity === "error");
  if (errs.length) fail(`the expression for ${q.code} is not valid: ${errs.map((p) => p.message).join("; ")}`);
  return ps.map((p) => `${q.code}: ${p.message}`);
}

export function applyFlowLogicAction(def: SurveyDefinition, a: FlowLogicAction, env: FlowLogicEnv): FlowLogicApplied {
  switch (a.op) {
    case "split_branch": {
      const q = env.question(a.question) ?? fail(`there is no question “${a.question}”`);
      const made = splitBranchByQuestion(def, q, env.ids, { ...(a.codes ? { codes: a.codes } : {}), ...(a.title ? { title: a.title } : {}) });
      if (typeof made === "string") fail(made);
      const node = made as BranchNode;
      /* where: after the block named, else after the top-level element holding the question */
      const flow = def.flow as FlowNode[];
      let afterId: string | undefined = a.after ? env.block(a.after) ?? fail(`there is no block “${a.after}”`) : undefined;
      if (!afterId) {
        const holder = listBlocks(flow as unknown[]).find((b) => b.pages.some((p) => p.node.questionIds.includes(q.id)));
        if (holder) { let loc = locateNode(flow, holder.id); while (loc && loc.container.ownerId) loc = locateNode(flow, loc.container.ownerId); afterId = loc?.node.id; }
      }
      const ins = insertFlowNode(flow, node, afterId ? { kind: "after", refId: afterId } : { kind: "inside", ownerId: null, slot: "children" });
      if (!ins.moved) fail(ins.reason ?? "the branch could not be placed");
      def.flow = ins.flow as never;
      const touched: string[] = [q.id];
      const warnings: string[] = [];
      /* existing blocks into paths: { "<answer code or label>": [blocks] }, and OTHERWISE */
      const placeIn = (blockRef: string, slot: string, where: string) => {
        const id = env.block(blockRef) ?? fail(`there is no block “${blockRef}”`);
        const r = moveBlockIntoBranch(def, id, node.id, slot);
        if (!r.moved) fail(`${blockRef} cannot go into ${where}: ${r.reason}`);
        def.flow = r.flow as never;
        touched.push(id);
      };
      for (const [ans, blocks] of Object.entries(a.blocks ?? {})) {
        const label = answerKey(q, ans);
        const path = node.branches.find((p) => p.label === `${q.code} = ${label.slice(0, 48)}`) ?? node.branches.find((p) => (p.label ?? "").endsWith(`= ${label.slice(0, 48)}`));
        if (!path) fail(`no path for ${q.code} = ${label}`);
        for (const b of blocks) placeIn(b, `branch:${path!.id}`, `the path “${path!.label}”`);
      }
      for (const b of a.otherwise ?? []) placeIn(b, "otherwise", "OTHERWISE");
      const placed = (def.flow as FlowNode[]);
      const fresh = branches(placed).find((b) => b.id === node.id)!;
      const empty = fresh.branches.filter((p) => !p.children.length).length;
      if (empty) warnings.push(`${empty} path${empty === 1 ? " has" : "s have"} no blocks yet — add_block_to_branch, or a new block, to give ${empty === 1 ? "it" : "them"} content`);
      return { description: `Branch “${fresh.title}” by ${q.code}: ${fresh.branches.map((p) => `“${p.label}”${p.children.length ? ` → ${p.children.map((c) => (c as { title?: string }).title ?? c.id).join(", ")}` : ""}`).join("; ")}${fresh.otherwise?.length ? `; otherwise → ${fresh.otherwise.map((c) => (c as { title?: string }).title ?? c.id).join(", ")}` : ""}`, warnings, touched };
    }
    case "rename_branch": {
      const b = findBranch(def, a.branch);
      const others = branches(def.flow as FlowNode[]).filter((x) => x.id !== b.id).map((x) => x.title ?? "");
      const before = b.title;
      if (a.title) b.title = uniqueName(a.title, others);
      const changed: string[] = [];
      for (const [from, to] of Object.entries(a.paths ?? {})) {
        const slot = pathSlot(b, from);
        if (slot === "otherwise") fail("OTHERWISE has no label to rename");
        const p = b.branches.find((x) => `branch:${x.id}` === slot)!;
        const old = p.label;
        p.label = uniqueName(to, b.branches.filter((x) => x !== p).map((x) => x.label ?? ""));
        changed.push(`“${old ?? "?"}” → “${p.label}”`);
      }
      return { description: `Branch ${before !== b.title ? `“${before ?? b.id}” renamed “${b.title}”` : `“${b.title}”`}${changed.length ? `; paths ${changed.join(", ")}` : ""}`, warnings: [], touched: [] };
    }
    case "add_block_to_branch": {
      const b = findBranch(def, a.branch);
      const slot = pathSlot(b, a.path);
      const q = env.question(a.block);
      const blockId = env.block(a.block);
      if (!blockId && q) fail(`${q.code} is a question — a branch path takes whole blocks; name the block it belongs to${(() => { const h = listBlocks(def.flow as unknown[]).find((x) => x.pages.some((p) => p.node.questionIds.includes(q.id))); return h ? ` (“${h.title ?? h.id}”)` : ""; })()}`);
      const id = blockId ?? fail(`there is no block “${a.block}”`);
      const r = moveBlockIntoBranch(def, id, b.id, slot);
      if (!r.moved) {
        const c = branchBlockChoices(def, b.id, slot).blocks.find((x) => x.id === id);
        fail(`${c?.title ?? a.block} cannot go into that path: ${r.reason}`);
      }
      def.flow = r.flow as never;
      const p = slot === "otherwise" ? "OTHERWISE" : `“${b.branches.find((x) => `branch:${x.id}` === slot)?.label}”`;
      const title = listBlocks(def.flow as unknown[]).find((x) => x.id === id)?.title ?? id;
      return { description: `Block “${title}” moved into ${p} of branch “${b.title ?? b.id}” (whole block, with its questions and logic)`, warnings: [], touched: [id] };
    }
    case "set_dynamic_text": {
      const q = env.question(a.target) ?? fail(`there is no question “${a.target}”`);
      if (a.expression === null) {
        if (!q.dynamicText) fail(`${q.code} has no dynamic text`);
        delete (q as { dynamicText?: unknown }).dynamicText;
        return { description: `${q.code} shows its own text again (dynamic text removed)`, warnings: [], touched: [q.id] };
      }
      let expression = a.expression;
      if (!expression) {
        const src = env.question(a.by!) ?? fail(`there is no question “${a.by}”`);
        expression = buildTernary(src.variableName || String(src.code), Object.entries(a.cases ?? {}).map(([k, v]) => ({ equals: answerKey(src, k), result: v })), a.otherwise ?? q.text.replace(/<[^>]*>/g, "").trim());
      }
      const prev = q.dynamicText;
      q.dynamicText = { expression };
      try { const warnings = refuseOnLint(def, q, "text"); return { description: `${q.code}'s text follows the answers: ${outcomeWords(def, q, "text")}`, warnings, touched: [q.id] }; }
      catch (e) { if (prev) q.dynamicText = prev; else delete (q as { dynamicText?: unknown }).dynamicText; throw e; }
    }
    case "set_dynamic_options": {
      const q = env.question(a.target) ?? fail(`there is no question “${a.target}”`);
      if (!(q.options ?? []).length) fail(`${q.code} has no options`);
      if (a.expression === null) {
        delete (q as { dynamicOptions?: unknown }).dynamicOptions;
        for (const o of q.options) delete (o as { labelExpression?: unknown }).labelExpression;
        return { description: `${q.code} shows all its options with their own labels again`, warnings: [], touched: [q.id] };
      }
      const snapshot = JSON.parse(JSON.stringify({ d: q.dynamicOptions ?? null, l: q.options.map((o) => o.labelExpression ?? null) }));
      const known = new Set(q.options.map((o) => String(o.code)));
      const check = (codes: (string | number)[]) => { const bad = codes.map(String).filter((c) => !known.has(c)); if (bad.length) fail(`${q.code} has no option ${bad.join(", ")} (codes: ${[...known].join(", ")})`); return codes.map(String).join(","); };
      try {
        if (a.expression) q.dynamicOptions = { expression: a.expression };
        else if (a.by && a.cases) {
          const src = env.question(a.by) ?? fail(`there is no question “${a.by}”`);
          q.dynamicOptions = { expression: buildTernary(src.variableName || String(src.code), Object.entries(a.cases).map(([k, v]) => ({ equals: answerKey(src, k), result: check(v) })), a.otherwise ? check(a.otherwise) : [...known].join(",")) };
        }
        for (const [code, expr] of Object.entries(a.labels ?? {})) {
          const o = q.options.find((x) => String(x.code) === code) ?? fail(`${q.code} has no option ${code}`);
          if (expr === null) delete (o as { labelExpression?: unknown }).labelExpression; else o.labelExpression = expr;
        }
        const warnings = [...refuseOnLint(def, q, "options"), ...refuseOnLint(def, q, "label")];
        return { description: `${q.code}'s options follow the answers (codes unchanged): ${outcomeWords(def, q, "options")}`, warnings, touched: [q.id] };
      } catch (e) {
        if (snapshot.d) q.dynamicOptions = snapshot.d; else delete (q as { dynamicOptions?: unknown }).dynamicOptions;
        q.options.forEach((o, i) => { if (snapshot.l[i]) o.labelExpression = snapshot.l[i]; else delete (o as { labelExpression?: unknown }).labelExpression; });
        throw e;
      }
    }
  }
}

function outcomeWords(def: SurveyDefinition, q: Question, what: "text" | "options"): string {
  const o = dynamicOutcomes(def, q).outcomes.slice(0, 6);
  return o.map((x) => `${x.when} → ${what === "text" ? `“${(x.text ?? "").replace(/<[^>]*>/g, "").slice(0, 60)}”` : (x.optionLabels ?? []).map((l) => l.replace(/<[^>]*>/g, "")).join(", ")}`).join("; ");
}

export function describeFlowLogicAction(a: FlowLogicAction): string {
  switch (a.op) {
    case "split_branch": return `Branch by ${a.question}${a.blocks ? ` (${Object.keys(a.blocks).length} paths with blocks)` : ""}`;
    case "rename_branch": return `Rename branch ${a.branch}${a.title ? ` to “${a.title}”` : ""}`;
    case "add_block_to_branch": return `Move block ${a.block} into ${a.path} of ${a.branch}`;
    case "set_dynamic_text": return a.expression === null ? `Remove ${a.target}'s dynamic text` : `Dynamic text on ${a.target}${a.by ? ` by ${a.by}` : ""}`;
    case "set_dynamic_options": return a.expression === null ? `Remove ${a.target}'s dynamic options` : `Dynamic options on ${a.target}${a.by ? ` by ${a.by}` : ""}`;
  }
}

/** auto-name a branch the copilot's create_branch built (titles unique, labels from conditions where none was given) */
export function nameCreatedBranch(def: SurveyDefinition, node: FlowNode): void {
  if (node.type === "branch") nameBranch(def, node);
}
