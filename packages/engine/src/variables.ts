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
  /**
   * The survey's design files. Needed only by anchored MaxDiff (§17), whose
   * extra variable is a property of the DESIGN rather than of the question —
   * the generator decides whether a follow-up is asked. Optional so that
   * every existing caller, including the question-type registry's hook, keeps
   * working; a caller that does not pass it simply describes a standard
   * MaxDiff question, which is what every design before this was.
   */
  designs?: { id: string; kind?: string; config?: Record<string, unknown>; file?: { columns?: string[]; rows?: Record<string, unknown>[] } }[],
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
    case "geo": {
      /*
       * One text column with the place as the respondent gave it ("lat,lng"
       * or the address), then typed components. Radius only in radius mode,
       * address parts only in address mode — the columns say what was asked.
       */
      const mode = q.settings.geoMode === "address" || q.settings.geoMode === "radius" ? q.settings.geoMode : "pin";
      push({ name: q.variableName, label: strip(q.text) || q.code, dataType: "text", notes: "The place as given: the address, or \"lat,lng\"" });
      push({ name: `${q.variableName}_LAT`, label: `${q.code} — latitude`, dataType: "numeric" });
      push({ name: `${q.variableName}_LNG`, label: `${q.code} — longitude`, dataType: "numeric" });
      push({ name: `${q.variableName}_ACCURACY_M`, label: `${q.code} — device location accuracy (m)`, dataType: "numeric", notes: "Only when the respondent used their device location" });
      if (mode === "radius") push({ name: `${q.variableName}_RADIUS_M`, label: `${q.code} — radius (m)`, dataType: "numeric" });
      if (mode === "address") {
        for (const [suffix, lab] of [["CITY", "city"], ["REGION", "region / state"], ["COUNTRY", "country"], ["POSTAL", "postal code"]] as const) {
          push({ name: `${q.variableName}_${suffix}`, label: `${q.code} — ${lab}`, dataType: "text" });
        }
      }
      push({ name: `${q.variableName}_SOURCE`, label: `${q.code} — how the place was given`, dataType: "text",
        valueCodes: ["pin", "device", "search", "typed"], valueLabels: { pin: "Pin on the map", device: "Device location", search: "Address search", typed: "Typed address" } });
      break;
    }
    case "acbc_task": {
      /*
       * ACBC exports the decisions, not the machinery: the BYO level per
       * attribute, the winning concept's level per attribute, the confirmed
       * rules, the screening counts, and the full transcript as JSON for
       * re-analysis. Attributes come from the design's configuration.
       */
      const design = designs?.find((d) => d.id === q.settings.designRef);
      const attrs = ((design?.config as { attributes?: { name: string }[] } | undefined)?.attributes ?? []).map((a) => a.name);
      for (const a of attrs) push({ name: `${q.variableName}_BYO_${a.replace(/[^A-Za-z0-9]+/g, "_")}`, label: `${q.code} — build-your-own: ${a}`, dataType: "text" });
      for (const a of attrs) push({ name: `${q.variableName}_WINNER_${a.replace(/[^A-Za-z0-9]+/g, "_")}`, label: `${q.code} — tournament winner: ${a}`, dataType: "text" });
      push({ name: `${q.variableName}_UNACCEPTABLE`, label: `${q.code} — unacceptable levels confirmed`, dataType: "text", notes: "attribute=level, | separated" });
      push({ name: `${q.variableName}_MUSTHAVE`, label: `${q.code} — must-have levels confirmed`, dataType: "text", notes: "attribute=level, | separated" });
      push({ name: `${q.variableName}_SCREENED`, label: `${q.code} — concepts screened`, dataType: "numeric" });
      push({ name: `${q.variableName}_ACCEPTED`, label: `${q.code} — concepts marked a possibility`, dataType: "numeric" });
      push({ name: `${q.variableName}_ROUNDS`, label: `${q.code} — tournament rounds`, dataType: "numeric" });
      push({ name: `${q.variableName}_JSON`, label: `${q.code} — full ACBC transcript (JSON)`, dataType: "text", notes: "BYO, every screen with concepts and verdicts, rules, every tournament round and choice" });
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
      /*
       * WHICH VERSION (block) OF THE DESIGN THIS RESPONDENT ANSWERED.
       *
       * Without it a multi-version design is unanalysable: the rows a
       * respondent saw cannot be recovered, so their choices cannot be
       * matched to the concepts that produced them. The analysis has always
       * looked for this column (`<VAR>_VERSION`); nothing declared or filled
       * it until the version was actually assigned at fielding.
       */
      push({ name: `${q.variableName}_VERSION`, label: `${q.code} — design version shown`, dataType: "text",
        notes: "The design block this respondent answered. Derived from their response seed, so it is reproducible from the stored response." });
      /*
       * ANCHORED MAXDIFF (§17): one dual-response answer per task, and it is
       * DATA, not a rendering detail. Without a declared variable the anchor
       * would be stored inside the task answer and invisible to the variable
       * dictionary, the exports and anybody reading the data outside this
       * platform — which is how a question a respondent answered comes to be
       * missing from the file the client receives.
       */
      /*
       * ONE COLUMN PER TASK, DECLARED FROM THE DESIGN. "_TASKS … expanded at
       * export" above was a note, not an implementation: no exporter ever
       * expanded it, so task answers reached no CSV. The design file knows
       * how many tasks a version has and, for a menu, which items are on it,
       * so the columns are declared here and filled by flattenVariables:
       *   CBC      VAR_T<n>            the alternative chosen (none = alternatives + 1)
       *   MaxDiff  VAR_T<n>_BEST / _WORST   item index
       *   Menu     VAR_T<n>_<item> 0/1, VAR_T<n>_NONE 0/1, VAR_T<n>_TOTAL
       */
      {
        const design = designs?.find((d) => d.id === q.settings.designRef);
        const rows = (design?.file?.rows ?? []) as Record<string, unknown>[];
        const v1 = rows.filter((r) => String(r.version ?? "1") === "1");
        const tasks = [...new Set(v1.map((r) => String(r.task)))];
        for (const t of tasks) {
          if (q.type === "maxdiff_task") {
            push({ name: `${q.variableName}_T${t}_BEST`, label: `${q.code} — task ${t} best (item index)`, dataType: "numeric" });
            push({ name: `${q.variableName}_T${t}_WORST`, label: `${q.code} — task ${t} worst (item index)`, dataType: "numeric" });
          } else if (design?.kind === "menu") {
            const items = v1.filter((r) => String(r.task) === t).sort((a, b) => Number(a.item) - Number(b.item));
            for (const it of items) {
              push({ name: `${q.variableName}_T${t}_${it.item}`, label: `${q.code} — task ${t}: ${strip(String(it.item_label ?? it.item))} chosen`, dataType: "numeric",
                valueCodes: [0, 1], valueLabels: { "0": "Not chosen", "1": "Chosen" }, optionCode: String(it.item) });
            }
            push({ name: `${q.variableName}_T${t}_NONE`, label: `${q.code} — task ${t}: bought nothing`, dataType: "numeric", valueCodes: [0, 1], valueLabels: { "0": "No", "1": "Yes" } });
            push({ name: `${q.variableName}_T${t}_TOTAL`, label: `${q.code} — task ${t}: bundle total`, dataType: "numeric", derived: true });
          } else {
            push({ name: `${q.variableName}_T${t}`, label: `${q.code} — task ${t} choice (alternative)`, dataType: "numeric",
              notes: "The alternative number chosen; the None option, when offered, is alternatives + 1" });
          }
        }
      }
      if (q.type === "maxdiff_task") {
        const design = designs?.find((d) => d.id === q.settings.designRef);
        if ((design?.config as { anchored?: boolean } | undefined)?.anchored) {
          push({
            name: `${q.variableName}_ANCHOR`,
            label: `${q.code} — anchor (all / some / none important)`,
            dataType: "text",
            valueCodes: ["all", "some", "none"],
            notes: "The dual-response follow-up asked after each set, one column per task at export. Places the utility scale's zero point.",
          });
        }
      }
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
  /*
   * FOLLOW-UP PROBES are declared up front from `maxProbes`, like loop
   * iterations: `Q5_PROBE_n` holds the n-th follow-up answer and
   * `Q5_PROBE_n_Q` the wording that was asked — which the analyst must see
   * when the wording was generated per respondent (probe.ts).
   */
  if (q.probe) {
    for (let n = 1; n <= q.probe.maxProbes; n++) {
      push({ name: `${q.variableName}_PROBE_${n}`, label: `${q.code} — follow-up ${n}`, dataType: "text",
        notes: `Answer to follow-up probe ${n} on ${q.code}` });
      push({ name: `${q.variableName}_PROBE_${n}_Q`, label: `${q.code} — follow-up ${n} wording`, dataType: "text",
        notes: `The exact follow-up question asked${q.probe.prompt ? "" : " (written per respondent)"}` });
    }
  }
  return out;
}

