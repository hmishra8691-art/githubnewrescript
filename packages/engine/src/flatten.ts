import type { SurveyDefinition, Question } from "@rescript/schema";
import { loopKeySuffix, type LoopContext, type ResponseState } from "./state.js";
import { directChildLoops, directQuestionIdsInLoop, loopNodes, loopVariablePrefix, type LoopFlowNode } from "./loopModel.js";

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

  /*
   * LOOP ITERATIONS LAND IN POSITIONAL COLUMNS — `Q7_1`, `Q7_2`, … — the
   * columns the dictionary declares up front (§29, §37). Position n's item is
   * read from `LOOP_<VAR>_ITEM_n_CODE`, which `runCalculations` writes into
   * `state.calculated` on every trigger and which is stored with the response,
   * so an export of a finished response needs no re-resolution.
   *
   * This replaces the `Q7_<code>` naming, which never reached an export at all
   * (the dictionary did not know those names) and collided with a multi-select's
   * own `Q7_<optionCode>` flag columns. The old spelling is kept ONLY as a
   * fallback for a response stored before the loop variables existed, so those
   * rows keep flattening to what they flattened to before.
   */
  const placed = placeLoopAnswers(def, state, out);

  for (const q of def.questions) {
    // every answer entry for this question (plain + loop-suffixed)
    const entries = Object.entries(state.answers).filter(
      ([k]) => k === q.id || k.startsWith(`${q.id}@`),
    );
    for (const [key, value] of entries) {
      if (placed.has(key)) continue;
      // legacy fallback for loop answers whose loop variables are absent
      const loopSuffix = key.includes("@") ? `_${key.split("@").slice(1).join("_")}` : "";
      flattenQuestion(q, value, `${q.variableName}${loopSuffix}`, out);
    }
    const other = state.answers[`${q.id}__other`];
    if (other !== undefined) out[`${q.variableName}_other`] = other;

    // ---- gamified / experimental families (variant batch) ----
    // Side answers live beside the answer exactly like `__other` above:
    // `<id>__correct`, `__rt`, `__timeout`, `__passed`. A reaction-time map
    // (`{rowCode: ms}`) spreads to one column per row, matching the
    // dictionary's VAR_<row>_RT.
    for (const [suffix, stem] of [
      ["correct", "CORRECT"], ["passed", "PASSED"], ["timeout", "TIMEOUT"], ["rt", "RT"],
    ] as const) {
      const side = state.answers[`${q.id}__${suffix}`];
      if (side === undefined) continue;
      if (suffix === "rt" && side && typeof side === "object" && !Array.isArray(side)) {
        for (const [row, ms] of Object.entries(side as Record<string, unknown>)) {
          out[`${q.variableName}_${row}_RT`] = ms;
        }
      } else {
        out[`${q.variableName}_${stem}`] = side;
      }
    }
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

/* ------------------------------------------------------------ loops */

/**
 * Place every loop-scoped answer in its positional column and return the
 * answer keys that were placed, so the caller can skip them.
 *
 * Works from the loop VARIABLES rather than from the answer keys: position n
 * is whatever `LOOP_<VAR>_ITEM_n_CODE` says ran n-th, which is how a randomised
 * loop still exports as `Q7_1..Q7_N` with the `_CODE` column saying which item
 * each position held. Nested loops recurse with the outer position prefixed:
 * `Q9_2_1` is the first inner iteration of the second outer one, and the inner
 * loop's own variables are prefixed by the outer item (`loopVariablePrefix`).
 */
function placeLoopAnswers(def: SurveyDefinition, state: ResponseState, out: FlatVars): Set<string> {
  const placed = new Set<string>();
  const byId = new Map(def.questions.map((q) => [q.id, q]));

  const place = (node: LoopFlowNode, parent: LoopContext | null, positionPrefix: string) => {
    const prefix = loopVariablePrefix(node, parent);
    const count = Number(state.calculated[`${prefix}_COUNT`]);
    if (!Number.isFinite(count)) return; // no loop variables: legacy fallback applies
    const questionIds = directQuestionIdsInLoop(node);
    const children = directChildLoops(node);
    for (let n = 1; n <= count; n++) {
      const code = state.calculated[`${prefix}_ITEM_${n}_CODE`];
      if (code == null) continue;
      const ctx: LoopContext = { loopVar: node.loopVar, loopId: node.id, code: String(code), label: "", index: n, parent };
      const suffix = loopKeySuffix(ctx);
      const position = `${positionPrefix}_${n}`;
      for (const qid of questionIds) {
        const q = byId.get(qid);
        if (!q) continue;
        const key = `${qid}${suffix}`;
        if (state.answers[key] === undefined) continue;
        flattenQuestion(q, state.answers[key], `${q.variableName}${position}`, out);
        placed.add(key);
        const other = state.answers[`${key}__other`];
        if (other !== undefined) { out[`${q.variableName}${position}_other`] = other; placed.add(`${key}__other`); }
      }
      for (const child of children) place(child, ctx, position);
    }
  };

  for (const { node, ancestors } of loopNodes(def)) {
    if (ancestors.length === 0) place(node, null, "");
  }
  return placed;
}
