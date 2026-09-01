import {
  questionTypeRegistry,
  type QuestionTypePlugin,
  type Question,
  BUILTIN_QUESTION_TYPES,
} from "@rescript/schema";
import { questionVariables } from "./variables.js";

/**
 * Built-in question type plugins. New types are added by calling
 * questionTypeRegistry.register(plugin) from any package or app —
 * the Studio editor and the runtime pick them up automatically.
 */

let seq = 0;
const nid = () => `q_${Date.now().toString(36)}${(seq++).toString(36)}`;

function baseCreate(type: string, partial?: Partial<Question>): Question {
  const id = partial?.id ?? nid();
  return {
    id,
    code: partial?.code ?? "QX",
    variableName: partial?.variableName ?? (partial?.code ?? "QX").toUpperCase(),
    type,
    text: partial?.text ?? "",
    options: [],
    rows: [],
    columns: [],
    validation: [],
    required: false,
    settings: { readOnly: false, hidden: false },
    skipLogic: [],
    ...partial,
  } as Question;
}

const CATEGORIES: Record<string, QuestionTypePlugin["category"]> = {
  single_select: "choice",
  multi_select: "choice",
  dropdown: "choice",
  multi_dropdown: "choice",
  image_select: "media",
  image_ranking: "media",
  hotspot: "media",
  ranking: "choice",
  numeric: "numeric",
  slider: "numeric",
  nps: "numeric",
  allocation: "numeric",
  numeric_list: "numeric",
  open_text: "text",
  long_text: "text",
  text_list: "text",
  date: "text",
  time: "text",
  matrix_single: "matrix",
  matrix_multi: "matrix",
  matrix_numeric: "matrix",
  matrix_text: "matrix",
  matrix_dropdown: "matrix",
  composite: "matrix",
  custom_table: "matrix",
  custom_component: "custom",
  hidden: "special",
  calculated: "special",
  embedded_data: "special",
  html: "special",
  conjoint_task: "special",
  maxdiff_task: "special",
};

const LABELS: Record<string, string> = {
  single_select: "Single select",
  multi_select: "Multi select",
  dropdown: "Dropdown",
  multi_dropdown: "Multi-select dropdown",
  numeric: "Numeric",
  open_text: "Open end (short)",
  long_text: "Open end (essay)",
  numeric_list: "Numeric list",
  text_list: "Text list",
  date: "Date",
  time: "Time",
  ranking: "Ranking",
  slider: "Slider",
  nps: "NPS (0–10)",
  matrix_single: "Matrix — single select",
  matrix_multi: "Matrix — multi select",
  matrix_numeric: "Matrix — numeric",
  matrix_text: "Matrix — text",
  matrix_dropdown: "Matrix — dropdown",
  image_select: "Image selection",
  image_ranking: "Image ranking",
  hotspot: "Image hotspot (click points)",
  allocation: "Allocation / constant sum",
  composite: "Composite (multi-column)",
  custom_table: "Custom table",
  custom_component: "Custom component",
  hidden: "Hidden variable",
  calculated: "Calculated variable",
  embedded_data: "Embedded data",
  html: "Text / HTML block",
  conjoint_task: "Conjoint tasks",
  maxdiff_task: "MaxDiff tasks",
};

function featuresFor(type: string): QuestionTypePlugin["features"] {
  const hasOptions = [
    "single_select", "multi_select", "dropdown", "multi_dropdown", "ranking",
    "image_select", "image_ranking", "allocation",
  ].includes(type);
  const hasRows = type.startsWith("matrix") || type === "composite" || type === "custom_table"
    || type === "numeric_list" || type === "text_list";
  const hasColumns = type.startsWith("matrix") || type === "composite" || type === "custom_table";
  return {
    options: hasOptions || type.startsWith("matrix"),
    rows: hasRows,
    columns: hasColumns,
    numericBounds: ["numeric", "slider", "nps", "matrix_numeric", "allocation"].includes(type),
    sum: type === "allocation",
    design: type === "conjoint_task" || type === "maxdiff_task",
  };
}

export function registerBuiltinQuestionTypes(): void {
  for (const type of BUILTIN_QUESTION_TYPES) {
    if (questionTypeRegistry.has(type)) continue;
    questionTypeRegistry.register({
      type,
      label: LABELS[type] ?? type,
      category: CATEGORIES[type] ?? "custom",
      features: featuresFor(type),
      variables: (q) => questionVariables(q),
      create: (partial) => {
        const q = baseCreate(type, partial);
        if (type === "nps") {
          q.settings.minValue = 0;
          q.settings.maxValue = 10;
        }
        if (type === "slider") {
          q.settings.minValue = q.settings.minValue ?? 0;
          q.settings.maxValue = q.settings.maxValue ?? 100;
        }
        if (type === "allocation") q.settings.sumTarget = q.settings.sumTarget ?? 100;
        return q;
      },
    });
  }
}

registerBuiltinQuestionTypes();
