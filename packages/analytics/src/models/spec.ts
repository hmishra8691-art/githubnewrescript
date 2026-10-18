/**
 * THE STABLE INTERFACE BETWEEN THE APP AND MODEL EXECUTION (§8 D).
 *
 * Every advanced model (HB-MNL, latent class, SEM) takes a validated
 * SPECIFICATION and returns the same envelope: a status, progress where the
 * model runs in steps, diagnostics and warnings with stable codes, a
 * structured output (null when the model must not be read), and the metadata
 * that makes the run reproducible — model, estimator version, seed, a
 * fingerprint of the exact data it saw, the options it ran with.
 *
 * The rule the envelope enforces: an output is present only when it is valid.
 * A model that did not converge, is not identified, or hit an improper
 * solution returns `status: "failed"` (or "refused" before running) with the
 * diagnostics that say why — never coefficients or fit indices dressed up as
 * results, and never a silent fallback to a simpler model.
 */

/** bump when a change could alter a number any advanced model reports */
export const MODELS_VERSION = "2026.10.18";

export type ModelKind = "hb" | "lca" | "sem";
export type ModelStatus = "done" | "running" | "failed" | "refused" | "cancelled";

export interface ModelDiagnostic {
  /** stable machine code, e.g. "not_identified", "heywood", "not_converged", "rhat_high" */
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface ModelMeta {
  model: ModelKind;
  /** `MODELS_VERSION` of the code that produced it */
  version: string;
  seed: number | null;
  /** FNV-1a over the numeric input the estimator saw — equal fingerprint, equal data */
  dataFingerprint: string;
  n: number;
  options: Record<string, unknown>;
  elapsedMs: number;
}

export interface ModelRun<T> {
  status: ModelStatus;
  progress?: { done: number; total: number; unit: string };
  diagnostics: ModelDiagnostic[];
  output: T | null;
  meta: ModelMeta;
  error?: { code: string; message: string };
}

export const diag = (code: string, severity: ModelDiagnostic["severity"], message: string): ModelDiagnostic => ({ code, severity, message });

/**
 * FNV-1a (32-bit, two lanes → 16 hex chars) over numbers, read as their IEEE
 * doubles, so 1 and 1.0000000001 differ and the order of values matters.
 */
export function fingerprintNumbers(chunks: Iterable<ArrayLike<number>>): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  const buf = new DataView(new ArrayBuffer(8));
  for (const arr of chunks) {
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      buf.setFloat64(0, Number.isFinite(v) ? v : -0.123456789e300);
      for (let b = 0; b < 8; b++) {
        const byte = buf.getUint8(b);
        h1 = Math.imul(h1 ^ byte, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ byte, 0x01000193 + 2) >>> 0;
      }
    }
    h1 = Math.imul(h1 ^ 0xff, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export const nowMs = (): number => { const p = (globalThis as { performance?: { now(): number } }).performance; return p ? p.now() : Date.now(); };

/** integer option within bounds, or the default */
export function intOpt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
}
export function numOpt(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
