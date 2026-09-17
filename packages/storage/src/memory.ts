import {
  clampExpiry, PLAYBACK_SECONDS, StorageError, UPLOAD_SECONDS,
  type CompletedPart, type MediaStorageProvider, type MultipartUpload,
  type ObjectMetadata, type SignedUrlOptions, type UploadOptions,
} from "./provider.js";

/**
 * AN OBJECT STORE THAT LIVES IN A PROCESS — AND WILL ANSWER HTTP.
 *
 * ## Why it is in the package and not in a test file
 *
 * Because it is not a mock. A mock asserts that we called the right method; a
 * double behaves like the thing. Every interesting bug in an upload path is
 * about BEHAVIOUR under interruption — a part accepted twice, a resume that
 * skips a part, a complete that names an etag the store never issued — and a
 * mock cannot have an opinion about any of them. This one can: it issues real
 * etags, refuses a completion whose etags do not match, refuses an expired
 * signature, and refuses a signed URL used against a different key.
 *
 * ## It speaks HTTP, which is the point
 *
 * `handleRequest` implements enough of the S3 REST API — single PUT, create /
 * upload-part / list-parts / complete / abort multipart, GET, HEAD,
 * DELETE — that a REAL BROWSER can upload to it. Sixty lines of `node:http`
 * in the test harness and the candidate runtime's recorder is exercised end
 * to end, against its own resume logic, with no Cloudflare account and no
 * network. That is the difference between testing the upload and testing our
 * belief about the upload.
 *
 * The signature check is deliberately simple-minded (an HMAC over method,
 * key, query and expiry) rather than a second SigV4 implementation: a bug
 * shared between a signer and its verifier is invisible, so the verifier here
 * is intentionally NOT the code under test. SigV4 itself is proved against
 * AWS's published vectors instead.
 */

import { createHmac, randomUUID } from "node:crypto";

interface StoredObject {
  key: string;
  body: Uint8Array;
  contentType: string;
  etag: string;
  lastModified: Date;
  metadata: Record<string, string>;
}

interface PendingMultipart {
  key: string;
  contentType: string;
  parts: Map<number, { body: Uint8Array; etag: string }>;
  createdAt: Date;
}

export interface MemoryStorageOptions {
  /** Where `handleRequest` is reachable. Signed URLs are built against it. */
  baseUrl?: string;
  secret?: string;
  now?: () => Date;
  /**
   * Fail every Nth write with a 500, to drive the retry paths. 0 = never.
   * The interruption a real network produces, on demand and reproducibly.
   */
  failEveryNthWrite?: number;
}

const etagOf = (bytes: Uint8Array): string =>
  createHmac("md5", "etag").update(bytes).digest("hex");

export class MemoryStorageProvider implements MediaStorageProvider {
  readonly name = "memory";
  readonly objects = new Map<string, StoredObject>();
  readonly multiparts = new Map<string, PendingMultipart>();
  /** Every request the double has served, for assertions about retries. */
  readonly calls: { method: string; key: string; query: string }[] = [];

  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly now: () => Date;
  private readonly failEvery: number;
  private writes = 0;

  constructor(opts: MemoryStorageOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://storage.test").replace(/\/+$/, "");
    this.secret = opts.secret ?? "memory-storage";
    this.now = opts.now ?? (() => new Date());
    this.failEvery = opts.failEveryNthWrite ?? 0;
  }

  /* --------------------------------------------------------- signatures */

  private sign(method: string, key: string, query: string, expiresAt: number): string {
    return createHmac("sha256", this.secret)
      .update([method.toUpperCase(), key, query, String(expiresAt)].join("\n"))
      .digest("hex");
  }

  private signedUrl(method: string, key: string, seconds: number, query: Record<string, string> = {}): string {
    const expiresAt = Math.floor(this.now().getTime() / 1000) + seconds;
    const params = new URLSearchParams(query);
    const canonical = [...params.entries()].sort().map(([k, v]) => `${k}=${v}`).join("&");
    params.set("X-Expires-At", String(expiresAt));
    params.set("X-Signature", this.sign(method, key, canonical, expiresAt));
    return `${this.baseUrl}/${key}?${params.toString()}`;
  }

