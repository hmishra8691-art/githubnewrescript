"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";

/**
 * File / Media Upload family: File Upload, Photo / Camera Capture and
 * Signature Capture — plus the client half of respondent uploads, which the
 * media family's Audio Recording shares.
 *
 * All three store the `upload` base type's shape: `{url, name, size, type}`,
 * or an array of those when `settings.maxFiles > 1`. Nothing else in the
 * platform needs to know which of them produced the file — exports, the
 * variable dictionary and validation see one model.
 *
 * NOTE ON THIS FILE'S SHAPE. The upload client used to live beside this file
 * as `variants/upload.ts`. Two modules cannot share a basename here: webpack
 * resolves `./upload` to `.tsx` before `.ts` (Next's resolve order) while
 * TypeScript resolves it to `.ts` first, so `import { uploadFile } from
 * "./upload"` type-checked against one module and bundled the other, and no
 * family file could reach the helper at runtime at all. The helper therefore
 * lives here, unchanged in behaviour, and `./upload` now means one thing to
 * both resolvers.
 */

/* ------------------------------------------------------------------ client */

export interface UploadedFile {
  url: string;
  name: string;
  size: number;
  type: string;
  path?: string;
  /** true when the file never left the browser (preview) */
  local?: boolean;
}

/**
 * In preview there is no session and no storage, so the file stays local as a
 * data URL (small files: signatures, photos) or an object URL — the renderer
 * works, the answer has the right shape, and nothing is written anywhere.
 * With a session, the file goes to `/api/upload` and the answer stores the
 * returned signed URL.
 */
