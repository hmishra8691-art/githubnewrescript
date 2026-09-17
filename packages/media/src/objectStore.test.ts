import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStorageProvider } from "@rescript/storage";
import {
  beginUpload, confirmUpload, copyMedia, freshUrl, removeMedia, resumeUpload, readObject, headObject, MediaError,
} from "./store.js";
import {
  SINGLE_PUT_MAX_BYTES, isMediaUrl, mediaStores, mediaUrl, providerKey, providerObjectStore, supabaseObjectStore,
} from "./objectStore.js";
import { stub } from "./store.test.js";

/**
 * THE PROVIDER STORE, AGAINST A REAL OBJECT STORE.
 *
 * `MemoryStorageProvider` is not a mock: it issues etags, refuses unsigned
 * requests, assembles multiparts and lists the parts it holds. What these
 * tests prove is the seam — that `packages/media` gets everything it needs
 * from `@rescript/storage` and stores nothing it should not.
 */
function harness() {
  const provider = new MemoryStorageProvider();
  const primary = providerObjectStore(provider);
  const s = stub({ stores: mediaStores(primary) });
  return { ...s, provider, primary };
}

const BEGIN = {
  kind: "question_video" as const, customerId: "cust-1", surveyId: "sv-1", questionId: "q-1",
  fileName: "question.webm", mimeType: "video/webm", now: 1_700_000_000_000,
};

/** Perform the browser's half of an upload against the memory store. */
async function putSingle(provider: MemoryStorageProvider, url: string, body: Uint8Array) {
  const res = await provider.handleRequest({ method: "PUT", url, body });
  assert.equal(res.status, 200, `PUT failed: ${res.status} ${String(res.body)}`);
}
async function putParts(provider: MemoryStorageProvider, parts: { partNumber: number; url: string; start: number; end: number }[], body: Uint8Array) {
  const done: { partNumber: number; etag: string }[] = [];
  for (const p of parts) {
    const res = await provider.handleRequest({ method: "PUT", url: p.url, body: body.slice(p.start, p.end) });
    assert.equal(res.status, 200, `part ${p.partNumber} failed: ${res.status}`);
    done.push({ partNumber: p.partNumber, etag: res.headers.etag ?? res.headers.ETag! });
  }
  return done;
}

test("logical buckets become prefixes in the one real bucket", () => {
  assert.equal(providerKey("rescript-video", "sv/q/1-a.webm"), "video/sv/q/1-a.webm");
  assert.equal(providerKey("rescript-uploads", "/sess/q/x.webm"), "uploads/sess/q/x.webm");
  assert.equal(providerKey("rescript-assets", "sv/q/doc.pdf"), "assets/sv/q/doc.pdf");
});

test("A SMALL OBJECT IS ONE PUT, and the row records which store took it", async () => {
  const h = harness();
  const ticket = await beginUpload(h.db, { ...BEGIN, bytes: 3_000 });
  assert.equal(ticket.kind, "single");
  assert.equal(ticket.storageProvider, "memory");
  assert.equal(h.rows.get(ticket.mediaId)!.storage_provider, "memory");
  assert.ok(ticket.uploadUrl);
  await putSingle(h.provider, ticket.uploadUrl!, new Uint8Array(3_000).fill(7));
  const stored = await confirmUpload(h.db, ticket.mediaId, { durationSeconds: 12 });
  assert.equal(stored.bytes, 3_000, "the size is the store's, not the client's word");
  /* THE URL IS OURS, NOT A FIVE-YEAR CREDENTIAL */
  assert.equal(stored.url, mediaUrl(ticket.mediaId, "question.webm"));
  assert.ok(stored.url.endsWith("/question.webm"), "ends in the file name, so consumers that decide by extension can");
  assert.ok(isMediaUrl(stored.url));
  assert.equal(h.rows.get(ticket.mediaId)!.status, "stored");
});

