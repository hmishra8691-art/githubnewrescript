/**
 * Client side of respondent uploads. In preview there is no session and no
 * storage, so the file stays local as a data URL (small files: signatures,
 * photos) or an object URL — the renderer works, the answer has the right
 * shape, and nothing is written anywhere. With a session, the file goes to
 * `/api/upload` and the answer stores the returned signed URL.
 */
export interface UploadedFile {
  url: string;
  name: string;
  size: number;
  type: string;
  path?: string;
  /** true when the file never left the browser (preview) */
  local?: boolean;
}

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
