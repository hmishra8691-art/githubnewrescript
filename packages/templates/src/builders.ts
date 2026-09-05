/**
 * Small builders used by the survey templates. They produce plain JSON that is
 * handed to `SurveyDefinition.parse` at the end, so every default the schema
 * knows about is applied exactly once, by the schema.
 */
import type { Condition, ConditionRule, ComparisonOperator, FlowNode } from "@rescript/schema";

/* ------------------------------------------------------------ conditions */

type SourceKind = "question" | "variable" | "embedded" | "calculation" | "quota" | "loop" | "option";

/** A rule on a question (by id), the common case. */
export function rule(
  ref: string,
  operator: ComparisonOperator,
  value?: unknown,
  value2?: unknown,
  extra: { kind?: SourceKind; rowCode?: string; columnId?: string; scope?: string } = {},
): ConditionRule {
  const r: ConditionRule = {
    type: "rule",
    source: { kind: extra.kind ?? "question", ref, ...(extra.rowCode ? { rowCode: extra.rowCode } : {}),
      ...(extra.columnId ? { columnId: extra.columnId } : {}), ...(extra.scope ? { scope: extra.scope } : {}) },
    operator,
  };
  if (value !== undefined) r.value = value;
  if (value2 !== undefined) r.value2 = value2;
  return r;
}
/** A rule on a calculated variable. */
export const calcRule = (name: string, op: ComparisonOperator, value?: unknown, value2?: unknown) =>
  rule(name, op, value, value2, { kind: "calculation" });
/** A rule on the CURRENT loop item — `ref` is code/label/index/count or a reference column. */
export const loopRule = (ref: string, op: ComparisonOperator, value?: unknown, scope?: string) =>
  rule(ref, op, value, undefined, { kind: "loop", scope });
export const embeddedRule = (name: string, op: ComparisonOperator, value?: unknown) =>
  rule(name, op, value, undefined, { kind: "embedded" });

export const and = (...children: Condition[]): Condition => ({ type: "group", op: "and", children });
export const or = (...children: Condition[]): Condition => ({ type: "group", op: "or", children });
export const not = (...children: Condition[]): Condition => ({ type: "group", op: "not", children });

/* ------------------------------------------------------------ options */

export interface OptSpec {
  code: string | number;
  label: string;
  flags?: string[];
  value?: string | number;
  imageUrl?: string;
  visibleIf?: Condition;
}

/** `opts(["Yes", "No"])` → codes 1..n; or pass full specs. */
export function opts(items: (string | OptSpec)[]): OptSpec[] {
  return items.map((it, i) => (typeof it === "string" ? { code: i + 1, label: it } : it));
}

export const AGREE_5 = opts(["Strongly disagree", "Disagree", "Neither agree nor disagree", "Agree", "Strongly agree"]);
export const SAT_5 = opts(["Very dissatisfied", "Dissatisfied", "Neutral", "Satisfied", "Very satisfied"]);
export const FREQ_6 = opts(["Daily", "Several times a week", "Weekly", "Monthly", "Less often", "Never"]);
export const LIKELY_5 = opts(["Very unlikely", "Unlikely", "Neither", "Likely", "Very likely"]);
export const YES_NO = opts(["Yes", "No"]);

/* ------------------------------------------------------------ flow */

export const page = (id: string, title: string, questionIds: string[], extra: Record<string, unknown> = {}): FlowNode =>
  ({ type: "page", id, title, questionIds, ...extra } as FlowNode);
export const block = (id: string, title: string, children: FlowNode[], extra: Record<string, unknown> = {}): FlowNode =>
  ({ type: "block", id, title, children, ...extra } as FlowNode);
export const section = (id: string, title: string, children: FlowNode[]): FlowNode =>
  ({ type: "section", id, title, children } as FlowNode);

/* ------------------------------------------------------------ media */

/**
 * A small inline SVG "product card" so image questions work with no network
 * and no third-party asset. Data URIs travel inside the definition JSON.
 */
export function svgTile(label: string, color: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='160' viewBox='0 0 240 160'>` +
    `<rect width='240' height='160' rx='16' fill='${color}'/>` +
    `<rect x='30' y='28' width='180' height='84' rx='10' fill='rgba(255,255,255,0.25)'/>` +
    `<text x='120' y='140' font-family='Inter,Arial,sans-serif' font-size='18' font-weight='600' fill='white' text-anchor='middle'>${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
