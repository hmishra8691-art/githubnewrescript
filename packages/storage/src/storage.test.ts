import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryStorageProvider, R2StorageProvider, StorageError,
  clampExpiry, interviewPrefix, organizationPrefix, responseMediaKey, safeKeySegment,
  MAX_SIGNED_SECONDS, PLAYBACK_SECONDS,
} from "./index.js";
import {
  MAX_PARTS, MIN_PART_BYTES, PART_BYTES, PartAccumulator, allParts, partRange,
  planUpload, remainingParts, retryDelayMs, retryable, uploadProgress, UploadPlanError,
} from "./upload.js";

/* ============================================================ keys */

test("keys: predictable to us, useless to anyone else", () => {
  const key = responseMediaKey({
    organizationId: "org-1", interviewId: "iv-2", responseId: "rp-3", fileName: "recording.webm",
  });
  assert.equal(key, "organizations/org-1/interviews/iv-2/responses/rp-3/recording.webm");
  assert.ok(key.startsWith(organizationPrefix("org-1")), "an organization is one prefix");
  assert.ok(key.startsWith(interviewPrefix("org-1", "iv-2")), "and an interview is one prefix");
});

test("keys: a file name cannot climb out of its prefix", () => {
  assert.equal(safeKeySegment("../../etc/passwd"), "____etc_passwd");
  assert.equal(safeKeySegment(".hidden"), "_hidden");
  assert.equal(safeKeySegment(""), "_");
  assert.equal(safeKeySegment(null), "_");
  assert.equal(safeKeySegment("a/b"), "a_b", "a segment never contains a separator");
  assert.ok(!safeKeySegment("x".repeat(500)).includes("/"));
  assert.equal(safeKeySegment("x".repeat(500)).length, 80);
});

test("keys: an expiry is clamped to what an S3 store will sign", () => {
  assert.equal(clampExpiry(60, 900), 60);
  assert.equal(clampExpiry(undefined, 900), 900);
  assert.equal(clampExpiry(0, 900), 1);
  assert.equal(clampExpiry(365 * 24 * 3600, 900), MAX_SIGNED_SECONDS,
    "a year-long media URL is not expressible and must not be silently issued");
  assert.ok(PLAYBACK_SECONDS < MAX_SIGNED_SECONDS);
});

/* ============================================================ upload plan */

test("plan: a small object is one PUT", () => {
  const p = planUpload(400 * 1024);
  assert.equal(p.kind, "single");
  assert.equal(p.partCount, 1);
});

test("plan: a recording-sized object is multipart with legal parts", () => {
  const p = planUpload(36 * 1024 * 1024);
  assert.equal(p.kind, "multipart");
  assert.equal(p.partBytes, PART_BYTES);
  assert.equal(p.partCount, 5);
  const parts = allParts(p);
  assert.equal(parts.at(-1)!.end, p.totalBytes, "the parts cover the object exactly");
  for (const part of parts.slice(0, -1)) {
    assert.ok(part.bytes >= MIN_PART_BYTES, `part ${part.partNumber} is below the store's floor`);
  }
  assert.ok(parts.at(-1)!.bytes > 0, "and the last part is the only short one");
});

test("plan: the parts tile the object with no gap and no overlap", () => {
  for (const size of [PART_BYTES, PART_BYTES + 1, 36e6, 101e6, 5 * PART_BYTES]) {
    const p = planUpload(size);
    let at = 0;
    for (const part of allParts(p)) {
      assert.equal(part.start, at, `gap before part ${part.partNumber} of ${size}`);
      at = part.end;
    }
    assert.equal(at, p.totalBytes, `parts do not reach the end of ${size}`);
  }
});

test("plan: an object too large for 10,000 parts grows the part rather than failing", () => {
  const huge = MAX_PARTS * PART_BYTES * 2;
  const p = planUpload(huge);
  assert.ok(p.partCount <= MAX_PARTS);
  assert.ok(p.partBytes > PART_BYTES);
});

