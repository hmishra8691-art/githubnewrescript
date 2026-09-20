import { test } from "node:test";
import assert from "node:assert/strict";
import { RecordingUploader, type UploaderEndpoints } from "./uploader.js";

const ENDPOINTS: UploaderEndpoints = { begin: "/api/x/begin", parts: "/api/x/parts", complete: "/api/x/complete" };

/*
 * A REFUSED PUT IS A FACT THIS BROWSER HOLDS, AND IT USED TO DROP IT.
 *
 * `queue()` starts each part in the background:
 *
 *     this.inFlight = this.inFlight.then(async () => { … await this.send(…) });
 *
 * `send()` returns a boolean and nothing reads it. For a MULTIPART upload
 * that was survivable — `finish()` asks the store which parts it holds before
 * completing, and the store's answer is better evidence than ours. For a
 * SINGLE PUT there is no such round trip: the only thing between a 403 and a
 * "Stored" chip was the server's HEAD at confirm time.
 *
 * That HEAD is the authority and it stays. But it is one check, on the far
 * side of a network, of something this object already knew — and when the
 * store is refusing signed URLs it is usually refusing the server's HEAD as
 * well, which is precisely the configuration where the last line of defence
 * is the one that has also failed. Every upload in production that hit this
 * was a single PUT: five images between 72 KB and 1.5 MB, six videos around
 * 1.1 MB, none of them large enough to be cut into parts.
 *
 * So: the client keeps its own account, refuses to call an upload stored when
 * a part it released was never acknowledged, and reports the store's own
 * status rather than a sentence about connections.
 */

/**
 * The three routes and an object store, small enough to lie on purpose.
 *
 * `putStatus` is what the object store answers a PUT with; `confirmSays` lets
 * the completion route claim success it has no right to, which is the one
 * case the client's own account exists to catch.
 */
function harness(opts: {
  putStatus?: number;
  putThrows?: boolean;
  confirmSays?: "truth" | "success";
} = {}) {
  const stored = new Set<string>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith("/api/")) {
      if (url.endsWith("/begin")) {
        return json({
          ok: true, mediaId: "m1", kind: "single", partBytes: 8 << 20, partCount: 1,
          uploadUrl: "https://store.test/signed/m1", uploadId: null, parts: [],
        });
      }
      if (url.endsWith("/parts")) {
        return json({ ok: true, kind: "single", complete: stored.has("m1"), uploaded: [], parts: [] });
      }
      if (url.endsWith("/complete")) {
        if (opts.confirmSays === "success") return json({ ok: true, mediaId: "m1", bytes: 1, verified: true });
        if (!stored.has("m1")) return json({ ok: false, error: "the recording did not reach storage. Try the upload again." }, 409);
        return json({ ok: true, mediaId: "m1", bytes: 1, verified: true });
      }
      return json({ ok: false, error: "no such route" }, 404);
    }

    /* the object store */
    if (opts.putThrows) throw new TypeError("Failed to fetch");
    const status = opts.putStatus ?? 200;
    if (status >= 200 && status < 300) {
      stored.add("m1");
      return new Response("", { status, headers: { etag: '"abc123"' } });
    }
    return new Response(
      "<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>",
      { status },
    );
  }) as unknown as typeof fetch;

  return { doFetch, stored };
}

function upload(h: ReturnType<typeof harness>) {
  return new RecordingUploader({
    endpoints: ENDPOINTS, token: "tok", responseId: "r1",
    mimeType: "image/png", estimatedBytes: 483_940,
    onState: () => { /* the UI is not what is under test */ },
    fetchImpl: h.doFetch,
  });
}

const file = (n: number) => new Blob([new Uint8Array(n).fill(7)]);

/* ==================================================================== */

test("the happy path still says stored", async () => {
  /*
   * First, so that a change which simply refuses everything cannot pass the
   * three tests below.
   */
  const h = harness();
  const u = upload(h);
  await u.begin();
  u.push(file(483_940));
  const out = await u.finish(0);
  assert.equal(out.ok, true);
  assert.equal(u.snapshot.phase, "stored");
});

test("a single PUT refused with 403 fails, in the store's words", async () => {
  const h = harness({ putStatus: 403 });
  const u = upload(h);
  await u.begin();
  u.push(file(483_940));
  const out = await u.finish(0);

  assert.equal(out.ok, false);
  assert.ok(!out.ok && /403/.test(out.error), `the status has to survive: "${!out.ok && out.error}"`);
  assert.ok(
    !out.ok && /configuration/i.test(out.error),
    "a 403 on a signed URL is not a connection problem, and telling a researcher to "
    + "retry sends them round a loop with no exit",
  );
  assert.equal(h.stored.has("m1"), false);
});

test("both accounts reach the researcher — the store's and the browser's", async () => {
  /*
   * The live failure this was written for: the browser saw no answer at all
   * (consistent with a blocked cross-origin request) while the server, which
   * has no cross-origin anything, was told 403 by the same store. Either
   * sentence alone sends somebody to a different half of the system; the pair
   * says the store is refusing everyone.
   *
   * An earlier version of the fix preferred the client's message and dropped
   * the server's, which is the more diagnostic of the two.
   */
  const h = harness({ putThrows: true });
  const u = upload(h);
  await u.begin();
  u.push(file(483_940));
  const out = await u.finish(0);

  assert.equal(out.ok, false);
  assert.ok(!out.ok && /did not reach storage/.test(out.error), `the server's account is missing: "${!out.ok && out.error}"`);
  assert.ok(!out.ok && /cross-origin/i.test(out.error), `the browser's account is missing: "${!out.ok && out.error}"`);
});

test("a PUT that never gets an answer says so — a blocked cross-origin request looks like this", async () => {
  /*
   * A bucket with no CORS rule for this origin does not answer 403; the
   * browser refuses to make the request at all and `fetch` rejects. That is a
   * different fault with a different fix, and it used to be reported with the
   * same seven words as a flaky connection.
   */
  const h = harness({ putThrows: true });
  const u = upload(h);
  await u.begin();
  u.push(file(483_940));
  const out = await u.finish(0);

  assert.equal(out.ok, false);
  assert.ok(!out.ok && /cross-origin/i.test(out.error), `"${!out.ok && out.error}" names no cause`);
});

test("a confirmation that claims success for an upload that never went is refused", async () => {
  /*
   * THE REQUIREMENT, HELD AT BOTH ENDS.
   *
   * "The system must never report 'Upload successful' unless the file has
   * actually been persisted." The server's HEAD is what normally enforces
   * that. This is the case where the server is wrong — a store that answers
   * a HEAD from a cache, a completion route someone loosens, a proxy — and
   * the browser is the only witness left. Two witnesses disagreeing is
   * resolved the safe way: a wrongly-reported success is the single outcome
   * nothing downstream can recover from, because nobody goes looking.
   */
  const h = harness({ putStatus: 403, confirmSays: "success" });
  const u = upload(h);
  await u.begin();
  u.push(file(483_940));
  const out = await u.finish(0);

  assert.equal(out.ok, false, "the server said yes for a file that was never sent");
  assert.notEqual(u.snapshot.phase, "stored");
});

test("and a confirmation that claims success for an upload that DID go is believed", async () => {
  /* the other side of the same coin: the check must not fire on a good upload */
  const h = harness({ confirmSays: "success" });
  const u = upload(h);
  await u.begin();
  u.push(file(483_940));
  const out = await u.finish(0);
  assert.equal(out.ok, true);
});
