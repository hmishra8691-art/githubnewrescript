import type { Condition, ConditionRule, SurveyDefinition, VariableDef } from "@rescript/schema";
import { buildVariableDictionary, conditionSummary, gridAxes, isVacuousCondition, listPages } from "@rescript/engine";

/**
 * WHO WAS ASKED EACH QUESTION, AS SPSS SYNTAX.
 *
 * A `.sav` carries values and labels, not routing: an empty cell means "not
 * asked" for one respondent and "skipped" for another, and the file cannot
 * say which. This writes the survey's own logic — a page's condition AND the
 * question's display logic, nested exactly as programmed — as one ASKED_<var>
 * flag per conditional question, so an analyst can `FILTER BY ASKED_Q5` and
 * read every percentage on its true base.
 *
 * Only what has an exact SPSS spelling is written: a choice, a value
 * comparison, answered / not answered, a grid cell, AND / OR / NOT at any
 * depth. A rule that has none (a COUNT, a calculation, a named expression, a
 * loop value) makes that question's flag a commented line naming the reason
 * — never an approximation that would put the wrong people in a base.
 */
export function spssBasesSyntax(def: SurveyDefinition): string {
  const dict = buildVariableDictionary(def);
  const pages = listPages(def.flow as unknown[]).map((p) => p.node as { id: string; questionIds: string[]; visibleIf?: Condition });
  const lines: string[] = [
    "* ---------------------------------------------------------------------------.",
    `* Bases for ${def.meta.code ?? "SURVEY"}${def.meta.title ? ` (${def.meta.title.replace(/[\r\n]+/g, " ")})` : ""}.`,
    "* ASKED_<variable> = 1 when the respondent met the question's conditions",
    "* (its page's condition AND its display logic), 0 otherwise.",
    "* Use it as the base:  FILTER BY ASKED_Q5.  ...  FILTER OFF.",
    "* Generated from the survey definition; run it after opening the .sav.",
    "* ---------------------------------------------------------------------------.",
    "",
  ];
  let written = 0;
  for (const q of def.questions) {
    const page = pages.find((p) => p.questionIds.includes(q.id));
    const conds = [page?.visibleIf, q.displayLogic].filter((c): c is Condition => !!c && !isVacuousCondition(c));
    if (!conds.length) continue;
    const base = (dict.find((v) => v.questionId === q.id)?.exportName || q.variableName || q.code).replace(/[^A-Za-z0-9_@#$.]/g, "_");
    const flag = spssName(`ASKED_${base}`);
    const words = conds.map((c) => conditionSummary(def, c)).join(" AND ");
    const parts = conds.map((c) => toSpss(def, dict, c));
    const missing = parts.find((p) => p.error);
    lines.push(`* ${q.code}: ${words.replace(/[\r\n]+/g, " ")}.`);
    if (missing) {
      lines.push(`* ${flag} not written — ${missing.error}. Filter this base by hand.`, "");
      continue;
    }
    lines.push(
      `COMPUTE ${flag} = 0.`,
      `IF (${parts.map((p) => p.text).join(" AND ")}) ${flag} = 1.`,
      `VARIABLE LABELS ${flag} '${quote(`Asked ${q.code}`)}'.`,
      `VALUE LABELS ${flag} 0 'Not asked' 1 'Asked'.`,
      "",
    );
    written += 1;
  }
  if (!written) lines.push("* No question in this survey is conditional: every base is everyone.");
  else lines.push("EXECUTE.");
  return lines.join("\n") + "\n";
}

type Out = { text: string; error?: undefined } | { text?: undefined; error: string };

function toSpss(def: SurveyDefinition, dict: VariableDef[], c: Condition, depth = 0): Out {
  if (depth > 64) return { error: "it nests too deeply" };
  if (c.type === "group") {
    const kids = c.children.filter((k) => !isVacuousCondition(k)).map((k) => toSpss(def, dict, k, depth + 1));
    const bad = kids.find((k) => k.error);
    if (bad) return bad;
    const texts = kids.map((k) => k.text!);
    if (!texts.length) return { text: "1 = 1" };
    if (c.op === "not") return { text: `NOT (${texts.join(" OR ")})` };
    return { text: texts.length === 1 ? texts[0] : `(${texts.join(c.op === "or" ? " OR " : " AND ")})` };
  }
  return rule(def, dict, c);
}

const NUM_OPS: Record<string, string> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

function rule(def: SurveyDefinition, dict: VariableDef[], r: ConditionRule): Out {
  const src = r.source;
  if (src.kind !== "question") return { error: `it reads a ${src.kind} value, which the data file does not carry as a variable` };
  if (src.count) return { error: "it is a COUNT" };
  if (src.rowPosition != null || src.optionPosition != null) return { error: "it names a position in a dynamic list" };
  const q = def.questions.find((x) => x.id === src.ref || x.code === src.ref || x.variableName === src.ref);
  if (!q) return { error: `it reads ${src.ref}, which is not in the survey` };
  if (r.value && typeof r.value === "object" && !Array.isArray(r.value)) return { error: "it compares with another answer" };
  const vars = dict.filter((v) => v.questionId === q.id && !v.loopVar);
  const nameOf = (v: VariableDef) => v.exportName || v.name;
  const val = (x: unknown) => (typeof x === "number" || /^-?\d+(\.\d+)?$/.test(String(x)) ? String(x) : `'${quote(String(x))}'`);

  /* a grid cell, a row (any column), or a constant-sum option */
  if (src.rowCode != null) {
    const cells = vars.filter((v) => String(v.rowCode ?? v.optionCode) === String(src.rowCode) && (src.columnId == null || v.columnId === src.columnId || (gridAxes(q).columnMeaning === "option_code" && v.optionCode === src.columnId)));
    if (!cells.length) return { error: `no exported variable holds ${q.code} row ${src.rowCode}` };
    const one = (v: VariableDef) => compare(nameOf(v), r, val);
    const outs = cells.map(one);
    const bad = outs.find((o) => o.error);
    if (bad) return bad;
    if (outs.length === 1) return outs[0];
    /* the engine's reading of a row with no column: ANY cell (a negated test: no cell) */
    const neg = ["ne", "notIn", "notSelected", "unanswered", "notContains"].includes(r.operator);
    return { text: `(${outs.map((o) => o.text).join(neg ? " AND " : " OR ")})` };
  }

  /* a multi-choice question: one 0/1 variable per option */
  const perOption = vars.filter((v) => v.optionCode != null && v.rowCode == null);
  if (perOption.length && (r.operator === "selected" || r.operator === "notSelected" || r.operator === "eq" || r.operator === "ne" || r.operator === "in" || r.operator === "notIn" || r.operator === "containsAny" || r.operator === "containsAll" || r.operator === "containsNone" || r.operator === "answered" || r.operator === "unanswered")) {
    const codes = (Array.isArray(r.value) ? r.value : r.value == null ? [] : [r.value]).map(String);
    const varFor = (code: string) => perOption.find((v) => String(v.optionCode) === code);
    if (r.operator === "answered" || r.operator === "unanswered") {
      const any = `ANY(1, ${perOption.map(nameOf).join(", ")})`;
      return { text: r.operator === "answered" ? any : `NOT ${any}` };
    }
    const named = codes.map(varFor);
    if (named.some((v) => !v)) return { error: `${q.code} has no exported variable for code ${codes.find((c) => !varFor(c))}` };
    const isOne = named.map((v) => `${nameOf(v!)} = 1`);
    const all = r.operator === "containsAll";
    const none = r.operator === "notSelected" || r.operator === "ne" || r.operator === "notIn" || r.operator === "containsNone";
    const joined = isOne.length === 1 ? isOne[0] : `(${isOne.join(all ? " AND " : " OR ")})`;
    return { text: none ? `NOT ${joined}` : joined };
  }

  const scalar = vars.find((v) => v.optionCode == null && v.rowCode == null && v.columnId == null) ?? vars[0];
  if (!scalar) return { error: `${q.code} has no exported variable` };
  return compare(nameOf(scalar), r, val);
}

function compare(name: string, r: ConditionRule, val: (x: unknown) => string): Out {
  const op = r.operator;
  if (op === "answered") return { text: `NOT MISSING(${name})` };
  if (op === "unanswered") return { text: `MISSING(${name})` };
  if (op === "selected") return { text: `${name} = ${val(r.value)}` };
  if (op === "notSelected") return { text: `${name} <> ${val(r.value)}` };
  if (NUM_OPS[op]) return { text: `${name} ${NUM_OPS[op]} ${val(r.value)}` };
  if (op === "between") return { text: `RANGE(${name}, ${val(r.value)}, ${val(r.value2)})` };
  if (op === "notBetween") return { text: `NOT RANGE(${name}, ${val(r.value)}, ${val(r.value2)})` };
  if (op === "in" || op === "notIn") {
    const list = (Array.isArray(r.value) ? r.value : [r.value]).map(val).join(", ");
    return { text: `${op === "notIn" ? "NOT " : ""}ANY(${name}, ${list})` };
  }
  if (op === "contains") return { text: `CHAR.INDEX(UPCASE(${name}), UPCASE(${val(r.value)})) > 0` };
  if (op === "notContains") return { text: `CHAR.INDEX(UPCASE(${name}), UPCASE(${val(r.value)})) = 0` };
  return { error: `its operator (${op}) has no SPSS spelling` };
}

const quote = (s: string) => s.replace(/'/g, "''").slice(0, 240);
const spssName = (s: string) => s.slice(0, 64);
