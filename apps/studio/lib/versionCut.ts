/*
 * ARCH-13 — what `POST /api/surveys/:id/versions` does with the answer of
 * `rescript_cut_version` (migration 0059), as a pure function so the
 * decision is tested without a database.
 *
 * The RPC inserts the snapshot and points the survey at it in one
 * transaction. The route calls it first; only when PostgREST says the
 * function does not exist (0059 not applied yet) does it fall back to the
 * older insert + `rescript_finalize_version` path.
 */

export interface RpcAnswer {
  data: unknown;
  error: { message?: string; code?: string; details?: string; hint?: string } | null;
}

export type CutDecision =
  /** the version was written and the survey points at it */
  | { kind: "cut"; versionId: string; version: string; revision: number | null }
  /** the survey moved past the editor's base revision; nothing was written */
  | { kind: "conflict"; revision: number | null }
  /** another cut took this version number; nothing was written — try the next number */
  | { kind: "version_taken" }
  /** the survey does not exist (deleted between the guard and the cut) */
  | { kind: "not_found" }
  /** the database predates 0059: use the two-step path */
  | { kind: "legacy" }
  | { kind: "error"; message: string };

/** PostgREST / Postgres saying the function is not there (not "the function failed"). */
export function isMissingFunction(err: RpcAnswer["error"], name = "rescript_cut_version"): boolean {
  if (!err) return false;
  if (err.code === "PGRST202" || err.code === "42883") return true;
  const text = `${err.message ?? ""} ${err.details ?? ""} ${err.hint ?? ""}`;
  return new RegExp(`could not find the function[^]*${name}|function [^ ]*${name}\\b[^]*does not exist`, "i").test(text);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : null);

export function decideCut(res: RpcAnswer): CutDecision {
  if (res.error) {
    if (isMissingFunction(res.error)) return { kind: "legacy" };
    return { kind: "error", message: res.error.message ?? "save failed" };
  }
  const row = (Array.isArray(res.data) ? res.data[0] : res.data) as
    | { outcome?: unknown; version_id?: unknown; cut_version?: unknown; revision?: unknown }
    | null
    | undefined;
  if (!row || typeof row !== "object") return { kind: "error", message: "the version cut returned nothing" };
  switch (row.outcome) {
    case "cut":
      if (typeof row.version_id !== "string" || typeof row.cut_version !== "string") return { kind: "error", message: "the version cut returned no version" };
      return { kind: "cut", versionId: row.version_id, version: row.cut_version, revision: num(row.revision) };
    case "conflict":
      return { kind: "conflict", revision: num(row.revision) };
    case "version_taken":
      return { kind: "version_taken" };
    case "not_found":
      return { kind: "not_found" };
    default:
      return { kind: "error", message: `the version cut answered ${JSON.stringify(row.outcome)}` };
  }
}

/**
 * The two-step path's unique-constraint check, matched on the constraint
 * NAME or SQLSTATE rather than only on wording — a driver that phrases
 * "duplicate" differently used to turn a recoverable collision into a 500.
 */
export const isVersionCollision = (msg?: string): boolean =>
  !!msg && (/duplicate/i.test(msg) || /survey_versions_survey_id_version_key/i.test(msg) ||
            /unique constraint/i.test(msg) || /23505/.test(msg));
