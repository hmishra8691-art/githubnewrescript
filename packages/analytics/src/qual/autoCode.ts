import type { QualCodebook, QualSegment } from "./types.js";
import { codingBatches, type CodingBatch } from "./aiCoding.js";
import type { RedactOptions } from "./redact.js";

/**
 * THE AUTOMATIC CODING PIPELINE (2026-10-22) — when an AI-moderated interview
 * completes, a transcript is imported or a group session closes, and the study
 * has turned it on: segment (done at import) → redact → code with the current
 * codebook (deductive) or propose codes (inductive) → everything lands
 * AI-suggested for review → the theme summaries it touches become stale (and,
 * when asked, are regenerated).
 *
 * It runs as a JOB (one row, like the chunked HB job of 0066): idempotent by
 * key (the source and its revision — the same transcript is never coded twice;
 * a corrected one is a new key), resumable (the cursor is the next batch; the
 * batches are recomputed from the source deterministically, so a continuation
 * codes exactly the batches not yet coded), batched and capped (at most
 * `maxBatchesPerSource` model calls per source), metered per call, and leased
 * so two continuations never code the same batch at once. Pure: the route does
 * the I/O.
 */

export interface AutoCodeSettings {
  enabled: boolean;
  /** auto: deductive when the codebook has live codes, else inductive */
  mode: "auto" | "deductive" | "inductive";
  maxBatchesPerSource: number;
  /** regenerate the summaries of the themes the new excerpts touch (more model calls); else they are only marked stale */
  updateSummaries: boolean;
}
export const DEFAULT_AUTOCODE: AutoCodeSettings = { enabled: false, mode: "auto", maxBatchesPerSource: 6, updateSummaries: false };
export const AUTOCODE_MAX_BATCHES = 20;

export function readAutoCodeSettings(v: unknown): AutoCodeSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const mode = o.mode === "deductive" || o.mode === "inductive" ? o.mode : "auto";
  const max = Number(o.maxBatchesPerSource);
  return { enabled: o.enabled === true, mode, maxBatchesPerSource: Number.isInteger(max) && max >= 1 ? Math.min(AUTOCODE_MAX_BATCHES, max) : DEFAULT_AUTOCODE.maxBatchesPerSource, updateSummaries: o.updateSummaries === true };
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "refused";
export interface AutoCodeProgress { batchesTotal: number; batchesDone: number; calls: number; excerpts: number; codes: number; rejected: number; skippedSegments: number; mode?: "inductive" | "deductive" }
export interface QualJob { id: string; kind: "autocode" | "transcribe_long"; key: string; status: JobStatus; sourceIds: string[]; progress: AutoCodeProgress | Record<string, unknown>; cursor: Record<string, unknown>; error?: string | null; leaseUntil?: string | null; createdAt?: string; updatedAt?: string }

/** the idempotency key of auto-coding one source at one revision */
export const autoCodeKey = (transcriptId: string, revision = 0): string => `autocode:${transcriptId}:r${revision}`;

/** inductive or deductive for this run */
export function autoCodeMode(settings: AutoCodeSettings, codebook: QualCodebook): "inductive" | "deductive" {
  if (settings.mode !== "auto") return settings.mode === "deductive" && !codebook.codes.some((c) => c.status !== "rejected") ? "inductive" : settings.mode;
  return codebook.codes.some((c) => c.status !== "rejected") ? "deductive" : "inductive";
}

/** the batches of one source — deterministic, so a continuation recomputes the same ones and codes from the cursor */
export function autoCodeBatches(segments: readonly QualSegment[], settings: AutoCodeSettings, redact: RedactOptions): { batches: CodingBatch[]; skipped: number } {
  return codingBatches(segments, { redact, maxBatches: Math.min(AUTOCODE_MAX_BATCHES, settings.maxBatchesPerSource) });
}

/** the next step of a job: the batch to code, or done */
export function nextAutoCodeStep(job: Pick<QualJob, "status" | "cursor">, total: number): { batch: number } | { done: true } {
  if (job.status !== "queued" && job.status !== "running") return { done: true };
  const at = Number((job.cursor as { batch?: unknown }).batch ?? 0);
  return Number.isInteger(at) && at < total ? { batch: at } : { done: true };
}

/** a lease: free when none, or expired */
export const leaseFree = (leaseUntil: string | null | undefined, now: number): boolean => !leaseUntil || Date.parse(leaseUntil) <= now;

/** which sources still need auto-coding: transcripts with participant text and no job for their current revision */
export function sourcesToAutoCode(transcripts: readonly { id: string; revision?: number; segments: readonly QualSegment[]; createdAt?: string }[], jobKeys: ReadonlySet<string>, opts: { since?: string } = {}): string[] {
  return transcripts.filter((t) => (!opts.since || !t.createdAt || t.createdAt >= opts.since) && t.segments.some((s) => s.role !== "moderator" && s.text.trim()) && !jobKeys.has(autoCodeKey(t.id, t.revision ?? 0))).map((t) => t.id);
}
