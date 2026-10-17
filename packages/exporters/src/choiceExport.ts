import type { SurveyDefinition } from "@rescript/schema";
import { stackedChoiceData, type StackedChoiceState } from "@rescript/engine";
import { csvRow } from "./csvCell.js";
import { defForRow, type VersionedSource } from "./versionedSource.js";
import { CSV_BOM } from "./csv.js";

/**
 * THE STACKED CBC CHOICE FILE (conjoint audit 2026-10-17).
 *
 * One row per respondent × task × shown alternative (the None alternative
 * included), with the design version, the design alternative (`alt`, the
 * concept's identity), a design-wide `concept_id`, the screen `position` this
 * respondent saw it in, every attribute's level (label and 1-based code) and
 * `chosen` 0/1 — the layout MNL and HB software reads directly. Built by
 * `stackedChoiceData` in the engine from the same design rows, version
 * assignment and order roll the renderer uses. Each response is read through
 * the definition version it was collected under, like every other export.
 */
export function choiceDataToCSV(
  def: SurveyDefinition,
  states: StackedChoiceState[],
  opts: { versioned?: VersionedSource; bom?: boolean } = {},
): { csv: string; rows: number; skippedNoSeed: number; questions: string[] } {
  const columns: string[] = [];
  const rows: Record<string, unknown>[] = [];
  let skippedNoSeed = 0;
  const questions = new Set<string>();
  const add = (cols: string[]) => { for (const c of cols) if (!columns.includes(c)) columns.push(c); };
  add(stackedChoiceData(def, []).columns);
  states.forEach((st, i) => {
    const out = stackedChoiceData(defForRow(def, i, opts.versioned), [st]);
    add(out.columns);
    rows.push(...out.rows);
    skippedNoSeed += out.skippedNoSeed;
    out.questions.forEach((q) => questions.add(q));
  });
  const lines = [csvRow(columns), ...rows.map((r) => csvRow(columns.map((c) => r[c] ?? "")))];
  return { csv: (opts.bom ? CSV_BOM : "") + lines.join("\n") + "\n", rows: rows.length, skippedNoSeed, questions: [...questions] };
}
