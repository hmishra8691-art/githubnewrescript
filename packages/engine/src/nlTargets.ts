import type { FlowNode, Option, Question, SurveyDefinition } from "@rescript/schema";
import { getQuestionByCodeOrVar } from "./state.js";
import { closestName } from "./logicExpression.js";
import { listPages } from "./blocks.js";
import { resolveOption } from "./optionActions.js";
import { normalizeOptionText } from "./optionCodes.js";
import { stripHtmlText } from "./html.js";

/**
 * WHAT A SENTENCE NAMES — resolved against the real survey, deterministically.
 *
 * "Make the age question required", "skip Q8 through Q12", "randomize these
 * options but keep None of these last": before anything can be done, each of
 * those names has to become ONE object of this survey, or an honest answer
 * about why it cannot — "there is no Q99 — did you mean Q9?", "two questions
 * mention age: Q1 and Q9". Guessing is never one of the outcomes. A name that
 * fits several objects comes back with all of them as candidates (the
 * interpreter turns that into a clarifying question); a name that fits none
 * comes back with the nearest real names (a did-you-mean).
 *
 * The order of trust is the programmer's: a code or variable name (exact,
 * then case-insensitive) is a name, "this question" is the selection, and a
 * description ("the income question", "the question about cars") is a search
 * of the question texts that must come back with exactly one match to count.
 *
 * Nothing here writes anything; the interpreter (`nlIntent.ts`) and the
 * Studio's grammar both read it.
 */

export interface QuestionCandidate { id: string; code: string; text: string }

export type QuestionRefResult =
  | { ok: true; question: Question; via: "code" | "variable" | "id" | "selection" | "number" | "text" }
  /** `ambiguous`: several questions fit (ask which); otherwise none did and `candidates` are the did-you-means */
  | { ok: false; reason: string; candidates: QuestionCandidate[]; ambiguous: boolean };

export interface TargetContext {
  /** the selected question — what "this question", "it", "these options" mean */
  selectedId?: string | null;
  /** a multi-selection — what "these questions" means (falls back to `selectedId`) */
  selectedIds?: string[] | null;
  /** what "the next five questions" counts from — usually the question the sentence's condition reads */
  anchorId?: string | null;
}

const plain = (s: string | undefined, n = 80): string => { const t = stripHtmlText(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const candidate = (q: Question): QuestionCandidate => ({ id: q.id, code: String(q.code), text: plain(q.text) });
const codeOf = (q: Question) => String(q.code);

/** words that carry no meaning when a question is described: "the question about", "the one asking" */
const STOP = new Set(["the", "a", "an", "question", "questions", "about", "on", "regarding", "re", "concerning", "asking", "asks", "ask", "that", "which", "one", "ones", "of", "for", "to", "is", "are", "with", "in", "and", "or", "item", "where", "we", "you", "your", "do", "does", "what", "how", "this", "it", "q"]);

/** a light stem: enough that "cars" finds "car" and "buying" finds "buy", not a linguist's stemmer */
export const stemWord = (w: string): string => {
  const x = w.toLowerCase();
  if (x.length > 5 && x.endsWith("ies")) return `${x.slice(0, -3)}y`;
  if (x.length > 5 && x.endsWith("ing")) return x.slice(0, -3);
  if (x.length > 4 && x.endsWith("ed")) return x.slice(0, -2);
  if (x.length > 4 && x.endsWith("es") && !x.endsWith("ses")) return x.slice(0, -2);
  if (x.length > 3 && x.endsWith("s") && !x.endsWith("ss")) return x.slice(0, -1);
  return x;
};
/** the stemmed content words of a text: letters and digits, variable names split at underscores */
export const contentWords = (s: string): string[] =>
  stripHtmlText(s ?? "").toLowerCase().replace(/[_]+/g, " ").split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w)).map(stemWord);

/** "this", "it", "the selected question" — the selection, not a name */
const SELECTION = /^(?:this|that|it|the\s+selected|the\s+current|current|selected|the\s+same|the\s+highlighted)(?:\s+(?:question|one|item))?$/i;
/** a token shaped like a question code: Q7, S1, QA3B — a typo of one gets a did-you-mean, not a text search */
const CODE_SHAPE = /^[A-Za-z]{1,4}\d+[A-Za-z0-9_]*$/;

/**
 * A question from what a sentence calls it: a code ("Q7", "q7", "question 7",
 * "#7"), a variable ("AGE"), the selection ("this question", "it"), or a
 * description — quoted text or a few words of its wording ("the age
 * question", "the question about income"), which must match exactly one
 * question to count.
 */
