/**
 * WHAT ELSE POINTS AT THIS QUESTION — and what happens to it when the
 * question goes.
 *
 * ## The state deleting used to leave
 *
 * Deleting a question removed it from `def.questions` and from the page that
 * held it, and stopped. Everything that pointed at it kept pointing at it:
 * a display rule on Q7 still read "show when Q5 = 2", a carry-forward still
 * named Q5 as its source, an auto-punch still punched from it, a quota cell
 * still counted it. None of that was visible, because a picker asked to
 * render an id it cannot find renders nothing — the rule appeared as an
 * unset row, and a programmer reading the screen saw an unfinished rule
 * rather than a broken one.
 *
 * The consequences are not cosmetic. A condition whose left-hand side does
 * not resolve is false, so Q7 stopped appearing and nobody could say why. A
 * carry-forward from a question that no longer exists produces an empty
 * option list, which — before `validate.ts` learned better — excused the
 * question from being required. And the lint reported all of it much later,
 * as a list of ids that mean nothing to the person reading them.
 *
 * ## What this module does instead
 *
 * One walk of the definition finds every reference, in any field, at any
 * depth, and decides what pruning it means. `referencesTo` runs that walk on
 * a copy and reports; `pruneReferencesTo` runs the same walk for real. They
 * are the same function, so the list a person approves is exactly the change
 * that is made — a preview computed by different code from the change it
 * previews is a preview that is eventually wrong.
 *
 * ## How a reference is recognised
 *
 * By the FIELD it sits in, not by a list of the places references are. The
 * schema spells a question id one of a few ways — `questionId`,
 * `sourceQuestionId`, `pairedQuestionId`, an id inside `questionIds`, a
 * `ref` on a target whose `kind` is "question" — and this walks the whole
 * document looking for those spellings. A reference site added to the schema
 * tomorrow is found without editing this file, which is the only way a
 * sixty-site sweep stays correct.
 *
 * ## What pruning means, field by field
 *
 * A rule that names the question is REMOVED, not repaired. That is the
 * decision that matters, and it is deliberately the conservative one:
 * "punch Heavy User when Q5 >= 5" with Q5 gone must not quietly become
 * "punch Heavy User", which is what clearing the condition and keeping the
 * rule would do. So losing a reference invalidates the thing that held it,
 * and the invalidation cascades outwards until it reaches something that has
 * an independent reason to exist — a question, a flow node, the survey.
 *
 * At that boundary the field is CLEARED instead, and the report says what
 * the survey now does: "Q7 has no display logic left — it will always be
 * shown" is the sentence a programmer needs to see before pressing Delete.
 */

import type { SurveyDefinition } from "@rescript/schema";
import { pipeTokensIn } from "./pipingTokens.js";

/** Field names that hold a question id, wherever they appear. */
const ID_KEYS = new Set([
  "questionId", "sourceQuestionId", "pairedQuestionId", "targetQuestionId",
  "fromQuestionId", "toQuestionId", "probeQuestionId", "baseQuestionId",
]);

/** Arrays of bare question ids. */
const ID_LIST_KEYS = new Set(["questionIds", "sourceQuestionIds", "excludeQuestionIds"]);

/**
 * Keys whose loss invalidates the object holding them. A punch with no source
 * expression is not a punch; a mask with no expression is not a mask; a rule
 * whose condition has gone is not a rule that now applies always.
 */
const REQUIRED_CHILD = new Set([
  "when", "visibleIf", "stopWhen", "where", "check", "condition",
  "expr", "source", "sources", "left", "right", "of", "target", "logic",
]);

/** Keys that are cleared rather than cascaded, with the consequence named. */
const CLEARABLE: Record<string, string> = {
  displayLogic: "it will always be shown",
  carryForward: "its option list is whatever it holds itself",
  mask: "every option is shown",
  rowMask: "every row is shown",
  columnMask: "every column is shown",
  randomization: "its list is presented in the authored order",
  attentionCheck: "it is no longer scored as an attention check",
  probe: "no follow-up is asked",
};

export interface QuestionReference {
  /** Where it lives, in the words the Studio uses: "Q7 — display logic". */
  where: string;
  /** What pruning does to it. */
  effect: string;
  /** Dotted path, for tests and for the audit record. */
  path: string;
  /** `removed` destroys a rule; `cleared` empties a field and keeps its owner. */
  kind: "removed" | "cleared" | "unplaced";
}

