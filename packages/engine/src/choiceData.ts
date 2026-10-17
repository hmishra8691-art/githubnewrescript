import type { SurveyDefinition, Question } from "@rescript/schema";
import { designVersionFor, shuffleAlternatives } from "./designVersion.js";

/**
 * STACKED ("LONG") CHOICE DATA FOR CBC — conjoint audit 2026-10-17.
 *
 * The wide export has one column per task holding the chosen alternative's
 * number. That is enough for the platform's own model (it re-reads the design
 * file) and useless to anyone else: to estimate an MNL or HB model outside the
 * platform the analyst needs the DESIGN and the CHOICE joined — one row per
 * respondent × task × alternative, with the levels that alternative showed
 * and whether it was chosen. That file did not exist.
 *
 * Identity is the design's, never the screen's. `alt` is the design
 * alternative the answer stores (the renderer writes `alt`, not the row it was
 * drawn in), `concept_id` names it across the whole design, and `position` is
 * where THIS respondent saw it — recomputed from their seed exactly as the
 * renderer computes it (shuffleAlternatives), the None alternative last. So
 * randomising the order never changes which concept a choice belongs to, and
 * position effects can still be tested.
 *
 * Only answered tasks are written (an unanswered task carries no choice), and
 * a response without a seed is skipped and counted: its version and screen
 * order cannot be recovered, and a guessed version would attach its choices to
 * concepts it never saw.
 */

/** design columns that are not attributes */
const NON_ATTRIBUTE = new Set(["version", "task", "alt", "is_holdout", "none_option", "position", "item_index", "item_label"]);

export interface StackedChoiceState {
  sessionId?: string;
  respondentId?: string | null;
  seed?: number | string | null;
  answers: Record<string, unknown>;
}

export interface StackedChoiceData {
  columns: string[];
  rows: Record<string, unknown>[];
  /** responses with CBC answers but no seed — not written */
  skippedNoSeed: number;
  /** the CBC questions included (variable names) */
  questions: string[];
}

/** CBC questions: conjoint_task with a generated or imported design that is not a menu. */
export function cbcQuestions(def: SurveyDefinition): Question[] {
  return def.questions.filter((q) => {
    if (q.type !== "conjoint_task") return false;
    const d = def.designs.find((x) => x.id === q.settings?.designRef);
    return !!d && d.kind !== "menu" && !!d.file?.rows?.length;
  });
}

/** attribute → levels in the design's own order (its configuration), else in order of first appearance */
export function cbcAttributeLevels(def: SurveyDefinition, q: Question): { name: string; levels: string[] }[] {
  const d = def.designs.find((x) => x.id === q.settings?.designRef);
  const rows = (d?.file?.rows ?? []) as Record<string, unknown>[];
  const cols = (d?.file?.columns ?? []).filter((c) => !NON_ATTRIBUTE.has(c));
  const configured = ((d?.config as { attributes?: { name: string; levels: string[] }[] } | undefined)?.attributes ?? []);
  return cols.map((name) => {
    const seen = [...new Set(rows.filter((r) => Number(r.none_option) !== 1).map((r) => String(r[name] ?? "")).filter((l) => l !== ""))];
    const cfg = configured.find((a) => a.name === name)?.levels?.map(String);
    // the configured order when it covers every level the file shows; otherwise the file's own
    const levels = cfg && seen.every((l) => cfg.includes(l)) ? cfg : seen;
    return { name, levels };
  });
}

export function stackedChoiceData(def: SurveyDefinition, states: StackedChoiceState[]): StackedChoiceData {
  const questions = cbcQuestions(def);
  const attrNames: string[] = [];
  const levelsByQ = new Map<string, { name: string; levels: string[] }[]>();
  for (const q of questions) {
    const attrs = cbcAttributeLevels(def, q);
    levelsByQ.set(q.id, attrs);
    for (const a of attrs) if (!attrNames.includes(a.name)) attrNames.push(a.name);
  }
  const columns = [
    "respondent", "session_id", "question", "version", "task", "is_holdout",
    "alt", "concept_id", "position", "none", "chosen",
    ...attrNames, ...attrNames.map((a) => `${a}_code`),
  ];
  const rows: Record<string, unknown>[] = [];
  let skippedNoSeed = 0;
  for (const st of states) {
    let skipped = false;
    for (const q of questions) {
      const ans = st.answers?.[q.id];
      if (!ans || typeof ans !== "object" || Array.isArray(ans)) continue;
      // a bigint seed may come back from the database as a numeric string
      const seed = st.seed == null || (st.seed as unknown) === "" ? NaN : Number(st.seed);
      if (!Number.isFinite(seed)) { skipped = true; continue; }
      const design = def.designs.find((x) => x.id === q.settings?.designRef)!;
      const all = design.file!.rows as Record<string, unknown>[];
      const version = designVersionFor(q, all, seed);
      const mine = all.filter((r) => String(r.version ?? "1") === version);
      const attrs = levelsByQ.get(q.id)!;
      const tasks = [...new Set(mine.map((r) => String(r.task)))];
      for (const t of tasks) {
        const choice = (ans as Record<string, unknown>)[t];
        if (choice == null || choice === "") continue;
        // exactly what the renderer shows: this version's rows of the task, rolled by (seed, question, task)
        const shown = shuffleAlternatives(mine.filter((r) => String(r.task) === t), seed, `${q.id}:${t}`);
        shown.forEach((r, i) => {
          const alt = String(r.alt ?? i + 1);
          const none = Number(r.none_option) === 1 ? 1 : 0;
          const row: Record<string, unknown> = {
            respondent: st.respondentId ?? st.sessionId ?? "",
            session_id: st.sessionId ?? "",
            question: q.variableName,
            version,
            task: Number(t),
            is_holdout: Number(r.is_holdout) === 1 ? 1 : 0,
            alt: Number(alt),
            concept_id: `${version}-${t}-${alt}`,
            position: i + 1,
            none,
            chosen: String(choice) === alt ? 1 : 0,
          };
          for (const a of attrNames) {
            const spec = attrs.find((x) => x.name === a);
            const level = none || !spec ? "" : String(r[a] ?? "");
            row[a] = level;
            row[`${a}_code`] = none || !spec ? 0 : spec.levels.indexOf(level) + 1;
          }
          rows.push(row);
        });
      }
    }
    if (skipped) skippedNoSeed++;
  }
  return { columns, rows, skippedNoSeed, questions: questions.map((q) => q.variableName) };
}
