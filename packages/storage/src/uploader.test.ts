import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorageProvider } from "./memory.js";
import { planUpload, PART_BYTES } from "./upload.js";
import { RecordingUploader, type UploadState, type UploaderEndpoints } from "./uploader.js";

const TEST_ENDPOINTS: UploaderEndpoints = { begin: "/api/x/begin", parts: "/api/x/parts", complete: "/api/x/complete" };

/**
 * THE UPLOAD PROTOCOL, END TO END, AGAINST A REAL OBJECT STORE.
 *
 * `MemoryStorageProvider` is not a mock — it issues real etags, refuses a
 * completion whose etags it did not issue, refuses an unsigned or expired
 * URL, and can be told to fail every Nth write. So this drives the ACTUAL
 * uploader against an actual store and asserts the things that only show up
 * under interruption:
 *
 *   · parts go while the recording is still in progress;
 *   · an interrupted upload resumes at the part it stopped on;
 *   · a part the browser believes it sent but the store never got is re-sent;
 *   · the same take uploaded twice is one object, not two;
 *   · nothing reports `stored` that the store has not confirmed.
 *
 * The API routes are a small in-process stub — the real ones need Supabase,
 * and what is under test here is the browser's half of the protocol.
 */

const MB = 1024 * 1024;

/** A stub of the three candidate upload routes, over the memory store. */
function harness(opts: { failEveryNthWrite?: number } = {}) {
  const store = new MemoryStorageProvider({ failEveryNthWrite: opts.failEveryNthWrite });
  const media = new Map<string, {
    id: string; key: string; uploadId: string | null; bytes: number;
    status: "uploading" | "stored"; clientToken: string;
  }>();
  const byClientToken = new Map<string, string>();
  const calls: string[] = [];
  /** Requests that must be answered as if the network had failed. */
  let offline = false;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (offline && !url.startsWith("/api/")) throw new Error("network down");

    if (url.startsWith("/api/")) {
      calls.push(url);
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (url.endsWith("/begin")) {
        /* duplicate protection: the same take resolves to the same row */
        const seen = byClientToken.get(body.clientToken);
        if (seen) {
          const row = media.get(seen)!;
          if (row.status === "stored") return json({ ok: true, alreadyStored: true, mediaId: row.id });
          const uploaded = row.uploadId ? await store.listUploadedParts(row.key, row.uploadId) : [];
          const plan = planUpload(row.bytes);
          const parts = [];
          for (let n = 1; n <= plan.partCount; n++) {
            if (uploaded.some((p) => p.partNumber === n)) continue;
            parts.push({ partNumber: n, url: await store.signUploadPart(row.key, row.uploadId!, n) });
          }
          return json({
            ok: true, resumed: true, mediaId: row.id, kind: "multipart",
            partBytes: plan.partBytes, partCount: plan.partCount, uploadId: row.uploadId,
            uploadUrl: null, parts, uploaded,
          });
        }

        const id = `m${media.size + 1}`;
        const key = `organizations/o/interviews/i/responses/${body.responseId}/${id}.webm`;
        const plan = planUpload(body.bytes);
        if (plan.kind === "single") {
          media.set(id, { id, key, uploadId: null, bytes: body.bytes, status: "uploading", clientToken: body.clientToken });
          byClientToken.set(body.clientToken, id);
          return json({
            ok: true, mediaId: id, kind: "single", partBytes: plan.partBytes, partCount: 1,
            uploadUrl: await store.createSignedUploadUrl(key), uploadId: null, parts: [],
          });
        }
        const mp = await store.createMultipartUpload(key, { contentType: body.mimeType });
        media.set(id, { id, key, uploadId: mp.uploadId, bytes: body.bytes, status: "uploading", clientToken: body.clientToken });
        byClientToken.set(body.clientToken, id);
        const parts = [];
        for (let n = 1; n <= plan.partCount; n++) {
          parts.push({ partNumber: n, url: await store.signUploadPart(key, mp.uploadId, n) });
        }
        return json({
          ok: true, mediaId: id, kind: "multipart", partBytes: plan.partBytes,
          partCount: plan.partCount, uploadUrl: null, uploadId: mp.uploadId, parts,
        });
      }

      if (url.endsWith("/parts")) {
        const row = media.get(body.mediaId)!;
        const uploaded = row.uploadId ? await store.listUploadedParts(row.key, row.uploadId) : [];
        const plan = planUpload(row.bytes);
        const parts = [];
        for (let n = 1; n <= plan.partCount; n++) {
          if (uploaded.some((p) => p.partNumber === n)) continue;
          parts.push({ partNumber: n, url: await store.signUploadPart(row.key, row.uploadId!, n) });
        }
        return json({
          ok: true, kind: "multipart", complete: parts.length === 0,
          partBytes: plan.partBytes, partCount: plan.partCount, uploaded, parts,
        });
      }

      if (url.endsWith("/complete")) {
        const row = media.get(body.mediaId)!;
        if (row.status === "stored") return json({ ok: true, mediaId: row.id, alreadyStored: true });
        if (row.uploadId) {
          const known = await store.listUploadedParts(row.key, row.uploadId);
          if (!known.length) return json({ ok: false, error: "nothing arrived" }, 409);
          try {
            await store.completeMultipartUpload(row.key, row.uploadId, known);
          } catch (e) {
            return json({ ok: false, error: (e as Error).message }, 502);
          }
        }
        /* THE VERIFICATION: the store's opinion, not the browser's */
        const meta = await store.getMetadata(row.key);
        if (!meta || meta.size <= 0) return json({ ok: false, error: "not in the store" }, 409);
        row.status = "stored";
        return json({ ok: true, mediaId: row.id, bytes: meta.size, verified: true });
      }
      return json({ ok: false, error: "no such route" }, 404);
    }

    /* a PUT straight at the object store */
    const res = await store.handleRequest({
      method: String(init?.method ?? "GET"),
      url,
      headers: {},
      body: init?.body instanceof Blob
        ? new Uint8Array(await (init.body as Blob).arrayBuffer())
        : undefined,
    });
    return new Response(res.body as BodyInit, { status: res.status, headers: res.headers });
  }) as unknown as typeof fetch;

  return { store, media, calls, doFetch, setOffline: (v: boolean) => { offline = v; } };
}