/** Build the full dictionary for a survey definition. */
/**
 * WHAT THE PROGRAMMER SAID ABOUT A VARIABLE, OVER WHAT THE SURVEY IMPLIES.
 *
 * The dictionary is derived: a name, a label and a set of value labels fall
 * out of the question that produces them, which is right almost always and
 * occasionally wrong. A grid row labelled "I would recommend it to a friend"
 * is a fine question and a terrible column header; a 1–5 scale exported as
 * "1".."5" needs its words back before anyone can read a crosstab.
 *
 * `def.variables` is where a programmer says so. It has been in the schema
 * since the first release and NOTHING read it — the dictionary was rebuilt
 * from the questions every time and the overrides were silently discarded,
 * which is why "variable management" was read-only. Overrides are matched by
 * name, apply to exports and analysis because both read this dictionary, and
 * never invent a variable: an override for a name the survey does not produce
 * is reported by `lintVariables` rather than conjuring a column.
 */
function applyOverrides(def: SurveyDefinition, derived: VariableDef[]): VariableDef[] {
  const overrides = new Map((def.variables ?? []).map((v) => [v.name, v]));
  if (overrides.size === 0) return derived;
  return derived.map((v) => {
    const o = overrides.get(v.name);
    if (!o) return v;
    /*
     * Only the fields a programmer is allowed to restate, and only the ones
     * they actually filled in. Everything structural stays derived, so an
     * override can never lie about where a variable comes from or what shape
     * its answers are — and an override that says nothing leaves the entry
     * byte-identical, which is what makes "is this row edited?" answerable.
     */
    const out = { ...v };
    if (o.label?.trim()) out.label = o.label;
    if (Object.keys(o.valueLabels ?? {}).length) out.valueLabels = { ...v.valueLabels, ...o.valueLabels };
    if (o.hidden === true) out.hidden = true;
    if (o.notes?.trim()) out.notes = o.notes;
    return out;
  });
}

/** Variable names an override mentions that the survey does not produce. */
export function unknownVariableOverrides(def: SurveyDefinition): string[] {
  const produced = new Set(buildDerivedVariables(def).map((v) => v.name));
  return (def.variables ?? []).map((v) => v.name).filter((n) => n && !produced.has(n));
}

export function buildVariableDictionary(def: SurveyDefinition): VariableDef[] {
  return applyOverrides(def, buildDerivedVariables(def));
}

/** The dictionary the survey implies, before any programmer override. */
export function buildDerivedVariables(def: SurveyDefinition): VariableDef[] {
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
      const base = questionVariables(q, loc.get(q.id), def.questions, def.designs);
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
      for (const v of questionVariables(renamed, loc.get(q.id), def.questions, def.designs)) {
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
  for (const name of unknownVariableOverrides(def)) {
    problems.push(
      `Variable override "${name}" does not match anything this survey produces — it may have been renamed. The override is ignored.`,
    );
  }
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
    case "setExpression":
      return "a set expression";
  }
}
