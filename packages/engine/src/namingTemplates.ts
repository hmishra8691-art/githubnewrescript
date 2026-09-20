import type { SurveyDefinition, Question, NamingTemplate } from "@rescript/schema";
import { applyRename, renameImpact, shadowsCalcFunction, type VariableUsage } from "./variableUsage.js";

/**
 * VARIABLE NAMING TEMPLATES (§44, phase 3).
 *
 * A research team's naming convention, written down once and applied to the
 * whole questionnaire. They already have these conventions; they keep them in
 * a Word document and apply them by hand, which is why a study's variable
 * names drift halfway through fieldwork and the data processor spends an
 * afternoon reconciling.
 *
 * ## What a template controls, and what it does not
 *
 * The pattern names a QUESTION's base variable. The engine composes every
 * derived column from that base — `Q5_R1`, `Q5_2`, `Q5_LAT` — and those
 * suffixes stay as they are. They are spelled out inline at around sixty
 * places in `variables.ts` and mirrored, separately, in `flatten.ts`; a
 * template that changed one spelling and not the other would declare columns
 * the runtime never fills, which is data loss that looks like a clean export.
 *
 * So `GRID{question}_{row}_{column}` from the brief is expressed as a
 * template of `GRID{number}` on the grid question: the template supplies the
 * `GRID5`, the engine supplies the `_R1_C2`.
 */

export interface TemplateContext {
  question: Question;
  /** 1-based position among all questions */
  number: number;
  /** 1-based position of the page/block the question sits on */
  section: number;
  /** 1-based position within its own section */
  numberInSection: number;
}

const slug = (text: string, words = 2): string =>
  (text ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, words)
    .join("_")
    .toUpperCase();

/**
 * The tokens a pattern may use.
 *
 * `{number:2}` zero-pads to two digits, which is the difference between
 * Q1…Q10 sorting as Q1, Q10, Q2 in every spreadsheet the client opens and
 * sorting the way a person expects.
 */
export const TEMPLATE_TOKENS: { token: string; describes: string }[] = [
  { token: "{number}", describes: "the question's position in the survey — {number:2} pads to 01" },
  { token: "{section}", describes: "the number of the page or block it sits on" },
  { token: "{n_in_section}", describes: "its position within that section" },
  { token: "{code}", describes: "the question code, e.g. Q7" },
  { token: "{question}", describes: "the same as {code}" },
  { token: "{variable}", describes: "the variable name it has now" },
  { token: "{shortname}", describes: "the first two words of the question text" },
  { token: "{type}", describes: "the question type, e.g. SINGLE_SELECT" },
];

/**
 * Render one pattern for one question.
 *
 * Unknown tokens are left ALONE rather than blanked. A pattern with a typo in
 * it then produces a name containing `{numbr}`, which fails validation loudly,
 * instead of silently producing `Q_` for every question in the study.
 */
export function renderNamingTemplate(pattern: string, ctx: TemplateContext): string {
  const q = ctx.question;
  return pattern.replace(/\{([a-z_]+)(?::(\d+))?\}/gi, (whole, rawName: string, pad?: string) => {
    const name = rawName.toLowerCase();
    const width = pad ? parseInt(pad, 10) : 0;
    const num = (n: number) => String(n).padStart(width, "0");
    switch (name) {
      case "number": return num(ctx.number);
      case "section": return num(ctx.section);
      case "n_in_section": return num(ctx.numberInSection);
      case "code": case "question": return q.code ?? "";
      case "variable": return q.variableName ?? "";
      case "shortname": return slug(q.text ?? "", width || 2);
      case "type": return String(q.type ?? "").toUpperCase();
      default: return whole;
    }
  });
}

