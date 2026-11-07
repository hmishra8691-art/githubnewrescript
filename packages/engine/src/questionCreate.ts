import type { Question, QuestionVariantDef } from "@rescript/schema";
import { questionTypeRegistry } from "@rescript/schema";
import "./questionTypes.js";
import { defaultIds, type IdMinter } from "./questionOps.js";

/**
 * A NEW QUESTION OF A VARIANT, exactly as the Studio's picker makes one.
 *
 * This is the picker's `createFromVariant`, moved here so that every creator
 * — the picker, the command palette, the Intelligent copilot's action layer —
 * makes the same object: the base type's plugin shape, the variant id, and
 * the variant's creation defaults (settings, options, rows, columns,
 * validation, instruction, starter text, probe, AI settings). A question the
 * copilot creates is therefore indistinguishable from one a programmer added
 * by hand; there is no AI-only representation.
 */
export function createQuestionFromVariant(
  v: QuestionVariantDef,
  naming: number | { code: string; variableName: string },
  ids: IdMinter = defaultIds,
): Question {
  const { code, variableName } = typeof naming === "number" ? { code: `Q${naming}`, variableName: `Q${naming}` } : naming;
  const plugin = questionTypeRegistry.get(v.baseType);
  const q: Question = plugin
    ? plugin.create({ id: ids("q"), code, variableName })
    : ({
        id: ids("q"), code, variableName, type: v.baseType, text: "",
        options: [], rows: [], columns: [], validation: [], required: false,
        settings: { readOnly: false, hidden: false }, skipLogic: [], listLogic: [],
      } as unknown as Question);
  q.type = v.baseType;
  q.variant = v.id;
  // creation: defaults land directly
  if (v.defaults?.settings) q.settings = { ...q.settings, ...v.defaults.settings } as never;
  if (v.defaults?.options) q.options = v.defaults.options.map((o) => ({ flags: [], ...o })) as never;
  if (v.defaults?.rows) q.rows = v.defaults.rows.map((r) => ({ flags: [], validation: [], required: false, ...r })) as never;
  if (v.defaults?.columns) {
    q.columns = v.defaults.columns.map((c, i) => ({
      options: [], validation: [], readOnly: false,
      variableStem: `${q.variableName}_C${i + 1}`,
      ...c,
    })) as never;
  }
  if (v.defaults?.validation) q.validation = v.defaults.validation as never;
  if (v.defaults?.instruction) q.instruction = v.defaults.instruction;
  // recipe presets: a starter text and a follow-up probe already switched on
  if (v.defaults?.text) q.text = v.defaults.text;
  if (v.defaults?.probe) q.probe = v.defaults.probe as never;
  if (v.defaults?.ai) q.ai = v.defaults.ai as never;
  if (v.defaults?.randomization) q.randomization = { ...v.defaults.randomization } as never;
  return q;
}

/**
 * STARTER OPTIONS FOR A NEW CHOICE QUESTION (audit 2026-11-07) — three numbered placeholders on a Single / Multi
 * Select, Dropdown, Image Select, Ranking or Constant Sum that has none and carries nothing forward. The Studio's
 * picker applies it; the copilot and imports bring their own options and do not.
 */
export const STARTER_OPTION_TYPES: ReadonlySet<string> = new Set(["single_select", "multi_select", "dropdown", "multi_dropdown", "image_select", "ranking", "image_ranking", "allocation"]);
export function withStarterOptions(q: Question, ids: IdMinter = defaultIds): Question {
  if (STARTER_OPTION_TYPES.has(q.type) && !(q.options ?? []).length && !q.carryForward) {
    q.options = [1, 2, 3].map((n) => ({ id: ids("opt"), code: n, label: `Option ${n}`, flags: [] })) as never;
  }
  /* a single / multi / dropdown grid gets a five-point scale, a cell grid two rows and two columns — the matrices arrived with rows and nothing to click */
  if (["matrix_single", "matrix_multi", "matrix_dropdown"].includes(q.type) && !(q.options ?? []).length && !q.carryForward && !(q.columns ?? []).length) {
    const scale = q.type === "matrix_single" ? ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"] : ["Column 1", "Column 2", "Column 3"];
    q.options = scale.map((label, i) => ({ id: ids("opt"), code: i + 1, label, flags: [] })) as never;
  }
  if ((q.type === "composite" || q.type === "custom_table") && !(q.columns ?? []).length) {
    if (!(q.rows ?? []).length) q.rows = [1, 2].map((n) => ({ code: `r${n}`, label: `Row ${n}`, flags: [], validation: [], required: false })) as never;
    q.columns = [["text", "Text"], ["numeric", "Number"]].map(([responseType, label], i) => ({ id: ids("col"), label, responseType, variableStem: `${q.variableName}_C${i + 1}`, options: [], validation: [], readOnly: false })) as never;
  }
  return q;
}
