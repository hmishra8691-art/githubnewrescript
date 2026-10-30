"use client";
import React from "react";
import { SCRIPT_CHECKED } from "@rescript/engine";
import type { VerifyView } from "./useCopilot";

/**
 * S2c — WHAT THE TEST SESSION FOUND, on the proposal card and in the Changes panel: "Running in a test session…",
 * then one line per code item with its verdict ("Ran in a test session: 4 scenarios, added class rs-highlight to Q5
 * on “Brand B”, no errors" / the error / "could not be run here: …"). After a failed repair, Apply needs "Apply anyway".
 */
export function VerifyCard({ verify, compact, onApplyAnyway, canApply }: { verify: VerifyView | null; compact?: boolean; onApplyAnyway?: () => void; canApply?: boolean }) {
  if (!verify) return null;
  const status = verify.status === "running" ? "running" : verify.status === "repairing" ? "repairing" : verify.ok ? "ok" : "failed";
  const verdicts = verify.report?.verdicts ?? [];
  return (
    <div className={`cp-block ${status === "failed" ? "err" : status === "ok" ? "" : "warn"}`} data-testid="cp-verify" data-status={status} data-repaired={verify.repaired}>
      <div className="iq-label">
        {status === "running" ? "Running in a test session…"
          : status === "repairing" ? "The test session found a problem — asking the copilot to fix it…"
          : status === "ok" ? (verdicts.every((v) => v.verdict === "not-run") ? "Checked — could not be run here" : "Ran in a test session")
          : verify.repaired ? "Still failing after one repair — review before applying" : "Did not pass the test session"}
      </div>
      {verdicts.length > 0 && (
        <ul>
          {verdicts.slice(0, compact ? 4 : 12).map((v) => (
            <li key={v.key} data-testid="cp-verify-item" data-verdict={v.verdict} data-key={v.key}>
              <strong>{v.label}</strong>: {v.summary}
              {!compact && v.detail.length > 1 && <ul className="iqi-dim">{v.detail.slice(1, 5).map((d, i) => <li key={i}>{d}</li>)}</ul>}
            </li>
          ))}
        </ul>
      )}
      {verify.report && !compact && <p className="iqi-dim" data-testid="cp-verify-meta">{verdicts.reduce((n, v) => n + v.scenarios, 0)} scenarios in {(verify.report.durationMs / 1000).toFixed(1)} s — in this browser, with the survey's real page, sandbox and write channel; nothing saved.{verify.report.truncated ? " The 20-second limit was reached: the remaining items were not run." : ""}</p>}
      {status === "failed" && !verify.anyway && onApplyAnyway && (
        <button type="button" className="iq-btn" data-testid="cp-apply-anyway" disabled={canApply === false} onClick={onApplyAnyway} title="Apply the proposal although its scripts did not pass the test session">Apply anyway</button>
      )}
    </div>
  );
}

/**
 * The gate's "checked … not run yet" sentence, made accurate once the test session has run: "checked and run in a
 * test session", or "checked, could not be run here: <reason>", or what failed.
 */
export function withRunNote(text: string, verify: VerifyView | null): string {
  if (!verify || !text.includes("not run yet")) return text;
  const vs = verify.report?.verdicts ?? [];
  const note = verify.status !== "done" ? "checked; running in a test session…"
    : vs.length && vs.every((v) => v.verdict === "not-run") ? `checked, could not be run here: ${vs[0]!.detail[0] ?? "the test session could not start it"}`
    : verify.ok ? "checked and run in a test session (see the result above)"
    : "checked and run in a test session — it did not pass (see above)";
  return text.replace(SCRIPT_CHECKED, note).replace("checked by the logic-script gate, not run yet", note);
}