/** Where each question sits, for the {number} and {section} tokens. */
export function templateContexts(def: SurveyDefinition): Map<string, TemplateContext> {
  const out = new Map<string, TemplateContext>();
  const pages = (def.flow ?? []).filter((n: any) => n.type === "page") as any[];

  /*
   * Numbering follows the FLOW, not `def.questions`, because that is the
   * order a respondent meets them and the order a researcher counts them in.
   * A question not placed on any page has no position, so it keeps its
   * definition order and is numbered after the placed ones — it is still in
   * the dictionary and still needs a name.
   */
  let n = 0;
  const placed = new Set<string>();
  pages.forEach((page, pi) => {
    let inSection = 0;
    for (const qid of page.questionIds ?? []) {
      const q = def.questions.find((x) => x.id === qid);
      if (!q || placed.has(q.id)) continue;
      placed.add(q.id);
      n += 1; inSection += 1;
      out.set(q.id, { question: q, number: n, section: pi + 1, numberInSection: inSection });
    }
  });
  for (const q of def.questions) {
    if (placed.has(q.id)) continue;
    n += 1;
    out.set(q.id, { question: q, number: n, section: pages.length + 1, numberInSection: 1 });
  }
  return out;
}

/* ------------------------------------------------------------ the plan */

export interface RenameStep {
  questionId: string;
  code: string;
  from: string;
  to: string;
  /** false when the template produced the name it already has */
  changed: boolean;
}

export interface TemplatePlan {
  steps: RenameStep[];
  /** steps that actually change something, in an order that never collides */
  ordered: RenameStep[];
  blockers: string[];
  warnings: string[];
  /** usages that a person has to look at afterwards */
  review: VariableUsage[];
}

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["RESP_ID", "SESSION_ID", "SURVEY_VERSION", "START_TIME", "END_TIME", "STATUS"]);

/**
 * What applying this template would do, and whether it can be done at all.
 *
 * Validation is on the FINAL STATE, not on each step in isolation. Renaming
 * Q1→Q2 while Q2→Q3 is perfectly valid as a whole and would be rejected by
 * any per-step "that name is taken" check — which is exactly the check
 * `renameVariable` applies, and exactly why bulk renaming needs its own
 * planner rather than a loop over the single-rename path.
 */
export function planTemplateRename(
  def: SurveyDefinition,
  pattern: string,
  opts: { questionIds?: string[] } = {},
): TemplatePlan {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const review: VariableUsage[] = [];
  const ctxs = templateContexts(def);

  const targeted = opts.questionIds ? new Set(opts.questionIds) : null;
  const steps: RenameStep[] = [];

  for (const q of def.questions) {
    if (targeted && !targeted.has(q.id)) continue;
    const ctx = ctxs.get(q.id);
    if (!ctx) continue;
    const to = renderNamingTemplate(pattern, ctx).trim();
    steps.push({ questionId: q.id, code: q.code, from: q.variableName, to, changed: to !== q.variableName });
  }

  const changing = steps.filter((s) => s.changed);

  /* ---- each new name has to be a usable name at all */
  for (const s of changing) {
    if (!VALID_NAME.test(s.to)) {
      blockers.push(
        `${s.code} would be named "${s.to}", which is not a usable variable name. Check the pattern for a token the template does not know.`,
      );
    } else if (RESERVED.has(s.to.toUpperCase())) {
      blockers.push(`${s.code} would be named "${s.to}", which is one of the system columns every export carries.`);
    } else if (shadowsCalcFunction(s.to)) {
      blockers.push(
        `${s.code} would be named "${s.to}", which is also a calculation function name — expressions could not tell the two apart.`,
      );
    }
  }

  /*
   * ---- the final state must have no duplicates.
   *
   * Checked against the names that will EXIST afterwards: the new names, plus
   * every question not being renamed, plus calculations and embedded fields,
   * which a template never touches.
   */
  const finalNames = new Map<string, string[]>();
  const note = (name: string, owner: string) => {
    const list = finalNames.get(name) ?? [];
    list.push(owner);
    finalNames.set(name, list);
  };
  for (const s of steps) note(s.to, s.code);
  for (const q of def.questions) {
    if (steps.some((s) => s.questionId === q.id)) continue;
    note(q.variableName, q.code);
  }
  for (const c of def.calculations ?? []) note(c.targetVariable, `calculation ${c.label || c.targetVariable}`);
  for (const e of def.embeddedData ?? []) note(e.name, "embedded data");

  for (const [name, owners] of finalNames) {
    if (owners.length > 1) {
      blockers.push(`"${name}" would belong to ${owners.join(" and ")}. Add {number} or {code} to the pattern to keep names distinct.`);
    }
  }

  /*
   * ---- the same refusals the single rename applies, gathered once.
   *
   * A script mentioning any renamed variable blocks the whole template: the
   * rename cannot be completed for that variable, and half-applying a naming
   * standard is worse than not applying it.
   */
  for (const s of changing) {
    const impact = renameImpact(def, s.from, s.to);
    for (const u of impact.usages) {
      if (u.rewrite === "frozen") blockers.push(`${s.code}: ${u.where}. ${u.detail ?? ""}`.trim());
      else if (u.rewrite === "review") review.push(u);
    }
    if (impact.aliasedByCode) {
      warnings.push(
        `${s.code}'s question code is also "${s.from}", so rules naming it keep resolving through the code. The codes are left alone; rename them separately if the standard covers codes too.`,
      );
    }
  }
  if (review.length) {
    warnings.push(`${review.length} reference${review.length === 1 ? "" : "s"} need checking by hand afterwards — wildcards and saved analyses are not rewritten.`);
  }

  return {
    steps,
    ordered: blockers.length ? [] : orderRenames(changing),
    blockers,
    warnings,
    review,
  };
}

