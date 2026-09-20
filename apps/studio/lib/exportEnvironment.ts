/**
 * R12 — WHAT ENVIRONMENT DID AN EXPORT HAPPEN IN?
 *
 * The export route used to answer this from a request parameter:
 *
 *     include === "test" ? "TEST" : "LIVE"
 *
 * `include` says which rows to ASK for, not what the file turned out to hold.
 * `include=live` and `include=all` both became LIVE, so exporting a survey
 * that has only ever been tested recorded production usage. In the live
 * database every one of the 22 such events was written against a survey with
 * zero live responses — and three of them after R12 was marked done.
 *
 * Nothing was mis-BILLED by it, because EXPORT_GENERATION is non-billable
 * today. That is exactly why it survived: the number it corrupts costs
 * nothing, and nobody reconciles a free number. It starts mattering at the
 * first period close, when events are grouped and invoiced by environment.
 *
 * The rule here is the one a data-protection question actually asks — did
 * production data leave the platform? — and it is answered by the rows.
 */

/** Just enough of a response row to answer the question. */
export interface EnvironmentRow {
  is_test?: boolean | null;
}

export type ExportEnvironment = "LIVE" | "TEST";

/**
 * LIVE when at least one real response is in the file; TEST otherwise.
 *
 * An EMPTY export is TEST, and deliberately so. Nothing production left the
 * platform, so calling it LIVE would put a production usage event on a
 * project's record for a file with no data in it — which is precisely the
 * shape of the bug this replaces.
 *
 * A row whose `is_test` could not be read (an older database missing the
 * column) counts as NOT live. That direction is the safe one: it under-reports
 * production usage rather than inventing it, and an under-report is visible
 * against the response counts while an over-report looks exactly like real
 * fieldwork.
 */
export function exportEnvironmentOf(rows: readonly EnvironmentRow[]): ExportEnvironment {
  return rows.some((r) => r?.is_test === false) ? "LIVE" : "TEST";
}
