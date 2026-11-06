"use client";
import React from "react";
import type { ThemeSynthesis } from "@rescript/analytics";
import { useStudio } from "../store";
import { applyHandoff, proposeHandoff } from "@/lib/qual/handoffApply";
import type { WorkspaceView } from "./qualApi";
import type { SynthesisState } from "./synthesisApi";

/**
 * HAND THE THEMES TO THE QUANTITATIVE PHASE (platform audit 2026-11-05; capability `mixed_methods`).
 *
 * The one gap between "an end-to-end research tool" and what the platform did: both phases of a mixed-methods
 * study were designed here and the researcher retyped the qualitative themes into the quantitative design. This
 * card shows what `qualHandoff` would write — a hypothesis, a research question and a construct per reviewed
 * theme, plus a Likert grid over the themes and a "which matters most" item on a page of their own — and
 * writes it into the survey on one click, through the Studio's own update path (undo, autosave, the edit lock).
 */
export function HandoffCard({ ws, st }: { ws: WorkspaceView; st: SynthesisState | null }) {
  const s = useStudio();
  const [includeAi, setIncludeAi] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const syntheses = React.useMemo<ThemeSynthesis[]>(() => Object.values(st?.themes ?? {}).map((v) => v.record), [st]);
  const proposal = React.useMemo(() => proposeHandoff(s.def, ws.state, syntheses, { includeAiSuggested: includeAi }), [s.def, ws.state, syntheses, includeAi]);
  const canEdit = !s.readOnly;

  const apply = () => {
    if (!proposal.themes.length) return;
    s.labelNextEdit("hand qualitative themes to the quantitative phase");
    let done: ReturnType<typeof applyHandoff> | null = null;
    s.update((d) => { done = applyHandoff(d, proposal); });
    if (done) {
      const r = done as ReturnType<typeof applyHandoff>;
      s.toast(`${r.hypotheses} hypothes${r.hypotheses === 1 ? "is" : "es"}, ${r.constructs} construct${r.constructs === 1 ? "" : "s"} and ${r.questions} question${r.questions === 1 ? "" : "s"} added to the survey — see Research design and the last page of the flow.`, "ok");
    }
  };

  return (
    <div className="card ql-section" data-testid="qual-handoff" data-themes={proposal.themes.length} data-skipped={proposal.skipped.length}>
      <div className="ql-row">
        <div className="eyebrow">Hand to the quantitative phase</div>
        <span className="grow" />
        <label className="ql-muted" style={{ fontSize: 12.5 }}>
          <input type="checkbox" checked={includeAi} onChange={(e) => setIncludeAi(e.target.checked)} data-testid="handoff-include-ai" /> include themes nobody has reviewed yet
        </label>
        <button type="button" className="btn small" onClick={() => setOpen((o) => !o)} data-testid="handoff-preview">{open ? "Hide" : "Preview"}</button>
        <button type="button" className="btn primary small" disabled={!canEdit || !proposal.themes.length} onClick={apply} data-testid="handoff-apply" title={canEdit ? undefined : (s.readOnlyReason ?? "The survey is read-only")}>
          Write into the survey
        </button>
      </div>
      <p className="ql-muted" style={{ fontSize: 13, margin: "4px 0 0" }} data-testid="handoff-statement">{proposal.statement}</p>
      {open && (
        <div style={{ marginTop: 8 }}>
          {proposal.themes.map((t) => (
            <div key={t.themeId} className="ql-section" data-testid="handoff-theme" data-name={t.name} style={{ fontSize: 13 }}>
              <b>{t.name}</b> <span className="ql-muted">· {t.evidence.sources}{t.evidence.totalSources ? ` of ${t.evidence.totalSources}` : ""} sources · {t.evidence.excerpts} excerpts</span>
              <div><span className="ql-muted">Hypothesis:</span> {t.hypothesis}</div>
              <div><span className="ql-muted">Question:</span> {t.researchQuestion}</div>
              <div><span className="ql-muted">Construct:</span> {t.construct.name}{t.construct.facets.length ? ` — ${t.construct.facets.join(", ")}` : ""}</div>
            </div>
          ))}
          {proposal.questions.length > 0 && (
            <div className="ql-section" style={{ fontSize: 13 }}>
              <b>Questions</b>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {proposal.questions.map((q) => <li key={q.id}><span className="mono">{q.code}</span> — {q.text}{q.rows ? ` (${q.rows.length} rows, ${q.options.length}-point agreement)` : ` (${q.options.length} options)`}</li>)}
              </ul>
            </div>
          )}
          {proposal.skipped.length > 0 && (
            <p className="ql-muted" style={{ fontSize: 12.5 }}>Skipped: {proposal.skipped.map((x) => `${x.name} (${x.why})`).join("; ")}.</p>
          )}
        </div>
      )}
    </div>
  );
}
