"use client";
import React from "react";
import type { MediaDisplay } from "@rescript/schema";
import { mediaHtml, mediaDisplayFromCss, resolveMediaUrl, expandMediaEmbeds, sanitizeHtml, type InsertableMediaKind } from "@rescript/engine";
import { AssetPicker } from "./AssetPicker";
import { MediaDisplayControls } from "./MediaDisplayControls";
import { useStudio, uid } from "./store";
import { ASSET_ACCEPT, importDriveAsset, uploadAsset, type AssetSummary, type UploadProgress } from "@/lib/assets";

/**
 * INSERT (OR EDIT) PICTURES, VIDEOS, AUDIO AND PLAYERS IN RICH TEXT.
 *
 * Opened from the editor's "Insert media" button, and again when an
 * already-inserted picture is clicked: the dialog reads the element's URL,
 * alt text and `style` back into the controls (`mediaDisplayFromCss`), so
 * "make the logo smaller" is a number changed, not HTML edited. It produces
 * the markup through the engine's `mediaHtml` — the same object the
 * renderer sizes a question's stimulus with — so the picture looks the same
 * in the builder, the preview and the live survey.
 *
 * ONE PLACE FOR A QUESTION'S MEDIA (1-10-26 review). The separate "Media shown
 * under the question text" field is gone; everything it did is here, for the
 * question text (`placement`):
 *
 *   Source      asset library · upload new · URL · Google Drive URL (and a
 *               Drive file can be saved into the library, to reuse it)
 *   Kind        image · video · audio · player (YouTube, Vimeo, Drive)
 *   Alt text    what a screen reader says
 *   Size        width, height, scale, fit, alignment, proportions, padding,
 *               spacing, shrink on small screens — per item
 *   Position    above the question text · below it · at the cursor
 *   Several     add, reorder, remove, each with its own settings
 *   Preview     the items as the respondent sees them, live
 *
 * In an answer option's label (no `placement`) the dialog stays what it was:
 * one picture or clip, its size, at the cursor — the position and
 * several-item controls belong to the question text only.
 *
 * Editing an item and clearing its Source is a valid action: Apply removes
 * that item from the text.
 */
export interface MediaInsertValue {
  kind: InsertableMediaKind;
  url: string;
  alt: string;
  display: MediaDisplay | undefined;
  mimeType?: string;
}

export type MediaPosition = "above" | "below" | "cursor" | "keep";

export interface MediaApply {
  /** where the HTML goes; "keep" = in place of the edited element */
  position: MediaPosition;
  /** the edited element's source was cleared: take it out */
  remove: boolean;
  items: MediaInsertValue[];
}

type Item = MediaInsertValue & { id: string };
type Source = "library" | "upload" | "url" | "drive";

const PIPED = /\{\{[^}]+\}\}/;
const isPiped = (u: string) => PIPED.test(u);