test("plan: a nonsense size is refused rather than guessed at", () => {
  assert.throws(() => planUpload(Number.NaN), UploadPlanError);
  assert.throws(() => planUpload(-1), UploadPlanError);
  assert.throws(() => partRange(planUpload(36e6), 0), UploadPlanError);
  assert.throws(() => partRange(planUpload(36e6), 99), UploadPlanError);
});

/* ============================================================ resume */

test("resume: only the parts the STORE is missing are sent again", () => {
  const p = planUpload(36 * 1024 * 1024);          // 5 parts
  const storeHas = [{ partNumber: 1 }, { partNumber: 2 }, { partNumber: 4 }];
  const left = remainingParts(p, storeHas).map((x) => x.partNumber);
  assert.deepEqual(left, [3, 5], "part 4 is not re-sent just because 3 failed");
});

test("resume: progress reflects what is stored, not what was attempted", () => {
  const p = planUpload(36 * 1024 * 1024);
  assert.equal(uploadProgress(p, []), 0);
  assert.ok(Math.abs(uploadProgress(p, [{ partNumber: 1 }, { partNumber: 2 }]) - 16 / 36) < 0.02);
  assert.equal(uploadProgress(p, allParts(p)), 1);
});

test("resume: a part number the store reports that we do not have is ignored", () => {
  const p = planUpload(36 * 1024 * 1024);
  assert.equal(uploadProgress(p, [{ partNumber: 999 }]), 0);
});

/* ============================================================ accumulator */

const chunk = (size: number) => ({ size });

test("accumulator: chunks become parts at the part size, remainder last", () => {
  const acc = new PartAccumulator(1000);
  assert.equal(acc.push(chunk(400)), null);
  assert.equal(acc.push(chunk(400)), null);
  const first = acc.push(chunk(400));
  assert.ok(first, "1200 bytes is a part");
  assert.equal(first!.partNumber, 1);
  assert.equal(first!.bytes, 1200);
  assert.equal(acc.buffered, 0, "a released part is not kept a second time");

  acc.push(chunk(150));
  const last = acc.finish();
  assert.equal(last!.partNumber, 2);
  assert.equal(last!.bytes, 150, "the last part is the only one allowed to be short");
  assert.equal(acc.totalBytes, 1350);
});

test("accumulator: finishing twice does not produce a second final part", () => {
  const acc = new PartAccumulator(1000);
  acc.push(chunk(10));
  assert.ok(acc.finish());
  assert.equal(acc.finish(), null, "an onstop that fires twice must not double the last part");
  assert.throws(() => acc.push(chunk(10)), UploadPlanError);
});

test("accumulator: an empty recording produces no parts at all", () => {
  const acc = new PartAccumulator(1000);
  assert.equal(acc.push(chunk(0)), null);
  assert.equal(acc.finish(), null);
  assert.equal(acc.totalBytes, 0);
});

/* ============================================================ retrying */

test("retry: backoff grows, is capped, and is jittered", () => {
  const fixed = () => 1;
  assert.equal(retryDelayMs(1, fixed), 500);
  assert.equal(retryDelayMs(2, fixed), 1000);
  assert.equal(retryDelayMs(10, fixed), 30_000);
  assert.equal(retryDelayMs(99, fixed), 30_000);
  assert.equal(retryDelayMs(3, () => 0), 1000, "jitter never delays less than half the base");
  assert.notEqual(retryDelayMs(3, () => 0), retryDelayMs(3, () => 1),
    "thirty candidates behind one router must not retry in lockstep");
});

test("retry: what is worth retrying", () => {
  assert.equal(retryable(null), true, "a network throw has no answer and may be transient");
  assert.equal(retryable(500), true);
  assert.equal(retryable(503), true);
  assert.equal(retryable(429), true);
  assert.equal(retryable(408), true);
  assert.equal(retryable(403), false, "an expired signature needs a new ticket, not another try");
  assert.equal(retryable(404), false);
  assert.equal(retryable(200), false);
});

/* ============================================================ the double */

const bytes = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

