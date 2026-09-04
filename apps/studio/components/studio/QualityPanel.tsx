"use client";
import React from "react";
import { CATEGORY_LABELS } from "@rescript/quality";
import { useStudio } from "./store";

/**
 * Data → Quality: the dashboard and the review workflow.
 *
 *   header      totals by classification and by decision, the fraud-risk
 *               distribution, one chip per signal category (click = filter),
 *               the coordinated clusters found
 *   table       one row per finished response; filter by classification,
 *               signal, decision, cluster, or search by id; sort by risk
 *   review      click a row → the full assessment: both scores, every signal
 *               group, every flag with observed / expected / severity /
 *               points / explanation, telemetry summary, decision history —
 *               and KEEP / REMOVE / REVIEW LATER, stored with a reason.
 *
 * Nothing here deletes. REMOVE marks the row and the clean dataset skips it;
 * the raw response stays and the decision can be cleared.
 */

type Include = "live" | "test" | "all";
const CLASSES = ["CLEAN", "REVIEW", "SUSPICIOUS", "HIGHLY_SUSPICIOUS", "CRITICAL"] as const;
const CLASS_COLOR: Record<string, string> = { CLEAN: "#2f9e44", REVIEW: "#f0b429", SUSPICIOUS: "#f76707", HIGHLY_SUSPICIOUS: "#e03131", CRITICAL: "#862e9c", UNSCORED: "#94a3b8" };
const SEV_COLOR: Record<string, string> = { low: "#94a3b8", medium: "#f0b429", high: "#f76707", critical: "#e03131" };

interface Row {
  sessionId: string; status: string; startedAt: string | null; completedAt: string | null; durationSec: number | null;
  assessed: boolean; configHash: string | null; computedAt: string | null;
  qualityScore: number | null; riskScore: number | null; classification: string | null; recommendation: string | null;
  categories: Record<string, number>; flags: { ruleId: string; category: string; severity: string; title: string }[];
  clusterId: string | null; clusterSize: number; reasons: string[];
  reviewStatus: string | null; reviewReason: string | null; reviewedAt: string | null; reviewedBy: string | null;
}
interface ConfigSummary {
  enabled: boolean; strictness: string; profile: string | null; bands: { review: number; suspicious: number; highlySuspicious: number; critical: number };
  rulesOn: number; rulesTotal: number; rulesCustomised: number; customRules: number; telemetryOff: string[]; maxPeers: number; configHash: string;
}
interface Payload {
  enabled: boolean; strictness: string | null; total: number;
  config: ConfigSummary | null; source: "draft" | "version" | null; revision: number | null; savedAt: string | null; version: string | null;
  live: { version: string; versionId: string; config: ConfigSummary } | null;
  staleAssessed: number;
  byClass: Record<string, number>; byReview: Record<string, number>; signals: Record<string, number>; histogram: number[];
  clusters: { id: string; size: number }[]; rows: Row[]; error?: string; migration?: string;
}

const fmtClass = (c: string | null) => (c ?? "UNSCORED").replace("_", " ");

