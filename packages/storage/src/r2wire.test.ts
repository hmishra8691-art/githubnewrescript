import { test } from "node:test";
import assert from "node:assert/strict";
import { R2StorageProvider } from "./r2.js";

/**
 * THE WIRE SHAPE OF EVERY R2 CALL.
 *
 * `sigv4.test.ts` proves the signature is right. This proves the REQUEST is
 * right: the method, the path, the query parameters S3 dispatches on, and the
 * XML in both directions. Those are the two halves — a perfectly signed
 * request to the wrong URL fails exactly like a badly signed one, and the
 * error S3 returns for either is unhelpfully similar.
 *
 * The fetch double records and replies. Nothing here reaches a network.
 */

function spy(replies: Array<{ status?: number; body?: string; headers?: Record<string, string> }>) {
  const seen: { method: string; url: URL; body: string | null }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const r = replies[Math.min(i++, replies.length - 1)] ?? {};
    seen.push({
      method: String(init?.method ?? "GET"),
      url: new URL(String(url)),
      body: init?.body ? new TextDecoder().decode(init.body as Uint8Array) : null,
    });
    return new Response(r.body ?? "", { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const provider = (fetchImpl: typeof fetch) => new R2StorageProvider({
  endpoint: "https://acct.r2.cloudflarestorage.com",
  bucket: "interviews",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret",
  fetchImpl,
});

test("r2 wire: a single PUT carries the bytes, the type and the length", async () => {
  const { seen, fetchImpl } = spy([{ headers: { etag: '"abc"' } }]);
  const meta = await provider(fetchImpl).upload("organizations/o/k.webm", new Uint8Array(9), {
    contentType: "video/webm",
  });
  assert.equal(seen[0]!.method, "PUT");
  assert.equal(seen[0]!.url.pathname, "/interviews/organizations/o/k.webm");
  assert.equal(meta.etag, "abc", "the etag is unquoted, or it will never match a part list");
  assert.equal(meta.size, 9);
});

test("r2 wire: ifAbsent becomes If-None-Match, and 412 becomes a 409", async () => {
  const { fetchImpl } = spy([{ status: 412 }]);
  await assert.rejects(
    () => provider(fetchImpl).upload("k", new Uint8Array(1), { ifAbsent: true }),
    (e: { status: number }) => e.status === 409,
  );
});

test("r2 wire: the multipart lifecycle uses the query parameters S3 dispatches on", async () => {
  const { seen, fetchImpl } = spy([
    { body: "<InitiateMultipartUploadResult><UploadId>UP-1</UploadId></InitiateMultipartUploadResult>" },
    { body: "<CompleteMultipartUploadResult><ETag>&quot;final&quot;</ETag></CompleteMultipartUploadResult>" },
    { status: 200, headers: { "content-length": "12", "content-type": "video/webm", etag: '"final"' } },
  ]);
  const r2 = provider(fetchImpl);

  const { uploadId } = await r2.createMultipartUpload("k", { contentType: "video/webm" });
  assert.equal(uploadId, "UP-1");
  assert.equal(seen[0]!.method, "POST");
  assert.ok(seen[0]!.url.searchParams.has("uploads"), "create is POST ?uploads");

  const meta = await r2.completeMultipartUpload("k", "UP-1", [
    { partNumber: 2, etag: "e2" }, { partNumber: 1, etag: '"e1"' },
  ]);
  const complete = seen[1]!;
  assert.equal(complete.method, "POST");
  assert.equal(complete.url.searchParams.get("uploadId"), "UP-1");
  assert.match(complete.body!, /<Part><PartNumber>1<\/PartNumber><ETag>&quot;e1&quot;<\/ETag><\/Part><Part><PartNumber>2<\/PartNumber>/,
    "parts are sorted ascending and the etag is re-quoted exactly once");
  assert.equal(seen[2]!.method, "HEAD", "the object is verified after assembly, not assumed");
  assert.equal(meta.size, 12);
});

test("r2 wire: a part URL names the part and the upload, and nothing else", async () => {
  const { fetchImpl } = spy([{}]);
  const url = new URL(await provider(fetchImpl).signUploadPart("k", "UP-1", 7));
  assert.equal(url.searchParams.get("partNumber"), "7");
  assert.equal(url.searchParams.get("uploadId"), "UP-1");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
});

test("r2 wire: listing parts reads the XML and follows the truncation marker", async () => {
  const page = (parts: number[], truncated: boolean, next?: number) =>
    `<ListPartsResult>${parts
      .map((n) => `<Part><PartNumber>${n}</PartNumber><ETag>&quot;e${n}&quot;</ETag></Part>`)
      .join("")}<IsTruncated>${truncated}</IsTruncated>${
      next ? `<NextPartNumberMarker>${next}</NextPartNumberMarker>` : ""
    }</ListPartsResult>`;
  const { seen, fetchImpl } = spy([
    { body: page([1, 2], true, 2) },
    { body: page([3], false) },
  ]);
  const parts = await provider(fetchImpl).listUploadedParts("k", "UP-1");
  assert.deepEqual(parts, [
    { partNumber: 1, etag: "e1" }, { partNumber: 2, etag: "e2" }, { partNumber: 3, etag: "e3" },
  ]);
  assert.equal(seen[1]!.url.searchParams.get("part-number-marker"), "2");
});

test("r2 wire: listing parts of an upload that is gone is empty, not an error", async () => {
  const { fetchImpl } = spy([{ status: 404, body: "<Error><Code>NoSuchUpload</Code></Error>" }]);
  assert.deepEqual(await provider(fetchImpl).listUploadedParts("k", "UP-1"), []);
});

test("r2 wire: abandoning an upload that is already gone is not an error", async () => {
  const { seen, fetchImpl } = spy([{ status: 404, body: "<Error><Code>NoSuchUpload</Code></Error>" }]);
  await provider(fetchImpl).abortMultipartUpload("k", "UP-1");
  assert.equal(seen[0]!.method, "DELETE");
  assert.equal(seen[0]!.url.searchParams.get("uploadId"), "UP-1");
});

test("r2 wire: a batch delete is one POST ?delete with a content-md5", async () => {
  const { seen, fetchImpl } = spy([{ body: "<DeleteResult/>" }]);
  await provider(fetchImpl).delete(["a/b", "c<d>"]);
  assert.equal(seen[0]!.method, "POST");
  assert.ok(seen[0]!.url.searchParams.has("delete"));
  assert.match(seen[0]!.body!, /<Key>a\/b<\/Key>/);
  assert.match(seen[0]!.body!, /<Key>c&lt;d&gt;<\/Key>/, "a key with XML in it cannot break the document");
  assert.match(seen[0]!.body!, /<Quiet>true<\/Quiet>/);
});

test("r2 wire: deleting nothing makes no request at all", async () => {
  const { seen, fetchImpl } = spy([{}]);
  await provider(fetchImpl).delete([]);
  assert.equal(seen.length, 0);
});

test("r2 wire: a per-key failure inside a 200 DeleteResult is still a failure", async () => {
  const { fetchImpl } = spy([{
    body: "<DeleteResult><Error><Key>a</Key><Code>AccessDenied</Code></Error></DeleteResult>",
  }]);
  await assert.rejects(() => provider(fetchImpl).delete(["a"]), /AccessDenied/);
});

test("r2 wire: listing objects is v2 and pages by continuation token", async () => {
  const { seen, fetchImpl } = spy([{
    body: `<ListBucketResult>
      <Contents><Key>organizations/o/a</Key><Size>10</Size><ETag>&quot;e&quot;</ETag>
        <LastModified>2026-01-02T03:04:05.000Z</LastModified></Contents>
      <Contents><Key>organizations/o/b</Key><Size>20</Size></Contents>
      <IsTruncated>true</IsTruncated><NextContinuationToken>TOK</NextContinuationToken>
    </ListBucketResult>`,
  }]);
  const out = await provider(fetchImpl).list("organizations/o/", { limit: 2 });
  assert.equal(seen[0]!.url.searchParams.get("list-type"), "2");
  assert.equal(seen[0]!.url.searchParams.get("prefix"), "organizations/o/");
  assert.equal(seen[0]!.url.searchParams.get("max-keys"), "2");
  assert.deepEqual(out.objects.map((o) => [o.key, o.size]), [
    ["organizations/o/a", 10], ["organizations/o/b", 20],
  ]);
  assert.equal(out.objects[0]!.lastModified?.toISOString(), "2026-01-02T03:04:05.000Z");
  assert.equal(out.cursor, "TOK");
});

test("r2 wire: an untruncated listing ends the paging", async () => {
  const { fetchImpl } = spy([{ body: "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>" }]);
  const out = await provider(fetchImpl).list("p/");
  assert.deepEqual(out.objects, []);
  assert.equal(out.cursor, null);
});

test("r2 wire: a HEAD on an absent key is null, not a throw", async () => {
  const { fetchImpl } = spy([{ status: 404 }]);
  assert.equal(await provider(fetchImpl).getMetadata("k"), null);
  const { fetchImpl: f2 } = spy([{ status: 404 }]);
  assert.equal(await provider(f2).exists("k"), false);
});

test("r2 wire: a download URL carries the disposition so a file saves under a name", async () => {
  const { fetchImpl } = spy([{}]);
  const url = new URL(await provider(fetchImpl).createSignedDownloadUrl("k", {
    downloadAs: 'inter"view.webm', expiresIn: 600,
  }));
  assert.equal(url.searchParams.get("X-Amz-Expires"), "600");
  assert.equal(
    url.searchParams.get("response-content-disposition"),
    'attachment; filename="inter_view.webm"',
    "a quote in a filename cannot break out of the header",
  );
});
