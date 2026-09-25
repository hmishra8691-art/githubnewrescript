import type { Condition, OptionMask, Question, SkipRule, SurveyDefinition, ValidationRule } from "@rescript/schema";
import { cond } from "@rescript/schema";
import {
  parseLogicExpression, formatCondition, conditionSummary, questionLogicSummary,
  getQuestionByCodeOrVar, listPages, listBlocks, questionOrder, conditionRefs,
  validateProposal, describeChange, objectKey, neighbours, parseSetExpression, formatSetExpression, maskSummary, ruleLabel,
  type ProposalChange, type ExpressionError, type DependencyIndex, type ObjectKey,
} from "@rescript/engine";

/**
 * THE INTELLIGENT MODE'S CONTRACT: sentence → INTENT → PROPOSAL → (Apply).
 *
 * An INTENT is the structured reading of what the programmer asked for —
 * "show Q5 when <expression>", "add a numeric question", "what depends on
 * Q3". It is deliberately provider-independent: the deterministic grammar
 * (`grammar.ts`) produces one from a sentence with no network at all, and
 * the language model, when it is configured, is asked for exactly the same
 * shape. So there is ONE planner, below, that turns an intent into a
 * proposal, and the model never gets to write logic in any form the parser
 * does not check.
 *
 * The condition inside an intent is EXPRESSION TEXT — the same language the
 * expression editor speaks (`Q3 = Yes AND Q4 > 2`) — and it goes through
 * `parseLogicExpression` against the real survey, so a rule that names a
 * question which does not exist, or compares an option that is not there,
 * is an error on the review card, not a rule in the survey.
 *
 * A PROPOSAL is what the review card shows: the summary, every change in
 * words (`describeChange`, the same words the Logic panel will use once it
 * is applied), the parsed condition three ways (text, summary, tree), and
 * the errors that block Apply. Nothing in this module writes to a survey.
 */

export type Intent =
  | { kind: "display"; target: string; action: "show" | "hide"; expression: string }
  | { kind: "skip"; from?: string; to: string; expression: string }
  | { kind: "required"; target: string; required: boolean }
  | { kind: "add_question"; type?: string; text: string; options?: string[]; after?: string; required?: boolean }
  | { kind: "rename"; target: string; newName: string }
  /** validation rules on a question, as {kind, value} pairs the engine merges by kind */
  | { kind: "validation"; target: string; rules: ValidationSpec[] }
  | { kind: "clear_validation"; target: string; kinds?: ValidationRule["kind"][] }
  /** an option mask: the SET EXPRESSION as text (`Q4.Selected`, `Q4.Selected AND Q5.Selected`, `NOT Q4.Selected`) */
  | { kind: "mask"; target: string; expression: string; action?: OptionMask["action"] }
  | { kind: "clear_mask"; target: string }
  | { kind: "find"; target: string; relation: "usedBy" | "dependsOn" | "affects" | "reach" }
  | { kind: "explain"; target: string }
  | { kind: "unknown"; reason: string };

export interface ValidationSpec { kind: ValidationRule["kind"]; value?: number | string }

export interface ProposalExpression {
  /** as typed (after the light normalisation) */
  text: string;
  /** canonical spelling, from the tree — what the expression editor would show */
  canonical: string;
  /** the Logic panel's sentence */
  summary: string;
  condition?: Condition;
  errors: ExpressionError[];
  warnings: ExpressionError[];
}

export interface AnswerLine { text: string; key?: ObjectKey }

export interface Proposal {
  intent: Intent;
  source: "grammar" | "ai";
  /** one line: what will happen */
  summary: string;
  changes: ProposalChange[];
  /** one line per change, in the Logic panel's words */
  descriptions: string[];
  expression?: ProposalExpression;
  /** the object the proposal is about, for the inspector and for selection after Apply */
  targetKey?: ObjectKey;
  /** anything here blocks Apply */
  errors: string[];
  warnings: string[];
  /** a read-only intent's answer — find / explain */
  answer?: AnswerLine[];
  readOnly: boolean;
}

