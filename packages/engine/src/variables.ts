import type { SurveyDefinition, Question, VariableDef, FlowNode } from "@rescript/schema";
import {
  directChildLoops, directQuestionIdsInLoop, loopNodes, loopVariableNames, maxLoopIterations,
  possibleLoopItems, type LoopFlowNode,
} from "./loops.js";
import { listFillVariableNames } from "./listFill.js";
import { fieldDataType } from "./fields.js";

/**
 * Variable / Data Dictionary generator (requirement §9).
 * Derives the full variable list from the programmed survey so the
 * dictionary is always consistent with the instrument.
 */

function valueMap(q: { options: { code: string | number; label: string }[] }): {
  codes: (string | number)[];
  labels: Record<string, string>;
} {
  const codes = q.options.map((o) => o.code);
  const labels: Record<string, string> = {};
  for (const o of q.options) labels[String(o.code)] = o.label;
  return { codes, labels };
}

function pageLocator(def: SurveyDefinition): Map<string, { pageId: string; sectionId?: string }> {
  const map = new Map<string, { pageId: string; sectionId?: string }>();
  const walk = (nodes: FlowNode[], section?: string): void => {
    for (const n of nodes) {
      if (n.type === "page") {
        for (const qid of n.questionIds) map.set(qid, { pageId: n.id, sectionId: section });
      } else if (n.type === "section" || n.type === "block") {
        walk(n.children, n.type === "section" ? (n.title ?? n.id) : section);
      } else if (n.type === "branch") {
        for (const b of n.branches) walk(b.children, section);
        if (n.otherwise) walk(n.otherwise, section);
      } else if (n.type === "loop" || n.type === "randomizer") {
        walk(n.children, section);
      }
    }
  };
  walk(def.flow);
  return map;
}

const strip = (html: string) => html.replace(/<[^>]*>/g, "").replace(/\{\{[^}]*\}\}/g, "…").trim();

/** Rows for dictionary purposes: static rows, or the carry-forward source's
 *  full option universe when rows are dynamic. */
function dictionaryRows(q: Question, all?: Question[]): Question["rows"] {
  if (q.rows.length || !q.carryForward || q.carryForward.into !== "rows") return q.rows;
  const src = all?.find((x) => x.id === q.carryForward!.sourceQuestionId);
  if (!src) return q.rows;
  return src.options.map((o) => ({
    code: o.code,
    label: o.label,
    flags: [],
    validation: [],
    required: false,
  }));
}

