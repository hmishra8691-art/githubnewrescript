import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStorageProvider } from "@rescript/storage";
import { PART_BYTES } from "@rescript/storage/upload";
import {
  COMPLETION_SAY, checkAfterAssembly, checkBeforeAssembly, completionReason,
} from "./completion.js";

/*
 * The bug these exist for, stated once:
 *
 *   a completion that assembles whatever parts happen to be in the store marks
 *   a truncated recording "saved", and a truncated video plays perfectly, so
 *   nobody finds out.
 *
 * Every assertion below is a way that could happen. The last group runs them
 * against a real object store rather than a mock, because the interesting
 * failures are the ones where the store and the client disagree — and a mock
 * that agrees with the client by construction cannot produce one.
 */

const part = (n: number) => ({ partNumber: n, etag: `etag-${n}` });

/** Upload one part the way a browser does: a signed URL and a PUT. */
async function putPart(
  s: MemoryStorageProvider, key: string, uploadId: string, n: number, body: Uint8Array,
) {
  const url = await s.signUploadPart(key, uploadId, n);
  const res = await s.handleRequest({ method: "PUT", url, body });
  assert.equal(res.status, 200, `part ${n} should upload`);
  return { partNumber: n, etag: String(res.headers.etag ?? "").replace(/"/g, "") };
}


/* ---------------------------------------------------- before assembly */

test("a single PUT has no parts and nothing to assemble", () => {
  const v = checkBeforeAssembly({
    multipartUploadId: null, knownParts: [], claimedParts: [], declaredBytes: 1234,
  });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.parts, null);
});

test("A SHORT UPLOAD IS REFUSED BEFORE ANYTHING IS ASSEMBLED", () => {
  /*
   * Three parts in the store, five owed by the declared size. Assembling would
   * produce a playable, wrong recording.
   */
  const v = checkBeforeAssembly({
    multipartUploadId: "u1",
    knownParts: [part(1), part(2), part(3)],
    claimedParts: [part(1), part(2), part(3), part(4), part(5)],
    declaredBytes: PART_BYTES * 5,
  });
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.code, "short");
  assert.equal(!v.ok && v.code === "short" && v.have, 3);
  assert.equal(!v.ok && v.code === "short" && v.expected, 5);
});

test("the CLIENT's optimism does not override the store", () => {
  /*
   * The client says all five went. The store holds three. The store wins —
   * this is the exact shape of the bug: a part that returns 200 and then is
   * not there is a part the client believes it sent.
   */
  const v = checkBeforeAssembly({
    multipartUploadId: "u1",
    knownParts: [part(1), part(2), part(3)],
    claimedParts: [part(1), part(2), part(3), part(4), part(5)],
    declaredBytes: PART_BYTES * 5,
  });
  assert.equal(v.ok, false);
});

test("a complete upload assembles from the store's list, not the client's", () => {
  const v = checkBeforeAssembly({
    multipartUploadId: "u1",
    knownParts: [part(1), part(2)],
    claimedParts: [part(1), part(2), part(99)],
    declaredBytes: PART_BYTES * 2,
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.ok && v.parts?.map((p) => p.partNumber), [1, 2]);
});

test("nothing at all is refused", () => {
  const v = checkBeforeAssembly({
    multipartUploadId: "u1", knownParts: [], claimedParts: [], declaredBytes: PART_BYTES * 2,
  });
  assert.equal(!v.ok && v.code, "empty");
});

test("a store that has FORGOTTEN the upload falls back rather than refusing", () => {
  /*
   * `knownParts: null` is "we could not ask", which is not evidence of a short
   * recording. Refusing here would fail a legitimate late completion — and the
   * HEAD afterwards still has to pass, so nothing is trusted on this path.
   */
  const v = checkBeforeAssembly({
    multipartUploadId: "u1",
    knownParts: null,
    claimedParts: [part(1), part(2)],
    declaredBytes: PART_BYTES * 2,
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.ok && v.parts?.map((p) => p.partNumber), [1, 2]);
});

test("with no declared size there is nothing to be short of", () => {
  const v = checkBeforeAssembly({
    multipartUploadId: "u1", knownParts: [part(1)], claimedParts: [], declaredBytes: null,
  });
  assert.equal(v.ok, true);
});

/* ----------------------------------------------------- after assembly */

test("an object that is not there is refused", () => {
  assert.equal(checkAfterAssembly(null).ok, false);
});

test("a ZERO-BYTE object is absence wearing a different hat", () => {
  /* S3 will hold an empty object quite happily. An empty recording is not one. */
  const v = checkAfterAssembly({ size: 0, contentType: "video/webm" });
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.code, "absent");
});

test("a real object passes, carrying the store's own facts", () => {
  const v = checkAfterAssembly({ size: 4242, contentType: "video/webm" });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.size, 4242);
  assert.equal(v.ok && v.contentType, "video/webm");
});