/** what the planner needs from the Studio that the engine does not own */
export interface PlannerDeps {
  uid(prefix: string): string;
  /** build a question of a variant, named for this survey — the Studio's own factory */
  makeQuestion(def: SurveyDefinition, variantId: string): Question;
  /** the dependency index, for find / explain */
  index?: DependencyIndex;
}

/* ------------------------------------------------------------ expressions */

/**
 * The expression parser speaks `Q3 = Yes AND Q4 > 2`; people write "Q3 is
 * yes and Q4 is greater than 2". These rewrites bridge the everyday
 * spellings to the ones the parser already knows. They are textual and
 * conservative: nothing here decides what a rule MEANS, only how an operator
 * is spelled, and the parser still has the last word.
 */
const REWRITES: [RegExp, string][] = [
  [/\bis\s+(?:greater|more|higher|bigger)\s+than\s+or\s+equal\s+to\b/gi, ">="],
  [/\bis\s+(?:less|lower|smaller|fewer)\s+than\s+or\s+equal\s+to\b/gi, "<="],
  [/\b(?:is\s+)?(?:greater|more|higher|bigger)\s+than\b/gi, ">"],
  [/\b(?:is\s+)?(?:less|lower|smaller|fewer)\s+than\b/gi, "<"],
  [/\b(?:is\s+)?at\s+least\b/gi, ">="],
  [/\b(?:is\s+)?at\s+most\b/gi, "<="],
  [/\b(?:is\s+)?(?:equal\s+to|equals)\b/gi, "="],
  [/\b(?:does\s+not|doesn't|didn't|did\s+not)\s+(?:equal|contain|include)\b/gi, "is not"],
  [/\b(?:is\s+not|isn't|was\s+not|wasn't)\s+(?:selected|chosen|picked|ticked)\b/gi, "not selected"],
  [/\b(?:is|was|has\s+been)\s+(?:selected|chosen|picked|ticked)\b/gi, "selected"],
  [/\b(?:includes?|selected)\s+(?:the\s+)?(?:option|answer|choice)\b/gi, "contains"],
  [/\b(?:is|was|has\s+been)\s+answered\b/gi, "answered"],
  [/\b(?:is|was)\s+(?:blank|empty|unanswered|skipped|not\s+answered)\b/gi, "unanswered"],
  [/\b(?:isn't|is\s+not|was\s+not|wasn't)\b/gi, "is not"],
  [/\b(?:was|are|were|has|have)\b/gi, "is"],
  [/\bthe\s+(?:answer|response|value)\s+(?:to|of|for)\s+/gi, ""],
  [/\b(?:respondent|they|the\s+user|the\s+person)\s+(?:answered|said|chose|selected|picked)\s+/gi, ""],
  [/\bin\s+([A-Za-z_][\w.]*)\s+(?:is|=)\s+/gi, "$1 = "],
  [/\bmore\s+than\s+or\s+=\b/gi, ">="],
];

/**
 * A multi-word operand gets quotes: `Q4 = United States` is what people
 * write, `Q4 = "United States"` is what the parser reads. Only bare words
 * (no quotes, no digits-only tokens) up to the next AND/OR/parenthesis.
 */
const OPERAND_AFTER = /((?:^|\s)(?:=|!=|<>|>=|<=|>|<|is not|is|not contains|contains|not selected|selected|matches|starts with|ends with))\s+((?!and\b|or\b|not\b|then\b)[A-Za-z][\w'’\-\/]*(?:\s+(?!and\b|or\b|not\b|then\b)[A-Za-z0-9][\w'’\-\/]*)+)(?=\s+(?:and|or|then)\b|\s*\)|$)/gi;

export function normaliseExpression(text: string): string {
  let out = text.trim().replace(/[.?!]+$/, "");
  for (const [re, to] of REWRITES) out = out.replace(re, to);
  out = out.replace(OPERAND_AFTER, (_, op: string, words: string) => `${op} "${words}"`);
  return out.replace(/\s+/g, " ").trim();
}