test("store: put, head, read, list, delete", async () => {
  const s = new MemoryStorageProvider();
  assert.equal(await s.exists("k"), false);
  assert.equal(await s.getMetadata("k"), null);

  const meta = await s.upload("organizations/o/a.webm", bytes(10), { contentType: "video/webm" });
  assert.equal(meta.size, 10);
  assert.equal(meta.contentType, "video/webm");
  assert.ok(meta.etag);

  assert.equal(await s.exists("organizations/o/a.webm"), true);
  assert.deepEqual(await s.read("organizations/o/a.webm"), bytes(10));

  await s.upload("organizations/o/b.webm", bytes(3));
  await s.upload("organizations/other/c.webm", bytes(3));
  const listed = await s.list(organizationPrefix("o"));
  assert.deepEqual(listed.objects.map((o) => o.key).sort(),
    ["organizations/o/a.webm", "organizations/o/b.webm"],
    "a prefix list does not cross into another organization");

  await s.delete(["organizations/o/a.webm"]);
  assert.equal(await s.exists("organizations/o/a.webm"), false);
});

test("store: deleting what is not there is not an error", async () => {
  const s = new MemoryStorageProvider();
  await s.delete(["nothing", "here"]);
  await s.delete([]);
});

test("store: ifAbsent refuses to overwrite a recording", async () => {
  const s = new MemoryStorageProvider();
  await s.upload("k", bytes(5), { ifAbsent: true });
  await assert.rejects(() => s.upload("k", bytes(5), { ifAbsent: true }), (e: StorageError) => {
    assert.equal(e.status, 409);
    return true;
  });
});

test("store: reading an absent object is a 404, not an empty buffer", async () => {
  const s = new MemoryStorageProvider();
  await assert.rejects(() => s.read("nope"), (e: StorageError) => e.status === 404);
});

/* ============================================================ multipart */