/* ------------------------------------------------------ what is said */

test("the reason recorded is specific; the sentence shown is not", () => {
  const short = { ok: false, code: "short", have: 3, expected: 5, resumable: true } as const;
  assert.equal(completionReason(short), "only 3 of 5 parts reached storage");
  assert.match(COMPLETION_SAY.short, /try again/i);
  /* and nothing tells somebody their recording was lost — all of these resume */
  for (const s of Object.values(COMPLETION_SAY)) assert.doesNotMatch(s, /lost|gone|deleted/i);
});

/* ============================== against a real object store, end to end */

test("a genuinely complete multipart upload verifies", async () => {
  const store = new MemoryStorageProvider();
  const key = "k/complete.webm";
  const { uploadId } = await store.createMultipartUpload(key, { contentType: "video/webm" });

  const body = Buffer.alloc(PART_BYTES + 1024, 7);
  const sent = [];
  sent.push(await putPart(store, key, uploadId, 1, body.subarray(0, PART_BYTES)));
  sent.push(await putPart(store, key, uploadId, 2, body.subarray(PART_BYTES)));

  const known = await store.listUploadedParts(key, uploadId);
  const before = checkBeforeAssembly({
    multipartUploadId: uploadId, knownParts: known,
    claimedParts: sent, declaredBytes: body.length,
  });
  assert.equal(before.ok, true);

  await store.completeMultipartUpload(key, uploadId, before.ok ? before.parts! : []);
  const after = checkAfterAssembly(await store.getMetadata(key));
  assert.equal(after.ok, true);
  assert.equal(after.ok && after.size, body.length);
});

test("A PART THAT WAS NEVER SENT IS CAUGHT BY THE STORE, NOT BY THE CLIENT", async () => {
  /*
   * The whole scenario, against a real store: the browser believes it sent two
   * parts and only one arrived. Before the check existed this assembled into a
   * playable half-recording and reported success.
   */
  const store = new MemoryStorageProvider();
  const key = "k/short.webm";
  const { uploadId } = await store.createMultipartUpload(key, { contentType: "video/webm" });

  const declared = PART_BYTES * 2;
  const sentOne = await putPart(store, key, uploadId, 1, Buffer.alloc(PART_BYTES, 7));

  const known = await store.listUploadedParts(key, uploadId);
  const verdict = checkBeforeAssembly({
    multipartUploadId: uploadId,
    knownParts: known,
    /* the client's belief, which is wrong */
    claimedParts: [sentOne, { partNumber: 2, etag: "never-arrived" }],
    declaredBytes: declared,
  });

  assert.equal(verdict.ok, false, "a short upload must not be assembled");
  assert.equal(!verdict.ok && verdict.code, "short");
  assert.equal(!verdict.ok && verdict.resumable, true, "and it must be resumable, not lost");

  /* nothing was assembled, so nothing is in the store pretending to be whole */
  assert.equal(await store.exists(key), false);
});