/**
 * Put the renames in an order where nothing is ever renamed onto a name that
 * is still in use.
 *
 * Renaming Q1→Q2 and Q2→Q3 has a valid end state but only one safe order. A
 * straight swap (A→B, B→A) has NO safe order, so one of the pair goes via a
 * temporary name — the same cycle-breaking a register allocator does.
 *
 * Without this, a bulk rename either refuses perfectly reasonable templates
 * or, worse, produces two variables with one name and a dictionary that
 * silently drops one of them.
 */
export function orderRenames(steps: RenameStep[]): RenameStep[] {
  const remaining = [...steps];
  const out: RenameStep[] = [];
  /** names currently occupied by something not yet renamed away */
  const live = new Set(steps.map((s) => s.from));
  let temp = 0;

  while (remaining.length) {
    const i = remaining.findIndex((s) => !live.has(s.to));
    if (i >= 0) {
      const [s] = remaining.splice(i, 1);
      live.delete(s.from);
      out.push(s);
      continue;
    }
    /*
     * Every remaining target is still occupied, so the rest form one or more
     * cycles. Break one by parking a variable on a name nothing can collide
     * with, and let the loop continue.
     */
    const s = remaining.shift()!;
    const parked = `__RENAMING_${temp++}__`;
    out.push({ ...s, to: parked });
    live.delete(s.from);
    remaining.push({ ...s, from: parked });
    live.add(parked);
  }
  return out;
}

/**
 * Apply the plan. Each step goes through `applyRename`, so every condition,
 * pipe and expression follows the variable — the template is a way of
 * choosing names, not a second renaming implementation.
 */
export function applyTemplateRename(def: SurveyDefinition, plan: TemplatePlan): SurveyDefinition {
  if (plan.blockers.length) throw new Error("This naming template cannot be applied; see the plan's blockers.");
  let next = def;
  for (const step of plan.ordered) next = applyRename(next, step.from, step.to, { alsoCode: false });
  return next;
}

/** Templates offered when a survey has none of its own. */
export const STARTER_TEMPLATES: NamingTemplate[] = [
  { id: "t_q_number", name: "Q1, Q2, Q3", pattern: "Q{number}" },
  { id: "t_q_padded", name: "Q01, Q02 (sorts correctly)", pattern: "Q{number:2}", notes: "Zero-padded so spreadsheets sort Q2 before Q10." },
  { id: "t_q_short", name: "Q1_SHORTNAME", pattern: "Q{number}_{shortname}" },
  { id: "t_section", name: "Section + number", pattern: "SEC{section}_Q{n_in_section:2}" },
  { id: "t_keep_code", name: "Follow the question code", pattern: "{code}" },
];