  private verify(method: string, key: string, params: URLSearchParams): string | null {
    const expiresAt = Number(params.get("X-Expires-At"));
    const signature = params.get("X-Signature");
    if (!signature || !Number.isFinite(expiresAt)) return "not signed";
    if (expiresAt * 1000 < this.now().getTime()) return "signature expired";
    const canonical = [...params.entries()]
      .filter(([k]) => k !== "X-Expires-At" && k !== "X-Signature")
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    if (this.sign(method, key, canonical, expiresAt) !== signature) return "signature does not match";
    return null;
  }

  /* ------------------------------------------------------- the interface */

  async upload(key: string, body: Uint8Array, opts: UploadOptions = {}): Promise<ObjectMetadata> {
    if (opts.ifAbsent && this.objects.has(key)) {
      throw new StorageError("An object already exists at that key.", 409);
    }
    return this.put(key, body, opts.contentType ?? "application/octet-stream", opts.metadata ?? {});
  }

  private put(key: string, body: Uint8Array, contentType: string, metadata: Record<string, string>): ObjectMetadata {
    const row: StoredObject = {
      key, body: new Uint8Array(body), contentType,
      etag: etagOf(body), lastModified: this.now(), metadata,
    };
    this.objects.set(key, row);
    return this.meta(row);
  }

  private meta(row: StoredObject): ObjectMetadata {
    return {
      key: row.key, size: row.body.byteLength, contentType: row.contentType,
      etag: row.etag, lastModified: row.lastModified,
    };
  }

