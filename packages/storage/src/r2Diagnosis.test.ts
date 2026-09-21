import { test } from "node:test";
import assert from "node:assert/strict";
import { R2StorageProvider } from "./r2.js";

/*
 * A REFUSAL HAS TO NAME ITSELF.
 *
 * `confirmUpload` proves an upload arrived by asking the store for the
 * object's metadata, and that call is a HEAD. HTTP forbids a body on a
 * response to HEAD — so when R2 refused, there was no XML to read, and the
 * error fell through to `res.statusText`. Every failure this path has ever
 * reported said the same word:
 *
 *     Reading the object failed (403) — Forbidden
 *
 * which is the status number spelled out. `AccessDenied`, `NoSuchBucket`,
 * `InvalidAccessKeyId` and `SignatureDoesNotMatch` are four different faults
 * with four different fixes — a token not scoped to the bucket, a bucket name
 * that is wrong, a key that no longer exists, a truncated secret or a skewed
 * clock — and the code is the only thing that separates them. Losing it turns
 * a two-minute fix into an evening.
 *
 * Worse than losing it: it invites a WRONG reading. An empty body looks like
 * evidence of something, and it is evidence of nothing but the method used.
 */

/** A provider whose network is a function, so a refusal can be scripted. */
function provider(handler: (req: { method: string; url: string; headers: Record<string, string> }) => Response) {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = String(init?.method ?? "GET");
    const url = String(input);
    calls.push({ method, url });
    return handler({ method, url, headers: (init?.headers ?? {}) as Record<string, string> });
  }) as unknown as typeof fetch;

  const p = new R2StorageProvider({
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "rescript-media",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "s".repeat(40),
    region: "auto",
    fetchImpl,
  });
  return { p, calls };
}

const xml = (code: string, message: string, status = 403) =>
  new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`, { status });

/* ==================================================================== */

test("a refused HEAD is re-asked with a body, and reports the store's own code", async () => {
  const { p, calls } = provider(({ method }) =>
    method === "HEAD"
      /* as the real thing answers: a status, and by protocol no body at all */
      ? new Response(null, { status: 403, statusText: "Forbidden" })
      : xml("AccessDenied", "Access Denied"));

  await assert.rejects(
    () => p.getMetadata("video/sv-1/q-1/take.webm"),
    (e: Error) => {
      assert.match(e.message, /AccessDenied/, `no code in: ${e.message}`);
      assert.doesNotMatch(e.message, /— Forbidden$/, "fell back to statusText despite a code being available");
      return true;
    },
  );
  assert.deepEqual(calls.map((c) => c.method), ["HEAD", "GET"], "exactly one diagnostic follow-up");
});

test("each of the four faults comes back distinguishable", async () => {
  /*
   * The point of the whole change: these have to read differently, because
   * they are fixed differently. A token that is not scoped to the bucket, a
   * bucket name that does not exist, a key that was revoked, a secret that
   * was truncated on paste.
   */
  const seen: string[] = [];
  for (const [code, message] of [
    ["AccessDenied", "Access Denied"],
    ["NoSuchBucket", "The specified bucket does not exist"],
    ["InvalidAccessKeyId", "The access key id is not valid"],
    ["SignatureDoesNotMatch", "The request signature does not match"],
  ] as const) {
    const { p } = provider(({ method }) =>
      method === "HEAD" ? new Response(null, { status: 403 }) : xml(code, message));
    await p.getMetadata("assets/sv-1/logo.png").then(
      () => assert.fail(`${code} did not throw`),
      (e: Error) => { seen.push(e.message); assert.match(e.message, new RegExp(code)); },
    );
  }
  assert.equal(new Set(seen).size, 4, `four faults collapsed into ${new Set(seen).size} message(s)`);
});

test("a missing object is still simply absent — no probe, no error", async () => {
  /*
   * The happy-path guard. `head` returning null is ordinary and frequent —
   * it is how `confirmUpload` detects a genuinely failed upload — and it must
   * not cost a second request or turn into an exception.
   */
  const { p, calls } = provider(() => new Response(null, { status: 404 }));
  assert.equal(await p.getMetadata("assets/sv-1/gone.png"), null);
  assert.deepEqual(calls.map((c) => c.method), ["HEAD"], "a 404 must not trigger the diagnostic GET");
});

test("a successful HEAD costs one request and returns the metadata", async () => {
  const { p, calls } = provider(() => new Response(null, {
    status: 200,
    headers: { "content-length": "833000", "content-type": "video/webm", etag: '"abc"' },
  }));
  const meta = await p.getMetadata("video/sv-1/q-1/take.webm");
  assert.equal(meta?.size, 833000);
  assert.equal(meta?.contentType, "video/webm");
  assert.deepEqual(calls.map((c) => c.method), ["HEAD"]);
});

test("when the probe cannot speak either, the original refusal still surfaces", async () => {
  /*
   * The diagnostic is a courtesy and must never replace the real failure —
   * a network error while probing would otherwise turn a clear 403 into a
   * confusing connection message.
   */
  const { p } = provider(({ method }) => {
    if (method === "HEAD") return new Response(null, { status: 403, statusText: "Forbidden" });
    throw new TypeError("connection reset");
  });
  await assert.rejects(
    () => p.getMetadata("assets/sv-1/logo.png"),
    (e: Error) => /403/.test(e.message) && /Forbidden/.test(e.message),
  );
});