export function resolveQuestionRef(def: SurveyDefinition, text: string, ctx: TargetContext = {}): QuestionRefResult {
  const raw = String(text ?? "").trim().replace(/[.?!,;:]+$/, "").trim();
  const quoted = /^["“'‘](.+)["”'’]$/.exec(raw)?.[1];
  let t = (quoted ?? raw).replace(/['’]s$/i, "").trim();
  if (!t) return { ok: false, reason: "Name a question — its code (Q7), its variable (AGE), or “this question” with one selected.", candidates: [], ambiguous: false };

  if (!quoted && SELECTION.test(t)) {
    const sel = ctx.selectedId ? def.questions.find((q) => q.id === ctx.selectedId) : undefined;
    return sel ? { ok: true, question: sel, via: "selection" } : { ok: false, reason: `“${t}” means the selected question, and nothing is selected — select it, or name it by its code (Q7).`, candidates: [], ambiguous: false };
  }
  if (!quoted) {
    const exact = getQuestionByCodeOrVar(def, t);
    if (exact) return { ok: true, question: exact, via: exact.id === t ? "id" : codeOf(exact) === t ? "code" : "variable" };
    const lower = t.toLowerCase();
    const loose = def.questions.find((q) => codeOf(q).toLowerCase() === lower) ?? def.questions.find((q) => q.variableName.toLowerCase() === lower);
    if (loose) return { ok: true, question: loose, via: codeOf(loose).toLowerCase() === lower ? "code" : "variable" };
    // "question 7", "the question 7", "q 7", "#7": the code Q7, else a question coded 7
    const n = /^(?:the\s+)?(?:question|q|#)\s*#?\s*(\d+[A-Za-z]?)$/i.exec(t);
    if (n) {
      const byCode = def.questions.find((q) => codeOf(q).toLowerCase() === `q${n[1]}`.toLowerCase()) ?? def.questions.find((q) => codeOf(q).toLowerCase() === n[1].toLowerCase());
      if (byCode) return { ok: true, question: byCode, via: "number" };
      t = `Q${n[1]}`;
    }
  }

  const names = def.questions.flatMap((q) => [codeOf(q), q.variableName]);
  const byName = (word: string): Question[] => {
    const near = closestName(word, names);
    const q = near ? getQuestionByCodeOrVar(def, near) : undefined;
    return q ? [q] : [];
  };
  const missing = (cands: Question[], what = t): QuestionRefResult => ({
    ok: false,
    reason: `There is no ${CODE_SHAPE.test(what) || /^[A-Z_][A-Z0-9_]*$/.test(what) ? what : `question “${what}”`} in this survey${cands.length === 1 ? ` — did you mean ${codeOf(cands[0])}?` : cands.length ? ` — did you mean ${cands.slice(0, 5).map(codeOf).join(", ")}?` : "."}`,
    candidates: cands.slice(0, 8).map(candidate),
    ambiguous: false,
  });
  if (!quoted && CODE_SHAPE.test(t)) return missing(byName(t));

  /*
   * A DESCRIPTION. Quoted, it is a piece of the question's wording; bare,
   * its content words must ALL appear in a question's text or variable name
   * ("the age question" → age). One match is the question; several are a
   * clarification; none is a did-you-mean over the questions sharing any
   * word, and over the names (a variable typed with a typo).
   */
  if (quoted) {
    const want = normalizeOptionText(quoted);
    const hits = def.questions.filter((q) => normalizeOptionText(q.text).includes(want));
    if (hits.length === 1) return { ok: true, question: hits[0], via: "text" };
    if (hits.length > 1) return { ok: false, reason: `${hits.length} questions contain “${quoted}”: ${hits.slice(0, 6).map(codeOf).join(", ")} — which one?`, candidates: hits.slice(0, 8).map(candidate), ambiguous: true };
  }
  const words = [...new Set(contentWords(quoted ?? t))];
  if (!words.length) return missing([]);
  const scored = def.questions.map((q) => {
    const have = new Set([...contentWords(q.text), ...contentWords(q.variableName)]);
    return { q, score: words.filter((w) => have.has(w)).length };
  });
  const all = scored.filter((s) => s.score === words.length).map((s) => s.q);
  if (all.length === 1) return { ok: true, question: all[0], via: "text" };
  if (all.length > 1) return { ok: false, reason: `${all.length} questions match “${t}”: ${all.slice(0, 6).map((q) => `${codeOf(q)} (${plain(q.text, 40)})`).join(", ")} — which one do you mean?`, candidates: all.slice(0, 8).map(candidate), ambiguous: true };
  const some = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).map((s) => s.q);
  return missing(some.length ? some : words.length === 1 ? byName(t) : []);
}

/* ------------------------------------------------------------ ranges */

export type QuestionRangeResult =
  | { ok: true; questions: Question[] }
  /** `ref`: the part of the text that did not resolve, when one part failed — so a caller can substitute a did-you-mean into the sentence */
  | { ok: false; reason: string; candidates: QuestionCandidate[]; ambiguous: boolean; ref?: string };

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, a: 1, an: 1 };
/** "5", "five", "a" → 5, 5, 1 */
export const countWord = (w: string | undefined): number | null => {
  if (w === undefined) return null;
  const x = w.trim().toLowerCase();
  if (/^\d+$/.test(x)) return Number(x);
  return NUMBER_WORDS[x] ?? null;
};

/** the placed questions in flow order — a question on no page is not "next" to anything */
export function placedOrder(def: SurveyDefinition): string[] {
  return listPages(def.flow as unknown[]).flatMap((p) => p.node.questionIds).filter((id, i, xs) => xs.indexOf(id) === i && def.questions.some((q) => q.id === id));
}

/**
 * The branch arms a question sits in, outermost first: `branchId#armIndex`
 * (or `branchId#otherwise`). Two questions in different arms of the same
 * branch are never asked to the same respondent one after the other, so a
 * range from one to the other means nothing.
 */
function armsOf(def: SurveyDefinition): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (nodes: FlowNode[], path: string[]): void => {
    for (const n of nodes ?? []) {
      const k = n as { type: string; id: string; questionIds?: string[]; children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
      if (k.type === "page") for (const id of k.questionIds ?? []) out.set(id, path);
      if (k.type === "branch") {
        (k.branches ?? []).forEach((b, i) => walk(b.children, [...path, `${k.id}#${i}`]));
        if (k.otherwise) walk(k.otherwise, [...path, `${k.id}#otherwise`]);
      } else if (k.children) walk(k.children, path);
    }
  };
  walk(def.flow as FlowNode[], []);
  return out;
}

const fail = (reason: string, extra: Partial<Extract<QuestionRangeResult, { ok: false }>> = {}): QuestionRangeResult => ({ ok: false, reason, candidates: [], ambiguous: false, ...extra });

/** a single reference inside a range, failing with that part named */
function one(def: SurveyDefinition, text: string, ctx: TargetContext): Question | QuestionRangeResult {
  const r = resolveQuestionRef(def, text, ctx);
  return r.ok ? r.question : { ok: false, reason: r.reason, candidates: r.candidates, ambiguous: r.ambiguous, ref: text.trim() };
}

/**
 * Several questions from one phrase, in flow order: "Q8 through Q12" (thru,
 * to, until, –, -), "Q8, Q9 and Q10", "the next five questions" (counted
 * from `ctx.anchorId`), "the previous two questions", "these questions" (the
 * selection), or one question. A range must run forward ("Q12 to Q8" is
 * refused with the order it should be) and stay inside one flow — not from
 * one arm of a branch into another.
 */
export function resolveQuestionRange(def: SurveyDefinition, text: string, ctx: TargetContext = {}): QuestionRangeResult {
  const t = String(text ?? "").trim().replace(/[.?!,;:]+$/, "").replace(/\s+/g, " ").trim();
  const order = placedOrder(def);
  const byId = (id: string) => def.questions.find((q) => q.id === id)!;
  const inOrder = (qs: Question[]) => [...new Set(qs)].sort((a, b) => (order.indexOf(a.id) < 0 ? 1e9 : order.indexOf(a.id)) - (order.indexOf(b.id) < 0 ? 1e9 : order.indexOf(b.id)));

  // the selection
  if (/^(?:these|those|the\s+selected|selected|the\s+highlighted)(?:\s+(?:questions?|ones?|items?))?$/i.test(t)) {
    const ids = ctx.selectedIds?.length ? ctx.selectedIds : ctx.selectedId ? [ctx.selectedId] : [];
    const qs = ids.map((id) => def.questions.find((q) => q.id === id)).filter((q): q is Question => !!q);
    return qs.length ? { ok: true, questions: inOrder(qs) } : fail(`“${t}” means the selected questions, and nothing is selected — select them, or name them (Q8 through Q12).`);
  }

  // relative: the next / previous N questions
  const rel = /^(?:the\s+)?(next|following|previous|preceding|last)\s+(?:(\w+)\s+)?questions?(?:\s+(?:after|before)\s+(.+))?$/i.exec(t);
  if (rel && (rel[2] === undefined || countWord(rel[2]) !== null)) {
    const n = rel[2] === undefined ? 1 : countWord(rel[2])!;
    let anchor: Question | undefined;
    if (rel[3]) { const a = one(def, rel[3], ctx); if (!("id" in a)) return a; anchor = a; }
    else anchor = ctx.anchorId ? def.questions.find((q) => q.id === ctx.anchorId) : ctx.selectedId ? def.questions.find((q) => q.id === ctx.selectedId) : undefined;
    if (!anchor) return fail(`“${t}” counts from a question, and none is named — say “the next ${n} questions after Q7”.`);
    const at = order.indexOf(anchor.id);
    if (at < 0) return fail(`${codeOf(anchor)} is not on any page, so no question comes ${/next|following/i.test(rel[1]) ? "after" : "before"} it.`);
    const forward = /next|following/i.test(rel[1]);
    const ids = forward ? order.slice(at + 1, at + 1 + n) : order.slice(Math.max(0, at - n), at);
    if (!ids.length) return fail(`${codeOf(anchor)} is the ${forward ? "last" : "first"} question — there is no question ${forward ? "after" : "before"} it.`);
    if (ids.length < n) return fail(`Only ${ids.length} question${ids.length === 1 ? "" : "s"} come${ids.length === 1 ? "s" : ""} ${forward ? "after" : "before"} ${codeOf(anchor)} (${ids.map((id) => codeOf(byId(id))).join(", ")}), not ${n}.`);
    return { ok: true, questions: ids.map(byId) };
  }

  // a span: "Q8 through Q12", "Q8 to Q12", "Q8-Q12", "Q8–Q12"
  const span = /^(?:from\s+)?(.+?)\s+(?:through|thru|to|until|till|up\s+to)\s+(.+)$/i.exec(t) ?? /^(.+?)\s*(?:–|—|-|\.\.)\s*(.+)$/.exec(t);
  if (span) {
    const a = one(def, span[1], ctx), b = one(def, span[2], ctx);
    if ("id" in a && "id" in b) {
      const i = order.indexOf(a.id), j = order.indexOf(b.id);
      if (i < 0 || j < 0) return fail(`${codeOf(i < 0 ? a : b)} is not on any page of the survey, so a range cannot reach it.`);
      if (i > j) return fail(`${codeOf(a)} comes after ${codeOf(b)} in the flow — a range runs forward: say “${codeOf(b)} through ${codeOf(a)}”.`);
      const arms = armsOf(def);
      const pa = arms.get(a.id) ?? [], pb = arms.get(b.id) ?? [];
      const split = pa.find((x) => { const branch = x.split("#")[0]; const other = pb.find((y) => y.split("#")[0] === branch); return other !== undefined && other !== x; });
      if (split) {
        const branch = split.split("#")[0];
        const title = (findBranch(def.flow as FlowNode[], branch) as { title?: string } | null)?.title;
        return fail(`${codeOf(a)} and ${codeOf(b)} are in different arms of the branch${title ? ` “${title}”` : ""}, so no respondent is asked both in one run — name a range inside one arm.`);
      }
      return { ok: true, questions: order.slice(i, j + 1).map(byId) };
    }
    /*
     * One end resolved and the other did not: that end is the problem, and
     * is named — unless the whole phrase is one description that happens to
     * contain "to" ("the question about going to work") or a name with a
     * dash in it ("S1-A"), which is tried first.
     */
    const whole = resolveQuestionRef(def, t, ctx);
    if (whole.ok) return { ok: true, questions: [whole.question] };
    if ("id" in a || "id" in b) return ("id" in a ? b : a) as QuestionRangeResult;
  }

  // a list: "Q8, Q9 and Q10"
  const parts = t.split(/\s*,\s*(?:and\s+)?|\s+(?:and|&|plus)\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const qs: Question[] = [];
    for (const p of parts) { const q = one(def, p, ctx); if (!("id" in q)) return q; qs.push(q); }
    return { ok: true, questions: inOrder(qs) };
  }
  const q = one(def, t, ctx);
  return "id" in q ? { ok: true, questions: [q] } : q;
}

function findBranch(nodes: FlowNode[], id: string): FlowNode | null {
  for (const n of nodes ?? []) {
    if (n.id === id) return n;
    const k = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
    for (const list of [k.children, ...(k.branches ?? []).map((b) => b.children), k.otherwise]) if (list) { const f = findBranch(list, id); if (f) return f; }
  }
  return null;
}

/**
 * The question right after the last of `questions` in flow order — where a
 * skip over them lands — or "end" when the last of them is the last question
 * the survey asks.
 */
export function firstQuestionAfter(def: SurveyDefinition, questions: Question[]): Question | "end" {
  const order = placedOrder(def);
  const last = Math.max(-1, ...questions.map((q) => order.indexOf(q.id)));
  const next = last >= 0 ? order[last + 1] : undefined;
  return next ? def.questions.find((q) => q.id === next)! : "end";
}

/* ------------------------------------------------------------ options */

export type OptionRefResult =
  | { ok: true; option: Option; position: number }
  | { ok: false; reason: string; candidates: { code: string | number; label: string }[]; ambiguous: boolean };

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };

/**
 * An option of `q` from what a sentence calls it: "option 3" (code 3, else
 * the third), "the third option", "the last option", "Canada", "\"None of
 * these\"", "None" (a prefix or part of exactly one label), "the Other
 * option" (the one with a specify box), or "this option" (`selected`). The
 * resolution itself is `resolveOption` — the same one every option action
 * uses — so a name that resolves here resolves when the action is applied.
 */
export function resolveOptionRef(q: Question, text: string, opts: { selected?: string | number | null } = {}): OptionRefResult {
  const options = (q.options ?? []) as Option[];
  const all = () => options.slice(0, 12).map((o) => ({ code: o.code, label: plain(o.label, 60) }));
  const done = (o: Option): OptionRefResult => ({ ok: true, option: o, position: options.indexOf(o) + 1 });
  if (!options.length) return { ok: false, reason: `${codeOf(q)} has no options.`, candidates: [], ambiguous: false };
  let t = String(text ?? "").trim().replace(/[.?!,;:]+$/, "").trim();
  const quoted = /^["“'‘](.+)["”'’]$/.exec(t)?.[1];
  if (quoted) t = quoted;
  else t = t.replace(/^the\s+/i, "").replace(/\s+(?:option|answer|choice|code)$/i, "").replace(/^(?:option|answer|choice)\s+(?=\D)/i, "").trim();

  if (!quoted && /^(?:this|that|it|the\s+selected|selected)(?:\s+(?:option|one|answer))?$/i.test(t)) {
    if (opts.selected === undefined || opts.selected === null) return { ok: false, reason: `“${t}” means the selected option, and none is selected — name it (“option 3”, “Canada”).`, candidates: all(), ambiguous: false };
    t = String(opts.selected);
  }
  if (!quoted) {
    const ord = /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|last|(\d+)(?:st|nd|rd|th))(?:\s+(?:option|answer|choice|one))?$/i.exec(t);
    if (ord) {
      const n = ord[1].toLowerCase() === "last" ? options.length : ord[2] ? Number(ord[2]) : ORDINALS[ord[1].toLowerCase()];
      return options[n - 1] ? done(options[n - 1]) : { ok: false, reason: `${codeOf(q)} has ${options.length} option${options.length === 1 ? "" : "s"}, so there is no ${ord[1].toLowerCase()} one.`, candidates: all(), ambiguous: false };
    }
    // "Other": the option with a specify box, when the label alone does not settle it
    if (/^other$/i.test(t)) {
      const others = options.filter((o) => o.flags?.includes("other_specify"));
      if (others.length === 1) return done(others[0]);
    }
  }
  const r = resolveOption(q, t);
  if (typeof r !== "string") return done(r);
  const bare = normalizeOptionText(t);
  const loose = bare ? options.filter((o) => normalizeOptionText(o.label).includes(bare) || normalizeOptionText(o.label).startsWith(bare)) : [];
  if (loose.length > 1) return { ok: false, reason: `${loose.length} options of ${codeOf(q)} match “${t}”: ${loose.map((o) => `“${plain(o.label, 40)}”`).join(", ")} — which one?`, candidates: loose.map((o) => ({ code: o.code, label: plain(o.label, 60) })), ambiguous: true };
  const near = closestName(t, options.map((o) => plain(o.label, 80)));
  return { ok: false, reason: `${codeOf(q)} has no option “${t}”${near ? ` — did you mean “${near}”?` : ` — its options are ${options.slice(0, 8).map((o) => `${o.code} “${plain(o.label, 30)}”`).join(", ")}${options.length > 8 ? ", …" : ""}.`}`, candidates: near ? options.filter((o) => plain(o.label, 80) === near).map((o) => ({ code: o.code, label: plain(o.label, 60) })) : all(), ambiguous: false };
}
