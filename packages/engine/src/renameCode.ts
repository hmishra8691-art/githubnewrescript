import type { SurveyDefinition } from "@rescript/schema";
import { pipeTokensIn } from "./pipingTokens.js";

/**
 * A QUESTION CODE CHANGES HAND — AND EVERYTHING THAT SPELLED IT FOLLOWS.
 *
 * The code field used to be a raw patch (`patch({ code })`). Rules that name a
 * question by id survive that, but text does not: `{{Q1.label}}` in a later
 * question, `{{expr: Q1 + 1}}`, a calculation written with the code, an
 * expression-valued rule, a named expression. Each of them resolves a NAME,
 * and after the rename the name is nothing — the lint calls it "Pipes from Q1,
 * which does not exist", and a respondent sees an empty piped value.
 *
 * `renameVariable` already does this for a variable name. This is its
 * counterpart for the code, with the one difference that matters: a code is
 * only one of the names a question answers to. `getQuestionByCodeOrVar`
 * resolves id, code OR variable name, and a calculation resolves the variable
 * name first. So when the old code is ALSO the question's variable name
 * (every question the Studio creates), nothing that spelled it stops
 * resolving, and nothing is rewritten — rewriting would only churn text that
 * works. When the two differ, every spelling of the old code is repointed.
 *
 * Pure: the input definition is never mutated.
 */
export interface RenameCodeResult {
  def: SurveyDefinition;
  /** what was rewritten, in the Studio's words: `Q5 — text (pipe {{Q1.label}})` */
  rewritten: string[];
  /** places that name the code and cannot be rewritten safely (scripts build names at runtime) — a person checks them */
  needsReview: string[];
  /** why nothing was done, when nothing was: a clash with another name, or no such question */
  problem?: string;
}

const CODE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXPRESSION_KEYS = new Set(["expression"]);
const EXPR_VALUE_KINDS = new Set(["custom_expression", "date_min", "date_max"]);
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const noop = (def: SurveyDefinition, problem?: string): RenameCodeResult => ({ def, rewritten: [], needsReview: [], ...(problem ? { problem } : {}) });

/** Every name that already means something, other than this question's own code: nothing may be renamed onto one. */
function namesTaken(def: SurveyDefinition, exceptQuestionId: string): Map<string, string> {
  const taken = new Map<string, string>();
  for (const q of def.questions ?? []) {
    if (q.id === exceptQuestionId) continue;
    if (q.code) taken.set(q.code, `the code of ${q.code}`);
    if (q.variableName) taken.set(q.variableName, `the variable name of ${q.code}`);
  }
  for (const c of def.calculations ?? []) if (c.targetVariable) taken.set(c.targetVariable, `the calculation ${c.targetVariable}`);
  for (const e of def.embeddedData ?? []) if (e.name) taken.set(e.name, `the embedded field ${e.name}`);
  return taken;
}

/**
 * Rewrite the identifiers of an expression that name the old code, skipping
 * string literals. A dotted reference (`Q1.R2`, `Q1.label`) keeps its tail; a
 * code-with-suffix (`Q1_2`, which a calculation reads as the variable
 * `<variable>_2`) keeps its suffix unless something owns that exact name.
 */
function rewriteExpression(src: string, from: string, to: string, ownsName: (n: string) => boolean): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      out += ch;
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (!/[A-Za-z_]/.test(ch) || (i > 0 && /[A-Za-z0-9_.]/.test(src[i - 1]!))) { out += ch; continue; }
    const m = /^[A-Za-z_][A-Za-z0-9_.*]*/.exec(src.slice(i));
    if (!m) { out += ch; continue; }
    const name = m[0];
    i += name.length - 1;
    const dot = name.indexOf(".");
    const head = dot < 0 ? name : name.slice(0, dot);
    const tail = dot < 0 ? "" : name.slice(dot);
    if (head === from) out += to + tail;
    else if (head.startsWith(`${from}_`) && !ownsName(head)) out += to + head.slice(from.length) + tail;
    else out += name;
  }
  return out;
}

/** Rewrite the pipe tokens of one string that read the old code, leaving everything else (row, property, modifiers) as written. */
function rewritePipes(text: string, from: string, to: string, rewriteExpr: (s: string) => string): { text: string; tokens: string[] } {
  let out = text;
  const tokens: string[] = [];
  const head = new RegExp(`^(\\s*)${escapeRe(from)}(?![A-Za-z0-9_])`);
  for (const t of pipeTokensIn(text)) {
    let body: string | null = null;
    if (t.kind === "question" && t.ref === from && head.test(t.raw)) body = t.raw.replace(head, `$1${to}`);
    else if (t.kind === "expr") {
      const r = rewriteExpr(t.raw);
      if (r !== t.raw) body = r;
    }
    if (body !== null && body !== t.raw) {
      const inner = t.text.slice(2, -2);
      const next = `{{${/^\s*/.exec(inner)![0]}${body}${/\s*$/.exec(inner)![0]}}}`; // the author's own spacing stays
      out = out.split(t.text).join(next);
      tokens.push(t.text);
    }
  }
  return { text: out, tokens };
}

