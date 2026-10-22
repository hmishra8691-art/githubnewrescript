"use client";
import React from "react";
import type { DatasetSpec } from "@rescript/analytics";
import type { AnalysisMethod } from "@rescript/schema";
import type { ModelJobView } from "@/lib/modelJobState";
import { AxApi, type AdvancedItemStatus, type AdvancedReading } from "./api";
import { Icon } from "../ui/Icon";

/**
 * THE ADVANCED MODELS OF THE PLAN, IN THE PLAN WORKSPACE (2026-10-22).
 *
 *   MethodOptions          the method's settings in the item editor — HB draws and seed, the latent-class K range,
 *                          the SEM model, the mediation bootstrap, ω, the Gabor–Granger prices — saved as the
 *                          plan item's `options` and checked by the same `plannedItemReadiness` as the apply
 *   AdvancedReadingPanel   the engine's reading of one advanced result (numbers only from the result), its
 *                          diagnostics and caveats, the SEM path diagram, and on request the model's gated interpretation
 *   AdvancedModelsCard     each advanced item fresh / stale / never run / running, a re-run, the plan's re-run policy,
 *                          and the HB jobs followed chunk by chunk until done (then the plan is run once so the result
 *                          joins the findings). A stale result is flagged and kept — never silently replaced.
 */

export const ADVANCED_METHODS = new Set<string>(["hb", "latent_class", "sem"]);
export const isAdvancedPlanItem = (method: string, options?: Record<string, unknown> | null): boolean =>
  ADVANCED_METHODS.has(method) || !!options?.bootstrap || options?.omega === true || options?.method === "gabor_granger";

const STATE_WORD: Record<string, string> = { fresh: "Up to date", stale: "Stale", never_run: "Not run yet", running: "Running" };
const STATE_TONE: Record<string, string> = { fresh: "success", stale: "warning", never_run: "neutral", running: "neutral" };
const DIAG_TONE: Record<string, string> = { ok: "success", caution: "warning", fail: "error" };

/* ------------------------------------------------------------ the editor's method settings */

