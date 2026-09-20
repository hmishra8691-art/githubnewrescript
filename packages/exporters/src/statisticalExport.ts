import type { SurveyDefinition, VariableDef } from "@rescript/schema";
import { buildVariableDictionary, flattenVariables } from "@rescript/engine";
import { buildSav, savVariableFor, type SavVariable } from "./spss.js";
import { buildXpt, buildSasSyntax, sasVariableFor, type SasVariable } from "./sas.js";
import { renderValue, renderHeader, type ValueMode, type HeaderMode } from "./valueRendering.js";
import type { ResponseStateLike } from "./csv.js";
import { buildZip } from "./zip.js";

/**
 * ONE MATRIX, EVERY FORMAT (§44).
 *
 * The CSV exporter already decided what a response dataset is: the system
 * columns, then every non-system variable in dictionary order, flattened by
 * the engine. SPSS and SAS must produce exactly that — a client who opens the
 * .sav beside the .csv and finds a different column set, or the same column
 * in a different order, has two datasets and no way to tell which is the
 * study.
 *
 * So the column list is built ONCE, here, and every writer consumes it. The
 * alternative — each format walking the dictionary itself — is four
 * implementations that agree until someone changes one of them.
 */

export interface MatrixOptions {
  mediaBaseUrl?: string | null;
  /** extra columns appended after the variables (quality, sample, environment) */
  extra?: { columns: readonly string[]; cells: (index: number) => unknown[] };
}

export interface ResponseMatrix {
  /** column names, in order */
  names: string[];
  /** the dictionary entry behind each column, where there is one */
  defs: Map<string, VariableDef>;
  rows: Record<string, unknown>[];
}

/** System columns, mirroring `responsesToCSV` exactly. */
const SYSTEM: { name: string; label: string; numeric: boolean }[] = [
  { name: "RESP_ID", label: "Respondent identifier", numeric: false },
  { name: "SESSION_ID", label: "Interview session identifier", numeric: false },
  { name: "SURVEY_VERSION", label: "Questionnaire version", numeric: true },
  { name: "START_TIME", label: "Interview start time", numeric: false },
  { name: "STATUS", label: "Interview status", numeric: false },
];

export function buildResponseMatrix(
  def: SurveyDefinition,
  states: ResponseStateLike[],
  opts: MatrixOptions = {},
): ResponseMatrix {
  const dict = buildVariableDictionary(def);
  const defs = new Map<string, VariableDef>();
  const varNames: string[] = [];
  for (const v of dict) {
    if (v.responseType === "system") continue;
    if (defs.has(v.name)) continue;
    defs.set(v.name, v);
    varNames.push(v.name);
  }

  const extraColumns = [...(opts.extra?.columns ?? [])];
  const names = [...SYSTEM.map((s) => s.name), ...varNames, ...extraColumns];

  const rows = states.map((state, i) => {
    const flat = flattenVariables(def, state as any, { mediaBaseUrl: opts.mediaBaseUrl ?? null });
    const row: Record<string, unknown> = {
      RESP_ID: state.respondentId ?? "",
      SESSION_ID: state.sessionId,
      SURVEY_VERSION: state.surveyVersion,
      START_TIME: state.startedAt,
      STATUS: state.status,
    };
    for (const name of varNames) row[name] = flat[name];
    if (opts.extra) {
      const cells = opts.extra.cells(i);
      extraColumns.forEach((c, j) => { row[c] = cells[j]; });
    }
    return row;
  });

  return { names, defs, rows };
}

/**
 * A multi-select's own column holds an ARRAY of codes, which no rectangular
 * statistical format has a cell for. The per-option `VAR_<code>` 0/1 flags
 * that sit beside it are the real representation and they are already in the
 * dictionary, so the array column is flattened to a delimited string rather
 * than dropped — a data processor who wants it can still see what was picked,
 * and nobody loses the analysable form.
 */
function scalarise(value: unknown): unknown {
  return Array.isArray(value) ? value.join(";") : value;
}

/**
 * Flatten each row and move every value onto its DELIVERED column name, so
 * the row keys and the variable names the writers emit are the same strings.
 */
function rekey(
  names: string[],
  defs: Map<string, VariableDef>,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const name of names) out[outputName(defs.get(name), name)] = scalarise(r[name]);
    return out;
  });
}

/** Longest string a column actually contains, so text columns are not all 255 wide. */
function widthOf(rows: Record<string, unknown>[], name: string, cap: number): number {
  let w = 1;
  for (const r of rows) {
    const v = scalarise(r[name]);
    if (v == null) continue;
    const len = Buffer.byteLength(String(v), "utf8");
    if (len > w) w = len;
    if (w >= cap) return cap;
  }
  return w;
}

/**
 * The name a column is DELIVERED under, which is not always the name it is
 * known by inside the platform.
 *
 * `exportName` exists so a house standard can ship `S1_GENDER` while the
 * logic keeps referring to `Q1` — renaming the variable to achieve that
 * would rewrite every rule that mentions it.
 *
 * The distinction has to be kept all the way through: the writers look up
 * each row's value by the variable's name, so if the variable is renamed for
 * output without re-keying the rows, every value silently becomes missing.
 * `rekey` below does both halves together for exactly that reason.
 */
function outputName(v: VariableDef | undefined, name: string): string {
  return v?.exportName?.trim() || name;
}

function systemVariable(name: string): { label: string; numeric: boolean } | undefined {
  const s = SYSTEM.find((x) => x.name === name);
  return s ? { label: s.label, numeric: s.numeric } : undefined;
}

