"use client";
import React from "react";
import {
  applySurveyActions, buildAnalysisFramework, coerceSurveyActions, designAdvice, parseAttributes, parseList, parsePrices, recommendMethodology,
  CATEGORY_NAMES, STUDY_METHODOLOGIES, type MethodInputs, type Methodology, type MethodologyRecommendation, type StudyCategory,
} from "@rescript/engine";
import { registerBuiltinDesignGenerators } from "@rescript/designs";
import { runSimulation } from "@rescript/templates";
import { useStudio } from "./store";
import { takePendingMethodology } from "../../lib/intelligent/methodologyRequest";
import { HeardNote, VoiceButton } from "../intelligent/VoiceButton";
import type { HeardTranscript } from "../../lib/intelligent/voice";

registerBuiltinDesignGenerators();

/**
 * STUDY DESIGN — THE RESEARCH METHODOLOGY ENGINE (2026-11-09) — Research tools → Study design.
 *
 *   1 OBJECTIVE      the business problem in the researcher's words → the research category, the recommended method
 *                    with why, the alternatives and when each fits, what is still missing — and a warning when the
 *                    method the researcher named does not answer the objective (recommendMethodology, deterministic)
 *   2 METHOD         Intelligent: the recommendation; Manual: any method of the registry, by category
 *   3 INPUTS         the method's own parameters (product, prices, concepts, brands, items, attributes & levels …)
 *   4 DESIGN ADVICE  for conjoint / MaxDiff: the design type, tasks, concepts per task, versions and the minimum sample
 *                    from the standard rule, against the sample and time the researcher has
 *   5 PREVIEW        the study built on a copy of the survey through the same gate as every edit — the questions, the
 *                    generated design file (the real generators: feasibility, balance, efficiency), the analysis plan
 *                    the engine derives, and 100 simulated respondents through the real logic
 *   6 ADD            one undoable edit, labelled with the method — the generated design is in Design Generators to
 *                    review, modify, regenerate and export
 */
type Fields = Record<string, string>;
const CATS = Object.keys(CATEGORY_NAMES) as StudyCategory[];

function inputsFrom(m: Methodology, f: Fields): MethodInputs {
  const out: MethodInputs = {};
  for (const i of m.inputs) {
    const v = (f[i.key] ?? "").trim();
    if (!v) continue;
    if (i.kind === "attributes") out.attributes = parseAttributes(v);
    else if (i.kind === "prices") out.prices = parsePrices(v);
    else if (i.kind === "list") (out as Record<string, unknown>)[i.key] = parseList(v);
    else if (i.kind === "number") (out as Record<string, unknown>)[i.key] = Number(v);
    else (out as Record<string, unknown>)[i.key] = v;
  }
  return out;
}

