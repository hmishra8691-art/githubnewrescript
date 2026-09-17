"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { stripHtmlText } from "@rescript/engine";
import {
  ASSET_ACCEPT, FAMILY_ICON, FAMILY_LABEL, deleteAsset, fetchAssetUsage, fetchAssets, formatBytes, patchAsset, uploadAsset,
  type AssetSummary, type UploadProgress,
} from "@/lib/assets";
import { AssetThumb } from "./AssetPicker";
import { useStudio } from "./store";

/**
 * ASSETS — the survey's media library, in the Studio.
 *
 * Every image, logo, video, audio clip and document the survey uses, as
 * rows in `media_objects` of kind `survey_asset`, stored in Cloudflare R2
 * through the same browser-direct uploader the interview recorder uses.
 * Upload (with a real progress bar), preview, rename, describe (alt text),
 * share with the customer's other surveys, replace, copy the URL, delete.
 *
 * Two promises the brief makes are kept here:
 *
 *   "avoid duplication" — a file is hashed before upload and an identical
 *   one already in the library is reused (`uploadAsset`).
 *
 *   "deletion does not silently break the survey" — before a delete, the
 *   server is asked where the asset is used (every survey of the customer,
 *   draft and published) and this survey's own definition is searched
 *   place by place. The researcher sees the list and chooses: remove the
 *   references here and delete, delete anyway, or keep it.
 */

type Family = AssetSummary["family"] | "all";

