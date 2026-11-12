"use client";
import React from "react";
import { useSession } from "@/lib/useSession";
import { AppHeader } from "@/components/ui/AppHeader";
import { advancedTemplates, buildDemoDataset, conjointAnalysis, frequency, maxdiffScores, type ConjointResult, type DemoDataset, type Frequency, type MaxDiffScore, type SurveyTemplate } from "@rescript/templates";

/**
 * /templates — THE ADVANCED RESEARCH TEMPLATES LIBRARY (2026-11-12).
 *
 * Every card is a complete, fieldable survey from @rescript/templates (the same list "New survey" offers), with the
 * guide that says what the method is for, how it works, how to analyse it and what to keep intact when it is
 * changed. "Use this template" goes to the dashboard's own New survey dialog with the template chosen, so the copy
 * is made the way every survey is made — a private definition in the user's project; the master is code and
 * cannot be changed by anyone's edits.
 *
 * The demonstration data is generated in the browser, on request, by walking the real survey; it is fictional and
 * is labelled so wherever it is shown. Its analyses are computed from those rows (demo.ts) — nothing is drawn by hand.
 */
const COMPLEXITY = ["Intermediate", "Advanced", "Expert"] as const;
type Sort = "category" | "name" | "duration" | "complexity";
interface Demo { data: DemoDataset; maxdiff: { variable: string; scores: MaxDiffScore[] }[]; conjoint: { variable: string; result: ConjointResult }[]; tables: Frequency[] }

function demoFor(t: SurveyTemplate): Demo {
  const def = t.build(`demo-${t.key}`);
  const data = buildDemoDataset(t.key, 150);
  const completes = data.rows.filter((r) => r.STATUS === "complete");
  const maxdiff = def.questions.filter((q) => q.type === "maxdiff_task").map((q) => ({ variable: q.variableName, scores: maxdiffScores(def, completes, q.variableName) }));
  const conjoint = def.questions.filter((q) => q.type === "conjoint_task").flatMap((q) => { const result = conjointAnalysis(def, completes, q.variableName); return result ? [{ variable: q.variableName, result }] : []; });
  /* the derived (hidden, auto-punched) variables are what each study is built to produce: one table each */
  const tables = def.questions.filter((q) => q.settings.hidden && q.punches.length && q.options.length).slice(0, 4).map((q) => frequency(def, completes, q.variableName)).filter((f): f is Frequency => !!f && f.base > 0);
  return { data, maxdiff, conjoint, tables };
}

const strip = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const cell: React.CSSProperties = { padding: "4px 10px 4px 0", borderBottom: "1px solid var(--c-border)", textAlign: "left", fontSize: 13 };