export function planExpression(def: SurveyDefinition, text: string): ProposalExpression {
  const norm = normaliseExpression(text);
  const r = parseLogicExpression(def, norm);
  return {
    text: norm,
    canonical: r.condition ? formatCondition(def, r.condition) : "",
    summary: r.condition ? conditionSummary(def, r.condition) : "",
    condition: r.condition,
    errors: r.errors,
    warnings: r.warnings,
  };
}

/**
 * A set expression in everyday words → the mask language the parser reads:
 * "selected in Q4" → `Q4.Selected`, "not selected in Q4" → `Q4.Unselected`,
 * "Q4 and Q5" → `Q4.Selected AND Q5.Selected`, "in Q4 but not in Q5" →
 * `Q4.Selected MINUS Q5.Selected`. A bare code means its selection. Text
 * already in the language passes through untouched.
 */
export function normaliseSetExpression(def: SurveyDefinition, text: string): string {
  let t = text.trim().replace(/[.?!]+$/, "");
  const code = (m: string) => { const q = getQuestionByCodeOrVar(def, m) ?? getQuestionByCodeOrVar(def, m.toUpperCase()); return q ? q.code : m; };
  t = t.replace(/\b(?:the\s+)?(?:options?|answers?|items?|choices?)\s+(?:that\s+were\s+|that\s+was\s+)?(?:not\s+|un)selected\s+(?:in|at|for)\s+([A-Za-z_][\w]*)/gi, (_, q) => `${code(q)}.Unselected`);
  t = t.replace(/\b(?:the\s+)?(?:options?|answers?|items?|choices?)\s+(?:that\s+were\s+|that\s+was\s+)?(?:selected|chosen|picked|ticked|answered)\s+(?:in|at|for)\s+([A-Za-z_][\w]*)/gi, (_, q) => `${code(q)}.Selected`);
  t = t.replace(/\b(?:the\s+)?(?:options?|answers?|items?|choices?)\s+(?:shown|displayed)\s+(?:in|at|for)\s+([A-Za-z_][\w]*)/gi, (_, q) => `${code(q)}.Displayed`);
  t = t.replace(/\b(?:not\s+|un)selected\s+(?:in|at)\s+([A-Za-z_][\w]*)/gi, (_, q) => `${code(q)}.Unselected`);
  t = t.replace(/\b(?:selected|chosen|picked)\s+(?:in|at)\s+([A-Za-z_][\w]*)/gi, (_, q) => `${code(q)}.Selected`);
  t = t.replace(/\b([A-Za-z_][\w]*)'s\s+(?:selected|selection|answers?)\b/gi, (_, q) => `${code(q)}.Selected`);
  t = t.replace(/\bbut\s+not\s+(?:in\s+)?/gi, "MINUS ").replace(/\b(?:minus|except|excluding|without)\b/gi, "MINUS").replace(/\b(?:and|both|intersect(?:ion)?)\b/gi, "AND").replace(/\b(?:or|either|union|plus)\b/gi, "OR");
  // a bare question code or variable is its selection
  t = t.replace(/(^|[\s(])([A-Za-z_][\w]*)(?=$|[\s)])/g, (m, pre, tok) => {
    if (/^(AND|OR|NOT|MINUS|UNION|INTERSECTION|DIFFERENCE|EXPR|LISTFILL|CURRENT_ITEM_CODE|CURRENT_ITEM)$/i.test(tok)) return m;
    const q = getQuestionByCodeOrVar(def, tok) ?? getQuestionByCodeOrVar(def, tok.toUpperCase());
    return q ? `${pre}${q.code}.Selected` : m;
  });
  return t.replace(/\s+/g, " ").trim();
}

/* -------------------------------------------------------------- targets */

export type Resolved =
  | { kind: "question"; id: string; label: string; question: Question }
  | { kind: "page" | "block"; id: string; label: string };

const clean = (s: string) => s.replace(/<[^>]+>/g, "").trim().toLowerCase();

/**
 * A name in a sentence → the object it means. Codes and variable names
 * first (the parser's own resolver), then a page or block by id or title,
 * then a question by the start of its text — "the age question".
 */
export function resolveTarget(def: SurveyDefinition, raw: string): Resolved | null {
  let token = raw.trim().replace(/^(?:the|question|q\.)\s+/i, "").replace(/\s+question$/i, "").replace(/[“”"']/g, "").trim();
  if (!token) return null;
  const q = getQuestionByCodeOrVar(def, token) ?? getQuestionByCodeOrVar(def, token.toUpperCase());
  if (q) return { kind: "question", id: q.id, label: q.code || q.variableName, question: q };
  const pageWord = /^(?:page|screen)\s+(.+)$/i.exec(token);
  const blockWord = /^(?:block|section|group)\s+(.+)$/i.exec(token);
  const pages = listPages(def.flow as unknown[]);
  const blocks = listBlocks(def.flow as unknown[]);
  const byName = <T extends { id: string; title?: string }>(items: T[], name: string): T | undefined =>
    items.find((x) => x.id === name) ?? items.find((x) => clean(x.title ?? "") === clean(name)) ?? items.find((x) => clean(x.title ?? "").startsWith(clean(name)) && clean(name).length >= 3);
  if (pageWord) {
    const p = byName(pages.map((p) => ({ id: p.node.id, title: p.node.title })), pageWord[1]);
    if (p) return { kind: "page", id: p.id, label: p.title || p.id };
    const n = Number(pageWord[1]);
    if (Number.isInteger(n) && pages[n - 1]) return { kind: "page", id: pages[n - 1].node.id, label: pages[n - 1].node.title || `Page ${n}` };
  }
  if (blockWord) {
    const b = byName(blocks.map((b) => ({ id: b.id, title: b.title })), blockWord[1]);
    if (b) return { kind: "block", id: b.id, label: b.title || b.id };
    const n = Number(blockWord[1]);
    if (Number.isInteger(n) && blocks[n - 1]) return { kind: "block", id: blocks[n - 1].id, label: blocks[n - 1].title || `Block ${n}` };
  }
  const b = byName(blocks.map((b) => ({ id: b.id, title: b.title })), token);
  if (b) return { kind: "block", id: b.id, label: b.title || b.id };
  const p = byName(pages.map((p) => ({ id: p.node.id, title: p.node.title })), token);
  if (p) return { kind: "page", id: p.id, label: p.title || p.id };
  const t = clean(token);
  if (t.length >= 4) {
    const byText = def.questions.find((x) => clean(x.text).startsWith(t)) ?? def.questions.find((x) => clean(x.text).includes(t));
    if (byText) return { kind: "question", id: byText.id, label: byText.code || byText.variableName, question: byText };
  }
  return null;
}

/* ------------------------------------------------------- question types */

/** everyday words for a kind of question → a variant the picker offers */
const TYPE_WORDS: [RegExp, string][] = [
  [/\b(?:multi(?:ple)?[\s-]?(?:select|choice|answer)|check ?box(?:es)?|select all|pick all)\b/i, "multi_select.checkbox"],
  [/\bdrop ?down\b/i, "single_select.dropdown"],
  [/\bnps\b|net promoter/i, "single_select.nps"],
  [/\blikert\b/i, "matrix.likert"],
  [/\b(?:matrix|grid)\b/i, "matrix.single"],
  [/\brank(?:ing)?\b/i, "ranking.drag"],
  [/\bslider\b/i, "slider.single"],
  [/\bstar(?:s| rating)?\b/i, "slider.stars"],
  [/\brating\b|\bscale\b/i, "matrix.rating"],
  [/\be-?mail\b/i, "text.email"],
  [/\bphone\b/i, "text.phone"],
  [/\b(?:number|numeric|numerical|integer|count|how many|age)\b/i, "numeric.open"],
  [/\bcurrency|price|amount|spend\b/i, "numeric.currency"],
  [/\bpercent(?:age)?\b/i, "numeric.percentage"],
  [/\b(?:long|essay|paragraph|multi[\s-]?line)\b/i, "text.multi_line"],
  [/\b(?:open[\s-]?end(?:ed)?|free[\s-]?text|text|comment|verbatim|open)\b/i, "text.single_line"],
  [/\b(?:yes\s*\/?\s*no|yes or no|boolean)\b/i, "single_select.radio"],
  [/\b(?:single[\s-]?(?:select|choice|answer)|radio|choice|choose one|pick one|select one)\b/i, "single_select.radio"],
];

export function variantForWords(words: string | undefined): string {
  if (!words) return "single_select.radio";
  for (const [re, id] of TYPE_WORDS) if (re.test(words)) return id;
  return "single_select.radio";
}

/* --------------------------------------------------------------- planner */

const withKey = (r: Resolved): ObjectKey => objectKey(r.kind === "question" ? "question" : "flowNode", r.id);

/**
 * Turn an intent into a proposal against THIS survey. Pure: reads the
 * definition, builds changes, validates them, writes nothing.
 */
export function planProposal(def: SurveyDefinition, intent: Intent, source: Proposal["source"], deps: PlannerDeps): Proposal {
  const base = (p: Partial<Proposal>): Proposal => ({
    intent, source, summary: "", changes: [], descriptions: [], errors: [], warnings: [], readOnly: false, ...p,
  });
  const finish = (p: Proposal): Proposal => {
    const errs = p.errors.length ? p.errors : validateProposal(def, p.changes);
    return { ...p, errors: errs, descriptions: p.changes.map((c) => describeChange(def, c)) };
  };
  const missing = (what: string) => base({ summary: "", errors: [`I could not find ${what} in this survey.`] });

  switch (intent.kind) {
    case "display": {
      const t = resolveTarget(def, intent.target);
      if (!t) return missing(`“${intent.target}”`);
      const ex = planExpression(def, intent.expression);
      const errors = ex.errors.map((e) => e.message);
      const warnings = ex.warnings.map((w) => w.message);
      if (!ex.condition) return base({ summary: `${intent.action === "show" ? "Show" : "Hide"} ${t.label} when …`, expression: ex, targetKey: withKey(t), errors, warnings });
      // "hide when X" on a question is "show when NOT X" — one field, one meaning
      const shown: Condition = intent.action === "show" ? ex.condition : cond.not(ex.condition);
      const changes: ProposalChange[] = t.kind === "question"
        ? [{ kind: "set_display_logic", questionId: t.id, condition: shown }]
        : [{ kind: "add_display_rule", rule: { id: deps.uid("dr"), target: { kind: t.kind, ref: t.id }, action: intent.action, when: ex.condition } }];
      if (t.kind === "question" && t.question.displayLogic) warnings.push(`${t.label} already has display logic (${conditionSummary(def, t.question.displayLogic)}); this replaces it.`);
      return finish(base({
        summary: `${intent.action === "show" ? "Show" : "Hide"} ${t.label} ${intent.action === "show" ? "only " : ""}when ${ex.summary}.`,
        changes, expression: ex, targetKey: withKey(t), warnings,
      }));
    }
    case "skip": {
      const ex = planExpression(def, intent.expression);
      const errors = ex.errors.map((e) => e.message);
      const warnings = ex.warnings.map((w) => w.message);
      const toWord = intent.to.trim().toLowerCase();
      let target: SkipRule["target"] | null = null;
      let toLabel = intent.to;
      let toKey: ObjectKey | undefined;
      const status = /screen/.test(toWord) ? "screened" : /quota/.test(toWord) ? "quota_full" : /terminat/.test(toWord) ? "terminated" : /complete|end/.test(toWord) ? "complete" : undefined;
      if (/^(?:the\s+)?(?:end|finish|completion)(?:\s+of\s+the\s+survey)?$/.test(toWord) || (status === "complete" && /end/.test(toWord))) { target = { kind: "end", status: "complete" }; toLabel = "the end"; }
      else if (/terminat|screen|disqualif|quota|out\b|exit/.test(toWord)) { target = { kind: "terminate", status: status ?? "terminated" }; toLabel = `out of the survey (${(status ?? "terminated").replace("_", " ")})`; }
      else if (/^https?:\/\//.test(intent.to.trim())) { target = { kind: "url", ref: intent.to.trim() }; }
      else {
        const t = resolveTarget(def, intent.to);
        if (!t) return missing(`“${intent.to}”`);
        target = t.kind === "question" ? { kind: "question", ref: t.id } : { kind: t.kind, ref: t.id };
        toLabel = t.label; toKey = withKey(t);
      }
      // the rule lives on the question that triggers it: the one named, else
      // the LAST question the condition reads (its answer is known by then)
      let from: Resolved | null = intent.from ? resolveTarget(def, intent.from) : null;
      if (intent.from && !from) return missing(`“${intent.from}”`);
      if (!from && ex.condition) {
        const order = questionOrder(def);
        const refs = [...conditionRefs(def, ex.condition)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
        const last = refs[refs.length - 1];
        const q = last ? def.questions.find((x) => x.id === last) : undefined;
        if (q) from = { kind: "question", id: q.id, label: q.code || q.variableName, question: q };
      }
      if (!ex.condition) return base({ summary: `Skip to ${toLabel} when …`, expression: ex, targetKey: toKey, errors, warnings });
      if (!from || from.kind !== "question") return base({ summary: `Skip to ${toLabel}`, expression: ex, errors: [...errors, "I could not tell which question the skip should follow — say “after Q3, skip to …”."], warnings });
      const rule: SkipRule = { id: deps.uid("sk"), when: ex.condition, target: target! };
      return finish(base({
        summary: `After ${from.label}, skip to ${toLabel} when ${ex.summary}.`,
        changes: [{ kind: "add_skip_rule", questionId: from.id, rule }],
        expression: ex, targetKey: objectKey("question", from.id), warnings,
      }));
    }
    case "required": {
      const t = resolveTarget(def, intent.target);
      if (!t) return missing(`“${intent.target}”`);
      if (t.kind !== "question") return base({ errors: [`${t.label} is a ${t.kind}; only a question can be required.`] });
      const warnings = t.question.required === intent.required ? [`${t.label} is already ${intent.required ? "required" : "optional"}.`] : [];
      return finish(base({
        summary: `Make ${t.label} ${intent.required ? "required" : "optional"}.`,
        changes: [{ kind: "set_required", questionId: t.id, required: intent.required }],
        targetKey: withKey(t), warnings,
      }));
    }
    case "add_question": {
      const variant = variantForWords(intent.type);
      const q = deps.makeQuestion(def, variant);
      q.text = intent.text.trim();
      if (intent.required) q.required = true;
      if (intent.options?.length && Array.isArray(q.options)) {
        q.options = intent.options.map((label, i) => ({ code: i + 1, label: label.trim(), flags: [] })) as Question["options"];
      }
      let at: { pageId?: string; index?: number } | undefined;
      let afterLabel = "";
      if (intent.after) {
        const t = resolveTarget(def, intent.after);
        if (!t) return missing(`“${intent.after}”`);
        if (t.kind === "question") {
          for (const p of listPages(def.flow as unknown[])) {
            const k = p.node.questionIds.indexOf(t.id);
            if (k >= 0) { at = { pageId: p.node.id, index: k + 1 }; break; }
          }
        } else if (t.kind === "page") at = { pageId: t.id };
        afterLabel = ` after ${t.label}`;
      }
      const warnings: string[] = [];
      if (!intent.text.trim()) warnings.push("The question has no text yet — add it after applying.");
      if (/select/.test(variant) && !(q.options?.length)) warnings.push("No options given — add them after applying.");
      return finish(base({
        summary: `Add ${q.code}${afterLabel}: “${q.text || "(untitled)"}”.`,
        changes: [{ kind: "add_question", question: q, at }],
        targetKey: objectKey("question", q.id), warnings,
      }));
    }
    case "rename": {
      const t = resolveTarget(def, intent.target);
      if (!t) return missing(`“${intent.target}”`);
      if (t.kind !== "question") return base({ errors: [`${t.label} is a ${t.kind}; only a question's variable can be renamed.`] });
      const newName = intent.newName.trim().replace(/[“”"']/g, "");
      return finish(base({
        summary: `Rename ${t.question.variableName} to ${newName}.`,
        changes: [{ kind: "rename_variable", oldName: t.question.variableName, newName }],
        targetKey: withKey(t),
      }));
    }
    case "validation": {
      const t = resolveTarget(def, intent.target);
      if (!t) return missing(`“${intent.target}”`);
      if (t.kind !== "question") return base({ errors: [`${t.label} is a ${t.kind}; validation belongs to a question.`] });
      const rules: ValidationRule[] = intent.rules.map((r) => ({ id: deps.uid("v"), kind: r.kind, ...(r.value !== undefined ? { value: r.value } : {}) }));
      if (!rules.length) return base({ errors: ["I could not tell which rule to set — say “Q3 must be between 18 and 99” or “limit Q5 to 200 characters”."] });
      const existing = (t.question.validation ?? []).filter((v) => rules.some((r) => r.kind === v.kind));
      const warnings = existing.map((v) => `${t.label} already has a ${ruleLabel(v.kind)} rule${v.value !== undefined ? ` (${v.value})` : ""}; this replaces it.`);
      const change = { kind: "set_validation" as const, questionId: t.id, rules };
      return finish(base({ summary: describeChange(def, change), changes: [change], targetKey: withKey(t), warnings }));
    }
    case "clear_validation": {
      const t = resolveTarget(def, intent.target);
      if (!t) return missing(`“${intent.target}”`);
      if (t.kind !== "question") return base({ errors: [`${t.label} is a ${t.kind}; validation belongs to a question.`] });
      const change = { kind: "clear_validation" as const, questionId: t.id, ...(intent.kinds?.length ? { kinds: intent.kinds } : {}) };
      return finish(base({ summary: describeChange(def, change), changes: [change], targetKey: withKey(t) }));
    }
    case "mask": {
      const t = resolveTarget(def, intent.target);
      if (!t) return missing(`“${intent.target}”`);
      if (t.kind !== "question") return base({ errors: [`${t.label} is a ${t.kind}; a mask belongs to a question with options.`] });
      const r = parseSetExpression(def, normaliseSetExpression(def, intent.expression));
      const errors = r.errors.map((e) => e.message);
      if (!r.expr) return base({ summary: `Mask ${t.label} by …`, targetKey: withKey(t), errors: errors.length ? errors : ["I could not read that set expression."], expression: { text: intent.expression, canonical: "", summary: "", errors: r.errors, warnings: [] } });
      const mask: OptionMask = { expr: r.expr, action: intent.action ?? "display", keepAlwaysShow: true };
      const warnings = t.question.mask ? [`${t.label} already has a mask (${formatSetExpression(def, t.question.mask.expr)}); this replaces it.`] : [];
      const change = { kind: "set_mask" as const, questionId: t.id, mask };
      return finish(base({
        summary: `${maskSummary(def, t.label, mask)}.`,
        changes: [change], targetKey: withKey(t), warnings,
        expression: { text: intent.expression, canonical: formatSetExpression(def, r.expr), summary: maskSummary(def, t.label, mask), errors: [], warnings: [] },
      }));
    }
    case "clear_mask": {
      const t = resolveTarget(def, intent.target);
      if (!t) return missing(`“${intent.target}”`);
      if (t.kind !== "question") return base({ errors: [`${t.label} is a ${t.kind}.`] });
      const change = { kind: "set_mask" as const, questionId: t.id, mask: null };
      return finish(base({ summary: describeChange(def, change), changes: [change], targetKey: withKey(t) }));
    }
    case "find": {
      const t = resolveTarget(def, intent.target);
      if (!t) return missing(`“${intent.target}”`);
      const key = withKey(t);
      const ix = deps.index;
      if (!ix) return base({ summary: "", errors: ["The dependency index is not available."], readOnly: true });
      /*
       * usedBy   — what reads T directly (a rule on Q5 that mentions Q3)
       * dependsOn — what T reads directly
       * affects  — everything downstream of T, transitively
       * reach    — everything upstream of T, transitively
       */
      const keys = (intent.relation === "usedBy" ? neighbours(ix, key, "usedBy").map((n) => n.key)
        : intent.relation === "dependsOn" ? neighbours(ix, key, "dependsOn").map((n) => n.key)
        : intent.relation === "affects" ? ix.affects(key)
        : ix.reach(key)).filter((k) => k !== key);
      const phrase = { usedBy: "depend on", dependsOn: "are used by", affects: "can be affected by", reach: "can affect" }[intent.relation];
      const none = { usedBy: `Nothing depends on ${t.label}.`, dependsOn: `${t.label} depends on nothing.`, affects: `Nothing is affected by ${t.label}.`, reach: `Nothing can affect ${t.label}.` }[intent.relation];
      return base({
        summary: keys.length ? `${keys.length} object${keys.length === 1 ? "" : "s"} ${phrase} ${t.label}.` : none,
        answer: keys.map((k) => ({ text: labelFor(def, ix, k), key: k })),
        targetKey: key, readOnly: true,
      });
    }
    case "explain": {
      const t = resolveTarget(def, intent.target);
      if (!t) return missing(`“${intent.target}”`);
      if (t.kind !== "question") return base({ summary: `${t.label} is a ${t.kind}.`, readOnly: true, targetKey: withKey(t), answer: [] });
      const q = t.question;
      const lines: AnswerLine[] = [];
      lines.push({ text: `${q.code} (${q.variableName}) is a ${q.type.replace(/_/g, " ")} question${q.required ? ", required" : ", optional"}.` });
      const logic = questionLogicSummary(def, q);
      if (!logic.length && !q.skipLogic?.length) lines.push({ text: "It is always shown; nothing skips from it." });
      for (const l of logic) lines.push({ text: l });
      for (const r of q.skipLogic ?? []) lines.push({ text: describeChange(def, { kind: "add_skip_rule", questionId: q.id, rule: r }).replace(/^After [^,]+, skip/, "Skips") });
      const ix = deps.index;
      if (ix) {
        const key = objectKey("question", q.id);
        const users = neighbours(ix, key, "usedBy").map((n) => n.key).filter((k) => k !== key);
        const reads = neighbours(ix, key, "dependsOn").map((n) => n.key).filter((k) => k !== key);
        if (reads.length) lines.push({ text: `It reads: ${reads.map((k) => labelFor(def, ix, k)).join(", ")}.` });
        if (users.length) lines.push({ text: `It is used by: ${users.map((k) => labelFor(def, ix, k)).join(", ")}.` });
      }
      return base({ summary: `About ${t.label}`, answer: lines, targetKey: withKey(t), readOnly: true });
    }
    case "unknown":
      return base({ errors: [intent.reason], readOnly: true });
  }
}

function labelFor(def: SurveyDefinition, ix: DependencyIndex, key: ObjectKey): string {
  const n = ix.nodes.get(key);
  if (n) return n.code || n.label;
  const [kind, id] = key.split(":", 2);
  if (kind === "question") { const q = def.questions.find((x) => x.id === id); if (q) return q.code || q.variableName; }
  return key;
}
