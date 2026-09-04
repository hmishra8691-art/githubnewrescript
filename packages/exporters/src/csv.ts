import type { SurveyDefinition } from "@rescript/schema";
import type { ResponseState } from "@rescript/engine";
import { buildVariableDictionary, flattenVariables } from "@rescript/engine";

/** The subset of a ResponseState the CSV exporter needs. */
export type ResponseStateLike = Pick<
  ResponseState,
  | "sessionId"
  | "respondentId"
  | "surveyVersion"
  | "startedAt"
  | "status"
  | "answers"
  | "embedded"
  | "calculated"
>;

/** RFC-4180 quoting: quote when the value contains comma, quote or newline. */
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = Array.isArray(value) ? value.join("|") : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvLine(cells: unknown[]): string {
  return cells.map(csvEscape).join(",");
}

const SYSTEM_COLUMNS = [
  "RESP_ID",
  "SESSION_ID",
  "SURVEY_VERSION",
  "START_TIME",
  "STATUS",
] as const;

/**
 * Export response states as CSV. Columns: the system columns, then every
 * non-system variable from the dictionary in dictionary order. Array values
 * are joined with "|".
 */
export function responsesToCSV(
  def: SurveyDefinition,
  states: ResponseStateLike[],
  /** optional per-row extra columns (e.g. the quality summary), same order as `states` */
  extra?: { columns: readonly string[]; cells: (index: number) => unknown[] },
): string {
  const dict = buildVariableDictionary(def);
  const varNames: string[] = [];
  const seen = new Set<string>();
  for (const v of dict) {
    if (v.responseType === "system") continue;
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    varNames.push(v.name);
  }

  const lines: string[] = [csvLine([...SYSTEM_COLUMNS, ...varNames, ...(extra?.columns ?? [])])];
  states.forEach((state, i) => {
    const flat = flattenVariables(def, state as any);
    const cells: unknown[] = [
      state.respondentId ?? "",
      state.sessionId,
      state.surveyVersion,
      state.startedAt,
      state.status,
      ...varNames.map((name) => flat[name]),
      ...(extra ? extra.cells(i) : []),
    ];
    lines.push(csvLine(cells));
  });
  return lines.join("\n") + "\n";
}

/** Export the variable dictionary itself as CSV. */
export function variableDictionaryToCSV(def: SurveyDefinition): string {
  const dict = buildVariableDictionary(def);
  const header = [
    "Variable",
    "Label",
    "Question",
    "Question Text",
    "Type",
    "Response Type",
    "Codes",
    "Value Labels",
    "Page",
    "Section",
    "Derived",
    "Hidden",
    "Row",
    "Column",
    "Option",
    "Notes",
  ];
  const lines = [csvLine(header)];
  for (const v of dict) {
    lines.push(
      csvLine([
        v.name,
        v.label,
        v.questionCode ?? "",
        v.questionText ?? "",
        v.dataType,
        v.responseType,
        v.valueCodes.join(","),
        Object.entries(v.valueLabels)
          .map(([code, label]) => `${code}=${label}`)
          .join("; "),
        v.pageId ?? "",
        v.sectionId ?? "",
        v.derived ? "Y" : "",
        v.hidden ? "Y" : "",
        v.rowCode ?? "",
        v.columnId ?? "",
        v.optionCode ?? "",
        v.notes ?? "",
      ]),
    );
  }
  return lines.join("\n") + "\n";
}