export function MediaInsertDialog({ open, initial, onClose, onInsert, placement }: {
  open: boolean;
  /** what an existing element carried, when editing */
  initial?: Partial<MediaInsertValue> | null;
  onClose(): void;
  onInsert(html: string, value: MediaInsertValue, apply: MediaApply): void;
  /** the question text: offer position, several items and players */
  placement?: boolean;
}) {
  const s = useStudio();
  const editing = !!initial?.url;
  const fresh = (): Item => ({ id: uid("media"), kind: "image", url: "", alt: "", display: { maxWidth: "100%" } });
  const firstItem = (): Item => initial
    ? { id: uid("media"), kind: initial.kind ?? "image", url: initial.url ?? "", alt: initial.alt ?? "", display: initial.display ?? (initial.kind ? undefined : { maxWidth: "100%" }), mimeType: initial.mimeType }
    : fresh();
  const sourceOf = (u: string): Source => (u && resolveMediaUrl(u).provider === "google_drive" ? "drive" : "url");
  /* initialised from `initial` on mount too, so the first paint already shows the element being edited */
  const [items, setItems] = React.useState<Item[]>(() => [firstItem()]);
  const [active, setActive] = React.useState(0);
  const [position, setPosition] = React.useState<MediaPosition>(editing ? "keep" : placement ? "above" : "cursor");
  const [source, setSource] = React.useState<Source>(() => sourceOf(initial?.url ?? ""));
  const [picking, setPicking] = React.useState(false);
  const [progress, setProgress] = React.useState<UploadProgress | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const first = firstItem();
    setItems([first]); setActive(0);
    setPosition(editing ? "keep" : placement ? "above" : "cursor");
    setSource(sourceOf(first.url));
    setError(null); setBusy(null); setProgress(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !picking) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, picking, onClose]);

  if (!open) return null;
  const cur = items[Math.min(active, items.length - 1)];
  const patch = (p: Partial<Item>) => setItems((xs) => xs.map((x, i) => (i === active ? { ...x, ...p } : x)));

  /** what an item's URL is, judged the way the renderer will judge it */
  const verdict = (it: Item): { ok: boolean; kind: InsertableMediaKind; message?: string } => {
    const u = it.url.trim();
    if (!u) return { ok: false, kind: it.kind };
    if (isPiped(u)) return { ok: true, kind: it.kind === "embed" ? "image" : it.kind, message: "Piped — each respondent sees the media their value points to" };
    const m = resolveMediaUrl(u);
    if (m.kind === "unsupported") return { ok: false, kind: it.kind, message: m.reason ?? "Not a media URL." };
    if (m.kind === "embed") {
      return placement
        ? { ok: true, kind: "embed", message: `${PROVIDER[m.provider] ?? m.provider} player${m.note ? ` · ${m.note}` : ""}` }
        : { ok: false, kind: it.kind, message: "Players (YouTube, Vimeo, Drive) go in the question text, not inside an answer option." };
    }
    if (it.kind === "embed") return { ok: true, kind: m.kind === "video" ? (m.mimeType?.startsWith("audio/") ? "audio" : "video") : "image" };
    return { ok: true, kind: it.kind };
  };
  const curV = verdict(cur);
  const kindOf = (it: Item) => verdict(it).kind;

  const pick = (a: AssetSummary) => {
    const kind: InsertableMediaKind = a.family === "video" || a.family === "audio" ? a.family : "image";
    patch({ url: a.url, mimeType: a.mimeType ?? undefined, kind, ...(cur.alt || !a.altText ? {} : { alt: a.altText }) });
  };
  const canUse = !!s.surveyDbId && s.surveyDbId !== "sandbox";

  const upload = async (file: File) => {
    setError(null);
    const out = await uploadAsset(s.surveyDbId, file, { onProgress: setProgress, altText: cur.alt || undefined });
    setProgress(null);
    if (fileRef.current) fileRef.current.value = "";
    if (!out.ok) { setError(out.error); return; }
    pick(out.asset);
  };
  const saveDrive = async () => {
    setError(null); setBusy("Saving to the asset library…");
    const out = await importDriveAsset(s.surveyDbId, cur.url.trim(), { altText: cur.alt || undefined });
    setBusy(null);
    if (!out.ok) { setError(out.error); return; }
    pick(out.asset);
    setSource("library");
  };

  const filled = items.filter((it) => it.url.trim());
  const removing = editing && !cur.url.trim();
  const allOk = filled.length > 0 && filled.every((it) => verdict(it).ok);
  const canApply = removing || allOk;
  const htmlOf = (it: Item) => mediaHtml(kindOf(it), it.url.trim(), it.display, { alt: it.alt.trim(), mimeType: it.mimeType });

  const apply = () => {
    const values: MediaInsertValue[] = filled.map((it) => ({ kind: kindOf(it), url: it.url.trim(), alt: it.alt.trim(), display: it.display, mimeType: it.mimeType }));
    const html = removing ? "" : filled.map(htmlOf).join("");
    onInsert(html, values[0] ?? { kind: cur.kind, url: "", alt: "", display: cur.display }, { position, remove: removing, items: values });
    onClose();
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    setItems((xs) => { const n = [...xs]; [n[i], n[j]] = [n[j], n[i]]; return n; });
    setActive(j);
  };

  /* the preview is the markup the respondent gets, through the renderer's own last step */
  const previewHtml = expandMediaEmbeds(sanitizeHtml(filled.filter((it) => verdict(it).ok).map((it) => isPiped(it.url) ? pipedPlaceholder(it) : htmlOf(it)).join("")));
  const textLine = <div className="mins-preview-text" aria-hidden>Question text…</div>;
  const multi = !!placement && !editing;
  const title = editing ? "Edit media" : "Insert media";

  return (
    <div className="modal-back" onClick={onClose} data-testid="media-insert">
      <div className="modal mins" role="dialog" aria-modal="true" aria-label={title} style={{ width: 780 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: "center", gap: 8 }}>
          <h2 style={{ fontSize: 15, margin: 0 }}>{title}</h2>
          <span className="grow" />
          <button type="button" className="btn small" onClick={onClose}>close</button>
        </div>

        {multi && (
          <div className="mins-items" data-testid="media-insert-items">
            {items.map((it, i) => (
              <span key={it.id} className={`mins-item ${i === active ? "on" : ""}`} data-testid={`media-insert-item-${i}`}>
                <button type="button" className="btn small ghost" onClick={() => setActive(i)} title="Edit this item">
                  Media {i + 1}{it.url.trim() ? ` · ${kindOf(it) === "embed" ? "player" : kindOf(it)}` : ""}
                </button>
                {items.length > 1 && (
                  <>
                    <button type="button" className="btn small ghost" title="Move earlier" disabled={i === 0} data-testid={`media-insert-item-up-${i}`} onClick={() => move(i, -1)}>↑</button>
                    <button type="button" className="btn small ghost" title="Move later" disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button>
                    <button type="button" className="btn small ghost danger" title="Remove this item" data-testid={`media-insert-item-remove-${i}`}
                      onClick={() => { setItems((xs) => xs.filter((_, j) => j !== i)); setActive((a) => Math.max(0, a > i || a === items.length - 1 ? a - 1 : a)); }}>×</button>
                  </>
                )}
              </span>
            ))}
            <button type="button" className="btn small" data-testid="media-insert-add" disabled={!cur.url.trim()}
              title={cur.url.trim() ? "Add another picture, video or clip" : "Give this item a source first"}
              onClick={() => { setItems((xs) => [...xs, fresh()]); setActive(items.length); setSource("url"); }}>+ Add media</button>
          </div>
        )}

        <div className="row" style={{ gap: 2, marginTop: 8, flexWrap: "wrap" }}>
          <span className="flabel" style={{ margin: "0 6px 0 0" }}>Type</span>
          {(["image", "video", "audio"] as const).map((k) => (
            <button key={k} type="button" className={`btn small ${curV.kind === k ? "primary" : ""}`} data-testid={`media-insert-kind-${k}`} onClick={() => patch({ kind: k })}>{k}</button>
          ))}
          {placement && <span className={`btn small ${curV.kind === "embed" ? "primary" : ""}`} style={{ pointerEvents: "none", opacity: curV.kind === "embed" ? 1 : 0.55 }} title="YouTube, Vimeo and Google Drive links become a player">player</span>}
        </div>

        <div className="f" style={{ marginTop: 8 }}><span>Source</span>
          <div className="row" style={{ gap: 2, marginBottom: 6, flexWrap: "wrap" }} data-testid="media-insert-sources">
            {([["library", "Asset library"], ["upload", "Upload new"], ["url", "URL"], ["drive", "Google Drive URL"]] as [Source, string][]).map(([k, l]) => (
              <button key={k} type="button" className={`btn small ${source === k ? "primary" : "ghost"}`} data-testid={`media-insert-source-${k}`}
                onClick={() => { setSource(k); if (k === "library" && canUse) setPicking(true); if (k === "upload" && canUse) fileRef.current?.click(); }}>{l}</button>
            ))}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <input className="input grow" data-testid="media-insert-url"
              placeholder={source === "drive" ? "https://drive.google.com/file/d/…/view — shared “Anyone with the link”" : `${curV.kind === "embed" ? "player" : curV.kind} URL — or {{ImageURL}} to pipe one`}
              value={cur.url} onChange={(e) => patch({ url: e.target.value, mimeType: undefined })} />
            <button type="button" className="btn small" disabled={!canUse} onClick={() => setPicking(true)} data-testid="media-insert-choose" title={canUse ? "Pick from this survey's assets" : "Save the survey first"}>Choose asset…</button>
            <button type="button" className="btn small" disabled={!canUse || !!progress} onClick={() => fileRef.current?.click()} data-testid="media-insert-upload" title={canUse ? "Upload a file into the asset library and use it here" : "Save the survey first"}>{progress ? progress.label : "Upload…"}</button>
            <input ref={fileRef} type="file" accept={ASSET_ACCEPT} style={{ display: "none" }} data-testid="media-insert-file"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          </div>
          {cur.url.trim() && curV.message && (
            <span className="muted" data-testid="media-insert-verdict" style={{ fontSize: 12.5, color: curV.ok ? undefined : "var(--danger, #b91c1c)" }}>{curV.ok ? "✓ " : "⚠ "}{curV.message}</span>
          )}
          {curV.ok && resolveMediaUrl(cur.url.trim()).provider === "google_drive" && (
            <span className="row" style={{ gap: 6, marginTop: 4, alignItems: "center" }}>
              <button type="button" className="btn small" data-testid="media-insert-drive-save" disabled={!canUse || !!busy} onClick={() => void saveDrive()}
                title={canUse ? "Copy this Drive file into the asset library, so it can be reused without the link" : "Save the survey first"}>{busy ?? "Save to asset library"}</button>
              <span className="muted" style={{ fontSize: 12 }}>reusable from the library, and shown without Drive’s frame</span>
            </span>
          )}
          {removing && <span className="muted" data-testid="media-insert-removing" style={{ fontSize: 12.5 }}>Source is empty — Apply removes this media from the question.</span>}
          {error && <span className="muted" data-testid="media-insert-error" style={{ fontSize: 12.5, color: "var(--danger, #b91c1c)" }}>⚠ {error}</span>}
        </div>

        {curV.kind !== "embed" && curV.kind !== "audio" && (
          <label className="f"><span>Alt text <span className="muted">(what a screen reader says)</span></span>
            <input className="input" data-testid="media-insert-alt" placeholder="e.g. Acme logo" value={cur.alt} onChange={(e) => patch({ alt: e.target.value })} /></label>
        )}
        {curV.kind === "embed" && (
          <label className="f"><span>Title <span className="muted">(what a screen reader says about the player)</span></span>
            <input className="input" data-testid="media-insert-alt" placeholder="e.g. Brand film" value={cur.alt} onChange={(e) => patch({ alt: e.target.value })} /></label>
        )}

        <h3 className="sec" style={{ marginTop: 10 }}>Size &amp; layout{multi && items.length > 1 ? ` — Media ${active + 1}` : ""}</h3>
        <MediaDisplayControls kind={curV.kind} value={cur.display} onChange={(display) => patch({ display })} compact />

        {placement && (
          <div className="row" style={{ gap: 14, marginTop: 10, flexWrap: "wrap", alignItems: "center" }} data-testid="media-insert-position">
            <span className="flabel" style={{ margin: 0 }}>Show media</span>
            {(editing ? (["keep", "above", "below"] as const) : (["above", "below", "cursor"] as const)).map((p) => (
              <label key={p} className="row" style={{ gap: 4, fontSize: 13 }}>
                <input type="radio" name="media-position" data-testid={`media-insert-position-${p}`} checked={position === p} onChange={() => setPosition(p)} />
                {p === "above" ? "Above question" : p === "below" ? "Below question" : p === "cursor" ? "At the cursor" : "Where it is"}
              </label>
            ))}
          </div>
        )}

        <h3 className="sec">Preview</h3>
        <div className="mdisp-preview mins-preview" data-testid="media-display-preview">
          {placement && (position === "below") && textLine}
          {previewHtml
            ? <div className="mins-preview-media" data-testid="media-insert-preview-media" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            : <div className="muted" style={{ fontSize: 12.5 }}>{removing ? "Nothing — this media will be removed." : "Nothing to preview yet."}</div>}
          {placement && (position === "above" || position === "keep") && textLine}
        </div>

        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" disabled={!canApply} onClick={apply} data-testid="media-insert-ok">
            {editing ? "Apply" : filled.length > 1 ? `Insert ${filled.length} items` : "Insert"}
          </button>
        </div>
      </div>
      <AssetPicker open={picking} onClose={() => setPicking(false)} onPick={pick}
        accept={curV.kind === "video" ? ["video"] : curV.kind === "audio" ? ["audio"] : curV.kind === "image" ? ["image"] : ["image", "video", "audio"]}
        title={`Choose ${curV.kind === "image" ? "an image" : curV.kind === "embed" ? "media" : `a ${curV.kind} file`}`} />
    </div>
  );
}