/* --------------------------------------------------------------- the walk */

interface Ctx {
  id: string;
  /**
   * The id AND the two names the question answers to.
   *
   * `getQuestionByCodeOrVar` resolves a reference by `id`, `code` or
   * `variableName` — those three are one identity at runtime. This walk only
   * ever compared the id, so a condition stored as `{ kind: "variable", ref:
   * "Q5" }` (which the Logic Builder writes, and which `lintLogic` treats
   * exactly like a question source) survived the prune and then resolved to
   * nothing. A rule that cannot resolve its left-hand side is false, so the
   * question depending on it silently stopped being shown, and the delete
   * dialog had reported that nothing referred to Q5.
   */
  names: Set<string>;
  out: QuestionReference[];
  /** words for the thing currently being walked, e.g. "Q7" or "Quota 'Age'" */
  owner: string;
  /** words for the field currently being walked, e.g. "display logic" */
  field: string;
}

const WORDS: Record<string, string> = {
  displayLogic: "display logic",
  skipLogic: "a skip rule",
  validation: "a validation rule",
  listLogic: "a list logic rule",
  optionPipeline: "a list operation",
  carryForward: "carry-forward",
  mask: "option masking",
  rowMask: "row masking",
  columnMask: "column masking",
  punches: "an auto-punch rule",
  randomization: "conditional randomization",
  attentionCheck: "the attention check",
  probe: "the follow-up probe",
  options: "an option's own logic",
  rows: "a row's own logic",
  columns: "a column's own logic",
  quotas: "a quota",
  flow: "the flow",
  blocks: "a block",
  listFills: "a list fill",
  qualityRules: "a quality rule",
  loops: "a loop",
  tests: "a test case",
  variables: "the variable dictionary",
};

/**
 * Arrays whose ELEMENTS have a reason to exist beyond the reference that was
 * found inside them. An option is still an option when the question its
 * visibility rule named is deleted; a page is still a page. Inside one of
 * these the cascade stops: the field that held the reference is cleared and
 * the consequence is reported, rather than the element being destroyed.
 *
 * `branches` is deliberately NOT here. A branch whose condition named the
 * deleted question cannot be repaired in either direction — keeping it and
 * clearing the condition sends every respondent down it, which is worse than
 * removing it and letting them fall through to the path the flow already
 * defines as the default.
 */
const PROTECTED_ELEMENTS = new Set([
  "questions", "flow", "children", "otherwise", "blocks", "pages",
  "options", "rows", "columns",
]);

/**
 * `children` is spelled the same in two completely different places: the
 * children of a FLOW node, which are pages and groups a survey is built from,
 * and the children of a CONDITION GROUP, which are the rules inside a
 * bracket. Protecting the first and the second alike kept a condition rule
 * alive with its source torn out — a rule reading "(nothing) = 1", which is
 * precisely the half-deleted state this module exists to stop.
 *
 * A condition node always says so: `type` is "rule" or "group". Everything
 * else under one of those keys is structure.
 */
function protectsElement(key: string, element: unknown): boolean {
  if (!PROTECTED_ELEMENTS.has(key)) return false;
  if (key !== "flow" && key !== "children" && key !== "otherwise") return true;
  const t = (element as any)?.type;
  return typeof t === "string" && t !== "rule" && t !== "group";
}

/** The array keys that hold the inside of a condition tree. */
const CONDITION_PARTS = new Set(["children", "all", "any"]);

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Returns true when `node` must be dropped by whoever holds it.
 *
 * Post-order: children are pruned first, then the node decides whether what
 * is left of it still means anything. `protect` is set for the elements of
 * the arrays above — it stops a cascade at the element rather than letting
 * a nested condition take a question, a page or an option with it.
 */
function walk(node: any, ctx: Ctx, path: string, protect = false): boolean {
  if (Array.isArray(node)) return false;
  if (!isObj(node)) return false;

  /* who this is, for the sentence a person reads */
  const savedOwner = ctx.owner;
  if (typeof node.code === "string" && typeof node.variableName === "string") ctx.owner = String(node.code);
  else if (typeof node.name === "string" && typeof node.id === "string") ctx.owner = `“${node.name}”`;
  try { return walkFields(node, ctx, path, protect); } finally { ctx.owner = savedOwner; }
}