export function questionVariables(
  q: Question,
  loc?: { pageId: string; sectionId?: string },
  all?: Question[],
): VariableDef[] {
  const rows = dictionaryRows(q, all);
  const base = {
    questionId: q.id,
    questionCode: q.code,
    questionText: strip(q.text),
    pageId: loc?.pageId,
    sectionId: loc?.sectionId,
    hidden: q.settings.hidden || q.type === "hidden",
    derived: q.type === "calculated",
    responseType: q.type,
  };
  const out: VariableDef[] = [];
  const push = (v: Partial<VariableDef> & Pick<VariableDef, "name" | "label" | "dataType">) =>
    out.push({
      valueCodes: [],
      valueLabels: {},
      ...base,
      ...v,
    } as VariableDef);

  switch (q.type) {
    case "single_select":
    case "dropdown":
    case "image_select": {
      const { codes, labels } = valueMap(q);
      push({ name: q.variableName, label: strip(q.text) || q.code, dataType: "numeric", valueCodes: codes, valueLabels: labels });
      if (q.options.some((o) => o.flags?.includes("other_specify")))
        push({ name: `${q.variableName}_other`, label: `${q.code} — Other (specify)`, dataType: "text" });
      break;
    }
    case "multi_select":
    case "multi_dropdown": {
      const { labels } = valueMap(q);
      for (const opt of q.options) {
        push({
          name: `${q.variableName}_${opt.code}`,
          label: `${q.code} — ${opt.label}`,
          dataType: "numeric",
          valueCodes: [0, 1],
          valueLabels: { "0": "Not selected", "1": "Selected" },
          optionCode: String(opt.code),
        });
      }
      if (q.options.some((o) => o.flags?.includes("other_specify")))
        push({ name: `${q.variableName}_other`, label: `${q.code} — Other (specify)`, dataType: "text" });
      void labels;
      break;
    }
    case "numeric":
    case "slider":
    case "nps":
      push({ name: q.variableName, label: strip(q.text) || q.code, dataType: "numeric" });
      break;
    case "open_text":
    case "long_text":
      push({ name: q.variableName, label: strip(q.text) || q.code, dataType: "text" });
      break;
    case "date":
      push({ name: q.variableName, label: strip(q.text) || q.code, dataType: "date" });
      break;
    case "time":
      push({ name: q.variableName, label: strip(q.text) || q.code, dataType: "time" });
      break;
    case "numeric_list":
    case "text_list": {
      if (q.rows.length > 0) {
        // labeled form fields — one variable per row, typed by fieldType
        for (const row of q.rows) {
          push({
            name: `${q.variableName}_${row.code}`,
            label: `${q.code} — ${strip(row.label)}`,
            dataType: fieldDataType(row.fieldType ?? (q.type === "numeric_list" ? "number" : "text")),
            rowCode: String(row.code),
          });
        }
      } else {
        const n = q.settings.listCount ?? 1;
        for (let i = 1; i <= n; i++) {
          push({
            name: `${q.variableName}_${i}`,
            label: `${q.code} — item ${i}`,
            dataType: q.type === "numeric_list" ? "numeric" : "text",
          });
        }
      }
      break;
    }
    case "ranking":
    case "image_ranking": {
      for (const opt of q.options) {
        push({
          name: `${q.variableName}_${opt.code}`,
          label: `${q.code} — rank of ${opt.label}`,
          dataType: "numeric",
          optionCode: String(opt.code),
        });
      }
      break;
    }
    case "allocation": {
      for (const opt of q.options) {
        push({
          name: `${q.variableName}_${opt.code}`,
          label: `${q.code} — ${opt.label}${q.settings.sumUnit ? ` (${q.settings.sumUnit})` : ""}`,
          dataType: "numeric",
          optionCode: String(opt.code),
        });
      }
      push({ name: `${q.variableName}_total`, label: `${q.code} — total`, dataType: "numeric", derived: true });
      break;
    }
    case "matrix_single":
    case "matrix_dropdown": {
      const colOpts = q.columns[0]?.options?.length ? q.columns[0].options : q.options;
      const labels: Record<string, string> = {};
      for (const o of colOpts) labels[String(o.code)] = o.label;
      for (const row of rows) {
        push({
          name: `${q.variableName}_${row.code}`,
          label: `${q.code} — ${row.label}`,
          dataType: "numeric",
          valueCodes: colOpts.map((o) => o.code),
          valueLabels: labels,
          rowCode: String(row.code),
        });
      }
      break;
    }
    case "matrix_multi": {
      const colOpts = q.columns[0]?.options?.length ? q.columns[0].options : q.options;
      for (const row of rows) {
        for (const opt of colOpts) {
          push({
            name: `${q.variableName}_${row.code}_${opt.code}`,
            label: `${q.code} — ${row.label} / ${opt.label}`,
            dataType: "numeric",
            valueCodes: [0, 1],
            valueLabels: { "0": "Not selected", "1": "Selected" },
            rowCode: String(row.code),
            optionCode: String(opt.code),
          });
        }
      }
      break;
    }
    case "matrix_numeric": {
      for (const row of rows) {
        push({ name: `${q.variableName}_${row.code}`, label: `${q.code} — ${row.label}`, dataType: "numeric", rowCode: String(row.code) });
      }
      break;
    }
    case "matrix_text": {
      for (const row of rows) {
        push({ name: `${q.variableName}_${row.code}`, label: `${q.code} — ${row.label}`, dataType: "text", rowCode: String(row.code) });
      }
      break;
    }
    case "composite":
    case "custom_table": {
      // one variable per row × column — each column with its own type/codes
      for (const col of q.columns) {
        const dt =
          col.responseType === "numeric" || col.responseType === "slider"
            ? "numeric"
            : col.responseType === "date"
              ? "date"
              : col.responseType === "time"
                ? "time"
                : col.responseType === "single" || col.responseType === "dropdown"
                  ? "numeric"
                  : "text";
        for (const row of rows) {
          if (col.responseType === "multi" || col.responseType === "multi_dropdown") {
            for (const opt of col.options) {
              push({
                name: `${col.variableStem}_${row.code}_${opt.code}`,
                label: `${q.code} — ${row.label} / ${col.label} / ${opt.label}`,
                dataType: "numeric",
                valueCodes: [0, 1],
                valueLabels: { "0": "Not selected", "1": "Selected" },
                rowCode: String(row.code),
                columnId: col.id,
                optionCode: String(opt.code),
              });
            }
          } else {
            const labels: Record<string, string> = {};
            for (const o of col.options) labels[String(o.code)] = o.label;
            push({
              name: `${col.variableStem}_${row.code}`,
              label: `${q.code} — ${row.label} / ${col.label}`,
              dataType: dt,
              valueCodes: col.options.map((o) => o.code),
              valueLabels: labels,
              rowCode: String(row.code),
              columnId: col.id,
              derived: !!col.expression,
            });
          }
        }
      }
      break;
    }
    case "hotspot": {
      const points = Math.max(1, Math.min(q.settings.maxSelections ?? 1, 20));
      for (let i = 1; i <= points; i++) {
        push({ name: `${q.variableName}_${i}_X`, label: `${q.code} — point ${i} X (%)`, dataType: "numeric" });
        push({ name: `${q.variableName}_${i}_Y`, label: `${q.code} — point ${i} Y (%)`, dataType: "numeric" });
      }
      break;
    }
    case "hidden":
      push({ name: q.variableName, label: strip(q.text) || q.code, dataType: "text", hidden: true });
      break;
    case "calculated":
      push({ name: q.variableName, label: strip(q.text) || q.code, dataType: "numeric", derived: true });
      break;
    case "embedded_data":
      push({ name: q.variableName, label: strip(q.text) || q.code, dataType: "text" });
      break;
    case "html":
      break; // display-only, no variables
    case "conjoint_task":
    case "maxdiff_task": {
      // one choice variable per task row of the referenced design
      push({ name: `${q.variableName}_TASKS`, label: `${q.code} — task responses`, dataType: "text", notes: "One column per task expanded at export from the design file." });
      break;
    }
    case "annotation": {
      push({ name: `${q.variableName}_PINS`, label: `${q.code} — number of pins`, dataType: "numeric" });
      push({ name: `${q.variableName}_STROKES`, label: `${q.code} — number of strokes`, dataType: "numeric" });
      push({ name: `${q.variableName}_JSON`, label: `${q.code} — marks (JSON)`, dataType: "text",
        notes: "Pins as {x,y,comment} percentages and strokes as point lists." });
      break;
    }
    case "media_timeline": {
      push({ name: `${q.variableName}_N`, label: `${q.code} — number of reactions`, dataType: "numeric" });
      push({ name: `${q.variableName}_JSON`, label: `${q.code} — reactions (JSON)`, dataType: "text",
        notes: "Each reaction is {t: seconds, code} — code is the option chosen, or 1 for a plain tap." });
      for (const o of q.options ?? []) {
        push({ name: `${q.variableName}_${o.code}_N`, label: `${q.code} — ${strip(o.label)} count`, dataType: "numeric" });
      }
      break;
    }
    case "upload": {
      const n = Math.max(1, q.settings.maxFiles ?? 1);
      for (let i = 1; i <= n; i++) {
        const stem = n === 1 ? q.variableName : `${q.variableName}_${i}`;
        push({ name: `${stem}_URL`, label: `${q.code} — file ${n === 1 ? "" : i + " "}URL`.replace("  ", " "), dataType: "text" });
        push({ name: `${stem}_NAME`, label: `${q.code} — file ${n === 1 ? "" : i + " "}name`.replace("  ", " "), dataType: "text" });
        push({ name: `${stem}_SIZE`, label: `${q.code} — file ${n === 1 ? "" : i + " "}size (bytes)`.replace("  ", " "), dataType: "numeric" });
      }
      break;
    }
    case "repeating_group": {
      // array of records → VAR_<i>_<row> up to the cap
      const n = Math.max(1, q.settings.maxRepeats ?? 10);
      push({ name: `${q.variableName}_N`, label: `${q.code} — number of entries`, dataType: "numeric" });
      for (let i = 1; i <= n; i++) {
        for (const r of q.rows ?? []) {
          push({
            name: `${q.variableName}_${i}_${r.code}`,
            label: `${q.code} — entry ${i}: ${strip(r.label)}`,
            dataType: r.fieldType && ["number", "decimal", "integer", "currency"].includes(r.fieldType) ? "numeric" : "text",
          });
        }
      }
      break;
    }
    case "experiment": {
      push({
        name: q.variableName, label: strip(q.text) || `${q.code} — assigned arm`, dataType: "text",
        valueLabels: Object.fromEntries((q.settings.arms ?? []).map((a) => [String(a.code), a.label])),
      });
      break;
    }
    default:
      push({ name: q.variableName, label: strip(q.text) || q.code, dataType: "text" });
  }

  // ---- gamified / experimental families (variant batch) ----
  // Side data stored beside the answer under `<id>__<suffix>` (see
  // variants/shared.tsx setSide) needs a column of its own, or a quiz score
  // and a reaction time would be captured and then never exported.
  if (q.options.some((o) => o.meta?.correct)) {
    push({
      name: `${q.variableName}_CORRECT`, label: `${q.code} — answered correctly`,
      dataType: "numeric", valueCodes: [0, 1], valueLabels: { "0": "Incorrect", "1": "Correct" },
      derived: true,
    });
  }
  // keyed to the variant, not to `timeLimitSeconds`: other families use a time
  // limit for other things (a media stimulus, a page clock) and must not
  // silently gain two reaction-time columns
  if (q.variant === "gamified.timed") {
    push({ name: `${q.variableName}_RT`, label: `${q.code} — response time (ms)`, dataType: "numeric", derived: true });
    push({
      name: `${q.variableName}_TIMEOUT`, label: `${q.code} — ran out of time`,
      dataType: "numeric", valueCodes: [0, 1], valueLabels: { "0": "Answered in time", "1": "Timed out" },
      derived: true,
    });
  }
  if (q.settings.expectedCodes?.length) {
    push({
      name: `${q.variableName}_PASSED`, label: `${q.code} — attention check passed`,
      dataType: "numeric", valueCodes: [0, 1], valueLabels: { "0": "Failed", "1": "Passed" },
      derived: true,
    });
  }
  if (q.variant === "experimental.reaction_time") {
    for (const row of rows) {
      push({
        name: `${q.variableName}_${row.code}_RT`,
        label: `${q.code} — ${strip(row.label)} response time (ms)`,
        dataType: "numeric", rowCode: String(row.code), derived: true,
      });
    }
  }
  if (q.variant === "gamified.matching" && rows.some((r) => r.meta?.answer != null)
    && !q.options.some((o) => o.meta?.correct)) {
    push({ name: `${q.variableName}_CORRECT`, label: `${q.code} — pairs matched correctly`, dataType: "numeric", derived: true });
  }
  return out;
}