export function StudyDesignPanel() {
  const s = useStudio();
  const pending = React.useMemo(() => takePendingMethodology(), []);
  const [objective, setObjective] = React.useState(pending?.objective ?? "");
  /* what was heard when it was not English: the original beside the English reading the engine uses */
  const [heard, setHeard] = React.useState<HeardTranscript | null>(null);
  const [rec, setRec] = React.useState<MethodologyRecommendation | null>(pending ? recommendMethodology(pending.objective) : null);
  const [methodId, setMethodId] = React.useState<string>(rec?.recommended.id ?? "van_westendorp");
  const [fields, setFields] = React.useState<Fields>({});
  const [sample, setSample] = React.useState("");
  const [minutes, setMinutes] = React.useState("");
  const [preview, setPreview] = React.useState<null | { ok: boolean; next: ReturnType<typeof applySurveyActions>["def"] | null; results: string[]; errors: string[]; warnings: string[]; designs: number; questions: number; tests: string[]; crosstabs: number; sim: { produced: number; ok: boolean; problems: string[]; endings: Record<string, number> } | null }>(null);
  const [added, setAdded] = React.useState<string | null>(null);
  const m = STUDY_METHODOLOGIES.find((x) => x.id === methodId)!;

  const recommend = () => { const r = recommendMethodology(objective); setRec(r); setPreview(null); setAdded(null); if (r) setMethodId(r.recommended.id); };
  const inputs = inputsFrom(m, fields);
  const needsDesign = m.inputs.some((i) => i.kind === "attributes") || (m.inputs.some((i) => i.key === "items") && /maxdiff|innovation/.test(m.id));
  const advice = needsDesign ? designAdvice({ ...(inputs.attributes?.length ? { attributes: inputs.attributes } : {}), ...(inputs.items?.length && !inputs.attributes?.length ? { items: inputs.items } : {}), ...(m.id === "menu_conjoint" ? { menu: true } : {}), ...(Number(sample) > 0 ? { sample: Number(sample) } : {}), ...(Number(minutes) > 0 ? { maxMinutes: Number(minutes) } : {}), ...(m.id === "rating_conjoint" ? { specialist: true } : {}) }) : null;
  const missingRequired = m.inputs.filter((i) => i.required && !(fields[i.key] ?? "").trim()).map((i) => i.label);

  const build = () => {
    setAdded(null);
    let actions = m.build(inputs);
    /* the design advice's parameters go into the design actions (the researcher can still change them in Design Generators) */
    if (advice) actions = actions.map((a) => ((a as { op: string }).op === "create_conjoint" && advice.method === "cbc" ? { ...a, tasks: advice.tasks, alternatives: advice.alternatives } : (a as { op: string }).op === "create_maxdiff" && advice.method === "maxdiff" ? { ...a, perTask: advice.perTask, tasks: advice.tasks } : a) as typeof a);
    const c = coerceSurveyActions(actions);
    const r = c.actions.length ? applySurveyActions(s.def, c.actions) : null;
    const errors = [...c.rejected.map((x) => x.reason), ...(r?.errors ?? [])];
    if (!r || errors.length) { setPreview({ ok: false, next: null, results: [], errors, warnings: r?.warnings ?? [], designs: 0, questions: 0, tests: [], crosstabs: 0, sim: null }); return; }
    const plan = buildAnalysisFramework(r.def, { now: "" });
    let sim = null;
    try { const run = runSimulation(r.def, { count: 100, seed: 7 }); sim = { produced: run.produced, ok: run.verdict.ok, problems: run.verdict.problems.slice(0, 6), endings: run.endings }; } catch { sim = null; }
    setPreview({
      ok: true, next: r.def, results: r.results.map((x) => x.description).filter(Boolean), errors: [], warnings: r.warnings,
      designs: (r.def.designs ?? []).length - (s.def.designs ?? []).length, questions: r.def.questions.length - s.def.questions.length,
      tests: [...new Set(plan.tests.map((t) => String((t as { method?: string }).method ?? "")).filter(Boolean))], crosstabs: plan.crosstabs.length, sim,
    });
  };
  const add = () => {
    if (!preview?.next) return;
    s.labelNextEdit(`Study design: ${m.name}`);
    s.replace(preview.next);
    setAdded(`${m.name} added: ${preview.questions} question${preview.questions === 1 ? "" : "s"}${preview.designs ? ` and ${preview.designs} design file${preview.designs === 1 ? "" : "s"} (review, regenerate or export it in Design Generators)` : ""}. Undo reverses it in one step.`);
    setPreview(null);
  };

  return (
    <div className="sd" data-testid="study-design">
      <h3 className="sec">Study design</h3>
      <p className="muted" style={{ fontSize: 13 }}>Describe the business problem. The methodology engine says what kind of study it is, which method fits and why, the alternatives, what is missing — and whether a method you have in mind answers the question. Then it builds the study with the platform's own generators: questions, logic, the design file, the analysis plan, and a simulation to check it.</p>

      <section className="sd-step">
        <b>1. The objective</b>
        <textarea className="ta" rows={3} data-testid="sd-objective" value={objective} onChange={(e) => { setObjective(e.target.value); setHeard(null); }} placeholder="We are launching a premium subscription and need to know how much customers would pay and which features justify the price." />
        <HeardNote heard={heard} onUseOriginal={heard ? () => { setObjective((o) => o.replace(heard.english ?? "", heard.text)); setHeard(null); } : undefined} />
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn primary small" data-testid="sd-recommend" disabled={objective.trim().length < 8} onClick={recommend}>Recommend a methodology</button>
          {/* 2026-11-09: say it instead — the objective, context, audience, problem, hypotheses; the words land above to edit before recommending */}
          <VoiceButton surveyId={s.surveyDbId} label="Speak instead" refusedMessage="Microphone access was refused — allow it in the browser to describe your research by voice." onHeard={(h) => {
            const words = (h.english || h.text).trim();
            if (!words) return;
            setObjective((o) => `${o.trim()}${o.trim() ? "\n" : ""}${words}`);
            setHeard(h.english && h.language !== "en" ? h : null);
          }} />
        </div>
      </section>

      {objective.trim().length >= 8 && rec === null && <p className="muted" data-testid="sd-none">No methodology could be read from that — say what decision the research should inform, or pick a method below.</p>}
      {rec && (
        <section className="sd-rec" data-testid="sd-rec" data-method={rec.recommended.id} data-category={rec.category}>
          <div className="sd-rec-head"><span className="chip">{rec.categoryName}</span><b>{rec.recommended.name}</b><span className="muted">confidence {rec.confidence}</span></div>
          {rec.proposed && !rec.proposed.fits && <div className="sd-warn" data-testid="sd-misfit"><b>{rec.proposed.method.name} does not answer this objective.</b> {rec.proposed.problem}</div>}
          <ul>{rec.why.map((w) => <li key={w}>{w}</li>)}</ul>
          {rec.alternatives.length > 0 && <div className="sd-alts"><span className="muted">Alternatives:</span>{rec.alternatives.map((a) => <button key={a.method.id} type="button" className={`btn tiny ${methodId === a.method.id ? "primary" : ""}`} title={a.when} onClick={() => { setMethodId(a.method.id); setPreview(null); }} data-testid="sd-alt">{a.method.name}</button>)}</div>}
          {rec.missing.length > 0 && <div className="sd-missing" data-testid="sd-missing"><span className="muted">Still needed:</span> {rec.missing.join(" · ")}</div>}
        </section>
      )}

      <section className="sd-step">
        <b>2. Method</b>
        <select className="select" data-testid="sd-method" value={methodId} onChange={(e) => { setMethodId(e.target.value); setPreview(null); }}>
          {CATS.map((c) => <optgroup key={c} label={CATEGORY_NAMES[c]}>{STUDY_METHODOLOGIES.filter((x) => x.category === c).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>)}
        </select>
        <p className="muted sd-fit">{m.fit} · sample {m.sample.note} · {m.loi}</p>
        <div className="sd-pros"><div><b>Strengths</b><ul>{m.strengths.map((x) => <li key={x}>{x}</li>)}</ul></div><div><b>Trade-offs</b><ul>{m.tradeoffs.map((x) => <li key={x}>{x}</li>)}</ul></div><div><b>Analysis</b><ul>{m.analysis.map((x) => <li key={x}>{x}</li>)}</ul></div></div>
      </section>

      <section className="sd-step">
        <b>3. Inputs</b>
        <div className="sd-grid">
          {m.inputs.map((i) => (
            <label key={i.key} className="f"><span>{i.label}{i.required ? " *" : ""}</span>
              {i.kind === "attributes" || i.kind === "list"
                ? <textarea className="ta" rows={i.kind === "attributes" ? 4 : 3} data-testid={`sd-in-${i.key}`} value={fields[i.key] ?? ""} onChange={(e) => setFields({ ...fields, [i.key]: e.target.value })} placeholder={i.kind === "attributes" ? (i.example ?? "Attribute: level, level, level") : (i.example ?? "One per line")} />
                : <input className="input" data-testid={`sd-in-${i.key}`} value={fields[i.key] ?? ""} onChange={(e) => setFields({ ...fields, [i.key]: e.target.value })} placeholder={i.example ?? ""} />}
            </label>
          ))}
          <label className="f"><span>Completes you can afford</span><input className="input" type="number" data-testid="sd-sample" value={sample} onChange={(e) => setSample(e.target.value)} /></label>
          <label className="f"><span>Minutes available for this part</span><input className="input" type="number" value={minutes} onChange={(e) => setMinutes(e.target.value)} /></label>
        </div>
        {Number(sample) > 0 && Number(sample) < m.sample.min && <div className="sd-warn" data-testid="sd-sample-warn">{sample} completes is below what {m.name} needs ({m.sample.note}).</div>}
      </section>

      {advice && (
        <section className="sd-step sd-advice" data-testid="sd-advice" data-method={advice.method}>
          <b>4. Design advice</b>
          <p>{advice.why}</p>
          <p className="muted">{advice.tasks} tasks{advice.alternatives ? ` · ${advice.alternatives} concepts per task` : ""}{advice.perTask ? ` · ${advice.perTask} items per task` : ""} · minimum ≈ {advice.minSample} completes · ≈ {advice.minutes} min</p>
          {advice.warnings.map((w) => <div key={w} className="sd-warn">{w}</div>)}
        </section>
      )}

      <div className="row" style={{ gap: 8, margin: "8px 0" }}>
        <button type="button" className="btn primary" data-testid="sd-preview" disabled={missingRequired.length > 0} title={missingRequired.length ? `Needed: ${missingRequired.join(", ")}` : undefined} onClick={build}>Build and check the study</button>
        {missingRequired.length > 0 && <span className="muted">Needed: {missingRequired.join(", ")}</span>}
      </div>

      {preview && (
        <section className={`sd-preview ${preview.ok ? "ok" : "bad"}`} data-testid="sd-result" data-ok={preview.ok ? "1" : "0"}>
          {!preview.ok ? <><b>It could not be built:</b><ul>{preview.errors.map((e) => <li key={e}>{e}</li>)}</ul></> : <>
            <b>Ready to add: {preview.questions} question{preview.questions === 1 ? "" : "s"}{preview.designs ? `, ${preview.designs} generated design file${preview.designs === 1 ? "" : "s"}` : ""}.</b>
            <ul>{preview.results.slice(0, 12).map((x, k) => <li key={k}>{x}</li>)}</ul>
            {preview.warnings.length > 0 && <details><summary>Checks ({preview.warnings.length})</summary><ul>{preview.warnings.slice(0, 12).map((w, k) => <li key={k}>{w}</li>)}</ul></details>}
            <p data-testid="sd-analysis"><b>Analysis plan</b> the engine derives: {preview.tests.length ? preview.tests.join(", ") : "frequencies"}{preview.crosstabs ? ` · ${preview.crosstabs} crosstabs` : ""}.</p>
            {preview.sim && <p data-testid="sd-sim"><b>Simulation</b> — {preview.sim.produced} respondents through the real logic: {Object.entries(preview.sim.endings).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}; {preview.sim.ok ? "no problems found." : `${preview.sim.problems.length} problem(s): ${preview.sim.problems.join("; ")}`}</p>}
            <button type="button" className="btn primary" data-testid="sd-add" onClick={add}>Add to the survey</button>
          </>}
        </section>
      )}
      {added && <div className="auth-note" data-testid="sd-added">{added}</div>}
    </div>
  );
}