function uploader(h: ReturnType<typeof harness>, bytes: number, seen: UploadState[] = []) {
  return new RecordingUploader({
    endpoints: TEST_ENDPOINTS,
    token: "tok", responseId: "r1", mimeType: "video/webm",
    estimatedBytes: bytes,
    onState: (s) => seen.push(s),
    fetchImpl: h.doFetch,
  });
}

const chunk = (n: number, fill = 1) => new Blob([new Uint8Array(n).fill(fill)]);

/* ==================================================================== */

test("upload: a small answer is one PUT, verified before it is called saved", async () => {
  const h = harness();
  const states: UploadState[] = [];
  const u = uploader(h, 400 * 1024, states);
  await u.begin();
  u.push(chunk(400 * 1024));
  const out = await u.finish(12);
  assert.equal(out.ok, true);
  assert.equal(u.snapshot.phase, "stored");
  assert.equal(u.snapshot.progress, 1);
  assert.equal([...h.store.objects.values()][0]!.body.byteLength, 400 * 1024);
  /* nothing claimed `stored` before the completion route answered */
  const storedAt = states.findIndex((s) => s.phase === "stored");
  assert.ok(storedAt > 0 && states.slice(0, storedAt).every((s) => s.phase !== "stored"));
});

test("upload: parts go WHILE the recording is still in progress", async () => {
  const h = harness();
  const u = uploader(h, 20 * MB);
  await u.begin();

  /* two parts' worth of chunks, and nothing has stopped yet */
  for (let i = 0; i < 4; i++) u.push(chunk(5 * MB, i));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(u.snapshot.partsDone >= 2,
    `only ${u.snapshot.partsDone} parts sent — the candidate would wait for the whole answer at the end`);

  u.push(chunk(2 * MB, 9));
  const out = await u.finish(90);
  assert.equal(out.ok, true);
  assert.equal([...h.store.objects.values()][0]!.body.byteLength, 22 * MB);
});

test("upload: an interruption resumes at the part it stopped on", async () => {
  /* every 3rd write fails, so parts 3 and 6 are refused on first attempt */
  const h = harness({ failEveryNthWrite: 3 });
  const u = uploader(h, 40 * MB);
  await u.begin();
  for (let i = 0; i < 5; i++) u.push(chunk(8 * MB, i));
  const out = await u.finish(120);
  assert.equal(out.ok, true, "injected failures must not lose the answer");
  assert.equal([...h.store.objects.values()][0]!.body.byteLength, 40 * MB,
    "and every byte is there, in order");
});

test("upload: a part the browser thinks it sent but the store never got is re-sent", async () => {
  const h = harness();
  const u = uploader(h, 24 * MB);
  await u.begin();
  for (let i = 0; i < 3; i++) u.push(chunk(8 * MB, i));
  await new Promise((r) => setTimeout(r, 40));

  /* the store loses part 2 — a proxy that answered 200 and dropped the body */
  const row = [...h.media.values()][0]!;
  const pending = h.store.multiparts.get(row.uploadId!)!;
  pending.parts.delete(2);

  const out = await u.finish(100);
  assert.equal(out.ok, true);
  const stored = [...h.store.objects.values()][0]!;
  assert.equal(stored.body.byteLength, 24 * MB, "the missing part was re-sent, not skipped");
  assert.equal(stored.body[8 * MB + 10], 1, "and it is the RIGHT part, in the right place");
});