/**
 * Change one question's CODE and repoint every text, expression and rule that
 * spelled the old one. Refuses (with `problem`, and the definition unchanged)
 * when the new code is not a valid name or is already another name in the
 * survey — a question, a variable, a calculation or an embedded field —
 * because a rule that names it would become ambiguous.
 *
 * Tolerates the editor having already written the new code into the question
 * (the input patches on every keystroke and commits on blur): when no question
 * holds `oldCode` but exactly one holds `newCode`, that is the one renamed.
 */
export function renameQuestionCode(def: SurveyDefinition, oldCode: string, newCode: string): RenameCodeResult {
  const from = String(oldCode ?? "").trim();
  const to = String(newCode ?? "").trim();
  if (!from || from === to) return noop(def);
  if (!CODE_RE.test(to)) return noop(def, `“${to}” is not a valid code — start with a letter or underscore, then letters, digits or underscores`);

  const holder = def.questions.find((q) => q.code === from);
  const already = !holder ? def.questions.filter((q) => q.code === to) : [];
  const target = holder ?? (already.length === 1 ? already[0] : undefined);
  if (!target) return noop(def, `there is no question coded ${from}`);

  const taken = namesTaken(def, target.id);
  const clash = taken.get(to);
  if (clash) return noop(def, `${to} is already ${clash}`);

  const next: SurveyDefinition = JSON.parse(JSON.stringify(def));
  const nq = next.questions.find((q) => q.id === target.id)!;
  nq.code = to;

  /*
   * Does the old spelling still resolve? A name keeps meaning this question
   * when it is the question's variable name — unless another question owns it
   * as a code or variable name, in which case it was never this one's alone.
   */
  const stillResolves = nq.variableName === from;
  const ownedElsewhere = taken.has(from);
  if (stillResolves || ownedElsewhere) return { def: next, rewritten: [], needsReview: [] };

  const rewritten: string[] = [];
  const review: string[] = [];
  const ownsName = (n: string) => taken.has(n) || n === nq.variableName;
  const rwExpr = (s: string) => rewriteExpression(s, from, to, ownsName);
  
  const walk = (node: any, path: string, owner: string): void => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`, owner)); return; }
    if (!isObj(node)) return;
    const words =
      typeof node.code === "string" && typeof node.variableName === "string" ? node.code
        : typeof node.label === "string" && typeof node.targetVariable === "string" ? `Calculation ${node.label || node.targetVariable}`
          : typeof node.name === "string" && node.when && node.id ? `Named expression ${node.name}`
            : owner;

    /* a structured source: { kind: "expr", ref: "Q1 + 1" } or a question named by its CODE */
    if (typeof node.kind === "string" && typeof node.ref === "string") {
      if (node.kind === "expr") {
        const r = rwExpr(node.ref);
        if (r !== node.ref) { node.ref = r; rewritten.push(`${words} — an expression in a rule`); }
      } else if (node.kind === "question" && node.ref === from) {
        node.ref = nq.id; // by id: it survives the next rename too
        rewritten.push(`${words} — a rule that read it by code`);
      }
    }
    if (node.$question === from) { node.$question = nq.id; rewritten.push(`${words} — a rule that compares against it by code`); }

    for (const key of Object.keys(node)) {
      const v = node[key];
      if (typeof v === "string") {
        if (v.includes("{{")) {
          const r = rewritePipes(v, from, to, rwExpr);
          if (r.tokens.length) { node[key] = r.text; for (const t of r.tokens) rewritten.push(`${words} — ${key} (pipe ${t})`); }
        }
        const isExpr =
          EXPRESSION_KEYS.has(key) ||
          (key === "value" && typeof node.kind === "string" && EXPR_VALUE_KINDS.has(node.kind)) ||
          (key === "value" && node.source === "expression");
        if (isExpr) {
          const r = rwExpr(node[key]);
          if (r !== node[key]) { node[key] = r; rewritten.push(`${words} — an expression`); }
        }
        continue;
      }
      /* scripts build names at runtime; a substitution would be a guess */
      if (key === "scripts" && path === "survey" && Array.isArray(v)) {
        for (const sc of v) if (typeof sc?.code === "string" && sc.code.includes(from)) review.push(`Script ${sc.name || sc.id} mentions ${from}`);
        continue;
      }
      walk(v, `${path}.${key}`, words);
    }
  };
  walk(next, "survey", "the survey");

  return { def: next, rewritten: [...new Set(rewritten)], needsReview: review };
}