test("A LARGE OBJECT GOES IN PARTS, is assembled at confirm, and is verified by HEAD", async () => {
  const h = harness();
  const size = SINGLE_PUT_MAX_BYTES + 3_000_000;
  const body = new Uint8Array(size).fill(1);
  const ticket = await beginUpload(h.db, { ...BEGIN, bytes: size });
  assert.equal(ticket.kind, "multipart");
  assert.ok(ticket.uploadId);
  assert.ok(ticket.parts.length >= 2);
  assert.equal(h.rows.get(ticket.mediaId)!.multipart_upload_id, ticket.uploadId);

  const etags = await putParts(h.provider, ticket.parts, body);
  const stored = await confirmUpload(h.db, ticket.mediaId, {}, etags);
  assert.equal(stored.bytes, size);
  assert.equal(h.rows.get(ticket.mediaId)!.multipart_upload_id, null, "the in-flight id is cleared once assembled");
  const head = await headObject(h.db, { bucket: ticket.bucket, path: ticket.path, storage_provider: "memory" });
  assert.equal(head?.size, size);
});

test("a multipart confirm with no etags is refused before anything is called saved", async () => {
  const h = harness();
  const ticket = await beginUpload(h.db, { ...BEGIN, bytes: SINGLE_PUT_MAX_BYTES + 1 });
  await assert.rejects(() => confirmUpload(h.db, ticket.mediaId, {}), (e: MediaError) => e.status === 400);
  assert.equal(h.rows.get(ticket.mediaId)!.status, "pending");
});

test("AN INTERRUPTED UPLOAD RESUMES FROM WHAT THE STORE HAS — the same take, the same row", async () => {
  const h = harness();
  const size = SINGLE_PUT_MAX_BYTES * 2 + 100;
  const body = new Uint8Array(size).fill(2);
  const t1 = await beginUpload(h.db, { ...BEGIN, bytes: size, clientToken: "take-1" });
  assert.equal(t1.kind, "multipart");
  /* the browser sends the first part and then loses the network */
  const first = await putParts(h.provider, t1.parts.slice(0, 1), body);

  /* it comes back — a refresh, a retry — and begins again with the same token */
  const t2 = await beginUpload(h.db, { ...BEGIN, bytes: size, clientToken: "take-1" });
  assert.equal(t2.mediaId, t1.mediaId, "the same row");
  assert.equal(t2.uploadId, t1.uploadId, "the same multipart upload");
  assert.deepEqual(t2.uploaded.map((p) => p.partNumber), [1], "the store says what it has");
  assert.ok(t2.parts.every((p) => p.partNumber !== 1), "only the missing parts are granted");
  assert.equal(h.rows.size, 1, "no second row, no second object");

  const rest = await putParts(h.provider, t2.parts, body);
  const stored = await confirmUpload(h.db, t1.mediaId, {}, [...first, ...rest]);
  assert.equal(stored.bytes, size);

  /* and a begin after completion says so rather than opening a third upload */
  const t3 = await beginUpload(h.db, { ...BEGIN, bytes: size, clientToken: "take-1" });
  assert.equal(t3.alreadyStored, true);
  assert.equal(t3.mediaId, t1.mediaId);
});

test("resumeUpload answers for a row by id, for a browser that kept the media id and lost everything else", async () => {
  const h = harness();
  const size = SINGLE_PUT_MAX_BYTES + 10;
  const t = await beginUpload(h.db, { ...BEGIN, bytes: size });
  const r = await resumeUpload(h.db, t.mediaId, size);
  assert.equal(r.kind, "multipart");
  assert.equal(r.parts.length, t.parts.length);
  await assert.rejects(() => resumeUpload(h.db, "nope"), (e: MediaError) => e.status === 404);
});

test("a fresh URL is short-lived and comes from the store that holds the object", async () => {
  const h = harness();
  const t = await beginUpload(h.db, { ...BEGIN, bytes: 100 });
  await putSingle(h.provider, t.uploadUrl!, new Uint8Array(100));
  await confirmUpload(h.db, t.mediaId);
  const before = Math.floor(Date.now() / 1000);
  const { url, row } = await freshUrl(h.db, t.mediaId);
  const expiresAt = Number(new URL(url).searchParams.get("X-Expires-At"));
  assert.ok(expiresAt - before <= 15 * 60 + 5 && expiresAt - before >= 15 * 60 - 60, `a fifteen-minute credential, got ${expiresAt - before}s`);
  assert.equal(row.kind, "question_video");
  /* an object still uploading has no URL to give */
  const pending = await beginUpload(h.db, { ...BEGIN, bytes: 100, questionId: "q-2" });
  await assert.rejects(() => freshUrl(h.db, pending.mediaId), (e: MediaError) => e.status === 409);
});