function walkFields(node: any, ctx: Ctx, path: string, protect: boolean): boolean {
  /*
   * A DIRECT reference on this node is the node's whole subject: a
   * carry-forward names its source, a carried option names where it came
   * from, a condition leaf names what it tests. None of those survives the
   * loss, protected element or not.
   */
  for (const key of ID_KEYS) if (node[key] === ctx.id) return true;
  /*
   * A condition leaf names its subject in `ref`. The `kind` beside it says how
   * the reference was authored — `question` from the picker, `variable` from
   * the expression editor, and both resolve through the same lookup — so the
   * KIND is not what decides whether this is a reference; the ref is.
   */
  if (typeof node.ref === "string" && node.kind !== "embedded" && node.kind !== "calc"
    && ctx.names.has(node.ref)) return true;

  for (const key of Object.keys(node)) {
    const child = node[key];

    if (ID_LIST_KEYS.has(key) && Array.isArray(child)) {
      const before = child.length;
      node[key] = child.filter((x: unknown) => x !== ctx.id);
      if (node[key].length !== before) {
        ctx.out.push({
          where: ctx.owner, path: `${path}.${key}`, kind: "unplaced",
          effect: "the question comes off the page that held it",
        });
      }
      continue;
    }

    if (!isObj(child) && !Array.isArray(child)) continue;

    const savedField = ctx.field;
    if (WORDS[key]) ctx.field = WORDS[key];
    let drop: boolean;
    if (Array.isArray(child)) {
      const before = child.length;
      for (let i = child.length - 1; i >= 0; i--) {
        if (walk(child[i], ctx, `${path}.${key}[${i}]`, protectsElement(key, child[i]))) child.splice(i, 1);
      }
      /*
       * The rules INSIDE a condition are not named separately. What a person
       * needs to know is which piece of logic changed and what the survey
       * now does — "QY — display logic, removed, so it will always be shown"
       * — not that a nested bracket lost a child. So a condition's own
       * internals report nothing here; whatever holds the condition does.
       */
      if (child.length !== before && !CONDITION_PARTS.has(key)) {
        ctx.out.push({
          where: `${ctx.owner} — ${WORDS[key] ?? ctx.field ?? key}`, path: `${path}.${key}`, kind: "removed",
          effect: `${before - child.length} removed`,
        });
      }
      /*
       * A condition group with nothing left in it is not a condition that is
       * now always true — it is the remains of one, and it takes its owner
       * with it. Same for a list operation whose every source has gone.
       */
      drop = before > 0 && child.length === 0
        && (CONDITION_PARTS.has(key) || REQUIRED_CHILD.has(key));
      if (drop && !protect) return true;
    } else {
      drop = walk(child, ctx, `${path}.${key}`);
      /*
       * Only a field the owner CANNOT DO WITHOUT takes the owner with it —
       * a rule's condition, a mask's expression, a punch's source. Anything
       * else is cleared where it stands, so one dead reference inside
       * `settings` can never delete every setting on the question.
       */
      if (drop && REQUIRED_CHILD.has(key) && !protect) return true;
    }

    ctx.field = savedField;
    if (!drop) continue;

    delete node[key];
    ctx.out.push({
      where: `${ctx.owner} — ${WORDS[key] ?? key}`, path: `${path}.${key}`, kind: "cleared",
      effect: CLEARABLE[key] ? `removed, so ${CLEARABLE[key]}` : "removed",
    });
  }

  return false;
}

/* ------------------------------------------------------- the two entry points */

/**
 * One walk of the whole definition, protected at the top so the survey
 * itself is never the thing that gets dropped. The question being deleted is
 * left in place: removing it belongs to the caller, which knows whether it is
 * deleting, replacing, or only asking what would happen.
 */
/** The id and the two names the question answers to — see `Ctx.names`. */
function namesOf(def: SurveyDefinition, id: string): Set<string> {
  const target = (def.questions ?? []).find((q) => q.id === id);
  const names = new Set<string>([id]);
  if (target?.code) names.add(target.code);
  if (target?.variableName) names.add(target.variableName);
  return names;
}