test("multipart: parts assemble in order regardless of the order they arrived", async () => {
  const s = new MemoryStorageProvider();
  const { uploadId } = await s.createMultipartUpload("k", { contentType: "video/webm" });

  const p1 = bytes(4, 1), p2 = bytes(4, 2), p3 = bytes(2, 3);
  const put = async (n: number, body: Uint8Array) => {
    const url = await s.signUploadPart("k", uploadId, n);
    const res = await s.handleRequest({ method: "PUT", url, body });
    assert.equal(res.status, 200);
    return { partNumber: n, etag: res.headers.etag!.replace(/"/g, "") };
  };
  // out of order on purpose: parallel uploads finish in whatever order they finish
  const e3 = await put(3, p3);
  const e1 = await put(1, p1);
  const e2 = await put(2, p2);

  const meta = await s.completeMultipartUpload("k", uploadId, [e3, e1, e2]);
  assert.equal(meta.size, 10);
  const stored = await s.read("k");
  assert.deepEqual(stored.slice(0, 4), p1);
  assert.deepEqual(stored.slice(4, 8), p2);
  assert.deepEqual(stored.slice(8), p3);
  assert.equal(meta.contentType, "video/webm", "the type from the create call survives");
});

test("multipart: the store's part list is what resume is computed from", async () => {
  const s = new MemoryStorageProvider();
  const { uploadId } = await s.createMultipartUpload("k");
  assert.deepEqual(await s.listUploadedParts("k", uploadId), []);

  for (const n of [1, 2, 4]) {
    const url = await s.signUploadPart("k", uploadId, n);
    await s.handleRequest({ method: "PUT", url, body: bytes(3, n) });
  }
  const have = await s.listUploadedParts("k", uploadId);
  assert.deepEqual(have.map((p) => p.partNumber), [1, 2, 4], "sorted, and only what arrived");

  const plan = { kind: "multipart" as const, totalBytes: 12, partBytes: 3, partCount: 4 };
  assert.deepEqual(remainingParts(plan, have).map((p) => p.partNumber), [3]);
});

test("multipart: a completion naming an etag the store never issued is refused", async () => {
  const s = new MemoryStorageProvider();
  const { uploadId } = await s.createMultipartUpload("k");
  const url = await s.signUploadPart("k", uploadId, 1);
  await s.handleRequest({ method: "PUT", url, body: bytes(4) });
  await assert.rejects(
    () => s.completeMultipartUpload("k", uploadId, [{ partNumber: 1, etag: "invented" }]),
    (e: StorageError) => e.status === 400,
  );
});

test("multipart: completing without a part that was promised is refused", async () => {
  const s = new MemoryStorageProvider();
  const { uploadId } = await s.createMultipartUpload("k");
  await assert.rejects(
    () => s.completeMultipartUpload("k", uploadId, [{ partNumber: 1, etag: "x" }]),
    (e: StorageError) => e.status === 400,
  );
  await assert.rejects(
    () => s.completeMultipartUpload("k", uploadId, []),
    (e: StorageError) => e.status === 400,
  );
});

test("multipart: abandoning releases the parts and cannot then be completed", async () => {
  const s = new MemoryStorageProvider();
  const { uploadId } = await s.createMultipartUpload("k");
  const url = await s.signUploadPart("k", uploadId, 1);
  await s.handleRequest({ method: "PUT", url, body: bytes(4) });
  await s.abortMultipartUpload("k", uploadId);
  assert.deepEqual(await s.listUploadedParts("k", uploadId), []);
  await assert.rejects(
    () => s.completeMultipartUpload("k", uploadId, [{ partNumber: 1, etag: "x" }]),
    (e: StorageError) => e.status === 404,
  );
  await s.abortMultipartUpload("k", uploadId);   // idempotent
});

test("multipart: re-uploading a part replaces it rather than appending", async () => {
  const s = new MemoryStorageProvider();
  const { uploadId } = await s.createMultipartUpload("k");
  const url = await s.signUploadPart("k", uploadId, 1);
  await s.handleRequest({ method: "PUT", url, body: bytes(4, 1) });
  const res = await s.handleRequest({ method: "PUT", url, body: bytes(4, 2) });
  const etag = res.headers.etag!.replace(/"/g, "");
  const meta = await s.completeMultipartUpload("k", uploadId, [{ partNumber: 1, etag }]);
  assert.equal(meta.size, 4, "a retried part is the same part, not a second one");
  assert.deepEqual(await s.read("k"), bytes(4, 2));
});

/* ============================================================ signatures */

test("http: an unsigned request is refused", async () => {
  const s = new MemoryStorageProvider();
  const res = await s.handleRequest({ method: "PUT", url: "/k", body: bytes(1) });
  assert.equal(res.status, 403);
  assert.match(String(res.body), /not signed/);
});

test("http: a PUT ticket does not authorise a GET, or another key", async () => {
  const s = new MemoryStorageProvider();
  await s.upload("k", bytes(4));
  const put = await s.createSignedUploadUrl("k");
  const asGet = await s.handleRequest({ method: "GET", url: put });
  assert.equal(asGet.status, 403);

  const elsewhere = put.replace("/k?", "/other?");
  const res = await s.handleRequest({ method: "PUT", url: elsewhere, body: bytes(1) });
  assert.equal(res.status, 403);
  assert.equal(await s.exists("other"), false);
});

test("http: an expired ticket is refused", async () => {
  let now = new Date("2026-01-01T00:00:00Z");
  const s = new MemoryStorageProvider({ now: () => now });
  const url = await s.createSignedUploadUrl("k", { expiresIn: 60 });
  now = new Date("2026-01-01T00:02:00Z");
  const res = await s.handleRequest({ method: "PUT", url, body: bytes(1) });
  assert.equal(res.status, 403);
  assert.match(String(res.body), /expired/);
});

test("http: a download URL serves the bytes and a filename", async () => {
  const s = new MemoryStorageProvider();
  await s.upload("k", bytes(6), { contentType: "video/webm" });
  const url = await s.createSignedDownloadUrl("k", { downloadAs: "answer.webm" });
  const res = await s.handleRequest({ method: "GET", url });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "video/webm");
  assert.match(res.headers["content-disposition"] ?? "", /answer\.webm/);
  assert.deepEqual(res.body, bytes(6));

  const head = await s.handleRequest({ method: "HEAD", url });
  assert.equal(head.headers["content-length"], "6");
  assert.equal(head.body, "", "a HEAD carries no body");
});

test("http: CORS is answered, because the browser asks before it uploads", async () => {
  const s = new MemoryStorageProvider();
  const res = await s.handleRequest({ method: "OPTIONS", url: "/k" });
  assert.equal(res.status, 204);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.match(res.headers["access-control-expose-headers"] ?? "", /etag/,
    "a browser cannot read the part etag unless it is exposed");
});

test("http: injected failures drive the retry path", async () => {
  const s = new MemoryStorageProvider({ failEveryNthWrite: 2 });
  const url = await s.createSignedUploadUrl("k");
  assert.equal((await s.handleRequest({ method: "PUT", url, body: bytes(1) })).status, 200);
  assert.equal((await s.handleRequest({ method: "PUT", url, body: bytes(1) })).status, 500);
  assert.equal((await s.handleRequest({ method: "PUT", url, body: bytes(1) })).status, 200);
});

/* ============================================================ R2 config */

test("r2: refuses to exist without credentials rather than failing later", () => {
  assert.throws(() => new R2StorageProvider({
    endpoint: "", bucket: "b", accessKeyId: "a", secretAccessKey: "s",
  }), (e: StorageError) => e.status === 500);
  assert.throws(() => new R2StorageProvider({
    endpoint: "https://x", bucket: "b", accessKeyId: "", secretAccessKey: "",
  }), (e: StorageError) => e.status === 500);
});

test("r2: a part number outside the store's range is refused before a round trip", async () => {
  const r2 = new R2StorageProvider({
    endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "b",
    accessKeyId: "a", secretAccessKey: "s",
    fetchImpl: async () => { throw new Error("must not be called"); },
  });
  await assert.rejects(() => r2.signUploadPart("k", "u", 0), (e: StorageError) => e.status === 400);
  await assert.rejects(() => r2.signUploadPart("k", "u", 10_001), (e: StorageError) => e.status === 400);
});

test("r2: the store's own words survive into the error", async () => {
  const r2 = new R2StorageProvider({
    endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "b",
    accessKeyId: "a", secretAccessKey: "s",
    fetchImpl: async () => new Response(
      `<?xml version="1.0"?><Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>`,
      { status: 404 },
    ),
  });
  await assert.rejects(() => r2.read("k"), (e: StorageError) => {
    assert.equal(e.status, 404);
    return true;
  });
  await assert.rejects(() => r2.list("p/"), (e: StorageError) => {
    assert.match(e.message, /NoSuchBucket: The specified bucket does not exist/);
    return true;
  });
});

test("r2: a network failure is a 503 that names itself, not a crash", async () => {
  const r2 = new R2StorageProvider({
    endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "b",
    accessKeyId: "a", secretAccessKey: "s",
    fetchImpl: async () => { throw new Error("ECONNRESET"); },
  });
  await assert.rejects(() => r2.getMetadata("k"), (e: StorageError) => {
    assert.equal(e.status, 503);
    assert.match(e.message, /ECONNRESET/);
    return true;
  });
});

test("r2: a 200 with an <Error> inside it is still a failure", async () => {
  const r2 = new R2StorageProvider({
    endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "b",
    accessKeyId: "a", secretAccessKey: "s",
    fetchImpl: async () => new Response(
      `<?xml version="1.0"?><Error><Code>InternalError</Code><Message>try again</Message></Error>`,
      { status: 200 },
    ),
  });
  await assert.rejects(
    () => r2.completeMultipartUpload("k", "u", [{ partNumber: 1, etag: "e" }]),
    (e: StorageError) => {
      assert.match(e.message, /InternalError: try again/);
      return true;
    },
  );
});

test("r2: signed URLs are path-style and carry the bucket", async () => {
  const r2 = new R2StorageProvider({
    endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "interviews",
    accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret",
    fetchImpl: async () => new Response("", { status: 200 }),
  });
  const url = new URL(await r2.createSignedUploadUrl("organizations/o/k.webm"));
  assert.equal(url.host, "acct.r2.cloudflarestorage.com");
  assert.equal(url.pathname, "/interviews/organizations/o/k.webm");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host",
    "only host is signed: every other header is a way for a browser PUT to fail");
});