export function AssetsPanel() {
  const s = useStudio();
  const canUse = s.surveyDbId && s.surveyDbId !== "sandbox";
  const [assets, setAssets] = React.useState<AssetSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [family, setFamily] = React.useState<Family>("all");
  const [view, setView] = React.useState<"grid" | "list">("grid");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<{ file: string; p: UploadProgress } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  const load = React.useCallback(async () => {
    if (!canUse) { setAssets([]); return; }
    setError(null);
    try { setAssets(await fetchAssets(s.surveyDbId)); } catch (e) { setError((e as Error).message); setAssets([]); }
  }, [s.surveyDbId, canUse]);
  React.useEffect(() => { void load(); }, [load]);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setError(null);
    let reused = 0;
    for (const f of list) {
      const out = await uploadAsset(s.surveyDbId, f, { onProgress: (p) => setProgress({ file: f.name, p }) });
      if (!out.ok) { setError(`${f.name}: ${out.error}`); break; }
      if (out.duplicate) reused++;
    }
    setProgress(null);
    if (fileRef.current) fileRef.current.value = "";
    if (reused) setNotice(`${reused === 1 ? "One file was" : `${reused} files were`} already in the library — reused, not stored again.`);
    await load();
  };

  const visible = (assets ?? []).filter((a) => {
    if (family !== "all" && a.family !== family) return false;
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      if (!a.name.toLowerCase().includes(t) && !(a.fileName ?? "").toLowerCase().includes(t) && !(a.altText ?? "").toLowerCase().includes(t)) return false;
    }
    return true;
  });
  const usageHere = React.useMemo(() => usageIndex(s.def), [s.def]);
  const open = openId ? (assets ?? []).find((a) => a.id === openId) ?? null : null;
  const totalBytes = (assets ?? []).reduce((n, a) => n + (a.bytes ?? 0), 0);

  return (
    <div data-testid="assets-panel" className="assets"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (canUse) void upload(e.dataTransfer.files); }}>
      <div className="row" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Assets</h2>
        <span className="muted" style={{ fontSize: 12.5 }}>{assets?.length ?? 0} asset{assets?.length === 1 ? "" : "s"}{totalBytes ? ` · ${formatBytes(totalBytes)}` : ""} · stored in Cloudflare R2</span>
        <span className="grow" />
        <input ref={fileRef} type="file" multiple accept={ASSET_ACCEPT} style={{ display: "none" }} data-testid="assets-file"
          onChange={(e) => { if (e.target.files) void upload(e.target.files); }} />
        <button type="button" className="btn primary" disabled={!canUse || !!progress || s.readOnly} data-testid="assets-upload" onClick={() => fileRef.current?.click()}>
          {progress ? progress.p.label : "⬆ Upload"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 10px" }}>
        Images, logos, video, audio, PDF and Office documents — up to 25 MB for pictures, 50 MB for audio and documents, 200 MB for video.
        Upload once, then <strong>Choose</strong> it wherever media goes: question media, option images, the branding logo, or inside any text with the editor's 🖼 button.
        Drop files anywhere on this page.
      </p>
      {progress && (
        <div className="asset-progress" data-testid="assets-progress" title={progress.file}><div style={{ width: `${Math.round(progress.p.fraction * 100)}%` }} /></div>
      )}
      {!canUse && <div className="chip warn">Save the survey first — the library belongs to a saved survey.</div>}
      {error && <div className="chip warn" data-testid="assets-error">⚠ {error}</div>}
      {notice && <div className="chip" data-testid="assets-notice" onClick={() => setNotice(null)} style={{ cursor: "pointer" }}>{notice} ×</div>}

      <div className="row" style={{ gap: 6, margin: "10px 0", flexWrap: "wrap", alignItems: "center" }}>
        <input className="input" style={{ width: 240 }} placeholder="search by name, file or alt text…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="assets-search" />
        {(["all", "image", "video", "audio", "document"] as const).map((f) => (
          <button key={f} type="button" className={`chip ${family === f ? "on" : ""}`} style={{ cursor: "pointer" }} onClick={() => setFamily(f)} data-testid={`assets-family-${f}`}>
            {f === "all" ? "all" : FAMILY_LABEL[f]} {f === "all" ? assets?.length ?? 0 : (assets ?? []).filter((a) => a.family === f).length}
          </button>
        ))}
        <span className="grow" />
        <button type="button" className={`btn small ${view === "grid" ? "primary" : ""}`} onClick={() => setView("grid")} title="Grid">▦</button>
        <button type="button" className={`btn small ${view === "list" ? "primary" : ""}`} onClick={() => setView("list")} title="List">☰</button>
      </div>

      {assets === null ? <p className="muted">Loading the library…</p> : visible.length === 0 ? (
        <div className={`asset-empty ${dragging ? "dragging" : ""}`} data-testid="assets-empty">
          {assets.length === 0 ? "Nothing here yet. Upload a file, or drop one on this page." : "No asset matches."}
        </div>
      ) : view === "grid" ? (
        <div className={`asset-grid ${dragging ? "dragging" : ""}`} data-testid="assets-grid">
          {visible.map((a) => {
            const used = usageHere.get(a.id);
            return (
              <button key={a.id} type="button" className={`asset-tile ${openId === a.id ? "on" : ""}`} onClick={() => setOpenId(a.id)} data-testid="asset-tile" data-family={a.family} title={a.name}>
                <AssetThumb asset={a} size={110} />
                <span className="asset-name">{a.name}</span>
                <span className="asset-meta">{FAMILY_LABEL[a.family]}{a.bytes ? ` · ${formatBytes(a.bytes)}` : ""}{a.width && a.height ? ` · ${a.width}×${a.height}` : ""}</span>
                <span className="asset-meta">{a.shared ? "shared · " : ""}{used?.length ? `used in ${used.length} place${used.length === 1 ? "" : "s"}` : "not used here"}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="grid" data-testid="assets-table">
            <thead><tr><th></th><th>Name</th><th>Type</th><th>Size</th><th>Dimensions</th><th>Uploaded</th><th>Used here</th><th>Shared</th></tr></thead>
            <tbody>
              {visible.map((a) => {
                const used = usageHere.get(a.id);
                return (
                  <tr key={a.id} style={{ cursor: "pointer" }} onClick={() => setOpenId(a.id)} data-testid="asset-row">
                    <td><AssetThumb asset={a} size={32} /></td>
                    <td><strong>{a.name}</strong>{a.fileName && a.fileName !== a.name ? <div className="muted" style={{ fontSize: 12 }}>{a.fileName}</div> : null}</td>
                    <td>{FAMILY_ICON[a.family]} {FAMILY_LABEL[a.family]}</td>
                    <td>{formatBytes(a.bytes)}</td>
                    <td>{a.width && a.height ? `${a.width}×${a.height}` : a.durationSeconds ? `${Math.round(a.durationSeconds)} s` : ""}</td>
                    <td>{new Date(a.createdAt).toLocaleDateString()}</td>
                    <td>{used?.length ? `${used.length} place${used.length === 1 ? "" : "s"}` : <span className="muted">—</span>}</td>
                    <td>{a.shared ? "yes" : ""}{a.fromOtherSurvey ? <span className="muted"> (from another survey)</span> : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open && <AssetDrawer asset={open} usedHere={usageHere.get(open.id) ?? []} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

/* ================================================================ one asset */

function AssetDrawer({ asset, usedHere, onClose, onChanged }: { asset: AssetSummary; usedHere: string[]; onClose(): void; onChanged(): Promise<void> }) {
  const s = useStudio();
  const [name, setName] = React.useState(asset.name);
  const [alt, setAlt] = React.useState(asset.altText ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [usage, setUsage] = React.useState<{ surveyId: string; code: string; title: string; inDraft: boolean; inLive: boolean }[] | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const replaceRef = React.useRef<HTMLInputElement | null>(null);
  const owned = !asset.fromOtherSurvey && !s.readOnly;

  React.useEffect(() => { setName(asset.name); setAlt(asset.altText ?? ""); setConfirmDelete(false); setError(null); }, [asset.id, asset.name, asset.altText]);
  React.useEffect(() => {
    let live = true;
    fetchAssetUsage(s.surveyDbId, asset.id).then((r) => { if (live) setUsage(r.usage); }).catch(() => { if (live) setUsage([]); });
    return () => { live = false; };
  }, [s.surveyDbId, asset.id]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async (patch: { displayName?: string | null; altText?: string | null; shared?: boolean }) => {
    setBusy(true); setError(null);
    try { await patchAsset(s.surveyDbId, asset.id, patch); await onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const copyUrl = async () => {
    try { await navigator.clipboard.writeText(asset.url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setError("Could not copy — select the URL and copy it."); }
  };
  const replace = async (file: File) => {
    setBusy(true); setError(null);
    try {
      const out = await uploadAsset(s.surveyDbId, file, { displayName: asset.name, altText: asset.altText ?? undefined });
      if (!out.ok) { setError(out.error); return; }
      if (out.asset.id === asset.id) { setError("That is the same file."); return; }
      /* every place in THIS survey that pointed at the old asset now points at the new one */
      s.labelNextEdit?.(`replace asset ${asset.name}`);
      s.update((d) => { rewriteAssetUrls(d, asset.id, out.asset.url); });
      const others = (usage ?? []).filter((u) => u.surveyId !== s.surveyDbId);
      const del = await deleteAsset(s.surveyDbId, asset.id, true);
      if (!del.ok) setError(`Replaced here, but the old file could not be removed: ${del.error}`);
      else if (others.length) setError(`Replaced here. ${others.length === 1 ? "One other survey" : `${others.length} other surveys`} still referenced the old file — those references now show a missing image.`);
      await onChanged();
      if (del.ok && !others.length) onClose();
    } finally { setBusy(false); if (replaceRef.current) replaceRef.current.value = ""; }
  };
  const remove = async (mode: "clean" | "force") => {
    setBusy(true); setError(null);
    try {
      if (mode === "clean" && usedHere.length) {
        s.labelNextEdit?.(`remove asset ${asset.name} from the survey`);
        s.update((d) => { stripAssetReferences(d, asset.id); });
        await s.flushDraft?.();
      }
      const out = await deleteAsset(s.surveyDbId, asset.id, true);
      if (!out.ok) { setError(out.error); return; }
      await onChanged();
      onClose();
    } finally { setBusy(false); }
  };

  const elsewhere = (usage ?? []).filter((u) => u.surveyId !== s.surveyDbId);
  const liveHere = (usage ?? []).some((u) => u.surveyId === s.surveyDbId && u.inLive);
  const inUse = usedHere.length > 0 || elsewhere.length > 0 || liveHere;

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" data-testid="asset-drawer" style={{ width: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: "center", gap: 10 }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>{FAMILY_ICON[asset.family]} {asset.name}</h2>
          <span className="chip">{FAMILY_LABEL[asset.family]}</span>
          {asset.shared && <span className="chip on">shared</span>}
          {asset.fromOtherSurvey && <span className="chip warn">from another survey — read-only here</span>}
          <span className="grow" />
          <button type="button" className="btn small" onClick={onClose}>close</button>
        </div>

        <div className="row" style={{ gap: 16, marginTop: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div className="asset-preview" data-testid="asset-preview">
            <AssetPreview asset={asset} />
          </div>
          <div className="grow" style={{ minWidth: 280 }}>
            <label className="f"><span>Name</span>
              <input className="input" data-testid="asset-name" value={name} disabled={!owned} onChange={(e) => setName(e.target.value)}
                onBlur={() => { if (owned && name.trim() && name.trim() !== asset.name) void save({ displayName: name.trim() }); }} /></label>
            {asset.family === "image" && (
              <label className="f"><span>Alt text <span className="muted">(what a screen reader says; inherited when inserted)</span></span>
                <input className="input" data-testid="asset-alt" value={alt} disabled={!owned} onChange={(e) => setAlt(e.target.value)}
                  onBlur={() => { if (owned && alt.trim() !== (asset.altText ?? "")) void save({ altText: alt.trim() || null }); }} /></label>
            )}
            <label className="f"><span>URL <span className="muted">(stable — paste it anywhere media goes)</span></span>
              <div className="row" style={{ gap: 6 }}>
                <input className="input mono grow" readOnly value={asset.url} data-testid="asset-url" onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn small" onClick={copyUrl} data-testid="asset-copy">{copied ? "Copied" : "Copy"}</button>
                <a className="btn small" href={`${asset.url}?download=1`} target="_blank" rel="noreferrer">Download</a>
              </div></label>
            <table className="grid" style={{ marginTop: 6 }}><tbody>
              <tr><td>File</td><td>{asset.fileName ?? "—"}</td></tr>
              <tr><td>Type</td><td>{asset.mimeType ?? "—"}</td></tr>
              <tr><td>Size</td><td>{formatBytes(asset.bytes) || "—"}{asset.width && asset.height ? ` · ${asset.width}×${asset.height} px` : ""}{asset.durationSeconds ? ` · ${Math.round(asset.durationSeconds)} s` : ""}</td></tr>
              <tr><td>Uploaded</td><td>{new Date(asset.createdAt).toLocaleString()}</td></tr>
              <tr><td>Belongs to</td><td>{asset.fromOtherSurvey ? "another survey of your account (shared)" : "this survey"}</td></tr>
            </tbody></table>
            {owned && (
              <label className="row" style={{ gap: 6, marginTop: 8, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" data-testid="asset-shared" checked={asset.shared} disabled={busy} onChange={(e) => void save({ shared: e.target.checked })} />
                Share with every survey in this account <span className="muted">— appears in their Choose asset pickers; stays owned here</span>
              </label>
            )}
          </div>
        </div>

        <h3 className="sec" style={{ marginTop: 12 }}>Where it is used</h3>
        <div data-testid="asset-usage" style={{ fontSize: 13 }}>
          {usedHere.length ? (
            <div>In this survey: {usedHere.map((u) => <span key={u} className="chip" style={{ marginRight: 4 }}>{u}</span>)}</div>
          ) : <div className="muted">Not used in this survey{liveHere ? " — but the published version still shows it" : ""}.</div>}
          {usage === null ? <div className="muted">Checking other surveys…</div> : elsewhere.length ? (
            <div style={{ marginTop: 4 }}>In other surveys: {elsewhere.map((u) => <span key={u.surveyId} className="chip warn" style={{ marginRight: 4 }} title={u.title}>{u.code}{u.inLive ? " (live)" : ""}</span>)}</div>
          ) : null}
        </div>

        {error && <div className="chip warn" style={{ marginTop: 8 }} data-testid="asset-error">⚠ {error}</div>}

        {owned && (
          <div className="row" style={{ gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <input ref={replaceRef} type="file" accept={ASSET_ACCEPT} style={{ display: "none" }} data-testid="asset-replace-file"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void replace(f); }} />
            <button type="button" className="btn small" disabled={busy} data-testid="asset-replace" onClick={() => replaceRef.current?.click()}
              title="Upload a new file and point every place in this survey at it">↻ Replace file…</button>
            <span className="grow" />
            {!confirmDelete ? (
              <button type="button" className="btn small danger" disabled={busy} data-testid="asset-delete" onClick={() => { if (inUse) setConfirmDelete(true); else void remove("force"); }}>Delete</button>
            ) : (
              <div className="card" style={{ padding: 10, width: "100%" }} data-testid="asset-delete-confirm">
                <strong style={{ fontSize: 13 }}>This asset is in use.</strong>
                <p className="muted" style={{ fontSize: 12.5, margin: "4px 0 8px" }}>
                  {usedHere.length ? `It appears in ${usedHere.length} place${usedHere.length === 1 ? "" : "s"} in this survey. ` : ""}
                  {liveHere ? "The published version of this survey still shows it. " : ""}
                  {elsewhere.length ? `${elsewhere.length === 1 ? "Another survey" : `${elsewhere.length} other surveys`} reference it — those will show a missing file once it is gone. ` : ""}
                  Deleting it without removing the references leaves a broken picture where it was.
                </p>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {usedHere.length > 0 && <button type="button" className="btn small primary" disabled={busy} data-testid="asset-delete-clean" onClick={() => void remove("clean")}>Remove it from this survey, then delete</button>}
                  <button type="button" className="btn small danger" disabled={busy} data-testid="asset-delete-force" onClick={() => void remove("force")}>Delete anyway</button>
                  <button type="button" className="btn small" onClick={() => setConfirmDelete(false)}>Keep it</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AssetPreview({ asset }: { asset: AssetSummary }) {
  if (asset.family === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={asset.url} alt={asset.altText ?? asset.name} style={{ maxWidth: 300, maxHeight: 240, borderRadius: 8, border: "1px solid var(--border)" }} />;
  }
  if (asset.family === "video") return <video src={asset.url} controls preload="metadata" style={{ maxWidth: 300, maxHeight: 240, borderRadius: 8 }} />;
  if (asset.family === "audio") return <audio src={asset.url} controls preload="metadata" style={{ width: 300 }} />;
  return <div className="asset-thumb asset-thumb-icon" style={{ width: 160, height: 160 }}>{FAMILY_ICON.document}</div>;
}

/* ================================================================ usage in the definition */

const MEDIA_ID_IN_URL = /\/api\/media\/([0-9a-f-]{36})/gi;

/**
 * Every place in THIS definition that carries an asset id, by asset:
 * "Q3 (option 2)", "Q7 media", "Branding logo", "Block “Intro” media".
 * Read from the JSON, so a URL in a place this list has never heard of still
 * counts — the label is just less specific.
 */
export function usageIndex(def: SurveyDefinition): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (id: string, where: string) => {
    const list = out.get(id) ?? [];
    if (!list.includes(where)) list.push(where);
    out.set(id, list);
  };
  const scan = (value: unknown, where: string) => {
    if (typeof value !== "string") return;
    for (const m of value.matchAll(MEDIA_ID_IN_URL)) add(m[1].toLowerCase(), where);
  };
  for (const q of def.questions) {
    scan(q.text, `${q.code} text`); scan(q.instruction, `${q.code} instruction`); scan(q.customHtml, `${q.code} HTML`);
    scan(q.settings.mediaUrl, `${q.code} media`); scan(q.settings.imageUrl, `${q.code} image`); scan(q.settings.mediaDisplay?.poster, `${q.code} poster`);
    q.options.forEach((o, i) => { scan(o.label, `${q.code} option ${o.code}`); scan(o.imageUrl, `${q.code} option ${o.code} image`); void i; });
    q.rows.forEach((r) => scan(r.label, `${q.code} row ${r.code}`));
    q.columns.forEach((c) => scan(c.label, `${q.code} column ${stripHtmlText(c.label).slice(0, 20) || c.id}`));
    /* anything else on the question — variant settings, meta */
    const rest = JSON.stringify({ ...q, text: "", instruction: "", customHtml: "", options: [], rows: [], columns: [], settings: { ...q.settings, mediaUrl: "", imageUrl: "", mediaDisplay: undefined } });
    for (const m of rest.matchAll(MEDIA_ID_IN_URL)) add(m[1].toLowerCase(), `${q.code} settings`);
  }
  scan(def.branding?.logoUrl, "Branding logo"); scan(def.branding?.headerHtml, "Branding header"); scan((def.branding as { customCss?: string } | undefined)?.customCss, "Branding CSS");
  const walk = (nodes: unknown[]) => {
    for (const n of nodes as Record<string, unknown>[]) {
      if (!n || typeof n !== "object") continue;
      if (typeof n.mediaUrl === "string") scan(n.mediaUrl, `Block “${(n.title as string) ?? n.id}” media`);
      for (const k of ["text", "html", "message", "body"]) if (typeof n[k] === "string") scan(n[k], `${String(n.type)} “${(n.title as string) ?? n.id}”`);
      if (Array.isArray(n.children)) walk(n.children);
      if (Array.isArray(n.branches)) for (const b of n.branches as Record<string, unknown>[]) if (Array.isArray(b.children)) walk(b.children);
      if (Array.isArray(n.otherwise)) walk(n.otherwise);
    }
  };
  walk(def.flow);
  return out;
}

/** Point every reference to `oldId` at `newUrl` — the whole definition, in place. */
export function rewriteAssetUrls(def: SurveyDefinition, oldId: string, newUrl: string): void {
  const re = new RegExp(`/api/media/${oldId}(?:/[^"'\\s)<>?#]*)?`, "i");
  const next = JSON.parse(JSON.stringify(def).replace(/\/api\/media\/[0-9a-f-]{36}(?:\/[^"\\\s)<>?#]*)?/gi, (m) => (re.test(m) ? newUrl : m))) as SurveyDefinition;
  Object.assign(def, next);
}

/**
 * Remove every reference to an asset: a field that IS its URL is cleared, a
 * picture or player inside HTML is removed whole, and anything else that
 * mentions the id has the URL blanked. In place.
 */
export function stripAssetReferences(def: SurveyDefinition, id: string): void {
  const url = new RegExp(`/api/media/${id}(?:/[^"'\\s)<>?#]*)?`, "i");
  const tag = new RegExp(`<(img|video|audio|source)\\b[^>]*/api/media/${id}[^>]*>(?:\\s*</\\1>)?`, "gi");
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === "string") {
          if (!url.test(v)) continue;
          if (v.trim().startsWith("/api/media/")) { delete obj[k]; continue; }
          let cleaned = v.replace(tag, "");
          cleaned = cleaned.replace(new RegExp(url.source, "gi"), "");
          obj[k] = cleaned;
        } else obj[k] = walk(v);
      }
      return obj;
    }
    return node;
  };
  walk(def);
}