/** Build the full dictionary for a survey definition. */
export function buildVariableDictionary(def: SurveyDefinition): VariableDef[] {
  const loc = pageLocator(def);
  const out: VariableDef[] = [];

  /*
   * QUESTIONS INSIDE A LOOP ARE DECLARED ONCE PER ITERATION (§29, §37) —
   * `Q7_1 … Q7_N`, N being the most iterations the definition allows — so the
   * export has the same columns before the first respondent and after the
   * last. A question inside a loop used to get one plain `Q7` row, which no
   * answer ever filled, while its real values sat under names the dictionary
   * had never heard of and were dropped from every CSV.
   *
   * A loop whose size the definition cannot know (a count from a variable, a
   * list from a variable) keeps the plain row, annotated, so the question at
   * least appears; its answers remain reachable by code and the lint says why
   * there are no positional columns.
   */
  const loopOf = new Map<string, { chain: LoopFlowNode[]; positions: number[][] }>();
  const declareLoop = (node: LoopFlowNode, chain: LoopFlowNode[], positionsSoFar: number[][]) => {
    const max = maxLoopIterations(def, node);
    const positions: number[][] = [];
    if (max != null) {
      for (const prefix of positionsSoFar.length ? positionsSoFar : [[]]) {
        for (let n = 1; n <= max; n++) positions.push([...prefix, n]);
      }
    }
    for (const qid of directQuestionIdsInLoop(node)) loopOf.set(qid, { chain: [...chain, node], positions });
    for (const child of directChildLoops(node)) declareLoop(child, [...chain, node], positions);
  };
  for (const { node, ancestors } of loopNodes(def)) {
    if (ancestors.length === 0) declareLoop(node, [], []);
  }

  for (const q of def.questions) {
    const inLoop = loopOf.get(q.id);
    if (!inLoop || inLoop.positions.length === 0) {
      const base = questionVariables(q, loc.get(q.id), def.questions);
      if (inLoop) {
        const innermost = inLoop.chain[inLoop.chain.length - 1];
        for (const v of base) {
          v.loopId = innermost.id; v.loopVar = innermost.loopVar;
          v.notes = `${v.notes ? `${v.notes} — ` : ""}inside loop "${innermost.loopVar}", whose size is not fixed by the definition: stored per iteration, no positional columns declared`;
        }
      }
      out.push(...base);
      continue;
    }
    const innermost = inLoop.chain[inLoop.chain.length - 1];
    for (const pos of inLoop.positions) {
      const suffix = pos.map((n) => `_${n}`).join("");
      // the SAME variable shapes as outside a loop, renamed per position, so a
      // multi-select still exports its 0/1 columns and a matrix its rows
      const renamed = { ...q, variableName: `${q.variableName}${suffix}` } as typeof q;
      for (const v of questionVariables(renamed, loc.get(q.id), def.questions)) {
        out.push({
          ...v,
          loopId: innermost.id,
          loopVar: innermost.loopVar,
          iteration: pos[pos.length - 1],
          label: `${v.label} (${inLoop.chain.map((l, i) => `${l.loopVar} ${pos[i]}`).join(", ")})`,
          notes: `${v.notes ? `${v.notes} — ` : ""}iteration ${pos.join(".")} of loop "${inLoop.chain.map((l) => l.loopVar).join(" › ")}"`,
        });
      }
    }
  }
  for (const calc of def.calculations) {
    out.push({
      name: calc.targetVariable,
      label: calc.label ?? calc.targetVariable,
      dataType: calc.dataType === "text" ? "text" : calc.dataType === "boolean" ? "boolean" : "numeric",
      responseType: "calculation",
      derived: true,
      hidden: true,
      valueCodes: [],
      valueLabels: {},
      notes: `= ${calc.expression}`,
    });
  }
  for (const ed of def.embeddedData) {
    out.push({
      name: ed.name,
      label: ed.label ?? ed.name,
      dataType: "text",
      responseType: "embedded_data",
      derived: false,
      hidden: true,
      valueCodes: [],
      valueLabels: {},
      notes: ed.source,
    });
  }
  /*
   * List Fill variables (§23, §34).
   *
   * They are declared here, from the configuration, rather than discovered
   * from data — so the dictionary, the CSV and XLSX exports and the SPSS
   * labels all carry a column for every allocated position from the moment
   * the list is configured, before a single respondent has run. A column that
   * only appears once someone happens to be allocated to it is how an export
   * silently changes shape between waves.
   */
  for (const lf of def.listFills) {
    const source = lf.source.kind === "question"
      ? def.questions.find((q) => q.id === (lf.source as { questionId: string }).questionId)
      : undefined;
    const codes = lf.options.length
      ? lf.options.map((o) => String(o.code))
      : (source?.options ?? []).map((o) => String(o.code));
    const labels: Record<string, string> = {};
    for (const code of codes) {
      const opt = lf.options.find((o) => String(o.code) === code);
      labels[code] = opt?.label ?? source?.options.find((o) => String(o.code) === code)?.label ?? code;
    }
    for (const v of listFillVariableNames(lf)) {
      const positional = v.position != null ? ` — item ${v.position}` : "";
      out.push({
        name: v.name,
        label: `${lf.label ?? lf.name ?? lf.id} (List Fill)${positional}${
          v.kind === "code" ? " code" : v.kind === "count" ? " — number allocated" : v.kind === "position" ? " position" : ""
        }`,
        dataType: v.kind === "count" || v.kind === "position" ? "numeric" : "text",
        responseType: "list_fill",
        derived: true,
        hidden: true,
        // an item column's possible values are the option codes, so a
        // frequency table of "what did respondents get" is available directly
        valueCodes: v.kind === "code" ? codes : [],
        valueLabels: v.kind === "code" ? labels : {},
        sourceQuestion: source?.code,
        notes: `List Fill "${lf.name ?? lf.id}" — ${lf.selection.method}, ${lf.tracking.sampleLevel ? "sample-level allocation" : "per respondent"}`,
      });
    }
  }
  /*
   * THE LOOPS' OWN VARIABLES (§24, §36). LOOP_<VAR>_COUNT, _ITEM_n, _ITEM_n_CODE
   * and one per reference column — declared from the definition like the List
   * Fill columns above, and carrying `loopId` / `referenceColumn` so the
   * dictionary can show a reference as belonging to its loop rather than as a
   * survey-wide field (§36).
   */
  for (const { node, ancestors } of loopNodes(def)) {
    if (ancestors.length) continue; // nested loops' variables are per outer item, not positional
    const items = possibleLoopItems(def, node) ?? [];
    const codes = items.map((i) => i.code);
    const labels = Object.fromEntries(items.map((i) => [i.code, i.label]));
    const srcQ = node.source.kind === "question" ? def.questions.find((q) => q.id === (node.source as { questionId: string }).questionId) : undefined;
    for (const v of loopVariableNames(def, node)) {
      const col = v.referenceColumn ? node.references?.columns.find((c) => c.name === v.referenceColumn) : undefined;
      out.push({
        name: v.name,
        label: `Loop "${node.loopVar}"${v.iteration != null ? ` — item ${v.iteration}` : ""}${
          v.referenceColumn ? ` ${v.referenceColumn}` : /_CODE$/.test(v.name) ? " code" : v.iteration == null ? " — number of iterations" : ""
        }`,
        dataType: v.dataType === "number" ? "numeric" : v.dataType === "boolean" ? "boolean" : "text",
        responseType: "loop",
        derived: true,
        hidden: true,
        valueCodes: /_CODE$/.test(v.name) ? codes : [],
        valueLabels: /_CODE$/.test(v.name) ? labels : {},
        sourceQuestion: srcQ?.code,
        loopId: node.id,
        loopVar: node.loopVar,
        iteration: v.iteration,
        referenceColumn: v.referenceColumn,
        notes: v.referenceColumn
          ? `Reference column "${v.referenceColumn}"${col?.dataType ? ` (${col.dataType})` : ""} of loop "${node.loopVar}" — belongs to this loop only${col?.description ? `: ${col.description}` : ""}`
          : `Loop "${node.loopVar}" over ${describeLoopSource(def, node)}`,
      });
    }
  }
  // system variables
  for (const [name, label] of [
    ["RESP_ID", "Respondent ID"],
    ["SESSION_ID", "Session ID"],
    ["SURVEY_VERSION", "Survey version"],
    ["START_TIME", "Start time"],
    ["END_TIME", "End time"],
    ["STATUS", "Completion status"],
  ] as const) {
    out.push({
      name,
      label,
      dataType: "text",
      responseType: "system",
      derived: false,
      hidden: true,
      valueCodes: [],
      valueLabels: {},
    });
  }
  return out;
}

