"use client";
import React from "react";
import type { AnalysisResult, DashboardWidget, ReportBlock, ReportTheme } from "@rescript/analytics";
import { ReportView } from "@/components/analytics/ReportView";
import { downloadBlob } from "@/components/analytics/api";

/**
 * /share/<token> — THE READ-ONLY CLIENT VIEW (§19, §20, §21). Loads the
 * published snapshot through the public API and renders it with no builder,
 * no edit controls and no access to anything but that snapshot. Password and
 * sign-in gates are handled here; downloads appear only when the share
 * permits them.
 */

interface Payload {
  report: { name: string | null; title: string; subtitle?: string; blocks?: ReportBlock[]; widgets?: DashboardWidget[] | null; crossFilter?: boolean; viewerSegments: string[]; branding: { showLogo?: boolean; footer?: string; header?: string } };
  theme: ReportTheme; results: Record<string, AnalysisResult>; version: number; publishedAt: string; mode: "snapshot"; dataset: { responses?: number; surveyVersion?: string; computedAt?: string } | null; permission: "viewer" | "download";
}

export default function SharePage({ params }: { params: { token: string } }) {
  const [data, setData] = React.useState<Payload | null>(null);
  const [gate, setGate] = React.useState<{ status: string; message: string; reportName?: string } | null>(null);
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const load = React.useCallback(async (pw?: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/share/${params.token}`, { headers: pw ? { "x-share-password": pw } : {}, cache: "no-store" });
      const j = await r.json();
      if (!r.ok) { setGate({ status: j.status ?? String(r.status), message: j.error ?? "This report is not available.", reportName: j.reportName }); setData(null); return; }
      setGate(null); setData(j as Payload);
    } catch { setGate({ status: "error", message: "The report could not be loaded." }); } finally { setBusy(false); }
  }, [params.token]);
  React.useEffect(() => { void load(); }, [load]);

  const download = async (format: "pptx" | "xlsx") => {
    setBusy(true);
    try {
      const r = await fetch(`/api/share/${params.token}`, { method: "POST", headers: { "content-type": "application/json", ...(password ? { "x-share-password": password } : {}) }, body: JSON.stringify({ format }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); alert(j.error ?? "Download not permitted."); return; }
      downloadBlob(await r.blob(), /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? `report.${format}`);
    } finally { setBusy(false); }
  };

  if (gate) {
    return (
      <div className="ax-share-page"><div className="ax-share-gate" data-testid="ax-share-gate" data-status={gate.status}>
        <div className="logo-mark" style={{ margin: "0 auto 10px" }}>R</div>
        {gate.reportName && <h2>{gate.reportName}</h2>}
        {gate.status === "password" ? (
          <form onSubmit={(e) => { e.preventDefault(); void load(password); }}>
            <p>{gate.message}</p>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoFocus data-testid="ax-share-password" />
            <button className="btn primary" disabled={busy} style={{ marginTop: 8 }}>Open report</button>
          </form>
        ) : gate.status === "sign_in" ? (
          <><p>{gate.message}</p><a className="btn primary" href={`/login?next=${encodeURIComponent(`/share/${params.token}`)}`}>Sign in</a></>
        ) : <p>{gate.message}</p>}
      </div></div>
    );
  }
  if (!data) return <div className="ax-share-page"><div className="muted" style={{ padding: 40, textAlign: "center" }}>Loading report…</div></div>;
  const rep = data.report;
  return (
    <div className="ax-share-page" data-testid="ax-share-view">
      <ReportView title={rep.title} subtitle={rep.subtitle} blocks={rep.widgets ? undefined : rep.blocks} widgets={rep.widgets ?? undefined} crossFilter={!!rep.crossFilter} results={data.results} theme={data.theme} mode="snapshot" version={data.version} publishedAt={data.publishedAt} branding={rep.branding} viewerSegments={rep.viewerSegments}
        toolbar={<>
          {data.dataset?.responses != null && <span className="muted" style={{ fontSize: 13 }}>{data.dataset.responses} responses</span>}
          {data.permission === "download" && <><button className="btn small" disabled={busy} onClick={() => download("pptx")} data-testid="ax-share-ppt">Download PPT</button><button className="btn small" disabled={busy} onClick={() => download("xlsx")} data-testid="ax-share-xlsx">Download Excel</button></>}
        </>} />
      <div className="ax-share-foot muted">Read-only view of a published report snapshot · Powered by Rescript Analytics</div>
    </div>
  );
}
