"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import type { ItemVerdict } from "@rescript/engine";
import { ScriptHistoryPanel } from "./ScriptHistory";
import { runEditorTest, runLog, runMarkers, type RunLine, type RunTarget } from "@/lib/scripts/testRun.ts";
import type { CodeDiagnostic } from "@/lib/code/types.ts";

/**
 * S3b — the management tools of ONE script editor (behaviour script, logic script, component JS): buttons for the
 * editor's header and the panels shown under it.
 *   History (item 5)              the item's audit entries and a code diff between versions
 *   Run in a test session (item 6) the S2c harness on the editor's CURRENT text (unsaved), its verdict and run log;
 *                                  errors that name a line become markers on that line
 * `itemKey` is the script audit log's item (`${kind}:${id}`); `code` is the editor's current text.
 */
type Run = { status: "running" } | { status: "done"; verdict: ItemVerdict; lines: RunLine[]; code: string; markers: CodeDiagnostic[]; ms: number } | { status: "error"; error: string };

const VERDICT_WORDS: Record<string, string> = {
  "ran-ok": "Ran — it did what it does, without errors", "ran-no-effect": "Ran — but nothing visible happened", "ran-error": "Ran — with an error",
  blocked: "Refused when run", timeout: "Stopped (time limit / watchdog)", "not-run": "Could not be run here",
};

export function useScriptTools(o: { itemKey: string | null; code: string; def?: SurveyDefinition; run?: RunTarget | null }) {
  const [panel, setPanel] = React.useState<"history" | null>(null);
  const [run, setRun] = React.useState<Run | null>(null);
  const start = async () => {
    if (!o.def || !o.run) return;
    setRun({ status: "running" });
    const t0 = Date.now();
    try {
      const { runVerification } = await import("@/lib/copilot/verify/harness");
      const r = await runEditorTest(o.def, o.run, o.code, (d, items) => runVerification(d, items));
      if ("error" in r) { setRun({ status: "error", error: r.error }); return; }
      setRun({ status: "done", verdict: r.verdict, lines: runLog(r.report), code: r.code, markers: runMarkers(r.report, r.code), ms: Date.now() - t0 });
    } catch (e) { setRun({ status: "error", error: e instanceof Error ? e.message : String(e) }); }
  };
  const buttons = (
    <>
      {o.run && o.def && <button type="button" className="btn sm ghost" disabled={run?.status === "running" || !o.code.trim()} onClick={() => void start()} data-testid="code-run"
        title="Run the code as it is in this editor (not saved) in a test session: the real page, its sandbox and write channel; nothing is saved">{run?.status === "running" ? "Running…" : "Run in a test session"}</button>}
      {o.itemKey && <button type="button" className="btn sm ghost" aria-expanded={panel === "history"} data-testid="code-history-toggle"
        onClick={() => setPanel((p) => (p === "history" ? null : "history"))}>History</button>}
    </>
  );
  const panels = (
    <>
      {run && run.status !== "running" && (
        <div className={`code-run ${run.status === "done" && (run.verdict.verdict === "ran-ok" || run.verdict.verdict === "ran-no-effect") ? "ok" : "fail"}`} data-testid="code-run-panel"
          data-verdict={run.status === "done" ? run.verdict.verdict : "error"} role="status">
          <div className="row" style={{ gap: 6 }}>
            <b data-testid="code-run-verdict">{run.status === "done" ? VERDICT_WORDS[run.verdict.verdict] ?? run.verdict.verdict : `Could not run: ${run.error}`}</b>
            <span className="grow" />
            {run.status === "done" && <span className="muted">{run.verdict.scenarios} scenario{run.verdict.scenarios === 1 ? "" : "s"} · {run.ms} ms · not saved</span>}
            <button type="button" className="btn sm ghost" onClick={() => setRun(null)}>Close</button>
          </div>
          {run.status === "done" && <>
            <div className="muted" data-testid="code-run-summary">{run.verdict.summary}</div>
            {run.lines.length > 0 ? (
              <pre data-testid="code-run-log">{run.lines.map((l) => `${l.kind === "error" ? "✖ error" : l.kind === "log" ? "· log" : l.kind === "effect" ? "→ effect" : l.kind === "write" ? "✎ write" : l.kind === "next" ? "▸ next" : "· note"}${l.line ? ` (line ${l.line})` : ""}${l.scenario ? ` [${l.scenario}]` : ""}: ${l.text}`).join("\n")}</pre>
            ) : <p className="muted" style={{ margin: "4px 0" }}>Nothing was logged, changed or written.</p>}
          </>}
        </div>
      )}
      {o.itemKey && panel === "history" && <ScriptHistoryPanel itemKey={o.itemKey} current={o.code} onClose={() => setPanel(null)} />}
    </>
  );
  const diagnostics = run?.status === "done" ? { forCode: run.code, list: run.markers } : null;
  return { buttons, panels, diagnostics };
}