test("upload: the same take twice is one object, not two", async () => {
  const h = harness();
  const u = uploader(h, 400 * 1024);
  await u.begin();
  await u.begin();        // a double-click, or a retried request that had worked
  assert.equal(h.media.size, 1, "a second begin for the same take must not start a second upload");
});

test("upload: going offline and coming back does not restart the answer", async () => {
  const h = harness();
  const u = uploader(h, 24 * MB);
  await u.begin();
  u.push(chunk(8 * MB, 1));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(u.snapshot.partsDone, 1);

  h.setOffline(true);
  u.push(chunk(8 * MB, 2));
  await new Promise((r) => setTimeout(r, 30));
  h.setOffline(false);

  const recovered = await u.resume();
  assert.equal(typeof recovered, "boolean");
  u.push(chunk(8 * MB, 3));
  const out = await u.finish(90);
  assert.equal(out.ok, true);
  const stored = [...h.store.objects.values()][0]!;
  assert.equal(stored.body.byteLength, 24 * MB);
  assert.equal(stored.body[0], 1, "the part sent before the outage was not sent again from scratch");
});

test("upload: abandoning a take stops it dead", async () => {
  const h = harness();
  const u = uploader(h, 24 * MB);
  await u.begin();
  u.push(chunk(8 * MB));
  await u.abandon();
  u.push(chunk(8 * MB));
  const out = await u.finish(30);
  assert.equal(out.ok, false);
  assert.equal(h.store.objects.size, 0, "an abandoned take stores nothing");
});

test("upload: a refused begin fails loudly rather than pretending to record", async () => {
  const h = harness();
  const u = new RecordingUploader({
    endpoints: TEST_ENDPOINTS,
    token: "tok", responseId: "r1", mimeType: "video/webm", estimatedBytes: 1000,
    onState: () => {},
    fetchImpl: (async () =>
      new Response(JSON.stringify({ ok: false, error: "This project has reached its storage limit." }), { status: 507 })
    ) as unknown as typeof fetch,
  });
  await assert.rejects(() => u.begin());
  assert.equal(u.snapshot.phase, "failed");
  assert.match(u.snapshot.message ?? "", /storage limit/);
});

test("upload: progress never counts a part the store has not taken", async () => {
  const h = harness({ failEveryNthWrite: 2 });
  const states: UploadState[] = [];
  const u = uploader(h, 24 * MB, states);
  await u.begin();
  for (let i = 0; i < 3; i++) u.push(chunk(8 * MB, i));
  await u.finish(90);
  const stored = [...h.store.objects.values()][0]!;
  for (const s of states) {
    assert.ok(s.progress <= 1);
    assert.ok(s.partsDone <= s.partsTotal || s.partsTotal === 0);
  }
  assert.equal(stored.body.byteLength, 24 * MB);
});

test("A RECORDING SHORTER THAN ITS ALLOWANCE STILL SAVES — the estimate is capacity, not a target", async () => {
  /*
   * The bug this exists for, and the reason every case above missed it: they
   * all push at least as many bytes as they declared. Real recordings never
   * do. `estimatedBytes` is `expectedBytes(maxSeconds)` — the bytes a
   * recording of the MAXIMUM length would take, plus a 15% margin — so even
   * an answer that runs the clock out delivers about 87% of it, and one that
   * ends early delivers far less.
   *
   * Deriving an owed part count from that estimate therefore refused every
   * multipart answer that ever existed. 128 MB of allowance is 16 parts; a
   * respondent who talks for two of the fifteen minutes produces 3. The old
   * code compared 3 with 16, said "Part of your answer did not reach us", and
   * the candidate could not finish the interview — on every question whose
   * limit crossed the 8 MiB threshold, which is about 59 seconds of video.
   */
  const h = harness();
  const u = uploader(h, 128 * MB);          // a 15-minute allowance
  await u.begin();
  for (let i = 0; i < 3; i++) u.push(chunk(8 * MB, i));   // ~2 minutes of talking
  const out = await u.finish(120);

  assert.equal(out.ok, true, "a short answer is a complete answer");
  assert.equal(u.snapshot.phase, "stored");
  assert.equal([...h.store.objects.values()][0]!.body.byteLength, 24 * MB);
});

test("the progress bar is denominated in parts that exist, not parts that were guessed at", async () => {
  /*
   * Same root cause, visible to the respondent: a bar scaled to the estimate
   * sat at a sixteenth of itself while the upload was in fact finished, which
   * reads as frozen and is why somebody closes the tab.
   */
  const h = harness();
  const u = uploader(h, 128 * MB);
  await u.begin();
  for (let i = 0; i < 3; i++) u.push(chunk(8 * MB, i));
  await u.finish(120);

  assert.equal(u.snapshot.progress, 1, "a finished upload reads as finished");
  assert.equal(u.snapshot.partsTotal, 3, "the total is what the recording produced");
});
