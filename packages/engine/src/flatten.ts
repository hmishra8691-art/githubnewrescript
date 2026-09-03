import type { SurveyDefinition, Question } from "@rescript/schema";
import type { ResponseState } from "./state.js";

export type FlatVars = Record<string, unknown>;

/**
 * Flatten the response state into the exported variable map.
 * This is the same naming the Variable Dictionary documents:
 *   single/numeric/text        VAR            scalar
 *   multi                      VAR            array of codes
 *                              VAR_<code>     0/1 per option
 *   matrix_*                   VAR_<row>      scalar / array per row
 *   composite                  <colStem>_<row>  per cell
 *   allocation                 VAR_<code>     numeric per option
 *   ranking                    VAR_<code>     rank position (1..n)
 *   lists                      VAR_1..VAR_n
 *   other specify              VAR_other
 */
export function flattenVariables(def: SurveyDefinition, state: ResponseState): FlatVars {
  const out: FlatVars = {};

  for (const q of def.questions) {
    // collect all answer entries for this question (plain + loop-suffixed)
    const entries = Object.entries(state.answers).filter(
      ([k]) => k === q.id || k.startsWith(`${q.id}@`),
    );
    for (const [key, value] of entries) {
      const loopSuffix = key.includes("@") ? `_${key.split("@")[1]}` : "";
      flattenQuestion(q, value, `${q.variableName}${loopSuffix}`, out);
    }
    const other = state.answers[`${q.id}__other`];
    if (other !== undefined) out[`${q.variableName}_other`] = other;
  }

  for (const [k, v] of Object.entries(state.calculated)) out[k] = v;
  for (const [k, v] of Object.entries(state.embedded)) out[k] = v;
  return out;
}

function flattenQuestion(q: Question, value: unknown, varName: string, out: FlatVars): void {
  if (value === undefined) return;

  switch (q.type) {
    case "multi_select":
    case "multi_dropdown":
    case "image_select": {
      const arr = Array.isArray(value) ? value : value == null ? [] : [value];
      out[varName] = arr;
      for (const opt of q.options) {
        out[`${varName}_${opt.code}`] = arr.some((v) => String(v) === String(opt.code)) ? 1 : 0;
      }
      break;
    }
    case "ranking":
    case "image_ranking": {
      const arr = Array.isArray(value) ? value : [];
      out[varName] = arr;
      arr.forEach((code, i) => {
        out[`${varName}_${code}`] = i + 1;
      });
      break;
    }
    case "allocation": {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        let total = 0;
        for (const [code, v] of Object.entries(value as Record<string, unknown>)) {
          out[`${varName}_${code}`] = v;
          const n = Number(v);
          if (Number.isFinite(n)) total += n;
        }
        out[`${varName}_total`] = total;
      }
      break;
    }
    case "numeric_list":
    case "text_list": {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        // labeled form fields: keyed by row code
        for (const [rc, v] of Object.entries(value as Record<string, unknown>)) {
          out[`${varName}_${rc}`] = v;
        }
      } else {
        const arr = Array.isArray(value) ? value : [];
        out[varName] = arr;
        arr.forEach((v, i) => {
          out[`${varName}_${i + 1}`] = v;
        });
      }
      break;
    }
    case "matrix_single":
    case "matrix_numeric":
    case "matrix_text":
    case "matrix_dropdown":
    case "slider": {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [row, v] of Object.entries(value as Record<string, unknown>)) {
          out[`${varName}_${row}`] = v;
        }
      } else {
        out[varName] = value;
      }
      break;
    }
    case "matrix_multi": {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [row, v] of Object.entries(value as Record<string, unknown>)) {
          const arr = Array.isArray(v) ? v : v == null ? [] : [v];
          out[`${varName}_${row}`] = arr;
          for (const col of q.columns.length ? q.columns : []) {
            for (const opt of col.options) {
              out[`${varName}_${row}_${opt.code}`] = arr.some(
                (x) => String(x) === String(opt.code),
              )
                ? 1
                : 0;
            }
          }
          for (const opt of q.options) {
            out[`${varName}_${row}_${opt.code}`] = arr.some(
              (x) => String(x) === String(opt.code),
            )
              ? 1
              : 0;
          }
        }
      }
      break;
    }
    case "hotspot": {
      // array of {x, y} percentages -> VAR_<i>_X / VAR_<i>_Y
      const pts = Array.isArray(value) ? (value as { x: number; y: number }[]) : [];
      pts.forEach((pt, i) => {
        out[`${varName}_${i + 1}_X`] = Math.round((Number(pt?.x) || 0) * 10) / 10;
        out[`${varName}_${i + 1}_Y`] = Math.round((Number(pt?.y) || 0) * 10) / 10;
      });
      break;
    }
    case "annotation": {
      const v = (value ?? {}) as { pins?: unknown[]; strokes?: unknown[] };
      const pins = Array.isArray(v.pins) ? v.pins : [];
      const strokes = Array.isArray(v.strokes) ? v.strokes : [];
      out[`${varName}_PINS`] = pins.length;
      out[`${varName}_STROKES`] = strokes.length;
      out[`${varName}_JSON`] = pins.length || strokes.length ? JSON.stringify({ pins, strokes }) : "";
      break;
    }
    case "media_timeline": {
      const arr = Array.isArray(value) ? (value as { t: number; code?: unknown }[]) : [];
      out[`${varName}_N`] = arr.length;
      out[`${varName}_JSON`] = arr.length ? JSON.stringify(arr) : "";
      for (const o of q.options ?? []) {
        out[`${varName}_${o.code}_N`] = arr.filter((r) => String(r?.code) === String(o.code)).length;
      }
      break;
    }
    case "upload": {
      const files = Array.isArray(value) ? value : value ? [value] : [];
      const n = Math.max(1, q.settings.maxFiles ?? 1);
      for (let i = 0; i < n; i++) {
        const f = files[i] as { url?: string; name?: string; size?: number } | undefined;
        const stem = n === 1 ? varName : `${varName}_${i + 1}`;
        out[`${stem}_URL`] = f?.url ?? "";
        out[`${stem}_NAME`] = f?.name ?? "";
        out[`${stem}_SIZE`] = f?.size ?? "";
      }
      break;
    }
    case "repeating_group": {
      const entries = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
      const n = Math.max(1, q.settings.maxRepeats ?? 10);
      out[`${varName}_N`] = entries.length;
      for (let i = 0; i < n; i++) {
        for (const r of q.rows ?? []) {
          out[`${varName}_${i + 1}_${r.code}`] = entries[i]?.[String(r.code)] ?? "";
        }
      }
      break;
    }
    case "composite":
    case "custom_table": {
      // { rowCode: { columnId: cellValue } } -> `${column.variableStem}_${row}`
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [row, cells] of Object.entries(value as Record<string, unknown>)) {
          if (!cells || typeof cells !== "object") continue;
          for (const [colId, v] of Object.entries(cells as Record<string, unknown>)) {
            const col = q.columns.find((c) => c.id === colId);
            const stem = col?.variableStem ?? `${varName}_${colId}`;
            if (col && (col.responseType === "multi" || col.responseType === "multi_dropdown")) {
              const arr = Array.isArray(v) ? v : v == null ? [] : [v];
              out[`${stem}_${row}`] = arr;
              for (const opt of col.options) {
                out[`${stem}_${row}_${opt.code}`] = arr.some(
                  (x) => String(x) === String(opt.code),
                )
                  ? 1
                  : 0;
              }
            } else {
              out[`${stem}_${row}`] = v;
            }
          }
        }
      }
      break;
    }
    default:
      out[varName] = value;
  }
}
