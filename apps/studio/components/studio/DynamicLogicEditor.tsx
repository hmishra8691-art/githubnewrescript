"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { buildTernary, compileDynamicGrid, dynamicOutcomes, lintDynamicLogic, GRID_OTHERWISE, type DynamicProblem, type DynamicGrid } from "@rescript/engine";
import { useStudio } from "./store";

/**
 * DYNAMIC TEXT AND OPTIONS — TERNARY LOGIC (2026-11-07).
 *
 * Three expressions on a question, in the calculation language with `cond ? a : b` (nestable):
 *   · Dynamic question text — the text shown, e.g. Q1 == "A" ? "About Product A?" : Q1 == "B" ? … : "Please choose"
 *   · Dynamic option set — which option CODES are shown, e.g. Q1 == "A" ? "1,2,3" : "4,5"
 *   · Dynamic option labels — per option
 * Typed directly or built from an earlier question's answers; checked by the engine's `lintDynamicLogic` (syntax,
 * unknown names, questions asked later, codes that are no option) and previewed with `dynamicOutcomes` — what each
 * respondent would see. The runtime, the preview and Intelligent Mode run the very same functions.
 */
export function DynamicLogicEditor({ q, patch }: { q: Question; patch(p: Partial<Question>): void }) {
  const s = useStudio();
  const problems = React.useMemo(() => lintDynamicLogic(s.def, q), [s.def, q]);
  const outcomes = React.useMemo(() => dynamicOutcomes(s.def, q), [s.def, q]);
  const [builder, setBuilder] = React.useState<"text" | "options" | null>(null);
  const hasOptions = (q.options ?? []).length > 0;
  const of = (f: DynamicProblem["field"], code?: string) => problems.filter((p) => p.field === f && (code === undefined || p.code === code));
  const say = (ps: DynamicProblem[]) => ps.length ? (
    <ul className="dl-problems" data-testid="dynamic-problems">{ps.map((p, i) => <li key={i} className={p.severity === "error" ? "iq-error" : "muted"}>{p.severity === "error" ? "✕" : "!"} {p.message}</li>)}</ul>
  ) : null;
  const setOptionLabel = (code: string | number, expr: string) =>
    patch({ options: q.options.map((o) => (String(o.code) === String(code) ? { ...o, labelExpression: expr.trim() ? expr : undefined } : o)) });

  return (
    <div data-testid="dynamic-logic">
      <p className="muted" style={{ fontSize: 12.5, marginTop: 0 }}>
        Ternary expressions over earlier answers: <code>cond ? a : b</code>, nestable. <code>Q1 == "A"</code> matches the option labelled A or coded A.
        Text results may pipe (<code>{"{{Q2}}"}</code>). When nothing matches or the expression fails, the static text / every option / the option's own label is shown.
      </p>

      <label className="f"><span>Dynamic question text</span>
        <textarea className="ta code" rows={3} data-testid="dynamic-text-expr" value={q.dynamicText?.expression ?? ""}
          placeholder={'Q1 == "A" ? "What is your experience with Product A?" : Q1 == "B" ? "…Product B?" : "Please select an option."'}
          onChange={(e) => patch({ dynamicText: e.target.value.trim() ? { expression: e.target.value } : undefined })} />
      </label>
      {say(of("text"))}
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <button type="button" className="btn small" data-testid="dynamic-text-build" onClick={() => setBuilder(builder === "text" ? null : "text")}>Build from answers…</button>
        {q.dynamicText && <button type="button" className="btn small ghost" onClick={() => patch({ dynamicText: undefined })}>Clear</button>}
      </div>
      {builder === "text" && <TernaryBuilder q={q} mode="text" onBuild={(expression) => { patch({ dynamicText: { expression } }); setBuilder(null); }} />}

      {hasOptions && <OptionGrid q={q} patch={patch} />}

      {hasOptions && (
        <>
          <label className="f"><span>Dynamic option set (codes shown)</span>
            <textarea className="ta code" rows={2} data-testid="dynamic-options-expr" value={q.dynamicOptions?.expression ?? ""}
              placeholder={'Q1 == "A" ? "1,2,3" : Q1 == "B" ? "4,5" : "1,2,3,4,5"'}
              onChange={(e) => patch({ dynamicOptions: e.target.value.trim() ? { expression: e.target.value } : undefined })} />
          </label>
          {say(of("options"))}
          <div className="row" style={{ gap: 6, marginBottom: 10 }}>
            <button type="button" className="btn small" data-testid="dynamic-options-build" onClick={() => setBuilder(builder === "options" ? null : "options")}>Build from answers…</button>
            {q.dynamicOptions && <button type="button" className="btn small ghost" onClick={() => patch({ dynamicOptions: undefined })}>Clear</button>}
          </div>
          {builder === "options" && <TernaryBuilder q={q} mode="options" onBuild={(expression) => { patch({ dynamicOptions: { expression } }); setBuilder(null); }} />}

          <details style={{ marginBottom: 10 }} open={q.options.some((o) => o.labelExpression)}>
            <summary className="flabel" style={{ cursor: "pointer" }}>Dynamic option labels ({q.options.filter((o) => o.labelExpression).length})</summary>
            {q.options.map((o) => (
              <div key={String(o.code)} style={{ marginBottom: 6 }}>
                <div className="row" style={{ gap: 6 }}>
                  <span className="mono muted" style={{ width: 44 }}>{String(o.code)}</span>
                  <span style={{ width: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={o.label.replace(/<[^>]*>/g, "")}>{o.label.replace(/<[^>]*>/g, "")}</span>
                  <input className="input mono grow" data-testid="dynamic-option-label" data-code={String(o.code)} value={o.labelExpression ?? ""}
                    placeholder={'Q1 == "A" ? "Great for A" : ""'} onChange={(e) => setOptionLabel(o.code, e.target.value)} />
                </div>
                {say(of("label", String(o.code)))}
              </div>
            ))}
          </details>
        </>
      )}

      {outcomes.outcomes.length > 0 && (
        <div data-testid="dynamic-outcomes">
          <div className="flabel">Preview — what each respondent sees{outcomes.source ? ` (by ${outcomes.source})` : ""}</div>
          <table className="dl-outcomes">
            <thead><tr><th>When</th>{q.dynamicText && <th>Question text</th>}{(q.dynamicOptions || q.options.some((o) => o.labelExpression)) && <th>Options</th>}</tr></thead>
            <tbody>
              {outcomes.outcomes.map((o, i) => (
                <tr key={i}>
                  <td className="mono">{o.when}</td>
                  {q.dynamicText && <td>{(o.text ?? "").replace(/<[^>]*>/g, "")}</td>}
                  {(q.dynamicOptions || q.options.some((x) => x.labelExpression)) && <td>{(o.optionLabels ?? []).map((l, j) => `${o.optionCodes?.[j] ?? ""} ${l.replace(/<[^>]*>/g, "")}`).join(" · ")}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** "Q1 = A → this, Q1 = B → that, otherwise …" written as the nested ternary (engine buildTernary) */
function TernaryBuilder({ q, mode, onBuild }: { q: Question; mode: "text" | "options"; onBuild(expr: string): void }) {
  const s = useStudio();
  const sources = s.def.questions.filter((x) => x.id !== q.id && (x.options ?? []).length > 0);
  const [srcId, setSrcId] = React.useState(sources[0]?.id ?? "");
  const src = sources.find((x) => x.id === srcId);
  const [vals, setVals] = React.useState<Record<string, string>>({});
  const [fallback, setFallback] = React.useState(mode === "text" ? q.text.replace(/<[^>]*>/g, "") : q.options.map((o) => String(o.code)).join(","));
  if (!sources.length) return <p className="muted" data-testid="ternary-builder">No earlier question with options to build from — type the expression instead.</p>;
  const build = () => {
    if (!src) return;
    const cases = (src.options ?? []).filter((o) => (vals[String(o.code)] ?? "").trim()).map((o) => ({ equals: typeof o.code === "number" || /^-?\d+$/.test(String(o.code)) ? Number(o.code) : String(o.code), result: vals[String(o.code)].trim() })); // by code: unique, survives relabelling and translation
    if (!cases.length) return;
    onBuild(buildTernary(src.variableName || String(src.code), cases, fallback));
  };
  const toggleCode = (srcCode: string, code: string) => {
    const cur = new Set((vals[srcCode] ?? "").split(",").map((x) => x.trim()).filter(Boolean));
    if (cur.has(code)) cur.delete(code); else cur.add(code);
    setVals({ ...vals, [srcCode]: q.options.map((o) => String(o.code)).filter((c) => cur.has(c)).join(",") });
  };
  return (
    <div className="card" style={{ padding: 10, marginBottom: 10 }} data-testid="ternary-builder">
      <label className="f"><span>Based on</span>
        <select className="select" value={srcId} onChange={(e) => { setSrcId(e.target.value); setVals({}); }} data-testid="ternary-source">
          {sources.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.text.replace(/<[^>]*>/g, "").slice(0, 50)}</option>)}
        </select></label>
      {(src?.options ?? []).map((o) => (
        <div key={String(o.code)} className="row" style={{ gap: 6, marginBottom: 4, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ width: 140 }}>If {src!.code} = {o.label.replace(/<[^>]*>/g, "")}</span>
          {mode === "text" ? (
            <input className="input grow" data-testid="ternary-case" value={vals[String(o.code)] ?? ""} placeholder="the text to show"
              onChange={(e) => setVals({ ...vals, [String(o.code)]: e.target.value })} />
          ) : (
            <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
              {q.options.map((qo) => (
                <label key={String(qo.code)} className="row" style={{ gap: 2, fontSize: 12.5 }}>
                  <input type="checkbox" checked={(vals[String(o.code)] ?? "").split(",").includes(String(qo.code))} onChange={() => toggleCode(String(o.code), String(qo.code))} />
                  {qo.label.replace(/<[^>]*>/g, "")}
                </label>
              ))}
            </span>
          )}
        </div>
      ))}
      <label className="f"><span>Otherwise (no match)</span>
        <input className="input" data-testid="ternary-fallback" value={fallback} onChange={(e) => setFallback(e.target.value)} /></label>
      <button type="button" className="btn small primary" data-testid="ternary-apply" onClick={build}>Write the expression</button>
    </div>
  );
}

/**
 * OPTION TEXT BY ANSWER — THE GRID (2026-11-07). Rows are this question's options, columns the answers of an earlier
 * question (and "Otherwise"). Type the text an option shows for that answer (blank keeps its own label) and untick
 * "show" to hide it for that answer. Saving compiles the grid into each option's dynamic label and the dynamic option
 * set (engine compileDynamicGrid) — the same expressions the fields below show, run by the same evaluator. Codes never
 * change, so the data keeps one meaning whatever text a respondent saw.
 */
function OptionGrid({ q, patch }: { q: Question; patch(p: Partial<Question>): void }) {
  const s = useStudio();
  const sources = s.def.questions.filter((x) => x.id !== q.id && (x.options ?? []).length > 0 && (x.options ?? []).length <= 12);
  const saved = q.dynamicGrid as DynamicGrid | undefined;
  const [open, setOpen] = React.useState(!!saved);
  const [grid, setGrid] = React.useState<DynamicGrid>(() => saved ?? { source: sources[0]?.id ?? "", cells: {} });
  const [said, setSaid] = React.useState<string | null>(null);
  const src = sources.find((x) => x.id === grid.source || x.code === grid.source || x.variableName === grid.source);
  if (!sources.length) return null;
  const plain = (h: string) => h.replace(/<[^>]*>/g, "").trim();
  const cell = (oc: string, ac: string) => grid.cells[oc]?.[ac] ?? {};
  const setCell = (oc: string, ac: string, patchCell: { text?: string; hide?: boolean }) =>
    setGrid((g) => ({ ...g, cells: { ...g.cells, [oc]: { ...(g.cells[oc] ?? {}), [ac]: { ...(g.cells[oc]?.[ac] ?? {}), ...patchCell } } } }));
  const cols = [...(src?.options ?? []).map((o) => ({ code: String(o.code), label: plain(o.label) || String(o.code) })), { code: GRID_OTHERWISE, label: "Otherwise / not answered" }];
  const apply = () => {
    if (!src) return;
    const g: DynamicGrid = { source: src.id, cells: grid.cells };
    const r = compileDynamicGrid(s.def, q, g);
    if (r.problems.length) { setSaid(r.problems.join(" · ")); return; }
    s.labelNextEdit?.(`option text by ${src.code}`);
    patch({
      dynamicGrid: g,
      options: q.options.map((o) => { const e = r.labels[String(o.code)]; const { labelExpression: _drop, ...rest } = o; return e ? { ...rest, labelExpression: e } : rest; }) as Question["options"],
      dynamicOptions: r.dynamicOptions,
    });
    setSaid(`Saved — ${Object.values(r.labels).filter(Boolean).length} option text${Object.values(r.labels).filter(Boolean).length === 1 ? "" : "s"} vary by ${src.code}${r.dynamicOptions ? "; some options hidden per answer" : ""}. The preview table below shows each respondent's view.`);
  };
  const clear = () => {
    patch({ dynamicGrid: undefined, dynamicOptions: undefined, options: q.options.map((o) => { const { labelExpression: _drop, ...rest } = o; return rest; }) as Question["options"] });
    setGrid({ source: grid.source, cells: {} }); setSaid("Cleared — every option shows its own label again.");
  };
  if (!open) return <button type="button" className="btn small" data-testid="option-grid-open" style={{ marginBottom: 10 }} onClick={() => setOpen(true)}>Option text by answer (grid)…</button>;
  return (
    <div className="card" style={{ padding: 10, marginBottom: 12, overflowX: "auto" }} data-testid="option-grid">
      <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 8 }}>
        <label className="f" style={{ marginBottom: 0 }}><span>Option text depends on</span>
          <select className="select" value={src?.id ?? ""} data-testid="option-grid-source" onChange={(e) => { setGrid({ source: e.target.value, cells: {} }); setSaid(null); }}>
            {sources.map((x) => <option key={x.id} value={x.id}>{x.code} — {plain(x.text).slice(0, 50)}</option>)}
          </select></label>
        <span className="muted" style={{ fontSize: 12 }}>Blank = the option's own label · untick to hide it for that answer</span>
      </div>
      <table className="dl-grid">
        <thead><tr><th>Option</th>{cols.map((c) => <th key={c.code}>{c.code === GRID_OTHERWISE ? c.label : `${src?.code} = ${c.label}`}</th>)}</tr></thead>
        <tbody>
          {q.options.map((o) => (
            <tr key={String(o.code)}>
              <td><span className="mono muted">{String(o.code)}</span> {plain(o.label)}</td>
              {cols.map((c) => { const v = cell(String(o.code), c.code); return (
                <td key={c.code}>
                  <input className="input small" data-testid="option-grid-cell" data-option={String(o.code)} data-answer={c.code} value={v.text ?? ""} placeholder={plain(o.label)} disabled={!!v.hide}
                    onChange={(e) => setCell(String(o.code), c.code, { text: e.target.value })} />
                  <label className="row" style={{ gap: 3, fontSize: 11.5 }}><input type="checkbox" data-testid="option-grid-show" checked={!v.hide} onChange={(e) => setCell(String(o.code), c.code, { hide: !e.target.checked })} /> show</label>
                </td>); })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button type="button" className="btn small primary" data-testid="option-grid-apply" onClick={apply}>Save grid</button>
        {(saved || q.options.some((x) => x.labelExpression)) && <button type="button" className="btn small ghost" onClick={clear}>Clear</button>}
        <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>Close</button>
      </div>
      {said && <p className="muted" style={{ fontSize: 12.5 }} data-testid="option-grid-said">{said}</p>}
    </div>
  );
}
