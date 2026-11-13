import type { VariableMeta } from "./dataset.js";
import type { AnalysisDefinition } from "./types.js";

/**
 * WHOLE TABLES IN ONE STEP (2026-11-16) — what the cross-tab builder's quick actions and Intelligent Mode both call.
 *
 * Building a banner run used to mean ticking every question into Rows one at a time, and a looped or grid question
 * came out as one table per variable. These read the variable list and return the rows and options of the table a
 * researcher means:
 *
 *   allQuestionsTable   every question that can be tabulated, down the side of one banner table
 *   variableGroups      the sets that ask one thing many times — a loop's passes, a grid's statements
 *   itemTableFor        one of those sets as ONE table, a row per item (analyses/itemTable.ts)
 *
 * Pure functions of the dictionary: nothing here reads responses.
 */
const TABULABLE = new Set(["categorical", "multi", "scale", "numeric"]);

/** the variables a table can be built from: answered questions, not bookkeeping, not text, not a grid's parent */
export function tabulableVariables(variables: VariableMeta[]): VariableMeta[] {
  return variables.filter((v) => !v.hidden && !v.derived && TABULABLE.has(v.role) && !v.name.startsWith("_"));
}

export interface TablePreset { rows: string[]; columns: string[]; options: Record<string, unknown> }

/** every question down the side, the banner across the top, in one table */
export function allQuestionsTable(variables: VariableMeta[], columns: string[], opts: { sectionId?: string; exclude?: string[] } = {}): TablePreset {
  const skip = new Set([...columns, ...(opts.exclude ?? [])]);
  const rows = tabulableVariables(variables).filter((v) => !skip.has(v.name) && (!opts.sectionId || v.sectionId === opts.sectionId)).map((v) => v.name);
  return { rows, columns, options: { layout: "banner", stackRows: true } };
}

export interface VariableGroup {
  key: string;
  kind: "loop" | "grid";
  /** the question the set measures */
  label: string;
  questionCode?: string;
  questionId?: string;
  variables: string[];
  /** a 0–10 recommendation question: the table leads with NPS */
  nps: boolean;
  size: number;
}

const stripPass = (label: string) => label.replace(/\s*\([^()]*\b\d+\)\s*$/, "");

/** the sets of variables that ask the same thing: the passes of a looped question, the statements of a grid */
export function variableGroups(variables: VariableMeta[]): VariableGroup[] {
  const groups = new Map<string, { kind: "loop" | "grid"; metas: VariableMeta[] }>();
  for (const v of tabulableVariables(variables)) {
    if (!v.questionId) continue;
    if (v.loopId && v.iteration != null) {
      const key = `loop:${v.questionId}:${v.rowCode ?? ""}:${v.optionCode ?? ""}`;
      const g = groups.get(key) ?? { kind: "loop" as const, metas: [] };
      g.metas.push(v); groups.set(key, g);
    } else if (v.rowCode != null && v.optionCode == null) {
      const key = `grid:${v.questionId}`;
      const g = groups.get(key) ?? { kind: "grid" as const, metas: [] };
      g.metas.push(v); groups.set(key, g);
    }
  }
  const out: VariableGroup[] = [];
  for (const [key, g] of groups) {
    if (g.metas.length < 2) continue;
    const first = g.metas[0];
    const label = g.kind === "loop" ? stripPass(first.label) : (first.itemLabel && first.label.includes(first.itemLabel) ? first.label.replace(first.itemLabel, "").replace(/[\s—:·-]+$/, "") : first.label) || first.questionCode || first.name;
    out.push({ key, kind: g.kind, label: label.trim() || first.questionCode || first.name, questionCode: first.questionCode, questionId: first.questionId, variables: g.metas.map((m) => m.name), nps: g.metas.every((m) => m.nps === true), size: g.metas.length });
  }
  return out;
}

/** one set as one table, a row per item; with a banner, one statistic per column */
export function itemTableFor(group: Pick<VariableGroup, "variables" | "nps">, columns: string[] = [], opts: { stat?: string; transpose?: boolean } = {}): TablePreset {
  return { rows: [...group.variables], columns, options: { layout: "items", ...(opts.stat ? { itemStat: opts.stat } : group.nps && columns.length ? { itemStat: "nps" } : {}), ...(opts.transpose ? { transpose: true } : {}) } };
}

/** lay a preset over a definition: rows, columns and only the options the preset speaks about */
export function applyTablePreset(def: AnalysisDefinition, preset: TablePreset): AnalysisDefinition {
  const options = { ...(def.options ?? {}) };
  /* leaving the item layout: its own switches go with it */
  if (preset.options.layout !== "items") { delete options.itemStat; delete options.itemStats; delete options.transpose; }
  return { ...def, kind: "crosstab", rows: preset.rows, columns: preset.columns, options: { ...options, ...preset.options } };
}
