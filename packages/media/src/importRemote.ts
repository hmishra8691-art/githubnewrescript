import { createHash } from "node:crypto";
import { assetFor, beginUpload, confirmUpload, findDuplicateAsset, MediaError, type AssetSummary, type MediaDb } from "./store.js";
import { ASSET_MAX_BYTES, assetFamilyFor, assetWithinLimit } from "./plan.js";

/**
 * A GOOGLE DRIVE FILE, COPIED INTO THE ASSET LIBRARY (1-10-26 review).
 *
 * "For Google Drive URLs, provide an option to save the used Google Drive
 * media as an asset in the Asset Library, so it can be reused later without
 * having to enter the URL again."
 *
 * The browser cannot read a Drive file (Drive sends no CORS headers), so the
 * server does: it downloads the file Drive serves for a link shared "Anyone
 * with the link", checks it is a picture, video or audio file the library
 * takes and within the library's size for that kind, and stores it through
 * the same ticket → upload → confirm path a browser upload uses. The result
 * is an ordinary library asset — deduplicated by hash like any other.
 */

/** The file id in any of Drive's link shapes, or null. */
export function driveFileId(url: string): string | null {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return null; }
  if (!/^(drive|docs)\.google\.com$/i.test(u.hostname)) return null;
  const m = /\/(?:file\/d|d)\/([A-Za-z0-9_-]{10,})/.exec(u.pathname);
  const id = m?.[1] ?? u.searchParams.get("id");
  return id && /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
}

export interface RemoteFile { bytes: Uint8Array; mimeType: string; fileName: string | null }

type FetchLike = (url: string, init?: { redirect?: "follow"; headers?: Record<string, string>; method?: string; body?: Uint8Array }) => Promise<{
  ok: boolean; status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Download a Drive file the way "Anyone with the link" allows, refusing a page instead of a file. */
export async function fetchDriveFile(url: string, opts: { fetchImpl?: FetchLike; maxBytes?: number } = {}): Promise<RemoteFile> {
  const id = driveFileId(url);
  if (!id) throw new MediaError("That is not a Google Drive file link — use the file's “Share → Copy link”.", 400);
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const max = opts.maxBytes ?? Math.max(...Object.values(ASSET_MAX_BYTES));
  const r = await f(`https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`, { redirect: "follow" });
  if (!r.ok) throw new MediaError(`Google Drive answered ${r.status} — is the file shared “Anyone with the link”?`, 502);
  const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type || type === "text/html") {
    throw new MediaError("Google Drive sent a page, not the file: share it as “Anyone with the link”, or (for a large video) download it and upload it instead.", 422);
  }
  const declared = Number(r.headers.get("content-length"));
  if (declared && declared > max) throw new MediaError(`The file is ${Math.round(declared / 1048576)} MB — larger than the library takes.`, 413);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.byteLength > max) throw new MediaError(`The file is ${Math.round(bytes.byteLength / 1048576)} MB — larger than the library takes.`, 413);
  const cd = r.headers.get("content-disposition") ?? "";
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd)?.[1];
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd)?.[1];
  let fileName: string | null = null;
  try { fileName = star ? decodeURIComponent(star) : plain ?? null; } catch { fileName = plain ?? null; }
  return { bytes, mimeType: type, fileName };
}

export type PutFn = (url: string, headers: Record<string, string>, body: Uint8Array) => Promise<{ etag?: string | null }>;

const defaultPut: PutFn = async (url, headers, body) => {
  const r = await fetch(url, { method: "PUT", headers, body: body as unknown as BodyInit });
  if (!r.ok) throw new MediaError(`storage refused the file (${r.status})`, 502);
  return { etag: r.headers.get("etag") };
};

/**
 * Store bytes the SERVER holds as a library asset of this survey. The same
 * row, ticket and confirmation as a browser upload — only the PUT is ours.
 */
export async function storeAssetBytes(db: MediaDb, args: {
  customerId: string; surveyId: string; createdBy?: string | null;
  file: RemoteFile; displayName?: string | null; altText?: string | null;
  put?: PutFn;
}): Promise<{ asset: AssetSummary; duplicate: boolean }> {
  const { file } = args;
  const family = assetFamilyFor(file.mimeType);
  if (family !== "image" && family !== "video" && family !== "audio") {
    throw new MediaError(`That file is ${file.mimeType} — Insert media takes pictures, video and audio.`, 415);
  }
  const size = assetWithinLimit(file.mimeType, file.bytes.byteLength);
  if (!size.ok) throw new MediaError(size.message!, 413);
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const scope = { surveyId: args.surveyId, customerId: args.customerId };
  const dup = await findDuplicateAsset(db, { ...scope, sha256, bytes: file.bytes.byteLength });
  if (dup) return { asset: dup, duplicate: true };

  const ext = file.mimeType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  const ticket = await beginUpload(db, {
    kind: "survey_asset", customerId: args.customerId, surveyId: args.surveyId, questionId: null,
    fileName: file.fileName ?? `drive-file.${ext}`, mimeType: file.mimeType, bytes: file.bytes.byteLength,
    sha256, displayName: args.displayName ?? null, altText: args.altText ?? null, createdBy: args.createdBy ?? null,
  });
  const put = args.put ?? defaultPut;
  const parts: { partNumber: number; etag: string }[] = [];
  if (!ticket.alreadyStored) {
    if (ticket.kind === "multipart") {
      for (const p of ticket.parts) {
        const out = await put(p.url, {}, file.bytes.subarray(p.start, p.end));
        parts.push({ partNumber: p.partNumber, etag: String(out.etag ?? "").replace(/"/g, "") });
      }
    } else if (ticket.uploadUrl) {
      await put(ticket.uploadUrl, { "content-type": file.mimeType, ...ticket.uploadHeaders }, file.bytes);
    } else {
      throw new MediaError("storage gave no place to put the file", 502);
    }
  }
  await confirmUpload(db, ticket.mediaId, { bytes: file.bytes.byteLength }, parts);
  const asset = await assetFor(db, ticket.mediaId, scope);
  if (!asset) throw new MediaError("the file was stored but cannot be found in the library", 500);
  return { asset, duplicate: false };
}
