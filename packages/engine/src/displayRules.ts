import type { SurveyDefinition, DisplayRule, FlowNode } from "@rescript/schema";
import type { EvalContext } from "./evaluate.js";
import { evaluateCondition } from "./evaluate.js";
import { flowNodeIndex } from "./flowTree.js";

/**
 * NAMED DISPLAY RULES, FOR EVERYTHING THEY CLAIM TO TARGET (§6).
 *
 * `DisplayRule.target.kind` has offered seven kinds since the first release —
 * question, page, section, block, option, row, column — and `flow.ts` acted
 * on exactly one of them:
 *
 *     if (rule.target.kind !== "question") continue;
 *
 * The other six were saved, exported, shown in the spec sheet and silently
 * ignored. That is the worst way for a feature to be missing: a programmer
 * writes "hide the pricing block when Q2 is 'no'", the rule appears in the
 * documentation the client signs off, and the block shows anyway.
 *
 * WHY THIS IS ONE FUNCTION RATHER THAN SIX.
 *
 * The semantics were already settled by `visibleQuestions`, and they are not
 * obvious enough to re-derive in six places:
 *
 *   - no rule names this thing            → visible
 *   - a HIDE rule whose condition holds   → hidden, and nothing overrides it
 *   - a SHOW rule                         → visibility IS the condition, so a
 *                                           show rule that does not hold hides
 *   - several SHOW rules                  → the last one wins
 *
 * The precedence matters: HIDE beating SHOW is what makes "hide this for
 * everyone in the pilot" a safe thing to add on top of existing rules, which
 * is how these get used in the field.
 *
 * WHAT THIS DOES *NOT* DO — and the reason is the important part.
 *
 * Option, row and column visibility already has a considered pipeline
 * (`carryforward.ts`): eligibility, list logic, masks, punches, list
 * operations, prioritisation, sort, randomisation. A second independent
 * mechanism deciding whether an option renders would be two sources of truth
 * for one question, and the bug it produces — an option visible in the
 * editor's trace and absent at runtime — is close to undiagnosable.
 *
 * So an item-level rule enters that pipeline as a stage, immediately after
 * eligibility, and composes with everything downstream exactly as eligibility
 * does. In particular a later union or carry-forward can still reintroduce a
 * code, and `always_show` still protects a pinned option, because those are
 * the rules that already hold for the stage this one sits beside.
 */

export type DisplayTargetKind = DisplayRule["target"]["kind"];

/** The kinds that name something INSIDE a question, and so need a `subRef`. */
const ITEM_KINDS = new Set<DisplayTargetKind>(["option", "row", "column"]);

/** The kinds that name a flow container. */
const CONTAINER_KINDS = new Set<string>(["page", "section", "block"]);

/**
 * Is any rule pointed at this kind at all?
 *
 * The option pipeline runs per option per question per page, so it asks this
 * first: a survey with no item-level rules — which is nearly all of them, and
 * every survey written before this existed — pays one Set lookup rather than a
 * walk of every rule for every option.
 */
export function hasDisplayRulesFor(def: SurveyDefinition, kind: DisplayTargetKind): boolean {
  const rules = def.displayRules;
  if (!rules?.length) return false;
  for (const r of rules) if (r.target.kind === kind) return true;
  return false;
}

/**
 * The verdict, and WHICH kind of rule reached it.
 *
 * `by` exists for one reason, and it is the option pipeline's precedence.
 * `eligibilityVerdict` already draws a line there that is worth matching
 * exactly: an explicit exclusion (`excludeWhen`) removes even an
 * `always_show` option, while an ordinary condition that merely fails to hold
 * does not. A named HIDE rule is an explicit exclusion — somebody named this
 * option and said remove it — so it wins over a pin. A named SHOW rule that
 * does not hold is the ordinary case, and a pinned option survives it.
 *
 * Without the distinction, pinning would either stop meaning anything or
 * become unoverridable, and both are worse than the extra field.
 */
export interface RuleVerdict {
  visible: boolean;
  by: "hide" | "show" | "none";
}

