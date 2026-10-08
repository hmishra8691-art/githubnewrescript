"use client";
import React from "react";
import type { ResearchConstruct, ResearchDesign } from "@rescript/schema";
import { applySurveyActions, hypothesisCoverage } from "@rescript/engine";
import { hypothesisLabel } from "@rescript/schema";
import { useStudio } from "./store";
import { InlineRichText } from "./RichTextEditor";

/**
 * THE RESEARCH DESIGN, EDITED BY HAND (Research Engine audit, Phase 1).
 *
 * The design — objective, hypotheses, population, sample size, methodology,
 * constructs and what measures them, assumptions — is the object every
 * analysis feature reads (coverage, the plan, the verdicts, the report), and
 * until now it could be written only by the copilot's `set_research` or by
 * typing "add hypothesis: …" into Intelligent mode. The Analysis tab told the
 * researcher to "write them in the Research design", which did not exist.
 *
 * Edits go through the store like every other panel's, labelled for undo.
 * Removing a hypothesis goes through the engine's `remove_hypothesis`, which
 * renumbers the H-labels on every question and plan item that cites it —
 * the one edit where a form writing the array directly would leave tags
 * pointing at the wrong hypothesis.
 */
const ROLES: ResearchConstruct["role"][] = ["independent", "dependent", "mediator", "moderator", "control", "screening", "descriptive"];
const EMPTY: ResearchDesign = { hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [] };