test("A DELETE IS CHECKED, NOT TRUSTED, and written down", async () => {
  const h = harness();
  const t = await beginUpload(h.db, { ...BEGIN, bytes: 100 });
  await putSingle(h.provider, t.uploadUrl!, new Uint8Array(100));
  await confirmUpload(h.db, t.mediaId);
  const report = await removeMedia(h.db, [{
    id: t.mediaId, bucket: t.bucket, path: t.path, storage_provider: "memory",
    customer_id: "cust-1", survey_id: "sv-1", kind: "question_video", bytes: 100,
  }], "purge_question");
  assert.equal(report.objects, 1);
  assert.equal(report.rows, 1);
  assert.equal(h.deletions.length, 1);
  assert.equal(h.deletions[0]!.verified, true);
  assert.equal(h.deletions[0]!.reason, "purge_question");
  assert.equal(await h.primary.head(t.bucket, t.path), null);
  await assert.rejects(() => readObject(h.db, { bucket: t.bucket, path: t.path, storage_provider: "memory" }));
});

test("a row naming a store nobody configured is said, not silently skipped", async () => {
  const h = harness();
  const report = await removeMedia(h.db, [{ id: "x", bucket: "rescript-video", path: "a/b/c", storage_provider: "cloudflare-r2" }]);
  assert.equal(report.objects, 0);
  assert.match(report.warnings[0]!, /no object store named "cloudflare-r2"/);
});

test("A CLONE IS A COPY: the bytes move inside the store and the new row has its own URL", async () => {
  const h = harness();
  const t = await beginUpload(h.db, { ...BEGIN, bytes: 50 });
  await putSingle(h.provider, t.uploadUrl!, new Uint8Array(50).fill(9));
  await confirmUpload(h.db, t.mediaId, { durationSeconds: 5 });
  const copy = await copyMedia(h.db, t.mediaId, { surveyId: "sv-2", questionId: "q-9", now: 1_700_000_000_001 });
  assert.notEqual(copy.mediaId, t.mediaId);
  assert.equal(copy.url, mediaUrl(copy.mediaId, "question.webm"));
  assert.equal(copy.durationSeconds, 5);
  assert.ok(copy.path.startsWith("sv-2/q-9/"));
  assert.equal((await h.primary.head(copy.bucket, copy.path))?.size, 50);
  /* deleting the original leaves the clone whole */
  await removeMedia(h.db, [{ id: t.mediaId, bucket: t.bucket, path: t.path, storage_provider: "memory" }]);
  assert.equal((await h.primary.head(copy.bucket, copy.path))?.size, 50);
});

test("legacy rows dispatch to the legacy store; new rows to the primary — nothing moves", async () => {
  const provider = new MemoryStorageProvider();
  const legacyObjects = new Set<string>(["rescript-video/old/q/1-a.webm"]);
  const legacy = supabaseObjectStore({
    listBuckets: async () => ({ data: [{ name: "rescript-video" }], error: null }),
    createBucket: async () => ({ error: null }),
    from: (bucket: string) => ({
      createSignedUploadUrl: async () => ({ data: null, error: { message: "legacy takes no new uploads in this test" } }),
      createSignedUrl: async (path: string, seconds: number) => ({ data: { signedUrl: `https://legacy.test/${bucket}/${path}?t=${seconds}` }, error: null }),
      download: async () => ({ data: { arrayBuffer: async () => new Uint8Array([1]).buffer }, error: null }),
      remove: async () => ({ data: null, error: null }),
      list: async (folder: string) => ({ data: [...legacyObjects].filter((o) => o.startsWith(`${bucket}/${folder}/`)).map((o) => ({ name: o.split("/").pop()! })), error: null }),
    }),
  });
  const s = stub({ stores: mediaStores(providerObjectStore(provider), legacy) });
  /* a row from before the column existed: storage_provider unset */
  s.rows.set("legacy-1", { id: "legacy-1", bucket: "rescript-video", path: "old/q/1-a.webm", kind: "question_video", status: "stored", storage_provider: null, mime_type: "video/webm", survey_id: "sv-1" });
  const { url } = await freshUrl(s.db, "legacy-1");
  assert.match(url, /^https:\/\/legacy\.test\//, "the legacy store answers for the legacy row");
  /* while a new upload goes to the primary */
  const t = await beginUpload(s.db, { ...BEGIN, bytes: 10 });
  assert.equal(t.storageProvider, "memory");
});