export function MethodOptions({ method, mediator, value, onChange }: { method: AnalysisMethod; mediator: string; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const set = (k: string, v: unknown) => { const next = { ...value }; if (v === undefined || v === "" || v === false) delete next[k]; else next[k] = v; onChange(next); };
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  const field = (label: string, el: React.ReactNode, wide = false) => <label className={`ax-field ap-field${wide ? " ap-field-wide" : ""}`}><span>{label}</span>{el}</label>;
  if (method === "hb") return (
    <div className="ap-editor-grid" data-testid="ap-ed-options" data-method="hb">
      {field("Burn-in iterations", <input className="input" type="number" min={100} value={String(value.burnIn ?? "")} placeholder="engine default" onChange={(e) => set("burnIn", num(e.target.value))} data-testid="ap-opt-burnin" />)}
      {field("Draws kept", <input className="input" type="number" min={100} value={String(value.draws ?? "")} placeholder="engine default" onChange={(e) => set("draws", num(e.target.value))} data-testid="ap-opt-draws" />)}
      {field("Seed", <input className="input" type="number" value={String(value.seed ?? "")} placeholder="fixed default" onChange={(e) => set("seed", num(e.target.value))} data-testid="ap-opt-seed" />)}
      <p className="muted ap-field-wide" style={{ fontSize: 12.5 }}>Hierarchical Bayes runs as a background job when the plan is applied; this page follows its progress.</p>
    </div>
  );
  if (method === "latent_class") return (
    <div className="ap-editor-grid" data-testid="ap-ed-options" data-method="latent_class">
      {field("Fewest classes", <input className="input" type="number" min={1} max={10} value={String(value.minClasses ?? "")} placeholder="2" onChange={(e) => set("minClasses", num(e.target.value))} data-testid="ap-opt-kmin" />)}
      {field("Most classes", <input className="input" type="number" min={1} max={10} value={String(value.maxClasses ?? "")} placeholder="6" onChange={(e) => set("maxClasses", num(e.target.value))} data-testid="ap-opt-kmax" />)}
      {field("Random starts", <input className="input" type="number" min={1} max={50} value={String(value.starts ?? "")} placeholder="engine default" onChange={(e) => set("starts", num(e.target.value))} data-testid="ap-opt-starts" />)}
      <p className="muted ap-field-wide" style={{ fontSize: 12.5 }}>The number of classes is chosen by BIC within this range. Covariates (class membership predicted by other variables) are not estimated.</p>
    </div>
  );
  if (method === "sem") return (
    <div className="ap-editor-grid" data-testid="ap-ed-options" data-method="sem">
      {field("Model (lavaan-style)", <textarea className="input mono" rows={6} value={String(value.syntax ?? "")} placeholder={"TRUST =~ M1 + M2 + M3\nINTENT =~ Y1 + Y2 + Y3\nINTENT ~ TRUST"} onChange={(e) => set("syntax", e.target.value)} data-testid="ap-opt-syntax" />, true)}
      {field("Scaling", <select className="select" value={String(value.scaling ?? "")} onChange={(e) => set("scaling", e.target.value)} data-testid="ap-opt-scaling"><option value="">marker (first loading = 1)</option><option value="unit_variance">unit variance</option></select>)}
    </div>
  );
  if (method === "regression" || method === "driver_analysis") return mediator ? (
    <div className="ap-editor-grid" data-testid="ap-ed-options" data-method="regression">
      <label className="ax-field ap-field"><span>Indirect effect</span><span><input type="checkbox" checked={!!value.bootstrap} onChange={(e) => set("bootstrap", e.target.checked ? 5000 : undefined)} data-testid="ap-opt-bootstrap" /> Bootstrap the indirect effect (5,000 resamples, percentile and BCa intervals)</span></label>
      {!!value.bootstrap && field("Seed", <input className="input" type="number" value={String(value.seed ?? "")} placeholder="fixed default" onChange={(e) => set("seed", num(e.target.value))} data-testid="ap-opt-bseed" />)}
    </div>
  ) : null;
  if (method === "reliability") return (
    <div className="ap-editor-grid" data-testid="ap-ed-options" data-method="reliability">
      <label className="ax-field ap-field"><span>Coefficient</span><span><input type="checkbox" checked={value.omega === true} onChange={(e) => set("omega", e.target.checked || undefined)} data-testid="ap-opt-omega" /> Also McDonald’s ω (one-factor model; needs 3+ items)</span></label>
    </div>
  );
  if (method === "pricing") return (
    <div className="ap-editor-grid" data-testid="ap-ed-options" data-method="pricing">
      {field("Method", <select className="select" value={String(value.method ?? "")} onChange={(e) => set("method", e.target.value)} data-testid="ap-opt-pmethod"><option value="">Van Westendorp</option><option value="gabor_granger">Gabor–Granger</option></select>)}
      {value.method === "gabor_granger" && field("Prices, one per purchase-intent question (in order)", <input className="input" value={Array.isArray(value.prices) ? (value.prices as number[]).join(", ") : ""} placeholder="9.99, 14.99, 19.99" onChange={(e) => { const xs = e.target.value.split(/[,;\s]+/).filter(Boolean).map(Number); set("prices", xs.length ? xs : undefined); }} data-testid="ap-opt-prices" />, true)}
    </div>
  );
  return null;
}

/** the update action's options: changed keys, and a null for each key removed (the engine merges) */
export function optionsPatch(before: Record<string, unknown> | undefined, after: Record<string, unknown>): Record<string, unknown> | undefined {
  const b = before ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after)) if (JSON.stringify(b[k]) !== JSON.stringify(v)) out[k] = v;
  for (const k of Object.keys(b)) if (!(k in after) && k !== "planned" && k !== "hypotheses") out[k] = null;
  return Object.keys(out).length ? out : undefined;
}

/* ------------------------------------------------------------ one advanced result, read */