/** Detect duplicate variable names — Studio surfaces these as errors. */
export function lintVariables(def: SurveyDefinition): string[] {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const v of buildVariableDictionary(def)) {
    const owner = v.questionCode ?? v.responseType;
    if (seen.has(v.name) && seen.get(v.name) !== owner) {
      problems.push(`Duplicate variable "${v.name}" (${seen.get(v.name)} and ${owner})`);
    }
    seen.set(v.name, owner);
  }
  return problems;
}

/** "Q2 (selected)", "a static list of 5", "List Fill lf1" — for a dictionary note. */
export function describeLoopSource(def: SurveyDefinition, node: LoopFlowNode): string {
  const s = node.source;
  switch (s.kind) {
    case "question": {
      const q = def.questions.find((x) => x.id === s.questionId);
      return `${q?.code ?? s.questionId} (${s.filter ?? "selected"})`;
    }
    case "static": return `a static list of ${s.items.length}`;
    case "design": return `design file ${s.designId}`;
    case "listFill": return `List Fill ${def.listFills.find((l) => l.id === s.listFillId)?.name ?? s.listFillId}`;
    case "count": return typeof s.count === "number" ? `${s.count} iterations` : `a count from ${s.count.ref}`;
    case "variable": return `the list in ${s.ref}`;
  }
}