export function QualityPanel({ include }: { include: Include }) {
  const s = useStudio();
  const [data, setData] = React.useState<Payload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [filter, setFilter] = React.useState<{ cls: string | null; signal: string | null; review: string | null; cluster: string | null; q: string }>({ cls: null, signal: null, review: null, cluster: null, q: "" });
  const [sort, setSort] = React.useState<"risk" | "quality" | "time">("risk");
  const [open, setOpen] = React.useState<string | null>(null);

  /*
   * The page reads the settings from the server, because that is what the
   * engine reads. An edit made a moment ago may still be inside the autosave
   * debounce, so the pending draft is flushed FIRST — otherwise the dashboard
   * showed the settings from before the edit and looked like it had not saved.
   */
  const load = React.useCallback(async () => {
    setError(null);
    try {
      if (s.saveState.kind === "dirty" || s.saveState.kind === "saving") await s.flushDraft();
      const r = await fetch(`/api/surveys/${s.surveyDbId}/quality?include=${include}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? `Server returned ${r.status}`); setData(null); return; }
      setData(j);
    } catch { setError("Could not load quality data."); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.surveyDbId, include]);
  React.useEffect(() => { void load(); }, [load]);

  const recompute = async () => {
    setBusy(true);
    try {
      const saved = await s.flushDraft();
      if (!saved && s.saveState.kind !== "clean" && s.saveState.kind !== "saved") { setError("Your latest settings could not be saved, so nothing was re-assessed. See the save status in the header."); return; }
      const r = await fetch(`/api/surveys/${s.surveyDbId}/quality/recompute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ include }), cache: "no-store" });
      const j = await r.json();
      if (!r.ok) setError(j.error ?? "Recompute failed");
      else console.info("[rescript:quality] recompute", j);
      await load();
    } finally { setBusy(false); }
  };

  const rows = React.useMemo(() => {
    if (!data) return [];
    let out = data.rows;
    if (filter.cls) out = out.filter((r) => (r.classification ?? "UNSCORED") === filter.cls);
    if (filter.signal) out = out.filter((r) => r.flags.some((f) => f.category === filter.signal));
    if (filter.review) out = out.filter((r) => (r.reviewStatus ?? "NONE") === filter.review);
    if (filter.cluster) out = out.filter((r) => r.clusterId === filter.cluster);
    if (filter.q) out = out.filter((r) => r.sessionId.includes(filter.q) || r.reasons.some((x) => x.toLowerCase().includes(filter.q.toLowerCase())));
    return [...out].sort((a, b) => sort === "risk" ? (b.riskScore ?? -1) - (a.riskScore ?? -1) : sort === "quality" ? (a.qualityScore ?? 101) - (b.qualityScore ?? 101) : (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  }, [data, filter, sort]);

  if (error) {
    return (
      <div className="card" style={{ borderColor: "var(--red)" }} data-testid="quality-error">
        <strong style={{ color: "var(--red)" }}>{error}</strong>
        {/migration/i.test(error) && <p className="muted" style={{ fontSize: 12 }}>Run <span className="mono">supabase/migrations/0005_response_quality.sql</span> on the database, then refresh.</p>}
      </div>
    );
  }
  if (!data) return <p className="muted">Loading quality data…</p>;

  const maxHist = Math.max(1, ...data.histogram);
  return (
    <div data-testid="quality-panel">
      <ConfigCard data={data} include={include} busy={busy} onRecompute={recompute} onSettings={() => s.goToTab?.("settings")} />
      {!data.enabled && (
        <div className="chip warn qd-note" data-testid="quality-disabled-note">
          Quality checks are off for this survey — enable them under Survey settings → Quality checks. Responses finished while off are unscored; “Re-assess” scores them with the current settings.
        </div>
      )}

      {/* ------------------------------------------------------ header */}
      <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "stretch" }} data-testid="quality-summary">
        <div className="card" style={{ padding: 10, minWidth: 150 }}>
          <div className="muted" style={{ fontSize: 11 }}>Total responses</div>
          <div style={{ fontSize: 22, fontWeight: 600 }} data-testid="q-total">{data.total.toLocaleString()}</div>
          <div className="muted" style={{ fontSize: 11 }}>{data.strictness ? `${data.strictness} strictness` : ""}</div>
        </div>
        {[...CLASSES, "UNSCORED"].map((c) => (
          <button key={c} className="card" data-testid={`q-class-${c}`} onClick={() => setFilter((f) => ({ ...f, cls: f.cls === c ? null : c }))}
            style={{ padding: 10, minWidth: 120, textAlign: "left", cursor: "pointer", borderColor: filter.cls === c ? CLASS_COLOR[c] : undefined, borderWidth: filter.cls === c ? 2 : 1 }}>
            <div className="muted" style={{ fontSize: 11 }}><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: CLASS_COLOR[c], marginRight: 5 }} />{fmtClass(c)}</div>
            <div style={{ fontSize: 20, fontWeight: 600 }}>{(data.byClass[c] ?? 0).toLocaleString()}</div>
          </button>
        ))}
        <div className="card" style={{ padding: 10, minWidth: 180 }}>
          <div className="muted" style={{ fontSize: 11 }}>Fraud-risk distribution</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40 }} data-testid="q-histogram">
            {data.histogram.map((n, i) => (
              <div key={i} title={`${i * 10}–${i * 10 + 9}: ${n}`} style={{ flex: 1, height: `${Math.max(2, (n / maxHist) * 100)}%`, background: i < 2 ? CLASS_COLOR.CLEAN : i < 4 ? CLASS_COLOR.REVIEW : i < 6 ? CLASS_COLOR.SUSPICIOUS : i < 8 ? CLASS_COLOR.HIGHLY_SUSPICIOUS : CLASS_COLOR.CRITICAL, borderRadius: 2 }} />
            ))}
          </div>
          <div className="muted" style={{ fontSize: 10, display: "flex", justifyContent: "space-between" }}><span>0</span><span>risk</span><span>100</span></div>
        </div>
      </div>

      <div className="row" style={{ flexWrap: "wrap", gap: 6, margin: "10px 0" }} data-testid="q-signals">
        <span className="muted" style={{ fontSize: 11 }}>Signals:</span>
        {Object.entries(data.signals).sort((a, b) => b[1] - a[1]).map(([cat, n]) => (
          <button key={cat} className={`chip ${filter.signal === cat ? "on" : ""}`} style={{ cursor: "pointer" }} data-testid={`q-signal-${cat}`}
            onClick={() => setFilter((f) => ({ ...f, signal: f.signal === cat ? null : cat }))}>{CATEGORY_LABELS[cat] ?? cat} {n}</button>
        ))}
        {!Object.keys(data.signals).length && <span className="muted" style={{ fontSize: 11 }}>none</span>}
        <span className="grow" />
        <span className="muted" style={{ fontSize: 11 }}>Decisions:</span>
        {(["KEEP", "REMOVE", "REVIEW_LATER", "NONE"] as const).map((d) => (
          <button key={d} className={`chip ${filter.review === d ? "on" : ""}`} style={{ cursor: "pointer" }} data-testid={`q-review-${d}`}
            onClick={() => setFilter((f) => ({ ...f, review: f.review === d ? null : d }))}>{d === "NONE" ? "undecided" : d.replace("_", " ").toLowerCase()} {data.byReview[d] ?? 0}</button>
        ))}
      </div>

      {data.clusters.length > 0 && (
        <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 10 }} data-testid="q-clusters">
          <span className="muted" style={{ fontSize: 11 }}>Coordinated clusters:</span>
          {data.clusters.slice(0, 12).map((c) => (
            <button key={c.id} className={`chip ${filter.cluster === c.id ? "on" : "warn"}`} style={{ cursor: "pointer" }} data-testid="q-cluster"
              onClick={() => setFilter((f) => ({ ...f, cluster: f.cluster === c.id ? null : c.id }))}>{c.id.slice(2, 8)} · {c.size} responses</button>
          ))}
        </div>
      )}

      <div className="row" style={{ gap: 8, marginBottom: 8, alignItems: "center" }}>
        <input className="input" style={{ width: 240 }} placeholder="search id or reason…" data-testid="q-search" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} />
        <select className="select" style={{ width: 160 }} value={sort} onChange={(e) => setSort(e.target.value as any)}>
          <option value="risk">highest risk first</option><option value="quality">lowest quality first</option><option value="time">newest first</option>
        </select>
        {(filter.cls || filter.signal || filter.review || filter.cluster || filter.q) && <button className="btn small" onClick={() => setFilter({ cls: null, signal: null, review: null, cluster: null, q: "" })}>clear filters</button>}
        <span className="muted" style={{ fontSize: 11 }}>{rows.length} of {data.total}</span>
        <span className="grow" />
        <button className="btn small" data-testid="q-recompute" disabled={busy} onClick={recompute}>{busy ? "Re-assessing…" : "↻ Re-assess all"}</button>
      </div>

      <div className="table-wrap">
        <table className="grid" data-testid="q-table">
          <thead><tr><th>Response</th><th>Class</th><th>Quality</th><th>Risk</th><th>Secs</th><th>Signals</th><th>Top reason</th><th>Decision</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sessionId} style={{ cursor: "pointer" }} data-testid="q-row" onClick={() => setOpen(r.sessionId)}>
                <td className="mono">{r.sessionId.slice(0, 8)}{r.status !== "complete" ? <span className="muted"> · {r.status}</span> : ""}</td>
                <td>
                  <span className="chip" style={{ borderColor: CLASS_COLOR[r.classification ?? "UNSCORED"], color: CLASS_COLOR[r.classification ?? "UNSCORED"] }}>{fmtClass(r.classification)}</span>
                  {r.assessed && data.config && r.configHash !== data.config.configHash && (
                    <div className="qd-stale" title={`Assessed ${r.computedAt ? new Date(r.computedAt).toLocaleString() : ""} with settings ${r.configHash ?? "(older build)"} — current settings are ${data.config.configHash}`} data-testid="q-row-stale">older settings</div>
                  )}
                </td>
                <td><Score value={r.qualityScore} invert /></td>
                <td><Score value={r.riskScore} /></td>
                <td>{r.durationSec ?? ""}</td>
                <td>{[...new Set(r.flags.map((f) => f.category))].map((c) => <span key={c} className="chip" style={{ marginRight: 2 }}>{CATEGORY_LABELS[c] ?? c}</span>)}{r.clusterId && <span className="chip warn">cluster {r.clusterSize}</span>}</td>
                <td style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.reasons.join("\n")}>{r.reasons[0] ?? (r.assessed ? "—" : "not assessed")}</td>
                <td>{r.reviewStatus ? <span className={`chip ${r.reviewStatus === "KEEP" ? "on" : "warn"}`}>{r.reviewStatus.replace("_", " ")}</span> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="muted" style={{ fontSize: 12 }}>No responses match.</p>}
      </div>

      {open && <ReviewDrawer sessionId={open} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

/**
 * The settings in effect — what the engine reads for this survey right now —
 * with where they came from (autosaved draft rev N / version X), so the page
 * always states the persisted configuration rather than implying it. Plus the
 * two gaps worth knowing about: responses assessed under older settings, and a
 * live link still running an older version's settings.
 */
function ConfigCard({ data, include, busy, onRecompute, onSettings }: { data: Payload; include: Include; busy: boolean; onRecompute(): void; onSettings(): void }) {
  const c = data.config;
  if (!c) return null;
  const when = data.savedAt ? new Date(data.savedAt).toLocaleString() : null;
  const liveDiffers = data.live && data.live.config.configHash !== c.configHash;
  return (
    <>
      <div className="card qd-config" data-testid="q-config" data-config-hash={c.configHash}>
        <div>
          <div className="qd-config-title">Quality settings in effect</div>
          <div className="qd-config-facts">
            <span className={`chip ${c.enabled ? "on" : "warn"}`} data-testid="q-config-enabled">{c.enabled ? "enabled" : "disabled"}</span>
            <span className="chip" data-testid="q-config-strictness">{c.strictness.replace("_", " ")} strictness</span>
            {c.profile && <span className="chip">profile: {c.profile}</span>}
            <span className="chip" data-testid="q-config-rules">{c.rulesOn} of {c.rulesTotal} rules on{c.rulesCustomised ? ` · ${c.rulesCustomised} customised` : ""}</span>
            <span className="chip" data-testid="q-config-custom">{c.customRules} custom rule{c.customRules === 1 ? "" : "s"}</span>
            <span className="chip" data-testid="q-config-bands">bands {c.bands.review} / {c.bands.suspicious} / {c.bands.highlySuspicious} / {c.bands.critical}</span>
            {c.telemetryOff.length > 0 && <span className="chip warn">not recording: {c.telemetryOff.join(", ")}</span>}
            <span className="chip mono" title="Fingerprint of these settings — the same value is written on every assessment made with them">{c.configHash}</span>
          </div>
          <div className="qd-config-source" data-testid="q-config-source">
            {data.source === "draft"
              ? <>From the autosaved draft{typeof data.revision === "number" ? ` (rev ${data.revision})` : ""}{when ? `, saved ${when}` : ""}. Test links and re-assessment use these settings.</>
              : <>From saved version {data.version ?? ""}{typeof data.revision === "number" ? ` (rev ${data.revision})` : ""} — no unsaved draft.</>}
            {data.live && (
              <> Live link runs v{data.live.version}: {data.live.config.enabled ? `${data.live.config.strictness.replace("_", " ")} strictness, ${data.live.config.rulesOn} rules` : "quality checks off"}
                {liveDiffers ? <strong> — different from the settings above; Save version and Publish to apply them to live respondents.</strong> : " — same settings."}</>
            )}
          </div>
        </div>
        <div className="qd-config-actions">
          <button className="btn small" onClick={onSettings} data-testid="q-config-edit">Edit settings</button>
          {data.staleAssessed > 0 && (
            <button className="btn small primary" disabled={busy} onClick={onRecompute} data-testid="q-config-stale" title="These responses were scored before the settings changed">
              {busy ? "Re-assessing…" : `↻ Re-assess ${data.staleAssessed} scored with older settings`}
            </button>
          )}
        </div>
      </div>
      {include === "live" && liveDiffers && data.total > 0 && (
        <div className="chip warn qd-note" data-testid="q-live-gap">New live responses are scored with the published version's settings (v{data.live!.version}) until you publish. “Re-assess” applies the settings above to the responses already collected.</div>
      )}
    </>
  );
}

function Score({ value, invert }: { value: number | null; invert?: boolean }) {
  if (value === null) return <span className="muted">—</span>;
  const good = invert ? value : 100 - value;
  const color = good >= 80 ? CLASS_COLOR.CLEAN : good >= 60 ? CLASS_COLOR.REVIEW : good >= 40 ? CLASS_COLOR.SUSPICIOUS : CLASS_COLOR.HIGHLY_SUSPICIOUS;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 46, height: 6, background: "var(--panel2)", borderRadius: 3, overflow: "hidden", display: "inline-block" }}>
        <span style={{ display: "block", width: `${value}%`, height: "100%", background: color }} />
      </span>
      <span className="mono" style={{ fontSize: 12 }}>{value}</span>
    </span>
  );
}

