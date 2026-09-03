import type { SurveyDefinition, Question, VariableDef, FlowNode } from "@rescript/schema";
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
  return out;
}

/** Build the full dictionary for a survey definition. */
export function buildVariableDictionary(def: SurveyDefinition): VariableDef[] {
  const loc = pageLocator(def);
  const out: VariableDef[] = [];
  for (const q of def.questions) {
    out.push(...questionVariables(q, loc.get(q.id), def.questions));
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