export function ResearchDesignEditor({ compact = false }: { compact?: boolean }) {
  const s = useStudio();
  const r: ResearchDesign = s.def.research ?? EMPTY;
  const coverage = React.useMemo(() => hypothesisCoverage(s.def), [s.def]);
  const patch = (label: string, fn: (d: ResearchDesign) => void) => {
    s.labelNextEdit(label);
    s.update((d) => {
      const cur: ResearchDesign = d.research ?? { ...EMPTY, hypotheses: [], constructs: [], analysis: [], assumptions: [], sources: [] };
      fn(cur);
      cur.updatedAt = new Date().toISOString();
      d.research = cur;
    });
  };
  const [draftHyp, setDraftHyp] = React.useState("");
  const addHypothesis = () => {
    const text = draftHyp.trim();
    if (!text) return;
    if (r.hypotheses.some((h) => h.trim().toLowerCase() === text.toLowerCase())) { s.toast("That hypothesis is already recorded", "err"); return; }
    patch("add hypothesis", (d) => { d.hypotheses.push(text); });
    setDraftHyp("");
  };
  const removeHypothesis = (i: number) => {
    const label = hypothesisLabel(i);
    const cited = coverage[i] ? coverage[i].tests.length + coverage[i].crosstabs.length : 0;
    if (cited && !window.confirm(`Remove ${label}? ${cited} planned ${cited === 1 ? "item cites" : "items cite"} it; the later hypotheses are renumbered and their tags follow them.`)) return;
    s.labelNextEdit(`remove ${label}`);
    s.update((d) => {
      // the engine's own removal: drops the label from every question and plan item, renumbers the rest
      const out = applySurveyActions(d, [{ op: "remove_hypothesis", hypothesis: label }]);
      if (out.valid) Object.assign(d, out.def);
      else d.research!.hypotheses.splice(i, 1);
    });
  };
  const byId = new Map(s.def.questions.map((q) => [q.id, q]));
  const questionLabel = (id: string) => { const q = byId.get(id); return q ? `${q.code} · ${(q.variableName || "").slice(0, 24)}` : id; };

  return (
    <div className={`rd-editor${compact ? " compact" : ""}`} data-testid="research-design">
      <div className="settings-grid">
        <label className="f"><span>Research objective</span>
          <textarea className="ta" rows={2} data-testid="rd-objective" placeholder="e.g. Understand why customers switch from Brand A to Brand B"
            value={r.objective ?? ""} onChange={(e) => patch("edit research objective", (d) => { d.objective = e.target.value || undefined; })} /></label>
        <label className="f"><span>Target population</span>
          <textarea className="ta" rows={2} data-testid="rd-population" placeholder="e.g. Adults 18–65 who bought in the category in the last 12 months"
            value={r.population ?? ""} onChange={(e) => patch("edit target population", (d) => { d.population = e.target.value || undefined; })} /></label>
        <label className="f"><span>Methodology</span>
          <textarea className="ta" rows={2} data-testid="rd-methodology" placeholder="e.g. Online quantitative survey, 12 minutes, quota sample"
            value={r.methodology ?? ""} onChange={(e) => patch("edit methodology", (d) => { d.methodology = e.target.value || undefined; })} /></label>
        <label className="f" style={{ maxWidth: 220 }}><span>Planned completes</span>
          <input className="input" type="number" min={1} step={1} data-testid="rd-sample" placeholder="e.g. 1000"
            value={r.sampleSize ?? ""} onChange={(e) => patch("edit planned sample size", (d) => { const n = Math.floor(Number(e.target.value)); d.sampleSize = Number.isFinite(n) && n > 0 ? n : undefined; })} /></label>
      </div>

      <h4 className="rd-h">Hypotheses <span className="muted">· {r.hypotheses.length}</span></h4>
      <ol className="rd-list" data-testid="rd-hypotheses">
        {r.hypotheses.map((h, i) => {
          const c = coverage[i];
          return (
            <li key={i} className="rd-row" data-testid="rd-hypothesis" data-status={c?.status ?? ""}>
              <span className="mono rd-label">{hypothesisLabel(i)}</span>
              <InlineRichText className="grow" value={h} testId="rd-hypothesis-text" placeholder="State the hypothesis" questionId={undefined}
                onChange={(text) => patch(`edit ${hypothesisLabel(i)}`, (d) => { d.hypotheses[i] = text; })} />
              {c && <span className={`chip${c.status === "testable" ? " on" : c.status === "partly" ? " warn" : ""}`} title={c.status === "testable" ? "measured, and a table or test is planned" : c.status === "partly" ? "measured, nothing planned yet" : c.status === "unmeasured" ? "a construct it names has no question" : "no construct or question is linked to it"}>{c.status === "testable" ? "testable" : c.status === "partly" ? "unplanned" : c.status === "unmeasured" ? "unmeasured" : "unlinked"}</span>}
              <button type="button" className="btn small danger" data-testid="rd-hypothesis-remove" title="Remove this hypothesis (later ones are renumbered)" onClick={() => removeHypothesis(i)}>×</button>
            </li>
          );
        })}
      </ol>
      <div className="row" style={{ gap: 6 }}>
        <input className="input grow" data-testid="rd-hypothesis-new" placeholder="New hypothesis, e.g. Price perception drives switching" value={draftHyp}
          onChange={(e) => setDraftHyp(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addHypothesis(); } }} />
        <button type="button" className="btn small" data-testid="rd-hypothesis-add" onClick={addHypothesis} disabled={!draftHyp.trim()}>+ hypothesis</button>
      </div>

      <h4 className="rd-h">Constructs <span className="muted">· what the study measures, and which questions measure it</span></h4>
      <div className="rd-constructs" data-testid="rd-constructs">
        {r.constructs.map((c, i) => (
          <div key={i} className="card rd-construct" data-testid="rd-construct" style={{ padding: 10 }}>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <input className="input" style={{ width: 200 }} data-testid="rd-construct-name" placeholder="Construct name, e.g. Price perception" value={c.name}
                onChange={(e) => patch("rename construct", (d) => { d.constructs[i].name = e.target.value; })} />
              <select className="select" style={{ width: 140 }} data-testid="rd-construct-role" value={c.role}
                onChange={(e) => patch("change construct role", (d) => { d.constructs[i].role = e.target.value as ResearchConstruct["role"]; })}>
                {ROLES.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              <input className="input grow" data-testid="rd-construct-definition" placeholder="Definition (optional)" value={c.definition ?? ""}
                onChange={(e) => patch("edit construct definition", (d) => { d.constructs[i].definition = e.target.value || undefined; })} />
              <button type="button" className="btn small danger" data-testid="rd-construct-remove" title="Remove this construct" onClick={() => patch("remove construct", (d) => { d.constructs.splice(i, 1); })}>×</button>
            </div>
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}>
              <span className="muted" style={{ fontSize: 12.5 }}>Measured by</span>
              {c.questionIds.map((id) => (
                <span key={id} className="chip" data-testid="rd-construct-question">{questionLabel(id)} <button type="button" className="rd-x" aria-label={`Remove ${questionLabel(id)}`} onClick={() => patch("unlink question from construct", (d) => { d.constructs[i].questionIds = d.constructs[i].questionIds.filter((x) => x !== id); })}>×</button></span>
              ))}
              <select className="select" style={{ width: 220 }} data-testid="rd-construct-add-question" value=""
                onChange={(e) => { const id = e.target.value; if (!id) return; patch("link question to construct", (d) => { if (!d.constructs[i].questionIds.includes(id)) d.constructs[i].questionIds.push(id); }); }}>
                <option value="">+ add a question…</option>
                {s.def.questions.filter((q) => !c.questionIds.includes(q.id) && !["html", "custom_component"].includes(q.type)).map((q) => <option key={q.id} value={q.id}>{q.code} — {(q.text || q.variableName).replace(/<[^>]*>/g, "").slice(0, 60)}</option>)}
              </select>
            </div>
          </div>
        ))}
        <button type="button" className="btn small" data-testid="rd-construct-add" onClick={() => patch("add construct", (d) => { d.constructs.push({ name: `Construct ${d.constructs.length + 1}`, role: "descriptive", questionIds: [] }); })}>+ construct</button>
      </div>

      <h4 className="rd-h">Assumptions <span className="muted">· what the design rests on that is not yet confirmed</span></h4>
      <LineList items={r.assumptions} testId="rd-assumption" placeholder="e.g. Respondents can recall their previous brand" onChange={(items) => patch("edit assumptions", (d) => { d.assumptions = items; })} />
    </div>
  );
}

function LineList({ items, onChange, placeholder, testId }: { items: string[]; onChange(items: string[]): void; placeholder: string; testId: string }) {
  const [draft, setDraft] = React.useState("");
  const add = () => { const t = draft.trim(); if (!t) return; onChange([...items, t]); setDraft(""); };
  return (
    <div>
      <ul className="rd-list" data-testid={`${testId}s`}>
        {items.map((a, i) => (
          <li key={i} className="rd-row" data-testid={testId}>
            <input className="input grow" value={a} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} />
            <button type="button" className="btn small danger" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>×</button>
          </li>
        ))}
      </ul>
      <div className="row" style={{ gap: 6 }}>
        <input className="input grow" data-testid={`${testId}-new`} placeholder={placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <button type="button" className="btn small" data-testid={`${testId}-add`} onClick={add} disabled={!draft.trim()}>+ add</button>
      </div>
    </div>
  );
}