/* ================================================================ review */

const GROUPS: [string, string[]][] = [
  ["Timing", ["timing"]], ["Behaviour", ["interaction", "bot"]], ["Navigation", ["navigation", "screener"]], ["Matrix quality", ["matrix"]],
  ["Attention", ["attention"]], ["Consistency", ["consistency", "pattern"]], ["Open-end quality", ["open_end"]],
  ["Device / network", ["device", "network"]], ["Duplicates", ["duplicate"]], ["Clusters", ["cluster"]], ["Custom & history", ["custom"]],
];

export function ReviewDrawer({ sessionId, onClose, onChanged }: { sessionId: string; onClose(): void; onChanged(): void }) {
  const s = useStudio();
  const [d, setD] = React.useState<any | null>(null);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [tab, setTab] = React.useState<"reasons" | "answers" | "telemetry" | "history">("reasons");
  const load = React.useCallback(async () => {
    const r = await fetch(`/api/surveys/${s.surveyDbId}/quality/${sessionId}`);
    if (r.ok) setD(await r.json());
  }, [s.surveyDbId, sessionId]);
  React.useEffect(() => { void load(); }, [load]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const decide = async (decision: "KEEP" | "REMOVE" | "REVIEW_LATER" | "CLEAR") => {
    setBusy(true);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/quality/${sessionId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, reason: reason || undefined, by: "researcher" }) });
      if (r.ok) { setReason(""); await load(); onChanged(); }
    } finally { setBusy(false); }
  };
  const reassess = async () => {
    setBusy(true);
    try { await fetch(`/api/surveys/${s.surveyDbId}/quality/${sessionId}`, { method: "POST" }); await load(); onChanged(); } finally { setBusy(false); }
  };

  const a = d?.quality;
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" data-testid="review-drawer" style={{ width: 860 }} onClick={(e) => e.stopPropagation()}>
        {!d ? <p className="muted">Loading…</p> : (
          <>
            <div className="row" style={{ alignItems: "center", gap: 10 }}>
              <h2 style={{ fontSize: 15, margin: 0 }}>Respondent <span className="mono">{d.sessionId.slice(0, 12)}</span></h2>
              <span className="chip">{d.status}</span>
              {d.isTest && <span className="chip warn">test</span>}
              <span className="grow" />
              <button className="btn small" onClick={reassess} disabled={busy} data-testid="review-reassess">↻ re-assess</button>
              <button className="btn small" onClick={onClose}>close</button>
            </div>

            {a ? (
              <>
                <div className="row" style={{ gap: 14, margin: "10px 0", flexWrap: "wrap" }} data-testid="review-scores">
                  <Big label="Quality score" value={`${a.qualityScore}/100`} sub="100 = very high quality" color={a.qualityScore >= 70 ? CLASS_COLOR.CLEAN : a.qualityScore >= 40 ? CLASS_COLOR.REVIEW : CLASS_COLOR.HIGHLY_SUSPICIOUS} />
                  <Big label="Fraud risk" value={`${a.riskScore}/100`} sub="100 = extremely suspicious" color={CLASS_COLOR[a.classification]} />
                  <Big label="Classification" value={fmtClass(a.classification)} sub={a.strictness ? `${a.strictness} strictness` : ""} color={CLASS_COLOR[a.classification]} />
                  <Big label="Recommendation" value={a.recommendation} sub={`${a.flags.length} flag${a.flags.length === 1 ? "" : "s"} · ${a.benchmarks?.peers ?? 0} peers`} color="var(--text)" />
                </div>

                <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 8 }} data-testid="review-groups">
                  {GROUPS.map(([label, cats]) => {
                    const score = Math.max(0, ...cats.map((c) => a.categories?.[c] ?? 0));
                    const n = a.flags.filter((f: any) => cats.includes(f.category)).length;
                    return <span key={label} className="chip" style={{ borderColor: n ? SEV_COLOR[score >= 60 ? "critical" : score >= 35 ? "high" : "medium"] : undefined }}>{label}: {n ? `${score} risk · ${n} flag${n === 1 ? "" : "s"}` : "ok"}</span>;
                  })}
                </div>

                <div className="row" style={{ gap: 4, marginBottom: 6 }}>
                  {(["reasons", "answers", "telemetry", "history"] as const).map((t) => <button key={t} className={`btn small ${tab === t ? "primary" : ""}`} onClick={() => setTab(t)}>{t === "reasons" ? "Detailed reasons" : t[0].toUpperCase() + t.slice(1)}</button>)}
                </div>

                {tab === "reasons" && (
                  <div data-testid="review-reasons">
                    {a.flags.length === 0 && <p className="muted" style={{ fontSize: 12 }}>No flags. {a.notMeasured?.length ? `Not measured: ${a.notMeasured.join(", ")}.` : ""}</p>}
                    <ol style={{ paddingLeft: 18, margin: 0 }}>
                      {[...a.flags].sort((x: any, y: any) => (y.riskPoints + y.qualityPenalty) - (x.riskPoints + x.qualityPenalty)).map((f: any, i: number) => (
                        <li key={i} style={{ marginBottom: 8, fontSize: 12 }} data-testid="review-flag">
                          <div><strong>{f.title}</strong> <span className="chip" style={{ borderColor: SEV_COLOR[f.severity], color: SEV_COLOR[f.severity] }}>{f.severity}</span> <span className="muted">+{f.riskPoints} risk · −{f.qualityPenalty} quality · {CATEGORY_LABELS[f.category] ?? f.category}</span></div>
                          <div><span className="muted">What happened:</span> {f.observed}{f.expected ? <> <span className="muted">· expected</span> {f.expected}</> : null}</div>
                          <div><span className="muted">Why it matters:</span> {f.explanation}</div>
                          {(f.questionIds?.length || f.relatedSessionIds?.length) ? (
                            <div className="muted" style={{ fontSize: 11 }}>
                              {f.questionIds?.length ? `Questions: ${f.questionIds.map((id: string) => s.def.questions.find((q) => q.id === id)?.code ?? id).join(", ")}` : ""}
                              {f.relatedSessionIds?.length ? ` · Related respondents: ${f.relatedSessionIds.map((x: string) => x.slice(0, 8)).join(", ")}` : ""}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                    {a.cluster?.clusterId && <div className="chip warn" style={{ marginTop: 6 }}>Cluster {a.cluster.clusterId.slice(2, 8)} · {a.cluster.size} responses · risk {a.cluster.clusterRisk} · shares {a.cluster.sharedSignals.join(", ") || "similar answers"}</div>}
                    {a.notMeasured?.length ? <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Not measured (telemetry off or unavailable): {a.notMeasured.join(", ")}.</div> : null}
                  </div>
                )}
                {tab === "answers" && (
                  <div className="table-wrap" style={{ maxHeight: 320 }}>
                    <table className="grid"><thead><tr><th>Variable</th><th>Value</th></tr></thead>
                      <tbody>{Object.entries(d.vars ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => <tr key={k}><td><strong>{k}</strong></td><td>{Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)}</td></tr>)}</tbody>
                    </table>
                  </div>
                )}
                {tab === "telemetry" && (
                  <div style={{ fontSize: 12 }} data-testid="review-telemetry">
                    {!d.telemetry ? <p className="muted">No telemetry recorded for this response.</p> : (
                      <table className="grid"><tbody>
                        <tr><td>Total duration</td><td>{a.system?.SYSTEM_TOTAL_DURATION ?? "—"} s (benchmark {a.system?.SYSTEM_MEDIAN_DURATION ?? "—"} s, ratio {a.system?.SYSTEM_DURATION_RATIO ?? "—"})</td></tr>
                        <tr><td>Pages visited</td><td>{d.telemetry.pages} · back {d.telemetry.navigation?.back ?? 0} · reloads {d.telemetry.navigation?.reloads ?? 0}</td></tr>
                        <tr><td>Focus</td><td>{d.telemetry.focus?.blurs ?? 0} tab switches · {Math.round((d.telemetry.focus?.totalOutOfFocusMs ?? 0) / 1000)} s out of focus</td></tr>
                        <tr><td>Clipboard</td><td>{d.telemetry.clipboard?.copies ?? 0} copies · {d.telemetry.clipboard?.pastes ?? 0} pastes ({d.telemetry.clipboard?.pasteChars ?? 0} chars) — contents never stored</td></tr>
                        <tr><td>Interaction</td><td>{d.telemetry.interaction?.pointerEvents ?? 0} pointer · {d.telemetry.interaction?.keyEvents ?? 0} key · {d.telemetry.interaction?.scrollEvents ?? 0} scroll events</td></tr>
                        <tr><td>Device</td><td>{d.telemetry.device ? `${d.telemetry.device.type} · ${d.telemetry.device.browser} on ${d.telemetry.device.os} · ${d.telemetry.device.screen} · ${d.telemetry.device.timezone} · ${d.telemetry.device.locale}${d.telemetry.device.webdriver ? " · WEBDRIVER" : ""}` : "—"}</td></tr>
                        <tr><td>Signatures</td><td>device {d.hashes?.device ?? "—"}… · ip {d.hashes?.ip ?? "—"}… (salted hashes)</td></tr>
                        <tr><td>Navigation</td><td className="mono" style={{ fontSize: 11 }}>{(d.telemetry.navigation?.sequence ?? []).join(" ")}</td></tr>
                        {d.telemetry.disabled?.length ? <tr><td>Not recorded</td><td>{d.telemetry.disabled.join(", ")}</td></tr> : null}
                      </tbody></table>
                    )}
                  </div>
                )}
                {tab === "history" && (
                  <div style={{ fontSize: 12 }} data-testid="review-history">
                    {!d.reviews?.length ? <p className="muted">No decisions yet.</p> : (
                      <table className="grid"><thead><tr><th>When</th><th>Decision</th><th>By</th><th>Reason</th></tr></thead>
                        <tbody>{d.reviews.map((r: any, i: number) => <tr key={i}><td>{new Date(r.decided_at).toLocaleString()}</td><td>{r.decision}</td><td>{r.decided_by}</td><td>{r.reason ?? ""}</td></tr>)}</tbody></table>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="muted" style={{ fontSize: 12 }}>This response has not been assessed (quality checks were off when it finished, or the migration was missing). Click re-assess.</p>
            )}

            {/* ------------------------------------------------ decision */}
            <div className="card" style={{ padding: 10, marginTop: 10 }} data-testid="review-decision">
              <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 12 }}>Your decision:</strong>
                {d.review?.status ? <span className={`chip ${d.review.status === "KEEP" ? "on" : "warn"}`} data-testid="review-current">{d.review.status.replace("_", " ")}{d.review.reason ? ` — ${d.review.reason}` : ""}{d.review.at ? ` · ${new Date(d.review.at).toLocaleString()}` : ""}</span> : <span className="muted" style={{ fontSize: 12 }}>none yet</span>}
                <span className="grow" />
                <input className="input" style={{ width: 260 }} placeholder="reason (optional)" data-testid="review-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                <button className="btn small" style={{ borderColor: CLASS_COLOR.CLEAN, color: CLASS_COLOR.CLEAN }} disabled={busy} data-testid="review-keep" onClick={() => decide("KEEP")}>KEEP</button>
                <button className="btn small danger" disabled={busy} data-testid="review-remove" onClick={() => decide("REMOVE")}>REMOVE</button>
                <button className="btn small" disabled={busy} data-testid="review-later" onClick={() => decide("REVIEW_LATER")}>REVIEW LATER</button>
                {d.review?.status && <button className="btn small ghost" disabled={busy} data-testid="review-clear" onClick={() => decide("CLEAR")}>undo</button>}
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>REMOVE excludes this response from clean datasets and exports marked clean. The raw response is never deleted and the decision can be undone; every decision is kept in the audit trail.</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Big({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div style={{ minWidth: 150 }}>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, color }}>{value}</div>
      {sub && <div className="muted" style={{ fontSize: 11 }}>{sub}</div>}
    </div>
  );
}