export async function uploadFile(
  file: File | Blob,
  ctx: { sessionId?: string | null; questionId: string; fileName?: string },
): Promise<UploadedFile> {
  const name = (file as File).name ?? ctx.fileName ?? "upload";
  if (!ctx.sessionId) {
    const url = file.size <= 2 * 1024 * 1024 ? await toDataUrl(file) : URL.createObjectURL(file);
    return { url, name, size: file.size, type: file.type, local: true };
  }
  const form = new FormData();
  form.append("file", file, name);
  form.append("sessionId", ctx.sessionId);
  form.append("questionId", ctx.questionId);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`);
  return { url: body.url, path: body.path, name: body.name ?? name, size: body.size ?? file.size, type: body.type ?? file.type };
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/* ------------------------------------------------------------------ shared */

/**
 * The session id to upload under — or nothing, which keeps the file in the
 * browser as a data URL.
 *
 * A live interview is served from `/s/<client>/<study>`; preview (`/preview`)
 * and test (`/t/...`) runs must not write to storage. `state.sessionId` cannot
 * tell them apart: the Runner mints one locally whenever the server sends
 * none, so it is always populated.
 */
export function liveSessionId(p: QRProps): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.pathname.startsWith("/s/") ? p.state.sessionId : undefined;
}

export function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The answer as a list, whichever of the two shapes it is stored in. */
export function filesOf(p: QRProps): UploadedFile[] {
  const v = p.value;
  if (Array.isArray(v)) return v.filter(Boolean) as UploadedFile[];
  return v && typeof v === "object" ? [v as UploadedFile] : [];
}

/** Write the answer back in the shape `settings.maxFiles` promises. */
export function commitFiles(p: QRProps, files: UploadedFile[]): void {
  const max = p.q.settings.maxFiles ?? 1;
  if (max > 1) p.onChange(files.length ? files : null);
  else p.onChange(files[0] ?? null);
}

/** Client-side size guard, so an oversize file is refused before it uploads. */
export function tooBig(p: QRProps, file: File | Blob): string | null {
  const cap = p.q.settings.maxSizeMb;
  if (cap == null || file.size <= cap * 1024 * 1024) return null;
  const name = (file as File).name ? `“${(file as File).name}”` : "That file";
  return `${name} is ${fmtSize(file.size)} — the limit is ${cap} MB.`;
}

/** A stored file's row: name, size and a remove button. */
function FileRow({ f, i, onRemove }: { f: UploadedFile; i: number; onRemove(): void }) {
  const isImage = f.type?.startsWith("image/");
  return (
    <div className="rs-up-row" data-file={i}>
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="rs-up-thumb" src={f.url} alt="" />
      ) : (
        <span className="rs-up-icon" aria-hidden>📄</span>
      )}
      <span className="rs-up-name" title={f.name}>{f.name}</span>
      <span className="rs-up-size">{fmtSize(f.size)}</span>
      <button type="button" className="rs-up-x" aria-label={`Remove ${f.name}`} onClick={onRemove}>×</button>
    </div>
  );
}

/* -------------------------------------------------------------- file upload */

/**
 * File / Document Upload. A drop zone and a file input (the two are the same
 * control: an OS file drop can only arrive as a drop event, and the input is
 * the keyboard and tap path). Files are size-checked here, uploaded one at a
 * time, and each shows a row with its size and a remove button.
 */
export function FileUpload(p: QRProps) {
  const max = p.q.settings.maxFiles ?? 1;
  const files = filesOf(p);
  const [busy, setBusy] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [over, setOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const ro = !!p.q.settings.readOnly;

  const take = async (list: FileList | File[] | null) => {
    if (!list || ro) return;
    setError(null);
    let next = [...filesOf(p)];
    for (const f of Array.from(list)) {
      const big = tooBig(p, f);
      if (big) { setError(big); continue; }
      if (max > 1 && next.length >= max) {
        setError(`You can attach at most ${max} files.`);
        break;
      }
      setBusy((b) => b + 1);
      try {
        const up = await uploadFile(f, { sessionId: liveSessionId(p), questionId: p.q.id });
        next = max > 1 ? [...next, up] : [up];
        commitFiles(p, next);
      } catch (e) {
        setError((e as Error).message || "Upload failed — please try again.");
      } finally {
        setBusy((b) => b - 1);
      }
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  const open = () => inputRef.current?.click();

  return (
    <div className="rs-up">
      <div
        className={`rs-up-zone ${over ? "over" : ""} ${ro ? "ro" : ""}`}
        role="button"
        tabIndex={0}
        aria-label="Choose a file to upload"
        data-testid="upload-zone"
        onClick={open}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } }}
        /* an OS file drop has no pointer-event equivalent — the click path
           above is the fallback for touch and keyboard */
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void take(e.dataTransfer?.files ?? null); }}
      >
        <span className="rs-up-zone-icon" aria-hidden>⬆</span>
        <span>
          <strong>Choose a file</strong> or drop it here
          <span className="rs-up-hint">
            {p.q.settings.accept ? ` · ${p.q.settings.accept}` : ""}
            {p.q.settings.maxSizeMb != null ? ` · up to ${p.q.settings.maxSizeMb} MB` : ""}
            {max > 1 ? ` · up to ${max} files` : ""}
          </span>
        </span>
      </div>
      <input
        ref={inputRef}
        className="rs-up-input"
        type="file"
        accept={p.q.settings.accept}
        multiple={max > 1}
        disabled={ro}
        data-testid="upload-input"
        onChange={(e) => void take(e.target.files)}
      />
      {busy > 0 && <div className="rs-up-busy" data-testid="upload-busy">Uploading…</div>}
      {files.length > 0 && (
        <div className="rs-up-list">
          {files.map((f, i) => (
            <FileRow key={`${f.url}-${i}`} f={f} i={i}
              onRemove={() => commitFiles(p, files.filter((_, j) => j !== i))} />
          ))}
        </div>
      )}
      {error && <div className="rs-error-msg" data-testid="upload-error">{error}</div>}
    </div>
  );
}

/* ------------------------------------------------------------ photo capture */

/**
 * Photo / Camera Capture. Tries the device camera for a live preview and a
 * shutter button; when there is no camera, or permission is refused, the file
 * input beside it (with `capture`, so a phone still opens its camera app)
 * takes the photo instead. Either way the answer is one uploaded file.
 */
export function CameraCapture(p: QRProps) {
  const files = filesOf(p);
  const photo = files[0];
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const ro = !!p.q.settings.readOnly;

  React.useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);
  React.useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  const stop = () => { stream?.getTracks().forEach((t) => t.stop()); setStream(null); };

  const startCamera = async () => {
    setNote(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      setStream(s);
    } catch {
      setNote("No camera available on this device (or permission was refused) — choose a photo instead.");
    }
  };

  const store = async (blob: Blob, name: string) => {
    const big = tooBig(p, blob);
    if (big) { setNote(big); return; }
    setBusy(true);
    try {
      const up = await uploadFile(blob, { sessionId: liveSessionId(p), questionId: p.q.id, fileName: name });
      commitFiles(p, [{ ...up, name: up.name || name }]);
    } catch (e) {
      setNote((e as Error).message || "Upload failed — please try again.");
    } finally {
      setBusy(false);
    }
  };

  const shoot = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0);
    c.toBlob((b) => { if (b) { stop(); void store(b, "photo.jpg"); } }, "image/jpeg", 0.9);
  };

  if (photo) {
    return (
      <div className="rs-up rs-cam">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="rs-cam-shot" src={photo.url} alt="The photo you took" data-testid="photo-preview" />
        <div className="rs-up-actions">
          <span className="rs-up-size">{photo.name} · {fmtSize(photo.size)}</span>
          <button type="button" className="rs-btn secondary" disabled={ro}
            onClick={() => commitFiles(p, [])}>Retake</button>
        </div>
      </div>
    );
  }

  return (
    <div className="rs-up rs-cam">
      {stream ? (
        <>
          <video ref={videoRef} className="rs-cam-live" autoPlay playsInline muted />
          <div className="rs-up-actions">
            <button type="button" className="rs-btn" onClick={shoot} data-testid="camera-shoot">Take photo</button>
            <button type="button" className="rs-btn secondary" onClick={stop}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="rs-up-actions">
          <button type="button" className="rs-btn" disabled={ro}
            onClick={() => void startCamera()} data-testid="camera-start">Use camera</button>
          <button type="button" className="rs-btn secondary" disabled={ro}
            onClick={() => inputRef.current?.click()}>Choose a photo</button>
        </div>
      )}
      <input
        ref={inputRef}
        className="rs-up-input"
        type="file"
        accept={p.q.settings.accept ?? "image/*"}
        capture="environment"
        disabled={ro}
        data-testid="photo-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void store(f, f.name || "photo.jpg");
        }}
      />
      {busy && <div className="rs-up-busy" data-testid="upload-busy">Uploading…</div>}
      {note && <div className="rs-media-note" data-testid="camera-note">{note}</div>}
    </div>
  );
}

/* --------------------------------------------------------------- signature */

/**
 * Signature Capture. A pointer-drawn pad — mouse, pen and finger alike —
 * saved as a PNG through the ordinary upload path, so a signature is just
 * another file on the response.
 */
export function SignaturePad(p: QRProps) {
  const files = filesOf(p);
  const saved = files[0];
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const drawing = React.useRef(false);
  const last = React.useRef<{ x: number; y: number } | null>(null);
  const [inked, setInked] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ro = !!p.q.settings.readOnly;

  // the pad's backing store must match its CSS size or the ink lands off-cursor
  React.useEffect(() => {
    const c = canvasRef.current;
    if (!c || saved) return;
    const fit = () => {
      const w = Math.max(200, c.clientWidth);
      const h = c.clientHeight || 170;
      if (c.width === w && c.height === h) return;
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      if (ctx) { ctx.lineWidth = p.q.settings.penWidth ?? 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = p.q.settings.penColor ?? "#0f172a"; }
      setInked(false);
    };
    fit();
    const roObs = new ResizeObserver(fit);
    roObs.observe(c);
    return () => roObs.disconnect();
  }, [saved, p.q.settings.penWidth, p.q.settings.penColor]);

  const at = (e: React.PointerEvent) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };

  const down = (e: React.PointerEvent) => {
    if (ro) return;
    drawing.current = true;
    last.current = at(e);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    const pt = at(e);
    if (!ctx || !last.current) return;
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    last.current = pt;
    setInked(true);
  };
  const up = () => { drawing.current = false; last.current = null; };

  const clear = () => {
    const c = canvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    setInked(false);
  };

  const done = () => {
    const c = canvasRef.current;
    if (!c || !inked) return;
    setError(null);
    setBusy(true);
    c.toBlob((b) => {
      if (!b) { setBusy(false); setError("Could not save the signature."); return; }
      void uploadFile(b, { sessionId: liveSessionId(p), questionId: p.q.id, fileName: "signature.png" })
        .then((up) => commitFiles(p, [{ ...up, name: "signature.png" }]))
        .catch((e: Error) => setError(e.message || "Could not save the signature."))
        .finally(() => setBusy(false));
    }, "image/png");
  };

  if (saved) {
    return (
      <div className="rs-sig">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="rs-sig-saved" src={saved.url} alt="Your signature" data-testid="signature-saved" />
        <div className="rs-up-actions">
          <span className="rs-up-size">Signed · {fmtSize(saved.size)}</span>
          <button type="button" className="rs-btn secondary" disabled={ro}
            onClick={() => commitFiles(p, [])} data-testid="signature-again">Sign again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="rs-sig">
      <canvas
        ref={canvasRef}
        className="rs-sig-pad"
        data-testid="signature-pad"
        aria-label="Signature pad — draw your signature"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      />
      <div className="rs-up-actions">
        <button type="button" className="rs-btn secondary" onClick={clear} disabled={!inked}>Clear</button>
        <button type="button" className="rs-btn" onClick={done} disabled={!inked || busy}
          data-testid="signature-done">{busy ? "Saving…" : "Done"}</button>
      </div>
      {error && <div className="rs-error-msg">{error}</div>}
    </div>
  );
}

registerVariantRenderer("fileupload", FileUpload);
// the base type's own presentation: an `upload` question with no variant
registerVariantRenderer("base:upload", FileUpload);
registerVariantRenderer("camera", CameraCapture);
registerVariantRenderer("signature", SignaturePad);
