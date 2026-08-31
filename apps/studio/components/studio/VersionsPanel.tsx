"use client";
import React from "react";
import { SurveyDefinition } from "@rescript/schema";
import { useStudio } from "./store";

interface VersionRow { id: string; version: string; label: string | null; notes: string | null; created_at: string }
interface DeploymentRow { id: string; client_slug: string; study_slug: string; mode: string; version_id: string; active: boolean }

/** Version control (requirement §12) + deployment pinning (§21). */
export function VersionsPanel() {
  const s = useStudio();
  const [versions, setVersions] = React.useState<VersionRow[]>([]);
  const [deployments, setDeployments] = React.useState<DeploymentRow[]>([]);
  const [compareA, setCompareA] = React.useState<string>("");
  const [compareB, setCompareB] = React.useState<string>("");
  const [diff, setDiff] = React.useState<string | null>(null);
  const [deployVersion, setDeployVersion] = React.useState<string>("");
  const [clientSlug, setClientSlug] = React.useState(s.def.deployment.clientSlug);
  const [studySlug, setStudySlug] = React.useState(s.def.deployment.studySlug);
  const [mode, setMode] = React.useState<"test" | "live">("test");

  const load = React.useCallback(() => {
    fetch(`/api/surveys/${s.surveyDbId}/versions`).then((r) => r.json())
      .then((d) => setVersions(d.versions ?? []));
    fetch(`/api/surveys/${s.surveyDbId}`).then((r) => r.json())
      .then((d) => setDeployments(d.deployments ?? []));
  }, [s.surveyDbId]);
  React.useEffect(load, [load]);

  const restore = async (versionId: string) => {
    const r = await fetch(`/api/surveys/${s.surveyDbId}/versions/${versionId}`);
    const d = await r.json();
    if (!d.version) return s.toast("Could not load version", "err");
    const parsed = SurveyDefinition.safeParse(d.version.definition);
    if (!parsed.success) return s.toast("Stored version invalid", "err");
    s.replace(parsed.data);
    await fetch(`/api/surveys/${s.surveyDbId}/versions/${versionId}`, { method: "POST" });
    s.toast(`Loaded v${d.version.version} into the editor`);
    load();
  };

  const compare = async () => {
    if (!compareA || !compareB) return;
    const [ra, rb] = await Promise.all([
      fetch(`/api/surveys/${s.surveyDbId}/versions/${compareA}`).then((r) => r.json()),
      fetch(`/api/surveys/${s.surveyDbId}/versions/${compareB}`).then((r) => r.json()),
    ]);
    const a = JSON.stringify(ra.version?.definition ?? {}, null, 2).split("\n");
    const b = JSON.stringify(rb.version?.definition ?? {}, null, 2).split("\n");
    const setA = new Set(a);
    const setB = new Set(b);
    const out: string[] = [];
    for (const line of a) if (!setB.has(line)) out.push(`- ${line.trim()}`);
    for (const line of b) if (!setA.has(line)) out.push(`+ ${line.trim()}`);
    setDiff(out.slice(0, 400).join("\n") || "(definitions identical)");
  };

  const deploy = async () => {
    if (!deployVersion) return s.toast("Pick a version to deploy", "err");
    const r = await fetch(`/api/surveys/${s.surveyDbId}/deploy`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId: deployVersion, clientSlug, studySlug, mode }),
    });
    const d = await r.json();
    if (d.url) { s.toast(`Deployed → ${d.url}`); load(); }
    else s.toast(d.error ?? "deploy failed", "err");
  };

  const runtimeBase = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:3001";

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Versions &amp; Deployment</h2>
        <span className="grow" />
        <button className="btn small" onClick={load}>↻</button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Every save creates an immutable snapshot. A deployed URL is pinned to one version — editing
        later never touches a live survey until you redeploy.
      </p>

      <h3 className="sec">Version history</h3>
      <div className="table-wrap">
        <table className="grid">
          <thead><tr><th>Version</th><th>Label</th><th>Saved</th><th>Deployed to</th><th></th></tr></thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td><strong>v{v.version}</strong>{v.id === s.currentVersionId ? " ← current" : ""}</td>
                <td>{v.label ?? ""}</td>
                <td>{new Date(v.created_at).toLocaleString()}</td>
                <td>{deployments.filter((d) => d.version_id === v.id)
                  .map((d) => `${d.mode}:/${d.client_slug}/${d.study_slug}`).join(", ")}</td>
                <td>
                  <button className="btn small" onClick={() => restore(v.id)}>load / restore</button>{" "}
                  <a className="btn small" href={`/api/surveys/${s.surveyDbId}/export/xlsx?versionId=${v.id}`}>vars.xlsx</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="sec">Compare versions</h3>
      <div className="row">
        <select className="select" value={compareA} onChange={(e) => setCompareA(e.target.value)}>
          <option value="">version A…</option>
          {versions.map((v) => <option key={v.id} value={v.id}>v{v.version}</option>)}
        </select>
        <select className="select" value={compareB} onChange={(e) => setCompareB(e.target.value)}>
          <option value="">version B…</option>
          {versions.map((v) => <option key={v.id} value={v.id}>v{v.version}</option>)}
        </select>
        <button className="btn" onClick={compare}>Compare</button>
      </div>
      {diff && <pre className="logic-pre" style={{ marginTop: 8, maxHeight: 320, overflowY: "auto" }}>{diff}</pre>}

      <h3 className="sec">Deploy</h3>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <select className="select" value={deployVersion} onChange={(e) => setDeployVersion(e.target.value)}>
          <option value="">pick version…</option>
          {versions.map((v) => <option key={v.id} value={v.id}>v{v.version}</option>)}
        </select>
        <input className="input mono" style={{ width: 140 }} value={clientSlug}
          onChange={(e) => setClientSlug(e.target.value)} placeholder="client-slug" />
        <span className="muted">/</span>
        <input className="input mono" style={{ width: 140 }} value={studySlug}
          onChange={(e) => setStudySlug(e.target.value)} placeholder="study-001" />
        <select className="select" value={mode} onChange={(e) => setMode(e.target.value as any)}>
          <option value="test">test</option><option value="live">live</option>
        </select>
        <button className="btn primary" onClick={deploy}>Deploy</button>
      </div>

      <h3 className="sec">Active deployments</h3>
      {deployments.length === 0 && <p className="muted">None yet.</p>}
      {deployments.map((d) => {
        const url = `${runtimeBase}/${d.mode === "test" ? "t" : "s"}/${d.client_slug}/${d.study_slug}`;
        return (
          <div key={d.id} className="card" style={{ padding: 10 }}>
            <div className="row">
              <span className={`chip ${d.mode === "live" ? "on" : "warn"}`}>{d.mode}</span>
              <a href={url} target="_blank" className="mono">{url}</a>
              <span className="muted mono" style={{ fontSize: 11 }}>
                v{versions.find((v) => v.id === d.version_id)?.version ?? "?"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