const PROVIDER: Record<string, string> = { youtube: "YouTube", vimeo: "Vimeo", google_drive: "Google Drive" };

/** a piped picture has no URL until a respondent arrives: the preview shows where it will go, at its size */
function pipedPlaceholder(it: Item): string {
  const label = it.url.trim().replace(/[<>&"]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="100%" height="100%" fill="#eef2ff" stroke="#6366f1" stroke-dasharray="6 4"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#4338ca">${label}</text></svg>`;
  return mediaHtml("image", `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, it.display, { alt: it.alt });
}

/** Read an inserted element back into dialog values — what the editor passes as `initial` on click. */
export function mediaValueFromElement(el: HTMLElement): Partial<MediaInsertValue> | null {
  const tag = el.tagName.toLowerCase();
  if (el.getAttribute("data-rs-media") === "embed") {
    const display = mediaDisplayFromCss(el.getAttribute("style"));
    return {
      kind: "embed",
      url: el.getAttribute("data-rs-src") ?? "",
      alt: (el.textContent ?? "").replace(/^\s*▶\s*/, "").trim(),
      display: Object.keys(display).length ? display : undefined,
    };
  }
  if (tag !== "img" && tag !== "video" && tag !== "audio") return null;
  /* the tag is `img`; the kind is `image` — reading the tag as the kind left
     an edited picture with no preview, no alt field and player controls */
  const kind: InsertableMediaKind = tag === "img" ? "image" : (tag as "video" | "audio");
  const display = mediaDisplayFromCss(el.getAttribute("style"));
  if (kind !== "image") {
    display.controls = el.hasAttribute("controls") ? undefined : false;
    if (el.hasAttribute("autoplay")) display.autoplay = true;
    if (el.hasAttribute("muted")) display.muted = true;
    if (el.hasAttribute("loop")) display.loop = true;
    const poster = el.getAttribute("poster");
    if (poster) display.poster = poster;
  }
  const source = el.querySelector("source");
  return {
    kind,
    url: el.getAttribute("src") ?? source?.getAttribute("src") ?? "",
    alt: el.getAttribute("alt") ?? "",
    display: Object.keys(display).filter((k) => (display as Record<string, unknown>)[k] !== undefined).length ? display : undefined,
    mimeType: source?.getAttribute("type") ?? undefined,
  };
}