export function AdvancedReadingPanel({ api, planned, dataset, canInterpret }: { api: AxApi; planned: string; dataset: DatasetSpec; canInterpret: boolean }) {
  const [r, setR] = React.useState<AdvancedReading | null>(null);
  const [busy, setBusy] = React.useState<"" | "read" | "model">("");
  const [err, setErr] = React.useState<string | null>(null);
  const read = async (interpretation: boolean) => {
    setBusy(interpretation ? "model" : "read"); setErr(null);
    try { setR(await api.advancedNarrative({ planned, environment: dataset.environment, dataset: dataset.dataset ?? "all", ...(interpretation ? { interpretation: true } : {}) })); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(""); }
  };
  const n = r?.narrative;
  return (
    <div className="ap-adv-reading" data-testid="ap-adv-reading" data-planned={planned}>
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <button className="btn small" disabled={!!busy} onClick={() => void read(false)} data-testid="ap-adv-read">{busy === "read" ? "Reading…" : r ? "Read again" : "Read the result"}</button>
        {canInterpret && r && n?.valid && <button className="btn small" disabled={!!busy} onClick={() => void read(true)} data-testid="ap-adv-interpret"><Icon name="sparkle" size={12} /> {busy === "model" ? "Interpreting…" : "Interpret with AI"}</button>}
      </div>
      {err && <p className="iq-error"><Icon name="warning" size={12} /> {err}</p>}
      {n && (
        <div data-testid="ap-adv-narrative" data-valid={n.valid ? "1" : "0"} data-method={n.method}>
          <div className="card-title" style={{ marginTop: 6 }}>{n.methodName}{r?.pending ? <span className="badge neutral" style={{ marginLeft: 6 }}>job not finished</span> : null}</div>
          <ul className="ax-insights" data-testid="ap-adv-summary">{n.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
          {n.diagnostics.length > 0 && (
            <table className="ax-table" data-testid="ap-adv-diagnostics"><thead><tr><th>Check</th><th>Value</th><th>Status</th></tr></thead>
              <tbody>{n.diagnostics.map((d, i) => <tr key={i}><td>{d.label}</td><td>{d.value}</td><td><span className={`badge ${DIAG_TONE[d.status] ?? "neutral"}`}>{d.status}</span>{d.note ? <span className="muted"> {d.note}</span> : null}</td></tr>)}</tbody>
            </table>
          )}
          {n.caveats.length > 0 && <ul className="muted" style={{ fontSize: 12.5, margin: "6px 0 0 18px" }} data-testid="ap-adv-caveats">{n.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>}
          {/* the diagram is the engine's own SVG: labels escaped, no script, built from the result's nodes and links */}
          {r?.svg && <div className="ap-adv-svg" data-testid="ap-adv-svg" style={{ overflowX: "auto", marginTop: 8 }} dangerouslySetInnerHTML={{ __html: r.svg }} />}
          {r?.interpretation && (
            <div data-testid="ap-adv-model" style={{ marginTop: 8 }}>
              <div className="card-title">Interpretation <span className="muted" style={{ fontSize: 12 }}>· AI-written, every number checked against the result</span></div>
              <ul className="ax-insights">{[...r.interpretation.implications, ...r.interpretation.recommendations].map((s, i) => <li key={i}>{s}</li>)}</ul>
              {r.interpretation.rejected.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{r.interpretation.rejected.length} sentence{r.interpretation.rejected.length === 1 ? "" : "s"} withheld — {r.interpretation.rejected[0].reason}</div>}
            </div>
          )}
          {r && r.model.status !== "not_asked" && !r.interpretation && <div className="muted" style={{ fontSize: 12.5 }} data-testid="ap-adv-model-status">{r.model.detail}</div>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the plan's advanced models, live */

type Followed = { planned: string; title: string; job: ModelJobView };

export function AdvancedModelsCard({ api, dataset, canEdit, canEditPlan, startJobs, onChanged, onPolicy }: {
  api: AxApi; dataset: DatasetSpec; canEdit: boolean; canEditPlan: boolean;
  /** jobs an apply just started: followed here until they finish */
  startJobs?: { planned: string; title: string; job: ModelJobView }[] | null;
  /** a run was made (a finished job joined the findings): the workspace reloads */
  onChanged: () => void;
  onPolicy: (policy: { mode: "manual" | "threshold"; newResponses?: number } | null) => Promise<boolean>;
}) {
  const [items, setItems] = React.useState<AdvancedItemStatus[] | null>(null);
  const [policy, setPolicy] = React.useState<{ mode: "manual" | "threshold"; newResponses?: number }>({ mode: "manual" });
  const [threshold, setThreshold] = React.useState("50");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [followed, setFollowed] = React.useState<Followed[]>([]);
  const following = React.useRef(false);
  const env = { environment: dataset.environment, dataset: dataset.dataset ?? "all" };

  const load = React.useCallback(async () => {
    try { const s = await api.advancedStatus(env); setItems(s.items); setPolicy(s.policy); if (s.policy.newResponses) setThreshold(String(s.policy.newResponses)); }
    catch { setItems([]); }
  }, [api, env.environment, env.dataset]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { void load(); }, [load]);

  /* follow the running jobs chunk by chunk; when every one is done, run the plan once so their results join the findings */
  const follow = React.useCallback(async (jobs: Followed[]) => {
    if (following.current || !jobs.length) return;
    following.current = true;
    let list = jobs;
    setFollowed(list);
    try {
      for (let guard = 0; guard < 400 && list.some((j) => j.job.status === "running"); guard++) {
        const next: Followed[] = [];
        for (const f of list) {
          if (f.job.status !== "running") { next.push(f); continue; }
          try { const { job } = await api.modelContinue(f.job.id); next.push({ ...f, job }); }
          catch (e) { next.push({ ...f, job: { ...f.job, status: "failed", error: (e as Error).message } }); }
        }
        list = next; setFollowed(list);
      }
      if (list.some((j) => j.job.status === "done") && canEdit) {
        const r = await api.advancedRerun(env);
        setItems(r.status);
        if (r.runId) { setMsg("The finished models joined a new run of the plan — findings and verdicts are updated."); onChanged(); }
      }
    } finally { following.current = false; await load(); }
  }, [api, canEdit, load, onChanged, env.environment, env.dataset]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => { if (startJobs?.length) void follow(startJobs.map((j) => ({ planned: j.planned, title: j.title, job: j.job }))); }, [startJobs, follow]);
  /* a job left running by an earlier visit is picked up too */
  React.useEffect(() => {
    if (!items || following.current || !canEdit) return;
    const running = items.filter((i) => i.job?.status === "running");
    if (running.length) void follow(running.map((i) => ({ planned: i.planned, title: i.title, job: { id: i.job!.id, status: "running", progress: { done: i.job!.done, total: i.job!.total, pct: i.job!.pct, unit: "iterations", projectedMs: null } } as ModelJobView })));
  }, [items, canEdit, follow]);

  const rerun = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api.advancedRerun(env);
      setItems(r.status);
      setMsg(`${r.jobs.length ? `${r.jobs.length} hierarchical Bayes job${r.jobs.length === 1 ? "" : "s"} started. ` : ""}${r.runId ? "The plan ran again on the data as it is now." : r.jobs.length ? "" : "Nothing needed re-running."}`);
      if (r.runId) onChanged();
      if (r.jobs.length) void follow(r.jobs.map((j) => ({ planned: j.planned, title: j.title, job: j.job })));
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!items || !items.length) return null;
  const stale = items.filter((i) => i.staleness.state === "stale" || i.staleness.state === "never_run");
  const jobOf = (planned: string) => followed.find((f) => f.planned === planned)?.job;
  return (
    <div className="card" data-testid="ap-advanced" data-stale={stale.length}>
      <div className="card-title">Advanced models <span className="ax-rail-count">{items.length}</span><span className="grow" />
        {canEdit && <button className={`btn small${busy ? " loading" : ""}`} disabled={busy || following.current} onClick={() => void rerun()} data-testid="ap-adv-rerun" title="Re-run what is stale or not run yet — HB as a background job; nothing is replaced until the new result is ready">Re-run{stale.length ? ` ${stale.length} stale` : ""}</button>}
      </div>
      <ul className="ap-attention">
        {items.map((it) => {
          const j = jobOf(it.planned) ?? (it.job?.status === "running" ? { status: "running", progress: { pct: it.job.pct, done: it.job.done, total: it.job.total } } as unknown as ModelJobView : null);
          return (
            <li key={it.planned} data-testid="ap-adv-item" data-planned={it.planned} data-state={j?.status === "running" ? "running" : it.staleness.state}>
              <span className={`badge ${STATE_TONE[j?.status === "running" ? "running" : it.staleness.state]}`}>{STATE_WORD[j?.status === "running" ? "running" : it.staleness.state]}</span> {it.title}
              {j?.status === "running" && <span data-testid="ap-job" data-pct={j.progress.pct}> · <progress max={100} value={j.progress.pct} style={{ width: 120, verticalAlign: "middle" }} /> {j.progress.pct}%</span>}
              {j && j.status === "failed" && <span className="iq-error" data-testid="ap-job-failed"> · {j.error ?? "the job failed"}</span>}
              <div className="muted" style={{ fontSize: 12.5 }}>{it.staleness.message}</div>
            </li>
          );
        })}
      </ul>
      {msg && <div className="muted" style={{ fontSize: 12.5 }} data-testid="ap-adv-msg">{msg}</div>}
      <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: "wrap", fontSize: 12.5 }} data-testid="ap-adv-policy" data-mode={policy.mode}>
        <span className="muted">When new completes arrive:</span>
        <select className="select small" disabled={!canEditPlan} value={policy.mode} onChange={async (e) => { const mode = e.target.value as "manual" | "threshold"; const p = mode === "threshold" ? { mode, newResponses: Math.max(1, Number(threshold) || 50) } : { mode }; if (await onPolicy(p)) setPolicy(p); }} data-testid="ap-adv-policy-mode">
          <option value="manual">flag the result as stale (re-run by hand)</option>
          <option value="threshold">re-run automatically after…</option>
        </select>
        {policy.mode === "threshold" && <><input className="input small" type="number" min={1} style={{ width: 80 }} disabled={!canEditPlan} value={threshold} onChange={(e) => setThreshold(e.target.value)} onBlur={async () => { const n = Math.max(1, Number(threshold) || 50); if (n !== policy.newResponses && await onPolicy({ mode: "threshold", newResponses: n })) setPolicy({ mode: "threshold", newResponses: n }); }} data-testid="ap-adv-policy-n" /><span className="muted">new completes (checked hourly)</span></>}
      </div>
    </div>
  );
}
