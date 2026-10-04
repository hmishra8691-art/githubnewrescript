import test from "node:test";
import assert from "node:assert/strict";
import { stub } from "./store.test.js";
import { driveFileId, fetchDriveFile, storeAssetBytes } from "./importRemote.js";
import { resetBucketCache } from "./store.js";

/**
 * SAVING A GOOGLE DRIVE FILE INTO THE ASSET LIBRARY (1-10-26 review).
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]);
const res = (body: Uint8Array | string, headers: Record<string, string>, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  arrayBuffer: async () => (typeof body === "string" ? new TextEncoder().encode(body) : body).buffer as ArrayBuffer,
});

test("every Drive link shape gives its file id; anything else gives none", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUv";
  assert.equal(driveFileId(`https://drive.google.com/file/d/${id}/view?usp=sharing`), id);
  assert.equal(driveFileId(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(driveFileId(`https://drive.google.com/uc?export=download&id=${id}`), id);
  assert.equal(driveFileId(`https://docs.google.com/file/d/${id}/edit`), id);
  assert.equal(driveFileId(`https://evil.example/file/d/${id}/view`), null, "not Drive");
  assert.equal(driveFileId("https://drive.google.com/drive/folders"), null, "no id");
  assert.equal(driveFileId("not a url"), null);
});

test("the file Drive serves comes back with its type and name; a page in its place is refused", async () => {
  let asked = "";
  const file = await fetchDriveFile("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view", {
    fetchImpl: async (u) => { asked = u; return res(PNG, { "content-type": "image/png", "content-disposition": "attachment; filename=\"pack.png\"; filename*=UTF-8''pack%20shot.png" }); },
  });
  assert.match(asked, /^https:\/\/drive\.google\.com\/uc\?export=download&id=1AbCdEfGhIjKlMnOpQrStUv$/);
  assert.equal(file.mimeType, "image/png");
  assert.equal(file.fileName, "pack shot.png", "the UTF-8 name wins");
  assert.equal(file.bytes.byteLength, PNG.byteLength);
  await assert.rejects(
    () => fetchDriveFile("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view", { fetchImpl: async () => res("<html>Sign in</html>", { "content-type": "text/html; charset=utf-8" }) }),
    /Anyone with the link/,
  );
  await assert.rejects(
    () => fetchDriveFile("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view", { maxBytes: 5, fetchImpl: async () => res(PNG, { "content-type": "image/png", "content-length": "10" }) }),
    /larger than the library takes/,
  );
  /* a declared size over the limit is refused before a byte is read */
  await assert.rejects(
    () => fetchDriveFile("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view", { maxBytes: 5, fetchImpl: async () => ({
      ...res(PNG, { "content-type": "video/mp4", "content-length": String(900 * 1048576) }),
      arrayBuffer: async () => { throw new Error("read a 900 MB body"); },
    }) }),
    /900 MB — larger than the library takes/,
  );
  await assert.rejects(() => fetchDriveFile("https://example.com/x.png"), /not a Google Drive file link/);
});

test("the bytes become an ordinary library asset — stored, confirmed, findable; the same bytes again are the same asset", async () => {
  resetBucketCache();
  const s = stub();
  const puts: string[] = [];
  const put = async (url: string, headers: Record<string, string>, body: Uint8Array) => {
    const m = /^https:\/\/storage\.test\/([^/]+)\/([^?]+)/.exec(url)!;
    s.objects.add(`${m[1]}/${decodeURIComponent(m[2])}`);
    puts.push(`${headers["content-type"]} ${body.byteLength}`);
    return { etag: "e1" };
  };
  const file = { bytes: PNG, mimeType: "image/png", fileName: "pack.png" };
  const out = await storeAssetBytes(s.db, { customerId: "c1", surveyId: "s1", file, altText: "Pack", put });
  assert.equal(out.duplicate, false);
  assert.equal(out.asset.family, "image");
  assert.match(out.asset.url, /^\/api\/media\/.+\/pack\.png$/);
  assert.deepEqual(puts, ["image/png 10"], "one PUT of the whole file, typed");
  const row = [...s.rows.values()].find((r) => r.id === out.asset.id)!;
  assert.equal(row.status, "stored");
  assert.equal(row.kind, "survey_asset");
  assert.equal(row.question_id, null, "a library asset belongs to the survey, not a question");
  const again = await storeAssetBytes(s.db, { customerId: "c1", surveyId: "s1", file, put });
  assert.equal(again.duplicate, true);
  assert.equal(again.asset.id, out.asset.id);
  assert.equal(puts.length, 1, "nothing uploaded the second time");
});

test("only pictures, video and audio — and within the library's size for the kind", async () => {
  const s = stub();
  await assert.rejects(() => storeAssetBytes(s.db, { customerId: "c1", surveyId: "s1", file: { bytes: PNG, mimeType: "application/pdf", fileName: "a.pdf" }, put: async () => ({}) }), /pictures, video and audio/);
  const big = { bytes: { byteLength: 30 * 1024 * 1024 } as unknown as Uint8Array, mimeType: "image/png", fileName: "x.png" };
  await assert.rejects(() => storeAssetBytes(s.db, { customerId: "c1", surveyId: "s1", file: big, put: async () => ({}) }), /up to 25 MB/);
});