export default function TemplatesPage() {
  const session = useSession({ redirectOnSignOut: true });
  const all = React.useMemo(() => advancedTemplates(), []);
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [complexity, setComplexity] = React.useState("");
  const [sort, setSort] = React.useState<Sort>("category");
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [demo, setDemo] = React.useState<Record<string, Demo | "working" | { error: string }>>({});
  const categories = React.useMemo(() => [...new Set(all.map((t) => t.guide!.category))], [all]);

  const shown = React.useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (t: SurveyTemplate) => `${t.name} ${t.description} ${t.guide!.category} ${t.guide!.methods.join(" ")} ${t.guide!.features.join(" ")} ${t.guide!.useCases.join(" ")}`.toLowerCase();
    const list = all.filter((t) => (!category || t.guide!.category === category) && (!complexity || t.guide!.complexity === complexity) && words.every((w) => hay(t).includes(w)));
    const by: Record<Sort, (a: SurveyTemplate, b: SurveyTemplate) => number> = {
      category: (a, b) => categories.indexOf(a.guide!.category) - categories.indexOf(b.guide!.category) || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      duration: (a, b) => a.guide!.minutes - b.guide!.minutes,
      complexity: (a, b) => COMPLEXITY.indexOf(b.guide!.complexity) - COMPLEXITY.indexOf(a.guide!.complexity) || a.name.localeCompare(b.name),
    };
    return [...list].sort(by[sort]);
  }, [all, query, category, complexity, sort, categories]);

  const open = openKey ? all.find((t) => t.key === openKey) ?? null : null;
  const built = React.useMemo(() => (open ? open.build("preview") : null), [open]);
  const runDemo = (t: SurveyTemplate) => {
    setDemo((d) => ({ ...d, [t.key]: "working" }));
    /* after a paint, so the button shows it is working: the walk takes a second or two */
    window.setTimeout(() => { try { const r = demoFor(t); setDemo((d) => ({ ...d, [t.key]: r })); } catch (e) { setDemo((d) => ({ ...d, [t.key]: { error: (e as Error).message } })); } }, 30);
  };

  return (
    <div className="hx-page" data-testid="templates-library">
      <AppHeader active="dashboard" user={session.state.kind === "signed_in" ? session.state.user : null} onSignOut={() => void session.signOut()} crumbs={<a href="/templates">Advanced research templates</a>} />
      <main style={{ maxWidth: 1180, margin: "0 auto", padding: "24px 20px 64px" }}>
        {!open && (
          <>
            <h1 style={{ margin: "0 0 4px" }}>Advanced research templates</h1>
            <p style={{ margin: "0 0 16px", color: "var(--c-text-subtle)", maxWidth: 760 }}>{all.length} complete, programmed studies built on a research method. Each opens as your own survey: change the content, keep the method. All brands and figures in them are fictional examples.</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
              <input className="input" style={{ flex: "1 1 260px" }} placeholder="Search by method, feature or use" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="tpl-search" aria-label="Search templates" />
              <select className="select" value={category} onChange={(e) => setCategory(e.target.value)} data-testid="tpl-category" aria-label="Category">
                <option value="">All categories</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className="select" value={complexity} onChange={(e) => setComplexity(e.target.value)} data-testid="tpl-complexity" aria-label="Complexity">
                <option value="">Any complexity</option>
                {COMPLEXITY.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} data-testid="tpl-sort" aria-label="Sort">
                <option value="category">Sort: category</option>
                <option value="name">Sort: name</option>
                <option value="duration">Sort: shortest first</option>
                <option value="complexity">Sort: most complex first</option>
              </select>
            </div>
            {shown.length === 0 && <p data-testid="tpl-empty">No template matches. Clear the search or the filters.</p>}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 }}>
              {shown.map((t) => {
                const g = t.guide!;
                const n = t.build("card").questions.filter((q) => q.type !== "html" && !q.settings.hidden).length;
                return (
                  <article key={t.key} data-testid={`tpl-card-${t.key}`} style={{ border: "1px solid var(--c-border)", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 8, background: "var(--c-surface)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                      <span className="badge">{g.category}</span>
                      <span style={{ fontSize: 12, color: "var(--c-text-subtle)" }}>{g.complexity}</span>
                    </div>
                    <h2 style={{ margin: 0, fontSize: 17, lineHeight: 1.3 }}>{t.name}</h2>
                    <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.5 }}>{t.description}.</p>
                    <div style={{ fontSize: 12.5, color: "var(--c-text-subtle)" }}>{g.methods.join(" · ")}</div>
                    <div style={{ fontSize: 12.5, color: "var(--c-text-subtle)" }}>About {g.minutes} minutes · {n} questions</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{g.features.slice(0, 4).map((f) => <span key={f} className="chip" style={{ fontSize: 11.5 }}>{f}</span>)}</div>
                    <div style={{ display: "flex", gap: 8, marginTop: "auto", paddingTop: 6 }}>
                      <button className="btn" onClick={() => { setOpenKey(t.key); window.scrollTo(0, 0); }} data-testid={`tpl-open-${t.key}`}>Preview</button>
                      <a className="btn primary" href={`/?template=${encodeURIComponent(t.key)}`} data-testid={`tpl-use-${t.key}`}>Use template</a>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}

        {open && built && (() => {
          const g = open.guide!;
          const asked = built.questions.filter((q) => q.type !== "html" && !q.settings.hidden);
          const derivedVars = built.questions.filter((q) => q.settings.hidden);
          const d = demo[open.key];
          const section = (title: string, body: React.ReactNode) => <section style={{ marginBottom: 18 }}><h3 style={{ margin: "0 0 6px", fontSize: 15 }}>{title}</h3><div style={{ fontSize: 14, lineHeight: 1.6 }}>{body}</div></section>;
          return (
            <div data-testid="tpl-detail" style={{ maxWidth: 860 }}>
              <button className="btn small" onClick={() => setOpenKey(null)} data-testid="tpl-back">← All templates</button>
              <div style={{ margin: "14px 0 6px" }}><span className="badge">{g.category}</span> <span style={{ fontSize: 13, color: "var(--c-text-subtle)" }}>{g.complexity} · about {g.minutes} minutes · {asked.length} questions</span></div>
              <h1 style={{ margin: "0 0 6px" }}>{open.name}</h1>
              <p style={{ margin: "0 0 14px", fontSize: 15 }}>{open.description}.</p>
              <p style={{ margin: "0 0 20px" }}><a className="btn primary" href={`/?template=${encodeURIComponent(open.key)}`} data-testid="tpl-detail-use">Start using this template</a></p>
              {section("Research objective", g.objective)}
              {section("When to use it", <ul style={{ margin: 0, paddingLeft: 18 }}>{g.useCases.map((u) => <li key={u}>{u}</li>)}</ul>)}
              {section("Who to ask", g.audience)}
              {section("Methodology", g.methodology)}
              {section("Logic and routing", g.logic)}
              {g.design ? section("Experimental design", g.design) : null}
              {section("Programming used", <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{g.features.map((f) => <span key={f} className="chip">{f}</span>)}</div>)}
              {section("The questions", <ol style={{ margin: 0, paddingLeft: 20 }}>{asked.map((q) => <li key={q.id} style={{ marginBottom: 4 }}><b>{q.variableName}</b> — {strip(q.text).slice(0, 170)} <span style={{ color: "var(--c-text-subtle)" }}>({q.type.replace(/_/g, " ")}{q.displayLogic ? ", conditional" : ""})</span></li>)}</ol>)}
              {derivedVars.length ? section("Derived variables", <ul style={{ margin: 0, paddingLeft: 18 }}>{derivedVars.map((q) => <li key={q.id}><b>{q.variableName}</b> — {strip(q.text)}{q.options.length ? `: ${q.options.map((o) => o.label).join(", ")}` : ""}</li>)}</ul>) : null}
              {section("Data structure", g.dataStructure)}
              {section("Sample", g.sample)}
              {section("Analysis", g.analysis)}
              {section("Limitations and assumptions", g.limitations)}
              {section("When you change it", <div style={{ border: "1px solid var(--c-warning-bd, var(--c-border))", background: "var(--c-warning-bg, transparent)", borderRadius: 8, padding: "8px 12px" }}>{g.whenEditing}</div>)}
              <section style={{ marginTop: 24 }} data-testid="tpl-demo">
                <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>Demonstration data</h3>
                {!d && <p style={{ fontSize: 14 }}>Generate 150 fictional respondents by walking this survey, and see the method's analysis run on them. <button className="btn small" onClick={() => runDemo(open)} data-testid="tpl-demo-run">Generate demonstration data</button></p>}
                {d === "working" && <p style={{ fontSize: 14 }}>Generating…</p>}
                {d && d !== "working" && "error" in d && <p style={{ fontSize: 14 }}>The demonstration data could not be generated: {d.error}</p>}
                {d && d !== "working" && !("error" in d) && (
                  <div style={{ fontSize: 14 }}>
                    <p style={{ border: "1px solid var(--c-warning-bd, var(--c-border))", background: "var(--c-warning-bg, transparent)", borderRadius: 8, padding: "8px 12px" }} data-testid="tpl-demo-note"><b>Fictional.</b> {d.data.note}</p>
                    <p>{d.data.rows.length} generated respondents: {Object.entries(d.data.statuses).map(([s, n]) => `${n} ${s.replace(/_/g, " ")}`).join(", ")}.</p>
                    {d.maxdiff.map((m) => (
                      <div key={m.variable} style={{ marginBottom: 14 }}>
                        <b>{m.variable}: best-minus-worst scores</b>
                        <table style={{ borderCollapse: "collapse", marginTop: 4 }}><thead><tr><th style={cell}>Item</th><th style={cell}>Shown</th><th style={cell}>Best</th><th style={cell}>Worst</th><th style={cell}>Score</th></tr></thead>
                          <tbody>{m.scores.map((s) => <tr key={s.item}><td style={cell}>{s.item}</td><td style={cell}>{s.shown}</td><td style={cell}>{s.best}</td><td style={cell}>{s.worst}</td><td style={cell}>{s.score.toFixed(3)}</td></tr>)}</tbody></table>
                      </div>
                    ))}
                    {d.conjoint.map((c) => (
                      <div key={c.variable} style={{ marginBottom: 14 }}>
                        <b>{c.variable}: choice shares and aggregate logit part-worths</b> <span style={{ color: "var(--c-text-subtle)" }}>({c.result.tasks} choice sets, none chosen in {(c.result.noneShare * 100).toFixed(1)}%)</span>
                        <table style={{ borderCollapse: "collapse", marginTop: 4 }}><thead><tr><th style={cell}>Attribute</th><th style={cell}>Level</th><th style={cell}>Chosen / shown</th><th style={cell}>Part-worth</th></tr></thead>
                          <tbody>{c.result.levels.map((l) => <tr key={`${l.attribute}|${l.level}`}><td style={cell}>{l.attribute}</td><td style={cell}>{l.level}</td><td style={cell}>{(l.share * 100).toFixed(1)}%</td><td style={cell}>{l.partWorth.toFixed(3)}</td></tr>)}</tbody></table>
                        <p style={{ margin: "6px 0 0" }}>Importance: {c.result.importance.map((i) => `${i.attribute} ${i.pct}%`).join(" · ")}</p>
                        <p style={{ margin: "4px 0 0", color: "var(--c-text-subtle)", fontSize: 12.5 }}>{c.result.note}</p>
                      </div>
                    ))}
                    {d.tables.map((f) => (
                      <div key={f.variable} style={{ marginBottom: 14 }}>
                        <b>{f.variable}</b> <span style={{ color: "var(--c-text-subtle)" }}>— {f.label} (base {f.base} completes)</span>
                        <table style={{ borderCollapse: "collapse", marginTop: 4 }}><tbody>{f.counts.map((c) => <tr key={c.code}><td style={cell}>{c.label}</td><td style={cell}>{c.n}</td><td style={cell}>{c.pct}%</td></tr>)}</tbody></table>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          );
        })()}
      </main>
    </div>
  );
}