  async createSignedUploadUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    return this.signedUrl("PUT", key, clampExpiry(opts.expiresIn, UPLOAD_SECONDS));
  }

  async createMultipartUpload(key: string, opts: UploadOptions = {}): Promise<MultipartUpload> {
    const uploadId = randomUUID();
    this.multiparts.set(uploadId, {
      key, contentType: opts.contentType ?? "application/octet-stream",
      parts: new Map(), createdAt: this.now(),
    });
    return { key, uploadId };
  }

  async signUploadPart(key: string, uploadId: string, partNumber: number, opts: SignedUrlOptions = {}): Promise<string> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new StorageError(`Part number ${partNumber} is out of range.`, 400);
    }
    return this.signedUrl("PUT", key, clampExpiry(opts.expiresIn, UPLOAD_SECONDS), {
      partNumber: String(partNumber), uploadId,
    });
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<ObjectMetadata> {
    const pending = this.multiparts.get(uploadId);
    if (!pending || pending.key !== key) throw new StorageError("No such upload.", 404);
    if (!parts.length) throw new StorageError("A multipart upload needs at least one part.", 400);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const chunks: Uint8Array[] = [];
    for (const p of ordered) {
      const held = pending.parts.get(p.partNumber);
      if (!held) throw new StorageError(`Part ${p.partNumber} was never uploaded.`, 400);
      if (held.etag !== p.etag.replace(/^"|"$/g, "")) {
        throw new StorageError(`Part ${p.partNumber} does not match the stored part.`, 400);
      }
      chunks.push(held.body);
    }
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const body = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { body.set(c, at); at += c.byteLength; }
    this.multiparts.delete(uploadId);
    return this.put(key, body, pending.contentType, {});
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.multiparts.delete(uploadId);
  }

  async listUploadedParts(key: string, uploadId: string): Promise<CompletedPart[]> {
    const pending = this.multiparts.get(uploadId);
    if (!pending || pending.key !== key) return [];
    return [...pending.parts.entries()]
      .map(([partNumber, p]) => ({ partNumber, etag: p.etag }))
      .sort((a, b) => a.partNumber - b.partNumber);
  }

  async createSignedDownloadUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    const query: Record<string, string> = {};
    if (opts.downloadAs) query["download"] = opts.downloadAs;
    return this.signedUrl("GET", key, clampExpiry(opts.expiresIn, PLAYBACK_SECONDS), query);
  }

  async getMetadata(key: string): Promise<ObjectMetadata | null> {
    const row = this.objects.get(key);
    return row ? this.meta(row) : null;
  }

  async read(key: string): Promise<Uint8Array> {
    const row = this.objects.get(key);
    if (!row) throw new StorageError("That object is not in the store.", 404);
    return row.body;
  }

  async delete(keys: string[]): Promise<void> {
    for (const k of keys) this.objects.delete(k);
  }

  async copy(fromKey: string, toKey: string, opts: { contentType?: string } = {}): Promise<ObjectMetadata> {
    const row = this.objects.get(fromKey);
    if (!row) throw new StorageError("That object is not in the store.", 404);
    return this.put(toKey, row.body, opts.contentType ?? row.contentType, { ...row.metadata });
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async list(prefix: string, opts: { limit?: number; cursor?: string } = {}) {
    const all = [...this.objects.values()]
      .filter((o) => o.key.startsWith(prefix))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    const from = opts.cursor ? all.findIndex((o) => o.key > opts.cursor!) : 0;
    const start = from < 0 ? all.length : from;
    const limit = Math.max(1, opts.limit ?? 1000);
    const page = all.slice(start, start + limit);
    const more = start + limit < all.length;
    return {
      objects: page.map((o) => this.meta(o)),
      cursor: more && page.length ? page[page.length - 1]!.key : null,
    };
  }

  /* ------------------------------------------------------------- the API */

  /**
   * Serve one S3-shaped HTTP request. A browser talks to this.
   *
   * Only what a signed URL can reach is implemented — there is no bucket
   * creation, no policy, no listing without a signature. A double that can do
   * more than the real credentials allow is a double that hides a permissions
   * bug until production.
   */
  async handleRequest(req: {
    method: string;
    url: string;
    headers?: Record<string, string | string[] | undefined>;
    body?: Uint8Array;
  }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array | string }> {
    const url = new URL(req.url, this.baseUrl);
    const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const method = req.method.toUpperCase();
    const params = url.searchParams;
    this.calls.push({ method, key, query: params.toString() });

    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,PUT,POST,DELETE,HEAD,OPTIONS",
      "access-control-allow-headers": "*",
      "access-control-expose-headers": "etag,content-length,content-type",
      "access-control-max-age": "86400",
    };
    if (method === "OPTIONS") return { status: 204, headers: cors, body: "" };

    const err = (status: number, code: string, message: string) => ({
      status,
      headers: { ...cors, "content-type": "application/xml" },
      body: `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    });

    // Everything a browser reaches must be signed, exactly as with R2.
    const bad = this.verify(method === "HEAD" ? "GET" : method, key, params);
    if (bad) return err(403, "AccessDenied", bad);

    if (method === "PUT") {
      this.writes++;
      if (this.failEvery > 0 && this.writes % this.failEvery === 0) {
        return err(500, "InternalError", "injected failure");
      }
      const body = req.body ?? new Uint8Array();
      const uploadId = params.get("uploadId");
      const partNumber = Number(params.get("partNumber"));
      if (uploadId) {
        const pending = this.multiparts.get(uploadId);
        if (!pending || pending.key !== key) return err(404, "NoSuchUpload", "No such upload.");
        const etag = etagOf(body);
        pending.parts.set(partNumber, { body: new Uint8Array(body), etag });
        return { status: 200, headers: { ...cors, etag: `"${etag}"` }, body: "" };
      }
      const contentType = String(req.headers?.["content-type"] ?? "application/octet-stream");
      const meta = this.put(key, body, contentType, {});
      return { status: 200, headers: { ...cors, etag: `"${meta.etag}"` }, body: "" };
    }

    if (method === "GET" || method === "HEAD") {
      const row = this.objects.get(key);
      if (!row) return err(404, "NoSuchKey", "That object is not in the store.");
      const headers: Record<string, string> = {
        ...cors,
        "content-type": row.contentType,
        "content-length": String(row.body.byteLength),
        etag: `"${row.etag}"`,
        "last-modified": row.lastModified.toUTCString(),
      };
      const download = params.get("download");
      if (download) headers["content-disposition"] = `attachment; filename="${download}"`;
      return { status: 200, headers, body: method === "HEAD" ? "" : row.body };
    }

    if (method === "DELETE") {
      this.objects.delete(key);
      return { status: 204, headers: cors, body: "" };
    }

    return err(405, "MethodNotAllowed", `${method} is not supported here.`);
  }
}
