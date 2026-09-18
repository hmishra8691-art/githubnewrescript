"use client";
import React from "react";
import { Loading } from "@/components/ui/Loading";
import { resolveMediaUrl } from "@rescript/engine";
import {
  ASSET_ACCEPT, FAMILY_ICON, FAMILY_LABEL, fetchAssets, formatBytes, uploadAsset,
  type AssetSummary, type UploadProgress,
} from "@/lib/assets";
import { useStudio } from "./store";

/**
 * "CHOOSE ASSET" — the one picker every media slot opens.
 *
 * A question's stimulus, an option's image, the branding logo, a block's
 * media, a picture inserted into rich text: each has a "Choose" button that
 * opens this. Search, filter by type, preview, pick — or drop a new file on
 * it and pick that, without leaving the field being edited. The library it
 * shows is the survey's own assets plus the customer's shared ones, from
 * `GET /api/surveys/:id/media`.
 *
 * `accept` narrows what is offered (an option image wants pictures, a video
 * question wants video); everything else is still listed, greyed, so the
 * researcher can see what is there.
 */
export function AssetPicker({ open, onClose, onPick, accept, title }: {
  open: boolean;
  onClose(): void;
  onPick(asset: AssetSummary): void;
  /** families this slot takes; undefined = any */
  accept?: AssetSummary["family"][];
  title?: string;
}) {
  const s = useStudio();
  const [assets, setAssets] = React.useState<AssetSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  const [family, setFamily] = React.useState<AssetSummary["family"] | "all">(accept?.length === 1 ? accept[0] : "all");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<UploadProgress | null>(null);
  const [dragging, setDragging] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const canUse = s.surveyDbId && s.surveyDbId !== "sandbox";

  const load = React.useCallback(async () => {
    if (!canUse) { setAssets([]); return; }
    setError(null);
    try { setAssets(await fetchAssets(s.surveyDbId)); } catch (e) { setError((e as Error).message); setAssets([]); }
  }, [s.surveyDbId, canUse]);
  React.useEffect(() => { if (open) void load(); }, [open, load]);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setError(null);
    let last: AssetSummary | null = null;
    for (const f of list) {
      const out = await uploadAsset(s.surveyDbId, f, { onProgress: setProgress });
      if (!out.ok) { setError(out.error); break; }
      last = out.asset;
    }
    setProgress(null);
    await load();
    if (last) setSelected(last.id);
    if (fileRef.current) fileRef.current.value = "";
  };

  if (!open) return null;
  const visible = (assets ?? []).filter((a) => {
    if (family !== "all" && a.family !== family) return false;
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      if (!a.name.toLowerCase().includes(t) && !(a.fileName ?? "").toLowerCase().includes(t) && !(a.altText ?? "").toLowerCase().includes(t)) return false;
    }
    return true;
  });
  const takes = (a: AssetSummary) => !accept || accept.includes(a.family);
  const current = visible.find((a) => a.id === selected) ?? (assets ?? []).find((a) => a.id === selected) ?? null;

  return (
    <div className="modal-back" onClick={onClose} data-testid="asset-picker">
      <div className="modal asset-picker" role="dialog" aria-modal="true" aria-label={title ?? "Choose an asset"} onClick={(e) => e.stopPropagation()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void upload(e.dataTransfer.files); }}>
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>{title ?? "Choose an asset"}</h2>
          <span className="grow" />
          <input ref={fileRef} type="file" multiple accept={ASSET_ACCEPT} style={{ display: "none" }} data-testid="asset-picker-file"
            onChange={(e) => { if (e.target.files) void upload(e.target.files); }} />
          <button type="button" className="btn small primary" disabled={!canUse || !!progress} onClick={() => fileRef.current?.click()} data-testid="asset-picker-upload">
            {progress ? progress.label : "⬆ Upload new"}
          </button>
          <button type="button" className="btn small" onClick={onClose}>close</button>
        </div>
        {progress && <div className="asset-progress"><div style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>}
        <div className="row" style={{ gap: 6, margin: "8px 0", flexWrap: "wrap" }}>
          <input className="input" style={{ width: 220 }} placeholder="search by name…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="asset-picker-search" autoFocus />
          {(["all", "image", "video", "audio", "document"] as const).map((f) => (
            <button key={f} type="button" className={`chip ${family === f ? "on" : ""}`} style={{ cursor: "pointer" }} onClick={() => setFamily(f)} data-testid={`asset-picker-family-${f}`}>
              {f === "all" ? "all types" : FAMILY_LABEL[f]}
            </button>
          ))}
          <span className="grow" />
          <span className="muted" style={{ fontSize: 12.5 }}>{visible.length} of {assets?.length ?? 0}</span>
        </div>
        {!canUse && <p className="muted" style={{ fontSize: 13 }}>Save the survey first — the library belongs to a saved survey.</p>}
        {error && <p style={{ color: "var(--danger, #b91c1c)", fontSize: 13 }}>⚠ {error}</p>}
        <div className={`asset-grid ${dragging ? "dragging" : ""}`} data-testid="asset-picker-grid">
          {assets === null && <Loading label="Loading assets…" rows={2} />}
          {assets !== null && visible.length === 0 && (
            <p className="muted" style={{ fontSize: 13, gridColumn: "1 / -1" }}>
              {assets.length === 0 ? "Nothing in the library yet — upload a file, or drop one here." : "No asset matches."}
            </p>
          )}
          {visible.map((a) => (
            <button key={a.id} type="button" className={`asset-tile ${selected === a.id ? "on" : ""} ${takes(a) ? "" : "dim"}`}
              title={takes(a) ? a.name : `${a.name} — this field takes ${accept?.map((f) => FAMILY_LABEL[f].toLowerCase()).join(" or ")}`}
              onClick={() => setSelected(a.id)} onDoubleClick={() => { if (takes(a)) { onPick(a); onClose(); } }} data-testid="asset-tile" data-family={a.family}>
              <AssetThumb asset={a} />
              <span className="asset-name">{a.name}</span>
              <span className="asset-meta">{FAMILY_LABEL[a.family]}{a.bytes ? ` · ${formatBytes(a.bytes)}` : ""}{a.shared ? " · shared" : ""}</span>
            </button>
          ))}
        </div>
        <div className="row" style={{ alignItems: "center", gap: 8, marginTop: 8 }}>
          {current ? (
            <span className="muted" style={{ fontSize: 12.5 }}>
              <strong>{current.name}</strong>{current.width && current.height ? ` · ${current.width}×${current.height}` : ""}{current.fileName ? ` · ${current.fileName}` : ""}{current.fromOtherSurvey ? " · shared from another survey" : ""}
            </span>
          ) : <span className="muted" style={{ fontSize: 12.5 }}>Select an asset, or double-click to use it.</span>}
          <span className="grow" />
          <button type="button" className="btn primary" disabled={!current || !takes(current)} data-testid="asset-picker-use"
            onClick={() => { if (current) { onPick(current); onClose(); } }}>Use this asset</button>
        </div>
      </div>
    </div>
  );
}

/** A small preview of an asset: the picture itself, a video frame, or an icon. */
export function AssetThumb({ asset, size = 96 }: { asset: AssetSummary; size?: number }) {
  const [broken, setBroken] = React.useState(false);
  const url = resolveMediaUrl(asset.url).url ?? asset.url;
  if (asset.family === "image" && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="asset-thumb" src={url} alt={asset.altText ?? asset.name} style={{ width: size, height: size }} loading="lazy" onError={() => setBroken(true)} />;
  }
  if (asset.family === "video" && !broken) {
    return <video className="asset-thumb" src={url} muted preload="metadata" style={{ width: size, height: size }} onError={() => setBroken(true)} />;
  }
  return <span className="asset-thumb asset-thumb-icon" style={{ width: size, height: size }} aria-hidden>{FAMILY_ICON[asset.family]}</span>;
}
