import test from "node:test";
import assert from "node:assert/strict";
import { answerVideoRule, sniffVideo, sniffedVideoOk, answerVideoStorageEstimate, ANSWER_VIDEO_MAX_BYTES, ANSWER_VIDEO_MIME_TYPES } from "./answerVideo.js";
import { verifyAnswerVideo, MediaError, type MediaDb } from "./store.js";

/* S5a item 3 (MM2-09): the respondent-video type, size and sniffing rules */

const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0, 0, 0]);
const MP4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const MOV = new Uint8Array([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

test("type: WebM, MP4 and MOV only (codecs parameter ignored)", () => {
  assert.deepEqual([...ANSWER_VIDEO_MIME_TYPES], ["video/webm", "video/mp4", "video/quicktime"]);
  assert.equal(answerVideoRule("video/webm;codecs=vp8,opus", 1000).ok, true);
  assert.equal(answerVideoRule("video/quicktime", 1000).ok, true);
  for (const bad of ["video/x-msvideo", "image/png", "text/html", "", null]) assert.equal(answerVideoRule(bad, 1000).ok, false, String(bad));
  assert.match(answerVideoRule("image/png", 10).message!, /WebM, MP4 or MOV/);
});

test("size: the question's cap, never above 50 MB; empty refused", () => {
  assert.equal(ANSWER_VIDEO_MAX_BYTES, 50 * 1024 * 1024);
  assert.equal(answerVideoRule("video/webm", 49 * 1024 * 1024).ok, true);
  assert.equal(answerVideoRule("video/webm", 51 * 1024 * 1024).ok, false);
  assert.equal(answerVideoRule("video/webm", 51 * 1024 * 1024, 500).ok, false, "a larger question cap does not lift the ceiling");
  assert.equal(answerVideoRule("video/webm", 6 * 1024 * 1024, 5).ok, false);
  assert.match(answerVideoRule("video/webm", 6 * 1024 * 1024, 5).message!, /accepts 5 MB/);
  assert.equal(answerVideoRule("video/webm", 0).ok, false);
});

test("sniffing: the bytes must be a video container", () => {
  assert.equal(sniffVideo(WEBM), "webm");
  assert.equal(sniffVideo(MP4), "mp4");
  assert.equal(sniffVideo(MOV), "mov");
  assert.equal(sniffVideo(PNG), null);
  assert.equal(sniffVideo(new Uint8Array(2)), null);
  assert.equal(sniffedVideoOk(PNG).ok, false);
});

test("storage estimate: one minute ≈ 7.5 MB", () => {
  const b = answerVideoStorageEstimate(60);
  assert.ok(b > 7_000_000 && b < 8_000_000, String(b));
  assert.equal(answerVideoStorageEstimate(60, 1000), b * 1000);
});

function fakeDb(bytes: Uint8Array) {
  const removed: string[] = []; const updates: Record<string, unknown>[] = [];
  const store = { read: async () => bytes, remove: async (_b: string, p: string[]) => { removed.push(...p); return { removed: p, failed: [] }; } };
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { storage_provider: null }, error: null }) }) }),
      update: (patch: Record<string, unknown>) => ({ eq: async () => { updates.push(patch); return { data: null, error: null }; } }),
    }),
    stores: { primary: store, byName: () => store },
  } as unknown as MediaDb;
  return { db, removed, updates };
}

test("verifyAnswerVideo: a real WebM passes; a PNG renamed .webm is removed and the row failed (415)", async () => {
  const ok = fakeDb(WEBM);
  await verifyAnswerVideo(ok.db, { mediaId: "m1", bucket: "rescript-uploads", path: "s/q/1-recording.webm", mimeType: "video/webm", bytes: 12 });
  assert.deepEqual(ok.removed, []);
  const bad = fakeDb(PNG);
  await assert.rejects(verifyAnswerVideo(bad.db, { mediaId: "m2", bucket: "rescript-uploads", path: "s/q/2-x.webm", mimeType: "video/webm", bytes: 12 }),
    (e: unknown) => e instanceof MediaError && e.status === 415);
  assert.deepEqual(bad.removed, ["s/q/2-x.webm"]);
  assert.equal(bad.updates[0].status, "failed");
  const big = fakeDb(WEBM);
  await assert.rejects(verifyAnswerVideo(big.db, { mediaId: "m3", bucket: "b", path: "p", mimeType: "video/webm", bytes: 60 * 1024 * 1024 }),
    (e: unknown) => e instanceof MediaError && e.status === 413);
});