/**
 * Does the named-rule layer leave this thing visible?
 *
 * `subRef` is the option code, row code or column id, and is compared as a
 * string: option codes are `string | number` in the schema and a rule written
 * against a numeric code must match the option that carries it.
 */
export function ruleVerdict(
  def: SurveyDefinition,
  kind: DisplayTargetKind,
  ref: string,
  ctx: EvalContext,
  subRef?: string | number,
): RuleVerdict {
  const rules = def.displayRules;
  if (!rules?.length) return { visible: true, by: "none" };

  const wanted = subRef === undefined ? undefined : String(subRef);
  const isItem = ITEM_KINDS.has(kind);
  let hidden = false;
  let shown: boolean | undefined;

  for (const rule of rules) {
    if (rule.target.kind !== kind || rule.target.ref !== ref) continue;
    if (isItem) {
      /*
       * A rule that says "hide an option of Q7" without saying WHICH option
       * names nothing in particular. Treating it as "every option" would let
       * one unfinished rule empty a question's list in the field, so it is
       * skipped here and reported by `runQualityCheck` instead — a rule that
       * does nothing and is flagged beats a rule that does too much.
       */
      if (rule.target.subRef === undefined || rule.target.subRef === "") continue;
      if (String(rule.target.subRef) !== wanted) continue;
    }
    const holds = evaluateCondition(rule.when, ctx);
    if (rule.action === "show") shown = holds;
    else if (holds) hidden = true;
  }

  if (hidden) return { visible: false, by: "hide" };
  if (shown === false) return { visible: false, by: "show" };
  return { visible: true, by: shown === true ? "show" : "none" };
}

/** The verdict as a plain boolean, for the callers that need nothing more. */
export function visibleByRules(
  def: SurveyDefinition,
  kind: DisplayTargetKind,
  ref: string,
  ctx: EvalContext,
  subRef?: string | number,
): boolean {
  return ruleVerdict(def, kind, ref, ctx, subRef).visible;
}

/**
 * A flow container's named rules — pages, sections and blocks.
 *
 * Composed with `node.visibleIf` by the caller rather than here: `visibleIf`
 * is the node's own logic and this is the survey-level layer over it, and
 * keeping them separate is what lets the flow inspector say which of the two
 * removed a page.
 */
export function containerVisibleByRules(
  def: SurveyDefinition,
  node: FlowNode,
  ctx: EvalContext,
): boolean {
  if (!CONTAINER_KINDS.has(node.type)) return true;
  return visibleByRules(def, node.type as DisplayTargetKind, node.id, ctx);
}

/**
 * What a rule can be pointed at, ready for a picker.
 *
 * In the engine rather than the Studio because the answer has to agree with
 * `ruleVerdict` — a picker that offers a container the interpreter cannot
 * resolve is how six of these target kinds came to be inert in the first
 * place. Labels are the programmer's words (a page's title, a question's
 * code), because a rule list showing `p_7f3a` is a rule list nobody audits.
 */
export interface DisplayRuleTarget {
  kind: DisplayTargetKind;
  ref: string;
  label: string;
  /** the options / rows / columns this target can be narrowed to */
  items?: { subRef: string; label: string }[];
}