function run(def: SurveyDefinition, id: string, known?: Set<string>): QuestionReference[] {
  const out: QuestionReference[] = [];
  const names = known ?? namesOf(def, id);
  const ctx: Ctx = { id, names, out, owner: "the survey", field: "" };
  const pipes = pipesNaming(def, names);
  walk(def as any, ctx, "survey", true);
  out.push(...pipes);
  /* the same field reported twice (once per nesting level) reads as noise */
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.path}|${r.kind}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * PIPES ARE REFERENCES TOO, AND THEY ARE THE ONES A RESPONDENT SEES.
 *
 * A pipe lives inside a string — `Earlier you said {{Q5}} — why?` — and the
 * walk above only inspects objects, so deleting Q5 left every one of them
 * untouched while the dialog said "Nothing else in this survey refers to it."
 * It then resolved to the empty string for every respondent, so the sentence
 * they read was "Earlier you said — why?" and nothing anywhere had warned.
 *
 * They are REPORTED and not rewritten, on purpose. A pipe is part of a
 * sentence somebody composed; deleting the token silently leaves a gap in it,
 * and deleting the sentence throws away work. What the programmer needs is to
 * be told before pressing Delete, which is exactly what was missing.
 */
function pipesNaming(def: SurveyDefinition, names: Set<string>): QuestionReference[] {
  const out: QuestionReference[] = [];
  const seen = new Set<string>();
  const scan = (value: unknown, owner: string, path: string): void => {
    if (typeof value === "string") {
      if (!value.includes("{{")) return;
      for (const t of pipeTokensIn(value)) {
        if (!names.has(t.ref)) continue;
        const k = `${owner}|${t.raw}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          where: `${owner} — the text`, path, kind: "cleared",
          effect: `${t.text} pipes nothing, so the sentence reads with a gap where it was`,
        });
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach((v, i) => scan(v, owner, `${path}[${i}]`)); return; }
    if (!isObj(value)) return;
    const next = typeof (value as any).code === "string" && typeof (value as any).variableName === "string"
      ? String((value as any).code) : owner;
    for (const key of Object.keys(value)) scan((value as any)[key], next, `${path}.${key}`);
  };
  scan(def, "the survey", "survey");
  return out;
}

/**
 * Everything that points at this question, and what deleting it would do —
 * computed by running the real pruning on a copy, so the preview cannot
 * describe a change the pruning does not make.
 */
export function referencesTo(def: SurveyDefinition, questionId: string): QuestionReference[] {
  return run(structuredClone(def) as SurveyDefinition, questionId);
}

/**
 * Prune every reference to this question, in place. Returns the same list
 * `referencesTo` would have returned, so a caller can record exactly what it
 * did in an audit line or a toast.
 *
 * The question itself is NOT removed — that stays with the caller, which
 * knows whether it is deleting, replacing or merely testing.
 */
export function pruneReferencesTo(def: SurveyDefinition, questionId: string): QuestionReference[] {
  return run(def, questionId);
}

/**
 * The same thing for a group going at once — deleting a block, or a flow
 * element with questions nested inside it.
 *
 * The questions are removed FIRST and then the references are pruned, so a
 * rule that only ever pointed from one doomed question to another is not
 * reported: a person deciding whether to delete a block wants to know what it
 * breaks OUTSIDE the block, and listing its internal wiring buries that.
 */
export function pruneReferencesToMany(def: SurveyDefinition, questionIds: string[]): QuestionReference[] {
  const gone = new Set(questionIds);
  /* the codes have to be read BEFORE the questions go — a deleted question
     cannot tell anyone what it was called, and the references that name it by
     code are precisely the ones in the questions that remain */
  const names = new Map(questionIds.map((id) => [id, namesOf(def, id)]));
  def.questions = (def.questions ?? []).filter((q) => !gone.has(q.id));
  const out: QuestionReference[] = [];
  for (const id of questionIds) out.push(...run(def, id, names.get(id)));
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.path}|${r.kind}|${r.where}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** What `pruneReferencesToMany` would do, without doing it. */
export function referencesToMany(def: SurveyDefinition, questionIds: string[]): QuestionReference[] {
  return pruneReferencesToMany(structuredClone(def) as SurveyDefinition, questionIds);
}