/**
 * SPSS (.sav) — codes in the cells, labels in the metadata.
 *
 * Note that `valueMode` is deliberately NOT accepted. In a statistical file
 * the code IS the value and the label is a property of it; writing "Male"
 * into the data would turn a nominal variable into a string one and cost the
 * user every frequency, crosstab and recode the format exists to support.
 * The brief asks for value labels "preserved as metadata, rather than simply
 * converting everything into text", and this is where that is honoured.
 */
export function responsesToSav(
  def: SurveyDefinition,
  states: ResponseStateLike[],
  opts: MatrixOptions = {},
): Buffer {
  const { names, defs, rows } = buildResponseMatrix(def, states, opts);

  const variables: SavVariable[] = names.map((name) => {
    const d = defs.get(name);
    const sys = systemVariable(name);
    if (d) {
      const v = savVariableFor(d);
      if (v.type === "string") v.stringWidth = widthOf(rows, name, 32767);
      return v;
    }
    if (sys && sys.numeric) return { name, label: sys.label, type: "numeric" };
    return { name, label: sys?.label ?? name, type: "string", stringWidth: widthOf(rows, name, 32767) };
  });

  const scalarRows = rekey(names, defs, rows);

  return buildSav({
    variables,
    rows: scalarRows,
    fileLabel: `${def.meta.code} — ${def.meta.title ?? ""}`.trim(),
  });
}

/** The SAS variable list, shared by the transport file and the syntax. */
function sasVariables(names: string[], defs: Map<string, VariableDef>, rows: Record<string, unknown>[]): SasVariable[] {
  return names.map((name) => {
    const d = defs.get(name);
    const sys = systemVariable(name);
    if (d) {
      const v = sasVariableFor(d);
      if (v.type === "string") v.stringWidth = widthOf(rows, name, 200);
      return v;
    }
    if (sys && sys.numeric) return { name, label: sys.label, type: "numeric" };
    return { name, label: sys?.label ?? name, type: "string", stringWidth: widthOf(rows, name, 200) };
  });
}

/** SAS transport file (.xpt v5). */
export function responsesToXpt(
  def: SurveyDefinition,
  states: ResponseStateLike[],
  opts: MatrixOptions = {},
): Buffer {
  const { names, defs, rows } = buildResponseMatrix(def, states, opts);
  const variables = sasVariables(names, defs, rows);
  const scalarRows = rekey(names, defs, rows);
  return buildXpt({
    variables,
    rows: scalarRows,
    datasetName: (def.meta.code ?? "SURVEY").replace(/[^A-Za-z0-9_]/g, "").slice(0, 8) || "SURVEY",
    datasetLabel: def.meta.title ?? "",
  });
}

/** The `.sas` program that labels the exported CSV. */
export function responsesToSasSyntax(
  def: SurveyDefinition,
  states: ResponseStateLike[],
  opts: MatrixOptions & { csvName?: string } = {},
): string {
  const { names, defs, rows } = buildResponseMatrix(def, states, opts);
  return buildSasSyntax(sasVariables(names, defs, rows), {
    csvName: opts.csvName ?? `${def.meta.code}_responses.csv`,
    datasetName: (def.meta.code ?? "SURVEY").replace(/[^A-Za-z0-9_]/g, "").slice(0, 32) || "SURVEY",
  });
}

/**
 * The rendered matrix behind the text formats — CSV, Excel and JSON all take
 * their cells from here, so "Labels only" means the same thing in all three.
 */
export function renderMatrix(
  matrix: ResponseMatrix,
  valueMode: ValueMode = "code",
  headerMode: HeaderMode = "name",
): { headers: string[]; rows: unknown[][] } {
  const headers = matrix.names.map((n) => renderHeader(matrix.defs.get(n), n, headerMode));
  const rows = matrix.rows.map((r) =>
    matrix.names.map((n) => renderValue(r[n], matrix.defs.get(n), valueMode)),
  );
  return { headers, rows };
}

/**
 * The SAS deliverable: a transport file, a CSV, and the syntax that labels
 * the CSV — bundled, because they are only useful together.
 *
 * Both data files are included on purpose. The transport file is the one SAS
 * opens directly but it truncates names to 8 characters and labels to 40; the
 * CSV plus syntax carries the full dictionary. Which one a given analyst
 * wants depends on their workflow, and guessing wrong means a re-export.
 */
export function responsesToSasBundle(
  def: SurveyDefinition,
  states: ResponseStateLike[],
  opts: MatrixOptions & { csv: string } = { csv: "" },
): Buffer {
  const code = def.meta.code ?? "SURVEY";
  const csvName = `${code}_responses.csv`;
  return buildZip([
    { name: csvName, data: opts.csv },
    { name: `${code}.sas`, data: responsesToSasSyntax(def, states, { ...opts, csvName }) },
    { name: `${code}.xpt`, data: responsesToXpt(def, states, opts) },
    {
      name: "README.txt",
      data: [
        `SAS export — ${code}${def.meta.title ? ` (${def.meta.title})` : ""}`,
        "",
        `${csvName}   the data, one row per response`,
        `${code}.sas         reads the CSV and applies variable labels and value labels`,
        `${code}.xpt         SAS transport (v5), opens directly but truncates names to 8`,
        "                     characters and labels to 40 — the .sas script has the full ones",
        "",
        "To use the CSV: open the .sas file, set the `path` macro variable to the",
        "folder holding the CSV, and run it.",
        "",
        `Exported ${new Date().toISOString()}`,
      ].join("\n"),
    },
  ]);
}