export function displayRuleTargets(def: SurveyDefinition): DisplayRuleTarget[] {
  const out: DisplayRuleTarget[] = [];

  for (const q of def.questions ?? []) {
    const text = q.text?.replace(/<[^>]*>/g, "").trim() ?? "";
    const label = `${q.code}${text ? ` — ${text.slice(0, 48)}` : ""}`;
    out.push({ kind: "question", ref: q.id, label });
    if (q.options?.length) {
      out.push({
        kind: "option", ref: q.id, label,
        items: q.options.map((o) => ({
          subRef: String(o.code),
          label: `${o.code} — ${o.label.replace(/<[^>]*>/g, "").slice(0, 40)}`,
        })),
      });
    }
    if (q.rows?.length) {
      out.push({
        kind: "row", ref: q.id, label,
        items: q.rows.map((r) => ({
          subRef: String(r.code),
          label: `${r.code} — ${r.label.replace(/<[^>]*>/g, "").slice(0, 40)}`,
        })),
      });
    }
    if (q.columns?.length) {
      out.push({
        kind: "column", ref: q.id, label,
        items: q.columns.map((c) => ({
          subRef: c.id,
          label: c.label.replace(/<[^>]*>/g, "").slice(0, 40) || c.id,
        })),
      });
    }
  }

  for (const [id, node] of flowNodeIndex(def.flow ?? [])) {
    if (!CONTAINER_KINDS.has(node.type)) continue;
    const title = (node as { title?: string }).title?.trim();
    if (node.type === "page") {
      /*
       * A page is usually untitled — its identity to a programmer is the
       * questions on it, so that is the label rather than an id they have
       * never seen.
       */
      const codes = ((node as { questionIds?: string[] }).questionIds ?? [])
        .map((qid) => def.questions.find((q) => q.id === qid)?.code)
        .filter(Boolean);
      out.push({
        kind: "page", ref: id,
        label: title || (codes.length ? codes.join(", ") : `page ${id}`),
      });
    } else {
      out.push({ kind: node.type as DisplayTargetKind, ref: id, label: title || `${node.type} ${id}` });
    }
  }

  return out;
}

/**
 * Rules that can never fire, for the quality check.
 *
 * Three ways a rule is dead: it names something that no longer exists, it is
 * an item rule with no item, or its target kind cannot be resolved. Each is
 * the residue of ordinary editing — a question deleted, a rule half-written —
 * and each is invisible without being told.
 */
export interface DeadDisplayRule {
  rule: DisplayRule;
  reason: string;
  /**
   * `warning` is reserved for the one case that is genuinely ambiguous: an
   * item code the question does not declare, which carry-forward and the list
   * operations can legitimately introduce at runtime. Everything else names
   * something that cannot exist, and a rule that cannot fire is a rule whose
   * absence somebody will eventually mistake for a bug in the engine.
   */
  level: "error" | "warning";
}

export function unresolvableDisplayRules(def: SurveyDefinition): DeadDisplayRule[] {
  const out: DeadDisplayRule[] = [];
  const questionIds = new Set(def.questions.map((q) => q.id));
  const nodes = flowNodeIndex(def.flow);

  for (const rule of def.displayRules ?? []) {
    const { kind, ref, subRef } = rule.target;
    if (!ref) {
      out.push({ rule, reason: "names no target", level: "error" });
      continue;
    }
    if (kind === "question") {
      if (!questionIds.has(ref)) out.push({ rule, reason: `question ${ref} no longer exists`, level: "error" });
      continue;
    }
    if (CONTAINER_KINDS.has(kind)) {
      const found = nodes.get(ref)?.type;
      if (!found) out.push({ rule, reason: `${kind} ${ref} is not in the flow`, level: "error" });
      else if (found !== kind) out.push({ rule, reason: `${ref} is a ${found}, not a ${kind}`, level: "error" });
      continue;
    }
    /* option / row / column */
    const q = def.questions.find((x) => x.id === ref);
    if (!q) {
      out.push({ rule, reason: `question ${ref} no longer exists`, level: "error" });
      continue;
    }
    if (subRef === undefined || subRef === "") {
      out.push({ rule, reason: `names no ${kind}, so it is ignored`, level: "error" });
      continue;
    }
    const present =
      kind === "option"
        ? q.options.some((o) => String(o.code) === String(subRef))
        : kind === "row"
          ? q.rows.some((r) => String(r.code) === String(subRef))
          : q.columns.some((c) => c.id === subRef);
    /*
     * Carry-forward and list operations can introduce codes the question does
     * not itself declare, so a missing code is a WARNING's worth of doubt
     * rather than proof of a mistake. It is still worth saying: the common
     * cause is a renamed option.
     */
    if (!present) {
      out.push({
        rule,
        reason: `${kind} “${subRef}” is not declared on ${q.code} (it may be carried in)`,
        level: "warning",
      });
    }
  }
  return out;
}
