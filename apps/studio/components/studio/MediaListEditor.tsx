"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { resolveMediaUrl } from "@rescript/engine";
import { uploadAsset } from "@/lib/assets";
import { MediaUrlInput } from "./MediaUrlInput";
import { useStudio, uid } from "./store";

type Item = NonNullable<Question["settings"]["mediaItems"]>[number];

/**
 * THE MEDIA UNDER A QUESTION — one item or several (Prince 11, 14, 16).
 *
 * One image stays exactly what it always was: `settings.mediaUrl`. The moment
 * a second is added the list moves to `settings.mediaItems` (in order), with
 * `mediaUrl` kept equal to the first so every reader of the single URL still
 * sees one. Each item can be replaced (Choose / Upload / paste), named, given
 * alt text, moved and deleted; several images can be uploaded at once; and
 * the layout — side by side or stacked — is chosen when there is more than one.
 * Images, video, YouTube and Google Drive links all work in every slot, and
 * every slot takes piping (`{{ImageURL}}`).
 */
export function MediaListEditor({ q, patchSettings, label }: {
  q: Question;
  patchSettings(p: Partial<Question["settings"]>): void;
  label: string;
}) {
  const studio = useStudio();
  const canUpload = studio.surveyDbId !== "sandbox";
  const items: Item[] = q.settings.mediaItems?.length
    ? q.settings.mediaItems
    : q.settings.mediaUrl
      ? [{ id: "m_first", url: q.settings.mediaUrl }]
      : [];
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const multiRef = React.useRef<HTMLInputElement | null>(null);

  const write = (next: Item[]) => {
    const kept = next;
    const simple = kept.length <= 1 && !kept[0]?.alt && !kept[0]?.title;
    patchSettings({
      mediaUrl: kept[0]?.url?.trim() ? kept[0].url : undefined,
      mediaItems: simple ? undefined : kept,
      ...(kept.length <= 1 ? { mediaLayout: undefined } : {}),
    });
  };
  const set = (i: number, p: Partial<Item>) => write(items.map((m, j) => (j === i ? { ...m, ...p } : m)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    write(next);
  };
  const add = () => write([...items.length ? items : [], { id: uid("media"), url: "" }]);

  const uploadMany = async (files: FileList) => {
    setError(null);
    const added: Item[] = [];
    let n = 0;
    for (const f of Array.from(files)) {
      n += 1;
      setBusy(`Uploading ${n} of ${files.length}…`);
      const out = await uploadAsset(studio.surveyDbId, f);
      if (!out.ok) { setError(`${f.name}: ${out.error}`); continue; }
      added.push({ id: uid("media"), url: out.asset.url, title: f.name.replace(/\.[^.]+$/, "") });
    }
    setBusy(null);
    if (multiRef.current) multiRef.current.value = "";
    if (added.length) write([...items.filter((m) => m.url.trim()), ...added]);
  };

  const several = items.length > 1;
  return (
    <div className="media-list" data-testid="media-list">
      {!several && (
        <MediaUrlInput label={label} testId="question-media" questionId={q.id} value={items[0]?.url}
          onChange={(v) => write(v ? [{ ...(items[0] ?? { id: "m_first" }), url: v }] : [])} />
      )}
      {several && (
        <>
          <span className="flabel">{label}</span>
          {items.map((m, i) => {
            const kind = resolveMediaUrl(m.url).kind;
            return (
              <div key={m.id} className="card media-item" data-testid="media-item" style={{ padding: 8, marginBottom: 6 }}>
                <div className="row" style={{ marginBottom: 4 }}>
                  <span className="step-badge">{i + 1}</span>
                  <input className="input grow" data-testid={`media-item-title-${i}`} placeholder={`Image ${i + 1} — name (optional)`}
                    value={m.title ?? ""} onChange={(e) => set(i, { title: e.target.value || undefined })} />
                  <button type="button" className="btn small" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="btn small" title="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="btn small danger" title="Delete this item" data-testid={`media-item-delete-${i}`}
                    onClick={() => write(items.filter((_, j) => j !== i))}>×</button>
                </div>
                {/* Choose / Upload here REPLACE this item */}
                <MediaUrlInput testId={`media-item-url-${i}`} questionId={q.id} value={m.url}
                  onChange={(v) => set(i, { url: v ?? "" })} />
                {kind === "image" && (
                  <input className="input" style={{ marginTop: 4 }} data-testid={`media-item-alt-${i}`}
                    placeholder="Alt text — what a screen reader says (leave blank to use the question text)"
                    value={m.alt ?? ""} onChange={(e) => set(i, { alt: e.target.value || undefined })} />
                )}
              </div>
            );
          })}
          <div className="row" style={{ gap: 12, margin: "4px 0 8px", flexWrap: "wrap" }} data-testid="media-layout">
            <span className="flabel" style={{ margin: 0 }}>Layout</span>
            {(["horizontal", "vertical"] as const).map((l) => (
              <label key={l} className="row" style={{ gap: 4, fontSize: 13 }}>
                <input type="radio" name={`media-layout-${q.id}`} data-testid={`media-layout-${l}`}
                  checked={(q.settings.mediaLayout ?? "vertical") === l}
                  onChange={() => patchSettings({ mediaLayout: l })} />
                {l === "horizontal" ? "Side by side (wraps on small screens)" : "Stacked"}
              </label>
            ))}
          </div>
        </>
      )}
      <div className="row" style={{ gap: 8, marginTop: 4, flexWrap: "wrap" }}>
        <button type="button" className="btn small" data-testid="media-add" onClick={add}
          disabled={!items.length || items.some((m) => !m.url.trim())}
          title={!items.length ? "Add the first item above" : "Add another image or video"}>
          + Add another
        </button>
        {canUpload && (
          <>
            <input ref={multiRef} type="file" accept="image/*,video/*" multiple style={{ display: "none" }}
              data-testid="media-upload-many-file"
              onChange={(e) => { if (e.target.files?.length) void uploadMany(e.target.files); }} />
            <button type="button" className="btn small" data-testid="media-upload-many" disabled={!!busy}
              onClick={() => multiRef.current?.click()}>{busy ?? "Upload multiple images"}</button>
          </>
        )}
      </div>
      {error && <div className="muted" data-testid="media-upload-error" style={{ fontSize: 12.5, color: "var(--danger, #b91c1c)" }}>⚠ {error}</div>}
    </div>
  );
}
