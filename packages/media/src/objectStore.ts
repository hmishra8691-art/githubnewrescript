/**
 * WHERE THE BYTES LIVE — behind one small interface.
 *
 * This package used to reach storage through a six-method slice of the
 * Supabase client. That made it portable in principle and Supabase-only in
 * practice: the vocabulary (`listBuckets`, `createBucket`, `from(bucket)`)
 * was Supabase's, and so were the one-year and five-year signed URLs it
 * permitted and this package baked into survey definitions and answers.
 *
 * `ObjectStore` is the vocabulary this package actually needs — grant an
 * upload, prove an object landed, sign a download, read, remove, copy — and
 * two adapters speak it:
 *
 *   - `providerObjectStore(provider)` over `@rescript/storage`'s
 *     `MediaStorageProvider` (Cloudflare R2 in production, the in-memory
 *     store in tests). The PRIMARY store for everything new.
 *   - `supabaseObjectStore(storage)` over the Supabase Storage client. The
 *     LEGACY store: it holds every object stored before the switch, and it
 *     keeps holding them. Nothing is moved.
 *
 * A row says which store holds it (`media_objects.storage_provider`), so a
 * read, a delete or a download URL goes to the right one without anybody
 * migrating bytes. Existing long-lived URLs embedded in definitions keep
 * working because the objects they point at are exactly where they were.
 *
 * ## Buckets become prefixes
 *
 * The three logical buckets — `rescript-video`, `rescript-uploads`,
 * `rescript-audio` — are the kinds' homes and stay in the rows. On the
 * provider store they are key prefixes inside ONE bucket (`video/…`,
 * `uploads/…`, `audio/…`), which is what an S3-shaped store wants and what
 * makes a bucket listing legible.
 *
 * ## No long URLs
 *
 * A signed URL from the provider store lives at most `MAX_SIGNED_SECONDS`
 * (seven days; playback fifteen minutes). That is a better design than the
 * old permission, and it is why the primary store never returns a URL for a
 * definition to keep: callers store a STABLE application URL
 * (`mediaUrl(mediaId)`) and the app redirects to a fresh signed one, after an
 * access check, each time it is played.
 */
import type { MediaStorageProvider, CompletedPart } from "@rescript/storage";

/** A part the browser must still send, and where. */
export interface PartGrant { partNumber: number; url: string; start: number; end: number }

export type UploadGrant =
  | { kind: "single"; url: string; headers?: Record<string, string> }
  | { kind: "multipart"; uploadId: string; partBytes: number; partCount: number; parts: PartGrant[] };

export interface ObjectHead { size: number; contentType: string | null; etag: string | null }

export interface RemoveReport {
  /** paths confirmed absent after the delete */
  removed: string[];
  /** paths the store still had, or refused to delete, with its words */
  failed: { path: string; reason: string }[];
}

export interface ObjectStore {
  /** what a row records: "supabase" | "cloudflare-r2" | "memory" */
  readonly name: string;
  /** Can this store hand out multipart grants and complete them? */
  readonly multipart: boolean;
  /**
   * The largest object of a kind this store will take, given what the
   * package would like. Supabase answers with the project's own ceiling;
   * the provider store answers with the wish.
   */
  ceiling(bucket: string, wanted: number): Promise<number>;
  /** An upload the browser performs itself. Multipart when the store can and the size warrants it. */
  grantUpload(bucket: string, path: string, opts: { bytes?: number | null; contentType?: string | null; expiresIn?: number }): Promise<UploadGrant>;
  /** Which parts the store already has, and grants for the rest. */
  resumeUpload(bucket: string, path: string, uploadId: string, bytes: number, opts?: { expiresIn?: number }): Promise<{ uploaded: CompletedPart[]; parts: PartGrant[]; partBytes: number; partCount: number }>;
  /** Assemble a multipart upload. */
  completeUpload(bucket: string, path: string, uploadId: string, parts: CompletedPart[]): Promise<ObjectHead>;
  /** Release a multipart upload's parts. Idempotent. */
  abortUpload(bucket: string, path: string, uploadId: string): Promise<void>;
  /** The store's own account of the object, or null. */
  head(bucket: string, path: string): Promise<ObjectHead | null>;
  /** A URL to fetch the object with, for `seconds` at most (the store may cap it). */
  signDownload(bucket: string, path: string, opts: { seconds: number; downloadAs?: string | null; contentType?: string | null }): Promise<string>;
  /** Read the whole object. Processing only. */
  read(bucket: string, path: string): Promise<Uint8Array>;
  /** Delete, then CHECK: a path is only `removed` when a HEAD afterwards finds nothing. */
  remove(bucket: string, paths: string[]): Promise<RemoveReport>;
  /** Duplicate inside the store. Throws if the store cannot. */
  copy(bucket: string, fromPath: string, toBucket: string, toPath: string, opts?: { contentType?: string | null }): Promise<ObjectHead>;
}

