import type { SurveyDefinition } from "@rescript/schema";
import type { Benchmarks, PeerRecord, ResponseTelemetry } from "./types.js";
import { median } from "./metrics.js";
import { estimatePageSeconds, estimateQuestionSeconds, pageQuestionIds } from "./survey.js";

/**
 * Benchmarks are what "too fast" is measured against. Peers first — the
 * median of this survey's own completes, page by page — because every survey
 * has its own natural pace. When there are fewer than `MIN_PEERS` completes,
 * the definition's reading-time estimate stands in, and the explanation says
 * so ("vs. estimated reading time" rather than "vs. median").
 */
export const MIN_PEERS = 8;

export function computeBenchmarks(def: SurveyDefinition, peers: PeerRecord[]): Benchmarks {
  const pq = pageQuestionIds(def);
  const pageEstimates: Record<string, number> = {};
  for (const [pid, qids] of Object.entries(pq)) pageEstimates[pid] = estimatePageSeconds(def, qids);
  const questionEstimates: Record<string, number> = {};
  for (const q of def.questions) questionEstimates[q.id] = estimateQuestionSeconds(q);
  const estimatedDurationSec = Object.values(pageEstimates).reduce((s, x) => s + x, 0);

  const completes = peers.filter((p) => p.status === "complete");
  const durations = completes
    .map((p) => p.system?.SYSTEM_TOTAL_DURATION ?? durationFromStamps(p.startedAt, p.completedAt))
    .filter((x): x is number => typeof x === "number" && x > 0);

  const pageMedians: Record<string, number> = {};
  const questionMedians: Record<string, number> = {};
  if (completes.length >= MIN_PEERS) {
    const perPage: Record<string, number[]> = {};
    const perQ: Record<string, number[]> = {};
    for (const p of completes) {
      for (const [pid, t] of Object.entries(p.system?.SYSTEM_PAGE_TIME ?? {})) (perPage[pid] ??= []).push(t);
      for (const [qid, t] of Object.entries(p.system?.SYSTEM_QUESTION_TIME ?? {})) (perQ[qid] ??= []).push(t);
    }
    for (const [pid, xs] of Object.entries(perPage)) { const m = median(xs); if (m !== null && xs.length >= MIN_PEERS) pageMedians[pid] = m; }
    for (const [qid, xs] of Object.entries(perQ)) { const m = median(xs); if (m !== null && xs.length >= MIN_PEERS) questionMedians[qid] = m; }
  }

  return {
    peers: completes.length,
    medianDurationSec: durations.length >= MIN_PEERS ? median(durations) : null,
    pageMedians,
    questionMedians,
    pageEstimates,
    questionEstimates,
    estimatedDurationSec,
  };
}

export function durationFromStamps(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 1000;
  return Number.isFinite(d) && d >= 0 ? d : null;
}

/** benchmark for a page: peer median if known, else the estimate */
export function pageBenchmark(b: Benchmarks, pageId: string): { seconds: number; source: "median" | "estimate" } {
  if (b.pageMedians[pageId] !== undefined) return { seconds: b.pageMedians[pageId], source: "median" };
  return { seconds: b.pageEstimates[pageId] ?? 3, source: "estimate" };
}

export function totalBenchmark(b: Benchmarks): { seconds: number; source: "median" | "estimate" } {
  if (b.medianDurationSec !== null) return { seconds: b.medianDurationSec, source: "median" };
  return { seconds: b.estimatedDurationSec, source: "estimate" };
}

/* ------------------------------------------------ derived timing views */

/** Seconds spent per page (summed over visits, out-of-focus time removed). */
export function pageSeconds(t: ResponseTelemetry | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!t) return out;
  for (const v of t.pages) {
    const end = v.leftAt ?? t.submittedAt;
    if (end === undefined) continue;
    const ms = Math.max(0, end - v.enteredAt - (v.outOfFocusMs ?? 0));
    out[v.pageId] = (out[v.pageId] ?? 0) + ms / 1000;
  }
  return out;
}

/** Seconds a question took: page-entry → last change on its first answering visit, else its page's time share. */
export function questionSeconds(t: ResponseTelemetry | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!t) return out;
  const pages = pageSeconds(t);
  for (const v of t.pages) {
    const n = v.questionIds.length || 1;
    for (const qid of v.questionIds) {
      const qt = t.questions[qid];
      if (qt?.firstChangeAt !== undefined && qt.lastChangeAt !== undefined && qt.firstChangeAt >= v.enteredAt - 1 && (v.leftAt === undefined || qt.firstChangeAt <= v.leftAt + 1)) {
        // active span on this visit: from page entry to the last change here
        const span = Math.max(0.2, (qt.lastChangeAt - v.enteredAt) / 1000);
        out[qid] = Math.max(out[qid] ?? 0, Math.min(span, pages[v.pageId] ?? span));
      } else if (out[qid] === undefined) {
        out[qid] = (pages[v.pageId] ?? 0) / n;
      }
    }
  }
  return out;
}

export function totalSeconds(t: ResponseTelemetry | null, startedAt: string | null, completedAt: string | null): number | null {
  if (t?.submittedAt && t.startedAt) return Math.max(0, (t.submittedAt - t.startedAt) / 1000);
  return durationFromStamps(startedAt, completedAt);
}
