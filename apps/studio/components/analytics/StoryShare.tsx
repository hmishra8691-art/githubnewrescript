"use client";
import * as React from "react";
import { ApiError, type StoryApi, type StoryPayload } from "./storyApi";

/**
 * SHARE THE STORY (Phase 4). Publishing freezes this version of the story —
 * its scenes, figures and sources — as the one interactive page a link opens;
 * a link then reaches that version and nothing live. The checks that stop a
 * story from publishing name the scene, so they can be fixed where they are.
 */
export function StoryShare({ api, id, payload, dirty, onChange }: { api: StoryApi; id: string; payload: StoryPayload; dirty: boolean; onChange: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [problems, setProblems] = React.useState<{ message: string; sceneId?: string }[]>([]);
  const [warnings, setWarnings] = React.useState<{ message: string }[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [access, setAccess] = React.useState<"link" | "users">("link");
  const [download, setDownload] = React.useState(false);
  const [emails, setEmails] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [link, setLink] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const published = payload.published as { reportId: string; version: number; storyVersion: number; at: string } | null;
  const current = !!published && published.storyVersion === payload.story.version;
  const newer = payload.newerData as { since: string; responses: number } | null;

  const publish = async () => {
    setBusy(true); setError(null); setProblems([]); setLink(null);
    try { const r = await api.publish(id); setWarnings(r.warnings ?? []); onChange(); }
    catch (e) { const x = e as ApiError; const d = x.details as { problems?: { message: string; sceneId?: string }[] } | undefined; if (d?.problems?.length) setProblems(d.problems); setError(x.message); }
    finally { setBusy(false); }
  };
  const makeLink = async () => {
    if (!published) return;
    setBusy(true); setError(null);
    try {
      const r = await api.shareLink(published.reportId, { access, permission: download ? "download" : "viewer", ...(access === "users" ? { emails: emails.split(/[,\s]+/).filter(Boolean) } : {}), ...(password ? { password } : {}), pinVersion: true });
      setLink(`${window.location.origin}/share/${r.token}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="st-panel" data-testid="st-share">
      <p className="muted" style={{ marginTop: 0 }}>One link opens this story as an interactive page: every scene with its evidence, “How was this calculated?”, key points or everything, and print or present. It shows the figures frozen in this version — nothing updates behind a link.</p>
      {newer && <div className="ax-warn" role="status" data-testid="st-newer-data">{newer.responses} {newer.responses === 1 ? "response has" : "responses have"} arrived since this story’s data was frozen ({newer.since.slice(0, 10)}). A link shows the frozen figures; create a new version from a fresh run to include them.</div>}
      {dirty && <div className="ax-warn" role="status">You have unsaved edits. Save them before publishing — a published version is what was saved.</div>}
      <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn primary small" disabled={busy || dirty} onClick={publish} data-testid="st-publish">{published ? (current ? "Publish again" : `Publish version ${payload.story.version}`) : "Publish this version"}</button>
        <a className="btn small" href={api.pageUrl(id, true)} target="_blank" rel="noreferrer" data-testid="st-preview-page">Preview the page</a>
        <a className="btn small" href={api.pageUrl(id, false)} data-testid="st-download-page" title="One file with everything inside it: attach it to an email or open it offline.">Download as a file</a>
      </div>
      {published && <p className="small" data-testid="st-published">{current ? "Published" : "Last published"}: story version {published.storyVersion} as share version {published.version}, {published.at.slice(0, 10)}.{!current ? ` The current version is ${payload.story.version}; links point at the published one until you publish again.` : ""}</p>}
      {error && <div className="ax-error" role="alert" data-testid="st-share-error">{error}</div>}
      {problems.length > 0 && <ul className="small" data-testid="st-share-problems">{problems.map((p, i) => <li key={i}>{p.message}</li>)}</ul>}
      {warnings.length > 0 && <ul className="small muted" data-testid="st-share-warnings">{warnings.map((w, i) => <li key={i}>{w.message}</li>)}</ul>}
      {published && (
        <fieldset style={{ border: "1px solid var(--line, #ddd)", borderRadius: 8, padding: 10, marginTop: 12 }}>
          <legend>Create a link to version {published.version}</legend>
          <label className="ax-field"><span>Who can open it</span>
            <select className="select small" value={access} onChange={(e) => setAccess(e.target.value as "link" | "users")} data-testid="st-share-access"><option value="link">Anyone with the link</option><option value="users">Only these people (they sign in)</option></select></label>
          {access === "users" && <label className="ax-field"><span>Email addresses</span><input className="input small" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="name@company.com, …" data-testid="st-share-emails" /></label>}
          <label className="ax-field"><span>Password (optional)</span><input className="input small" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
          <label className="ax-toggle"><input type="checkbox" checked={download} onChange={(e) => setDownload(e.target.checked)} /> Let them download the PowerPoint</label>
          <div><button className="btn small primary" disabled={busy || (access === "users" && !emails.trim())} onClick={makeLink} data-testid="st-share-create">Create link</button></div>
          {link && <div className="row" style={{ gap: 8, marginTop: 8 }}><input className="input small" readOnly value={link} onFocus={(e) => e.currentTarget.select()} data-testid="st-share-link" style={{ flex: 1 }} /><button className="btn small" onClick={() => { void navigator.clipboard?.writeText(link).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy"}</button></div>}
        </fieldset>
      )}
    </div>
  );
}
