import { portalDefinition, scoreInterview, scorecardRow } from "@rescript/engine";
import type { Question, SurveyDefinition } from "@rescript/schema";

/**
 * THE SCORECARD, THE RESEARCHER'S SIDE — THE PARTS THAT ARE DECISIONS (phase 2, 2026-11-20). Pure.
 *
 * What the settings screen may offer (which answers can be added up, which variables can be pointed at), and how
 * a page of completed responses is scored again after the scorecard changed. Scoring itself is the engine's — the
 * same functions the final save and the portal use — so "score again" cannot disagree with either.
 */
export interface ScorableItem { key: string; question: string; row?: string | number; label: string }

const plain = (s: unknown) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const short = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const numeric = (v: unknown) => (typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));

function hasScale(q: Question): boolean {
  const opts = (q.options ?? []) as { code: string | number; value?: string | number }[];
  if (opts.length) return opts.some((o) => numeric(o.value ?? o.code));
  const s = (q.settings ?? {}) as { minValue?: number; maxValue?: number };
  return typeof s.minValue === "number" && typeof s.maxValue === "number" && s.maxValue > s.minValue;
}

const SINGLE = new Set(["single_select", "dropdown"]);
const RATED = new Set(["rating", "scale", "slider", "nps", "numeric", "number"]);

/** the answers a score may add up: single-choice questions and rating questions with a numeric scale, and each row of a single-choice grid */
export function scorableItems(def: Pick<SurveyDefinition, "questions">): ScorableItem[] {
  const out: ScorableItem[] = [];
  for (const q of def.questions) {
    if (!hasScale(q)) continue;
    if (q.type === "matrix_single") {
      for (const r of (q as unknown as { rows?: { code: string | number; label?: string }[] }).rows ?? []) out.push({ key: `${q.id}::${r.code}`, question: q.id, row: r.code, label: `${q.code} · ${short(plain(r.label ?? r.code))}` });
    } else if (SINGLE.has(q.type) || RATED.has(q.type)) {
      out.push({ key: q.id, question: q.id, label: `${q.code} · ${short(plain(q.text))}` });
    }
  }
  return out;
}

export const itemKey = (it: { question: string; row?: string | number }) => (it.row === undefined ? it.question : `${it.question}::${it.row}`);

export function calculatedVariables(def: Pick<SurveyDefinition, "questions">): { code: string; label: string }[] {
  return def.questions.filter((q) => q.type === "calculated").map((q) => ({ code: q.code, label: `${q.code}${plain(q.text) ? ` · ${short(plain(q.text))}` : ""}` }));
}

/** single-choice questions people can be grouped by */
export function groupingQuestions(def: Pick<SurveyDefinition, "questions">): { id: string; label: string }[] {
  return def.questions.filter((q) => SINGLE.has(q.type) && (q.options ?? []).length >= 2 && (q.options ?? []).length <= 50).map((q) => ({ id: q.id, label: `${q.code} · ${short(plain(q.text))}` }));
}

/** an id from a label: letters, digits, underscore; unique among the ones taken */
export function newScoreId(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = (label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 40)) || "score";
  let id = base, n = 2;
  while (used.has(id)) id = `${base}_${n++}`;
  return id;
}

export interface CompletedRow {
  id: string; survey_id: string; respondent_id: string | null; is_test: boolean | null; version_id: string | null; completed_at: string | null;
  answers: unknown; calculated: unknown; embedded: unknown;
}
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Score a page of completed responses. Each is scored against the questions of the version IT ran, with the portal
 * settings that are live now. A response whose version cannot be read is skipped and counted, never guessed.
 */
export function scorePage(rows: CompletedRow[], live: SurveyDefinition, versions: Map<string, SurveyDefinition>) {
  const upserts: ReturnType<typeof scorecardRow>[] = [];
  let skipped = 0;
  for (const r of rows) {
    const own = r.version_id ? versions.get(r.version_id) : undefined;
    const scored = own ? scoreInterview(portalDefinition(own, live), { answers: obj(r.answers), calculated: obj(r.calculated), embedded: obj(r.embedded) }) : null;
    if (!scored) { skipped++; continue; }
    upserts.push(scorecardRow(r, scored, r.completed_at));
  }
  return { upserts, skipped };
}

/** the key the live definition's scores carry (what "up to date" means for a stored row); null = no scorecard */
export function liveScoreKey(live: SurveyDefinition | null): string | null {
  return live ? scoreInterview(live, { answers: {} })?.key ?? null : null;
}