/** The stores an installation has, and which holds a given row. */
export interface MediaStores {
  /** where everything new goes */
  primary: ObjectStore;
  /** by `media_objects.storage_provider`; null for a name nobody configured */
  byName(name: string | null | undefined): ObjectStore | null;
}

export function mediaStores(primary: ObjectStore, ...others: ObjectStore[]): MediaStores {
  const all = new Map<string, ObjectStore>();
  for (const s of [primary, ...others]) all.set(s.name, s);
  return {
    primary,
    byName(name) {
      if (!name) return all.get("supabase") ?? null; /* rows from before the column existed */
      return all.get(name) ?? null;
    },
  };
}

/**
 * The stable, access-checked URL a definition or an answer keeps for a
 * provider-stored object. With a file name it ends in that name, so a
 * consumer that decides by extension (an `<img>`, the media resolver) can.
 */
export function mediaUrl(mediaId: string, fileName?: string | null): string {
  const base = `/api/media/${encodeURIComponent(mediaId)}`;
  const leaf = (fileName ?? "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
  return leaf ? `${base}/${leaf}` : base;
}

export const MEDIA_URL_PATTERN = /^\/api\/media\/([^/?#]+)(?:\/[^/?#]+)?$/;

/** Is this a URL this package minted (as opposed to a legacy long-lived storage URL)? */
export function isMediaUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && MEDIA_URL_PATTERN.test(url);
}

/** The media id inside one of our URLs, or null. */
export function mediaIdFromUrl(url: string | null | undefined): string | null {
  const m = typeof url === "string" ? MEDIA_URL_PATTERN.exec(url) : null;
  return m ? decodeURIComponent(m[1]!) : null;
}

/* ------------------------------------------------------------ provider */

/** The logical bucket names, as key prefixes in the one real bucket. */
export const BUCKET_PREFIX: Record<string, string> = {
  "rescript-video": "video",
  "rescript-uploads": "uploads",
  "rescript-audio": "audio",
  "rescript-assets": "assets",
};

export function providerKey(bucket: string, path: string): string {
  const prefix = BUCKET_PREFIX[bucket] ?? bucket.replace(/^rescript-/, "");
  return `${prefix}/${path.replace(/^\/+/, "")}`;
}

/** Objects up to this go as one PUT; larger ones are cut into parts. */
export const SINGLE_PUT_MAX_BYTES = 16 * 1024 * 1024;
const PART_BYTES = 8 * 1024 * 1024;
const UPLOAD_SECONDS = 2 * 60 * 60;

function planParts(bytes: number): { partBytes: number; partCount: number } {
  const total = Math.max(1, bytes);
  let partBytes = PART_BYTES;
  while (Math.ceil(total / partBytes) > 10_000) partBytes *= 2;
  return { partBytes, partCount: Math.max(1, Math.ceil(total / partBytes)) };
}

export function providerObjectStore(provider: MediaStorageProvider): ObjectStore {
  const key = providerKey;
  const toHead = (m: { size: number; contentType?: string | null; etag?: string | null } | null): ObjectHead | null =>
    m ? { size: m.size, contentType: m.contentType ?? null, etag: m.etag ?? null } : null;

  return {
    name: provider.name,
    multipart: true,

    async ceiling(_bucket, wanted) { return wanted; },

    async grantUpload(bucket, path, opts) {
      const k = key(bucket, path);
      const expiresIn = opts.expiresIn ?? UPLOAD_SECONDS;
      const bytes = typeof opts.bytes === "number" && opts.bytes > 0 ? opts.bytes : 0;
      if (!bytes || bytes <= SINGLE_PUT_MAX_BYTES) {
        return {
          kind: "single",
          url: await provider.createSignedUploadUrl(k, { expiresIn, contentType: opts.contentType ?? undefined }),
        };
      }
      const mp = await provider.createMultipartUpload(k, { contentType: opts.contentType ?? undefined });
      const plan = planParts(bytes);
      const parts: PartGrant[] = [];
      for (let n = 1; n <= plan.partCount; n++) {
        const start = (n - 1) * plan.partBytes;
        parts.push({
          partNumber: n,
          url: await provider.signUploadPart(k, mp.uploadId, n, { expiresIn }),
          start,
          end: Math.min(bytes, start + plan.partBytes),
        });
      }
      return { kind: "multipart", uploadId: mp.uploadId, partBytes: plan.partBytes, partCount: plan.partCount, parts };
    },

    async resumeUpload(bucket, path, uploadId, bytes, opts = {}) {
      const k = key(bucket, path);
      const expiresIn = opts.expiresIn ?? UPLOAD_SECONDS;
      const plan = planParts(bytes);
      const uploaded = await provider.listUploadedParts(k, uploadId);
      const have = new Set(uploaded.map((p) => p.partNumber));
      const parts: PartGrant[] = [];
      for (let n = 1; n <= plan.partCount; n++) {
        if (have.has(n)) continue;
        const start = (n - 1) * plan.partBytes;
        parts.push({
          partNumber: n,
          url: await provider.signUploadPart(k, uploadId, n, { expiresIn }),
          start,
          end: Math.min(bytes, start + plan.partBytes),
        });
      }
      return { uploaded, parts, partBytes: plan.partBytes, partCount: plan.partCount };
    },

    async completeUpload(bucket, path, uploadId, parts) {
      const meta = await provider.completeMultipartUpload(key(bucket, path), uploadId, parts);
      return toHead(meta)!;
    },

    async abortUpload(bucket, path, uploadId) {
      await provider.abortMultipartUpload(key(bucket, path), uploadId).catch(() => {});
    },

    async head(bucket, path) {
      return toHead(await provider.getMetadata(key(bucket, path)));
    },

    async signDownload(bucket, path, opts) {
      return provider.createSignedDownloadUrl(key(bucket, path), {
        expiresIn: opts.seconds,
        downloadAs: opts.downloadAs ?? undefined,
        contentType: opts.contentType ?? undefined,
      });
    },

    async read(bucket, path) {
      return provider.read(key(bucket, path));
    },

    async remove(bucket, paths) {
      const report: RemoveReport = { removed: [], failed: [] };
      if (!paths.length) return report;
      try {
        await provider.delete(paths.map((p) => key(bucket, p)));
      } catch (e) {
        for (const p of paths) report.failed.push({ path: p, reason: (e as Error).message });
        return report;
      }
      /* the check — a delete that returned 200 is a claim; a HEAD is a fact */
      for (const p of paths) {
        try {
          if (await provider.exists(key(bucket, p))) report.failed.push({ path: p, reason: "the object is still in the store after the delete" });
          else report.removed.push(p);
        } catch (e) {
          report.failed.push({ path: p, reason: `could not verify the delete: ${(e as Error).message}` });
        }
      }
      return report;
    },

    async copy(bucket, fromPath, toBucket, toPath, opts = {}) {
      const meta = await provider.copy(key(bucket, fromPath), key(toBucket, toPath), { contentType: opts.contentType ?? undefined });
      return toHead(meta)!;
    },
  };
}

/* ------------------------------------------------------------ supabase */

/**
 * The slice of the Supabase Storage client the legacy store calls. Typed
 * structurally so this package still imports nothing from the library.
 */
export interface SupabaseStorageLike {
  listBuckets(): PromiseLike<{ data: Array<{ name: string; file_size_limit?: number | null }> | null; error: { message: string } | null }>;
  createBucket(name: string, opts: { public: boolean; fileSizeLimit?: number }): PromiseLike<{ error: { message: string } | null }>;
  from(bucket: string): {
    createSignedUploadUrl(path: string): PromiseLike<{ data: { signedUrl: string; token: string; path: string } | null; error: { message: string } | null }>;
    createSignedUrl(path: string, seconds: number, opts?: { download?: string | boolean }): PromiseLike<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
    download(path: string): PromiseLike<{ data: { arrayBuffer(): Promise<ArrayBuffer>; type?: string } | null; error: { message: string } | null }>;
    remove(paths: string[]): PromiseLike<{ data: unknown; error: { message: string } | null }>;
    /**
     * `search` narrows the listing to names containing it and `offset` pages
     * through what is left — both are Supabase's own parameters, and `head`
     * below needs them to ask about ONE object rather than hoping it is in
     * the first page of its folder.
     */
    list(path: string, opts?: { limit?: number; offset?: number; search?: string }): PromiseLike<{ data: { name: string; metadata?: { size?: number; mimetype?: string } | null }[] | null; error: { message: string } | null }>;
    copy?(from: string, to: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
}

/** True for the storage service's refusal of a limit above the project's own. */
function isLimitRefusal(message: string): boolean {
  return /exceeded the maximum allowed size|maximum allowed size|exceeds the maximum/i.test(message);
}

export function supabaseObjectStore(storage: SupabaseStorageLike): ObjectStore {
  const ensured = new Map<string, number>();

  const split = (path: string) => {
    const segs = path.split("/");
    return { folder: segs.slice(0, -1).join("/"), leaf: segs[segs.length - 1]! };
  };

  /**
   * A HEAD this store does not have, emulated by asking for the one name.
   *
   * It used to list the folder with `limit: 1000` and look for the leaf in
   * what came back — so an object really sitting in a folder with more than a
   * thousand siblings answered "not there". That answer is not a nuisance:
   * `confirmUpload` reads it as proof the upload failed, marks the row
   * `failed` and tells the researcher their file did not arrive, for a file
   * that did. A busy survey's asset folder reaches a thousand objects on its
   * own, and the failure would start on one particular upload and never stop.
   *
   * `search` narrows the listing to that name server-side, which is the whole
   * question being asked. The paging loop stays as a belt-and-braces for a
   * deployment where `search` is not honoured: a full page with no hit is the
   * only case in which "not found" could be an artefact of the page size, so
   * it is the only case that asks for another page.
   */
  const head = async (bucket: string, path: string): Promise<ObjectHead | null> => {
    const { folder, leaf } = split(path);
    const PAGE = 1000;
    for (let offset = 0; offset < 50_000; offset += PAGE) {
      const listed = await storage.from(bucket).list(folder, { limit: PAGE, offset, search: leaf });
      if (listed.error) throw new Error(listed.error.message);
      const page = listed.data ?? [];
      const hit = page.find((f) => f.name === leaf);
      if (hit) {
        return { size: Number(hit.metadata?.size ?? 0), contentType: hit.metadata?.mimetype ?? null, etag: null };
      }
      if (page.length < PAGE) return null;
    }
    return null;
  };

  return {
    name: "supabase",
    multipart: false,

    /*
     * A Supabase project has a GLOBAL upload limit — 50 MB by default — and a
     * bucket may not declare one above it. The limit asked for is a
     * preference; what comes back is what the project will accept, read back
     * rather than assumed. (The history of why is in `docs/`: a one-second
     * clip was once refused as "too large" because the bucket never existed.)
     */
    async ceiling(bucket, wanted) {
      const known = ensured.get(bucket);
      if (known !== undefined) return known;
      const { data: buckets, error } = await storage.listBuckets();
      if (error) throw new Error(`could not check storage buckets: ${error.message}`);
      const existing = buckets?.find((b) => b.name === bucket);
      if (existing) {
        const limit = typeof existing.file_size_limit === "number" && existing.file_size_limit > 0
          ? Math.min(existing.file_size_limit, wanted) : wanted;
        ensured.set(bucket, limit);
        return limit;
      }
      let made = await storage.createBucket(bucket, { public: false, fileSizeLimit: wanted });
      if (made.error && isLimitRefusal(made.error.message)) made = await storage.createBucket(bucket, { public: false });
      if (made.error && !/already exists/i.test(made.error.message)) {
        throw new Error(`could not create the storage bucket: ${made.error.message}`);
      }
      const after = await storage.listBuckets();
      const row = after.data?.find((b) => b.name === bucket);
      const limit = row && typeof row.file_size_limit === "number" && row.file_size_limit > 0
        ? Math.min(row.file_size_limit, wanted) : wanted;
      ensured.set(bucket, limit);
      return limit;
    },

    async grantUpload(bucket, path) {
      const signed = await storage.from(bucket).createSignedUploadUrl(path);
      if (signed.error || !signed.data) throw new Error(signed.error?.message ?? "no upload url");
      return { kind: "single", url: signed.data.signedUrl, headers: { "x-upsert": "false" } };
    },
    async resumeUpload() { throw new Error("Supabase Storage does not resume uploads"); },
    async completeUpload() { throw new Error("Supabase Storage has no multipart upload to complete"); },
    async abortUpload() { /* nothing to release */ },

    head,

    async signDownload(bucket, path, opts) {
      const signed = await storage.from(bucket).createSignedUrl(path, opts.seconds, opts.downloadAs ? { download: opts.downloadAs } : undefined);
      if (signed.error || !signed.data) throw new Error(signed.error?.message ?? "no url");
      return signed.data.signedUrl;
    },

    async read(bucket, path) {
      const { data, error } = await storage.from(bucket).download(path);
      if (error || !data) throw new Error(error?.message ?? "not found");
      return new Uint8Array(await data.arrayBuffer());
    },

    async remove(bucket, paths) {
      const report: RemoveReport = { removed: [], failed: [] };
      if (!paths.length) return report;
      const { error } = await storage.from(bucket).remove(paths);
      if (error) {
        for (const p of paths) report.failed.push({ path: p, reason: error.message });
        return report;
      }
      for (const p of paths) {
        try {
          if (await head(bucket, p)) report.failed.push({ path: p, reason: "the object is still in the store after the delete" });
          else report.removed.push(p);
        } catch (e) {
          report.failed.push({ path: p, reason: `could not verify the delete: ${(e as Error).message}` });
        }
      }
      return report;
    },

    async copy(bucket, fromPath, toBucket, toPath) {
      const from = storage.from(bucket);
      if (bucket !== toBucket || !from.copy) throw new Error("Supabase Storage cannot copy this object here");
      const { error } = await from.copy(fromPath, toPath);
      if (error) throw new Error(error.message);
      const h = await head(toBucket, toPath);
      if (!h) throw new Error("the copy did not appear in the store");
      return h;
    },
  };
}
