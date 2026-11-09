"use client";
import React from "react";
import { useStudio } from "./store";
import { STAGE_WORDS, lastScriptCheck, runScriptCheck, subscribeScriptCheck } from "../../lib/scripts/scriptCheck";

function useCheck() {
  const s = useStudio();
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => subscribeScriptCheck(force), []);
  return lastScriptCheck(s.def);
}

/** Scripts panel: run the lifecycle check; counts per stage (2026-11-09) */
export function ScriptLifecycleBar() {
  const s = useStudio();
  const run = useCheck();
  const [busy, setBusy] = React.useState(false);
  if (!s.def.scripts.length) return null;
  const go = async () => { setBusy(true); try { await new Promise((r) => setTimeout(r, 0)); await runScriptCheck(s.def, s.surveyDbId); } finally { setBusy(false); } };
  return (
    <div className="sl-bar" data-testid="script-lifecycle">
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <strong>Script status</strong>
        <span className="muted">Generated → executed → validated: written is not the same as run, and run is not the same as right.</span>
        <span className="grow" />
        <button type="button" className="btn small" disabled={busy} onClick={() => void go()} data-testid="script-check">{busy ? "Checking…" : run ? "Check again" : "Check scripts"}</button>
      </div>
      {run && (
        <div className="sl-counts" data-testid="script-check-counts">
          {run.stale && <span className="chip warn" data-testid="script-check-stale">The survey changed since this check — run it again</span>}
          {(["validated", "executed", "generated", "not_reached", "failing", "refused", "empty"] as const).filter((k) => run.check.counts[k]).map((k) => <span key={k} className={`chip sl-${k}`}>{run.check.counts[k]} {STAGE_WORDS[k].toLowerCase()}</span>)}
          <span className="muted">{run.check.simulated} simulated respondents · {run.check.casesRun} test case{run.check.casesRun === 1 ? "" : "s"}</span>
          {run.casesNote && <p className="muted" style={{ margin: "4px 0 0", fontSize: 12.5 }}>{run.casesNote}</p>}
        </div>
      )}
    </div>
  );
}

/** on each script card: its stage and the evidence for it */
export function ScriptStageChip({ scriptId }: { scriptId: string }) {
  const run = useCheck();
  const st = run?.check.scripts.find((x) => x.id === scriptId);
  if (!run || !st) return <span className="chip" data-testid="script-stage" data-stage="unchecked" title="Run “Check scripts” to see whether it runs and whether a test checks it">Not checked</span>;
  const origin = st.origin === "ai" ? "AI" : st.origin === "import" ? "imported" : st.origin === "person" ? "person" : null;
  return (
    <span className="sl-stage" data-testid="script-stage" data-stage={run.stale ? "stale" : st.stage}>
      <span className={`chip sl-${st.stage}${run.stale ? " sl-stale" : ""}`} title={st.summary}>{STAGE_WORDS[st.stage]}{run.stale ? " (stale)" : ""}</span>
      {origin && <span className="muted" style={{ fontSize: 12 }}>last written by {origin}</span>}
      <span className="sl-why" data-testid="script-stage-why">{st.summary}</span>
    </span>
  );
}
