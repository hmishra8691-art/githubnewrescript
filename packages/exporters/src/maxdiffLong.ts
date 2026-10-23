import type { SurveyDefinition } from "@rescript/schema";
import { designFor, designVersionFor, shuffleAlternatives } from "@rescript/engine";
import { csvRow } from "./csvCell.js";
import type { ResponseStateLike } from "./csv.js";

/**
 * MAXDIFF CHOICE FILE — ONE ROW PER RESPONDENT × TASK × ITEM SHOWN (MD-P1).
 *
 * The wide export carries a MaxDiff answer as `VAR_T<n>_BEST / _WORST /
 * _ORDER` columns, which is what a crosstab wants and what a choice model
 * does not: hierarchical-Bayes and logit tools (Sawtooth, R `bwsTools` /
 * `mlogit`, Python `pylogit`, Stan) all read a LONG file in which every item a
 * respondent saw is a row carrying the respondent, the task, the design
 * version, where on screen it was, and whether it was picked best or worst.
 *
 * Everything here is recomputed from what is stored — the response's seed
 * decides the version (designVersion.ts) and the on-screen order
 * (`shuffleAlternatives`), exactly as the renderer decided them — so the file
 * says what the respondent actually saw. A response without a seed cannot be
 * placed and is reported in `skipped` rather than silently given version 1.
 */
export const MAXDIFF_LONG_COLUMNS = [
  "RESP_ID", "SESSION_ID", "QUESTION_ID", "QUESTION", "LOOP", "VERSION", "TASK", "PRACTICE",
  "POSITION", "ITEM_INDEX", "ITEM_LABEL", "BEST", "WORST", "ANCHOR",
] as const;

export type MaxDiffLongRow = Record<(typeof MAXDIFF_LONG_COLUMNS)[number], string | number>;

export function maxdiffChoiceRows(
  def: SurveyDefinition,
  states: (ResponseStateLike & { seed?: number })[],
): { columns: readonly string[]; rows: MaxDiffLongRow[]; skipped: { sessionId: string; reason: string }[] } {
  const rows: MaxDiffLongRow[] = [];
  const skipped: { sessionId: string; reason: string }[] = [];
  const questions = def.questions.filter((q) => q.type === "maxdiff_task");
  for (const state of states) {
    const seed = state.seed;
    let placed = true;
    for (const q of questions) {
      const design = designFor(def, q);
      if (!design) continue;
      const entries = Object.entries(state.answers ?? {}).filter(([k]) => k === q.id || k.startsWith(`${q.id}@`));
      if (!entries.length) continue;
      if (typeof seed !== "number" || !Number.isFinite(seed)) {
        if (placed) skipped.push({ sessionId: state.sessionId, reason: "no response seed — the design version and order cannot be recovered" });
        placed = false;
        continue;
      }
      const version = designVersionFor(q, design.rows, seed, state.calculated);
      const versionRows = design.rows.filter((r) => String(r.version ?? "1") === version);
      for (const [key, value] of entries) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const loop = key.includes("@") ? key.split("@").slice(1).join("@") : "";
        for (const [task, raw] of Object.entries(value as Record<string, unknown>)) {
          if (!raw || typeof raw !== "object") continue;
          const bw = raw as { best?: unknown; worst?: unknown; anchor?: unknown };
          const given = (v: unknown) => v != null && v !== "";
          if (!given(bw.best) && !given(bw.worst)) continue;
          const shown = shuffleAlternatives(versionRows.filter((r) => String(r.task) === task), seed, `${q.id}:${task}`);
          shown.forEach((r, i) => {
            const item = String(r.item_index ?? "");
            rows.push({
              RESP_ID: state.respondentId ?? "",
              SESSION_ID: state.sessionId,
              QUESTION_ID: q.id,
              QUESTION: q.variableName,
              LOOP: loop,
              VERSION: version,
              TASK: task,
              PRACTICE: Number(r.practice) === 1 ? 1 : 0,
              POSITION: i + 1,
              ITEM_INDEX: Number.isFinite(Number(item)) ? Number(item) : item,
              ITEM_LABEL: String(r.item_label ?? item),
              BEST: given(bw.best) ? (String(bw.best) === item ? 1 : 0) : "",
              WORST: given(bw.worst) ? (String(bw.worst) === item ? 1 : 0) : "",
              ANCHOR: given(bw.anchor) ? String(bw.anchor) : "",
            });
          });
        }
      }
    }
  }
  return { columns: MAXDIFF_LONG_COLUMNS, rows, skipped };
}

/** The choice file as CSV (formula-guarded like every CSV the platform writes). */
export function maxdiffChoiceCSV(def: SurveyDefinition, states: (ResponseStateLike & { seed?: number })[], opts: { bom?: boolean } = {}): string {
  const { columns, rows } = maxdiffChoiceRows(def, states);
  const lines = [csvRow(columns), ...rows.map((r) => csvRow(columns.map((c) => r[c as keyof MaxDiffLongRow])))];
  return (opts.bom ? "\uFEFF" : "") + lines.join("\n") + "\n";
}
