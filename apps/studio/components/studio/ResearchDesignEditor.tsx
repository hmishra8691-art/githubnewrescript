"use client";
import React from "react";
import type { HypothesisDetail, ResearchConstruct, ResearchDesign } from "@rescript/schema";
import { applySurveyActions, describeHypothesis, hypothesisCoverage, structuredHypotheses } from "@rescript/engine";
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
const EMPTY: ResearchDesign = { hypotheses: [], hypothesisDetails: [], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [] };
const H_TYPES: NonNullable<HypothesisDetail["type"]>[] = ["causal", "association", "difference", "descriptive"];
const H_DIRS: NonNullable<HypothesisDetail["direction"]>[] = ["positive", "negative", "difference", "none"];
const H_EFFECTS: NonNullable<HypothesisDetail["expectedEffect"]>[] = ["small", "medium", "large"];
const H_STATUS: NonNullable<HypothesisDetail["status"]>[] = ["proposed", "supported", "not_supported", "mixed", "inconclusive"];

export function ResearchDesignEditor({ compact = false }: { compact?: boolean }) {
  const s = useStudio();
  const r: ResearchDesign = s.def.research ?? EMPTY;
  const coverage = React.useMemo(() => hypothesisCoverage(s.def), [s.def]);
  const readings = React.useMemo(() => structuredHypotheses(s.def), [s.def]);
  const patch = (label: string, fn: (d: ResearchDesign) => void) => {
    s.labelNextEdit(label);
    s.update((d) => {
      const cur: ResearchDesign = d.research ?? { ...EMPTY, hypotheses: [], hypothesisDetails: [], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [] };
      fn(cur);
      cur.updatedAt = new Date().toISOString();
      d.research = cur;
    });
  };
  /* the structured reading of hypothesis i (Phase 3): recorded fields, by index, beside the statement */
  const setDetail = (i: number, label: string, field: keyof HypothesisDetail, value: string) => patch(`${label} of ${hypothesisLabel(i)}`, (d) => {
    const details = [...(d.hypothesisDetails ?? [])];
    while (details.length < d.hypotheses.length) details.push({});
    const next = { ...details[i] } as Record<string, unknown>;
    if (value) next[field] = value; else delete next[field];
    details[i] = next as HypothesisDetail;
    d.hypothesisDetails = details;
  });
  const [openReading, setOpenReading] = React.useState<number | null>(null);
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
      <BriefSection r={r} patch={patch} surveyDbId={s.surveyDbId} />
      <h4 className="rd-h">Research design</h4>
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
        <label className="f rd-strict" title="Enforced: a change that opens a research gap — a construct left with no question, a planned analysis reading a removed variable, a KPI with no variable, a hypothesis nothing tests — is refused at the change, and the gaps the design has are blockers in Review. Off: the same gaps are warnings." data-testid="rd-strict">
          <span>Enforcement</span>
          <span className="row" style={{ gap: 6, alignItems: "center" }}><input type="checkbox" data-testid="rd-strict-box" checked={r.strict === true} onChange={(e) => patch(e.target.checked ? "enforce the research design" : "stop enforcing the research design", (d) => { d.strict = e.target.checked ? true : undefined; })} /> research gaps are blockers</span>
        </label>
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
              <button type="button" className={`btn small${openReading === i ? " on" : ""}`} data-testid="rd-hypothesis-reading" title="The reading of this hypothesis: type, direction, the construct on each side, the effect expected" onClick={() => setOpenReading(openReading === i ? null : i)}>{readings[i] ? describeHypothesis(readings[i]) || "reading" : "reading"}</button>
              <button type="button" className="btn small danger" data-testid="rd-hypothesis-remove" title="Remove this hypothesis (later ones are renumbered)" onClick={() => removeHypothesis(i)}>×</button>
              {openReading === i && readings[i] && (
                <div className="rd-reading" data-testid="rd-reading">
                  {([["type", "Type", H_TYPES], ["direction", "Direction", H_DIRS], ["expectedEffect", "Expected effect", H_EFFECTS], ["status", "Status", H_STATUS]] as [keyof HypothesisDetail, string, string[]][]).map(([field, label, values]) => (
                    <label key={field} className="f"><span>{label}{readings[i].source[field as never] === "parsed" ? <span className="muted"> · read from the words</span> : null}</span>
                      <select className="select" data-testid={`rd-reading-${field}`} value={(r.hypothesisDetails?.[i] as Record<string, string> | undefined)?.[field] ?? ""} onChange={(e) => setDetail(i, label.toLowerCase(), field, e.target.value)}>
                        <option value="">{field === "type" || field === "direction" ? `${(readings[i] as unknown as Record<string, string>)[field]} (from the words)` : "—"}</option>
                        {values.map((v) => <option key={v} value={v}>{v.replace(/_/g, " ")}</option>)}
                      </select></label>
                  ))}
                  {(["independent", "dependent", "moderator", "mediator", "group", "lower"] as (keyof HypothesisDetail)[]).map((field) => (
                    <label key={field} className="f"><span>{field === "group" ? "Higher group" : field === "lower" ? "Lower group" : field[0].toUpperCase() + field.slice(1)}{readings[i].source[field as never] === "parsed" ? <span className="muted"> · read from the words</span> : null}</span>
                      <input className="input" list="rd-construct-names" data-testid={`rd-reading-${field}`} placeholder={(readings[i] as unknown as Record<string, string | undefined>)[field] ?? (field === "independent" || field === "dependent" ? "a construct, or words" : "")} value={(r.hypothesisDetails?.[i] as Record<string, string> | undefined)?.[field] ?? ""} onChange={(e) => setDetail(i, field, field, e.target.value)} /></label>
                  ))}
                  <datalist id="rd-construct-names">{r.constructs.map((c) => <option key={c.name} value={c.name} />)}</datalist>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="row" style={{ gap: 6 }}>
        <input className="input grow" data-testid="rd-hypothesis-new" placeholder="New hypothesis, e.g. Price perception drives switching" value={draftHyp}
          onChange={(e) => setDraftHyp(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addHypothesis(); } }} />
        <button type="button" className="btn small" data-testid="rd-hypothesis-add" onClick={addHypothesis} disabled={!draftHyp.trim()}>+ hypothesis</button>
      </div>

      <h4 className="rd-h">Research questions <span className="muted">· what the study sets out to answer, in words</span></h4>
      <LineList items={r.researchQuestions ?? []} testId="rd-question" placeholder="e.g. Why do customers switch from Brand A to Brand B?" onChange={(items) => patch("edit research questions", (d) => { d.researchQuestions = items; })} />

      <h4 className="rd-h">KPIs <span className="muted">· what the study reports, read from a variable</span></h4>
      <div className="rd-list" data-testid="rd-kpis">
        {(r.kpis ?? []).map((k, i) => (
          <div key={i} className="rd-row" data-testid="rd-kpi">
            <input className="input" style={{ width: 180 }} data-testid="rd-kpi-name" placeholder="KPI name" value={k.name} onChange={(e) => patch("rename KPI", (d) => { d.kpis[i].name = e.target.value; })} />
            <select className="select" style={{ width: 160 }} data-testid="rd-kpi-variable" value={k.variable ?? ""} onChange={(e) => patch("set KPI variable", (d) => { d.kpis[i].variable = e.target.value || undefined; })}>
              <option value="">variable…</option>
              {s.def.questions.filter((q) => !["html", "custom_component"].includes(q.type)).map((q) => <option key={q.id} value={q.variableName}>{q.variableName}</option>)}
              {(r.analysisPlan?.derived ?? []).map((dv) => <option key={dv.name} value={dv.name}>{dv.name} (derived)</option>)}
            </select>
            <input className="input" style={{ width: 140 }} data-testid="rd-kpi-measure" placeholder="measure (top-2-box, mean…)" value={k.measure ?? ""} onChange={(e) => patch("set KPI measure", (d) => { d.kpis[i].measure = e.target.value || undefined; })} />
            <input className="input" style={{ width: 110 }} data-testid="rd-kpi-target" placeholder="target" value={k.target ?? ""} onChange={(e) => patch("set KPI target", (d) => { d.kpis[i].target = e.target.value || undefined; })} />
            <select className="select" style={{ width: 100 }} value={k.direction ?? ""} onChange={(e) => patch("set KPI direction", (d) => { d.kpis[i].direction = (e.target.value || undefined) as never; })}><option value="">—</option><option value="higher">higher</option><option value="lower">lower</option></select>
            <button type="button" className="btn small danger" aria-label="Remove KPI" onClick={() => patch("remove KPI", (d) => { d.kpis.splice(i, 1); })}>×</button>
          </div>
        ))}
        <button type="button" className="btn small" data-testid="rd-kpi-add" onClick={() => patch("add KPI", (d) => { d.kpis = [...(d.kpis ?? []), { name: `KPI ${(d.kpis?.length ?? 0) + 1}` }]; })}>+ KPI</button>
      </div>

      <h4 className="rd-h">Audience <span className="muted">· who the questionnaire is written for — what adaptation reads</span></h4>
      <div className="settings-grid">
        <label className="f"><span>Audience</span>
          <textarea className="ta" rows={2} data-testid="rd-audience" placeholder="e.g. First-time smartphone buyers, 18–30, no brand vocabulary" value={r.audience?.description ?? ""}
            onChange={(e) => patch("edit audience", (d) => { const v = e.target.value; d.audience = v ? { characteristics: [], ...(d.audience ?? {}), description: v } : undefined; })} /></label>
        <label className="f" style={{ maxWidth: 220 }}><span>Language level</span>
          <select className="select" data-testid="rd-audience-literacy" value={r.audience?.literacy ?? ""} disabled={!r.audience} onChange={(e) => patch("set audience language level", (d) => { if (d.audience) d.audience.literacy = (e.target.value || undefined) as never; })}>
            <option value="">—</option><option value="plain">plain</option><option value="general">general</option><option value="expert">expert</option>
          </select></label>
      </div>
      {r.audience && <LineList items={r.audience.characteristics ?? []} testId="rd-audience-trait" placeholder="What sets them apart: e.g. no prior experience of the category" onChange={(items) => patch("edit audience characteristics", (d) => { if (d.audience) d.audience.characteristics = items; })} />}

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

/**
 * THE PROJECT BRIEF (Phase 8): the client's question and decision behind the
 * objective — who asked, what they will decide, who reads the findings, when.
 * Each field is one edit; "copy from another project" brings a brief the
 * researcher already wrote elsewhere (the client, the stakeholders, the
 * deliverables are the same from one study to the next).
 */
type BriefT = NonNullable<ResearchDesign["brief"]>;
const BRIEF_EMPTY: BriefT = { stakeholders: [], deliverables: [] };
function BriefSection({ r, patch, surveyDbId }: { r: ResearchDesign; patch(label: string, fn: (d: ResearchDesign) => void): void; surveyDbId: string }) {
  const b: BriefT = r.brief ?? BRIEF_EMPTY;
  const canCopy = !!surveyDbId && surveyDbId !== "sandbox";
  const [others, setOthers] = React.useState<{ surveyId: string; title: string; brief: BriefT }[] | null>(null);
  const [loadErr, setLoadErr] = React.useState<string | null>(null);
  const setField = (label: string, k: keyof BriefT, v: string) => patch(label, (d) => { const cur = { ...BRIEF_EMPTY, ...(d.brief ?? {}) }; (cur as Record<string, unknown>)[k] = v || undefined; const empty = !cur.client && !cur.businessQuestion && !cur.decision && !cur.background && !cur.deadline && !cur.stakeholders.length && !cur.deliverables.length; d.brief = empty ? undefined : cur; });
  const setList = (label: string, k: "stakeholders" | "deliverables", items: string[]) => patch(label, (d) => { const cur = { ...BRIEF_EMPTY, ...(d.brief ?? {}) }; cur[k] = items; d.brief = cur; });
  const loadOthers = async () => {
    if (!canCopy) return;
    try { const res = await fetch("/api/briefs", { cache: "no-store" }); const j = await res.json(); if (!res.ok) throw new Error(j.error ?? res.statusText); setOthers((j.briefs as { surveyId: string; title: string; brief: BriefT }[]).filter((x) => x.surveyId !== surveyDbId)); setLoadErr(null); }
    catch (e) { setLoadErr((e as Error).message); setOthers([]); }
  };
  return (
    <div data-testid="rd-brief">
      <h4 className="rd-h">Project brief <span className="muted">· the client's question and the decision the findings inform</span></h4>
      <div className="settings-grid">
        <label className="f"><span>Client</span>
          <input className="input" data-testid="rd-brief-client" placeholder="e.g. Acme Foods" value={b.client ?? ""} onChange={(e) => setField("edit brief client", "client", e.target.value)} /></label>
        <label className="f"><span>Business question</span>
          <textarea className="ta" rows={2} data-testid="rd-brief-question" placeholder="e.g. Should we cut the price of Brand A?" value={b.businessQuestion ?? ""} onChange={(e) => setField("edit business question", "businessQuestion", e.target.value)} /></label>
        <label className="f"><span>Decision it informs</span>
          <textarea className="ta" rows={2} data-testid="rd-brief-decision" placeholder="e.g. whether to launch the 500ml pack in Q2" value={b.decision ?? ""} onChange={(e) => setField("edit brief decision", "decision", e.target.value)} /></label>
        <label className="f"><span>Background</span>
          <textarea className="ta" rows={2} data-testid="rd-brief-background" placeholder="e.g. Brand A lost 4 points of share in 2025; the category is moving to private label" value={b.background ?? ""} onChange={(e) => setField("edit brief background", "background", e.target.value)} /></label>
        <label className="f" style={{ maxWidth: 260 }}><span>Findings due</span>
          <input className="input" data-testid="rd-brief-deadline" placeholder="e.g. 30 November 2026" value={b.deadline ?? ""} onChange={(e) => setField("edit brief deadline", "deadline", e.target.value)} /></label>
      </div>
      <div className="settings-grid">
        <div className="f"><span>Stakeholders</span>
          <LineList items={b.stakeholders} testId="rd-stakeholder" placeholder="Who reads and acts on the findings: e.g. the CMO" onChange={(items) => setList("edit brief stakeholders", "stakeholders", items)} /></div>
        <div className="f"><span>Deliverables</span>
          <LineList items={b.deliverables} testId="rd-deliverable" placeholder="e.g. a findings report and a deck" onChange={(items) => setList("edit brief deliverables", "deliverables", items)} /></div>
      </div>
      {canCopy && (
        <div className="row" style={{ gap: 6, alignItems: "center", marginTop: 6 }} data-testid="rd-brief-copy">
          {others === null ? <button type="button" className="btn small" data-testid="rd-brief-copy-load" onClick={() => void loadOthers()}>Copy from another project…</button> : others.length === 0 ? <span className="muted" data-testid="rd-brief-copy-none">{loadErr ? `Could not list your projects: ${loadErr}` : "No other project of yours has a brief yet."}</span> : (
            <select className="select" data-testid="rd-brief-copy-select" defaultValue="" onChange={(e) => { const o = others.find((x) => x.surveyId === e.target.value); if (!o) return; patch(`copy the brief from ${o.title}`, (d) => { d.brief = { ...BRIEF_EMPTY, ...o.brief }; }); e.target.value = ""; }}>
              <option value="">Copy the brief from…</option>
              {others.map((o) => <option key={o.surveyId} value={o.surveyId}>{o.title}{o.brief.client ? ` — ${o.brief.client}` : ""}</option>)}
            </select>
          )}
        </div>
      )}
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
