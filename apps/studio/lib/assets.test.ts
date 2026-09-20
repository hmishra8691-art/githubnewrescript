import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadAsset, refuseFile, formatBytes } from "./assets.ts";

/*
 * "UPLOAD SUCCESSFUL" HAS TO MEAN THE FILE IS IN THE LIBRARY.
 *
 * The reported fault was that the Assets section reported success for files
 * that were not stored. The upload protocol itself turned out to be careful
 * — the server HEADs the object before it will confirm anything — but the
 * last step of `uploadAsset` was not:
 *
 *     try   { const { asset } = await fetchAssetUsage(...); return { ok: true, asset }; }
 *     catch { return { ok: true, asset: <one assembled here from the File> }; }
 *
 * The read-back is the step that proves the row exists and is visible to
 * this survey — the last two boxes of the lifecycle the brief draws. When it
 * failed, the function invented an `AssetSummary` from the local `File`
 * (`customerId: ""`, `shared: false`, the server's display name lost) and
 * returned it as a success, so the library drew a tile for an asset nobody
 * had confirmed was there.
 *
 * These tests pin every exit of that function to the same rule: `ok: true`
 * only when something the server said came back.
 */

const ASSET = {
  id: "m1", surveyId: "sv-1", customerId: "c1", name: "logo.png", fileName: "logo.png",
  altText: null, mimeType: "image/png", family: "image", bytes: 11, width: 2, height: 2,
  durationSeconds: null, sha256: null, shared: false, fromOtherSurvey: false,
  createdAt: "2026-09-20T00:00:00.000Z", url: "/api/media/m1",
};

/**
 * The four routes `uploadAsset` touches, plus the object store.
 *
 * `readBack` is the switch under test: "ok" answers the library read, "500"
 * refuses it. `putStatus` refuses the PUT, which is what a misconfigured
 * bucket does to every upload.
 */
function stubFetch(opts: { readBack?: "ok" | "500"; putStatus?: number; duplicate?: boolean } = {}) {
  const calls: string[] = [];
  const stored = new Set<string>();
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);

    if (url.includes("/media/lookup")) return json({ ok: true, asset: opts.duplicate ? ASSET : null });
    if (url.includes("/media/ticket")) {
      return json({
        ok: true, mediaId: "m1", kind: "single", partBytes: 1 << 24, partCount: 1,
        uploadUrl: "https://store.test/signed/m1", uploadId: null, parts: [],
      });
    }
    if (url.includes("/media/parts")) return json({ ok: true, kind: "single", complete: stored.has("m1"), uploaded: [], parts: [] });
    if (url.includes("/media/confirm")) {
      if (!stored.has("m1")) return json({ ok: false, error: "the recording did not reach storage. Try the upload again." }, 409);
      return json({ ok: true, mediaId: "m1", video: { url: "/api/media/m1", mediaId: "m1", bytes: 11 } });
    }
    /* GET /api/surveys/<id>/media/<mediaId> — the read-back */
    if (/\/media\/m1$/.test(url)) {
      return opts.readBack === "500"
        ? json({ error: "the library is unavailable" }, 500)
        : json({ asset: ASSET, usage: [] });
    }

    /* the object store */
    const status = opts.putStatus ?? 200;
    if (status >= 200 && status < 300) { stored.add("m1"); return new Response("", { status, headers: { etag: '"e"' } }); }
    return new Response("<Error><Code>AccessDenied</Code></Error>", { status });
  }) as unknown as typeof fetch;

  return { impl, calls, stored };
}

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = original; });
}

const png = () => new File([new Uint8Array(11).fill(3)], "logo.png", { type: "image/png" });

/* ==================================================================== */

test("a complete upload returns the asset the SERVER described", async () => {
  const s = stubFetch({ readBack: "ok" });
  const out = await withFetch(s.impl, () => uploadAsset("sv-1", png()));
  assert.equal(out.ok, true);
  assert.ok(out.ok && out.asset.customerId === "c1", "the summary has to be the server's, not one built here");
  assert.equal(out.ok && out.duplicate, false);
  assert.ok(s.stored.has("m1"), "and the object really went to the store");
});

test("THE REGRESSION: a library read-back that fails is not a successful upload", async () => {
  const s = stubFetch({ readBack: "500" });
  const out = await withFetch(s.impl, () => uploadAsset("sv-1", png()));
  assert.equal(out.ok, false, "this returned ok:true with an asset assembled from the local File");
  assert.ok(!out.ok && /library could not read it back/i.test(out.error), out.ok ? "" : out.error);
});

test("a store that refuses the PUT is a failed upload, with the store's status in it", async () => {
  const s = stubFetch({ readBack: "ok", putStatus: 403 });
  const out = await withFetch(s.impl, () => uploadAsset("sv-1", png()));
  assert.equal(out.ok, false);
  assert.ok(!out.ok && /403/.test(out.error), `no status in "${!out.ok && out.error}"`);
  assert.equal(s.stored.has("m1"), false);
});

test("an identical file already in the library is reused, and says so", async () => {
  /* unchanged behaviour, asserted so the stricter rule above cannot break it */
  const s = stubFetch({ duplicate: true });
  const out = await withFetch(s.impl, () => uploadAsset("sv-1", png()));
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.duplicate, true);
  assert.ok(!s.calls.some((c) => c.includes("/media/ticket")), "nothing should have been uploaded");
});

test("progress ends at 1 only on a real success", async () => {
  const seen: number[] = [];
  const bad = stubFetch({ readBack: "500" });
  await withFetch(bad.impl, () => uploadAsset("sv-1", png(), { onProgress: (p) => seen.push(p.fraction) }));
  assert.ok(!seen.includes(1), `a failed upload reported ${JSON.stringify(seen)} — 1 means done`);

  const good: number[] = [];
  const ok = stubFetch({ readBack: "ok" });
  await withFetch(ok.impl, () => uploadAsset("sv-1", png(), { onProgress: (p) => good.push(p.fraction) }));
  assert.ok(good.includes(1), "and a real one has to reach it");
});

/* ---------------------------------------------------------------- sizes */

test("a size is reported at its own scale", () => {
  /*
   * `formatBytes` is what the library tiles show. A file of 483,940 bytes is
   * "473 KB", not "0.5 MB" and certainly not "0.0 MB" — the recorder panel
   * had the second of those and it is why "the file size is not displayed
   * correctly" was a fair description of it.
   */
  assert.equal(formatBytes(0), "");
  assert.equal(formatBytes(900), "900 B");
  assert.equal(formatBytes(72_385), "71 KB");
  assert.equal(formatBytes(483_940), "473 KB");
  assert.equal(formatBytes(1_577_660), "1.5 MB");
});

test("a file the library does not take is refused before a byte moves", () => {
  assert.equal(refuseFile(png()), null);
  const exe = new File([new Uint8Array(4)], "setup.exe", { type: "application/x-msdownload" });
  assert.match(String(refuseFile(exe)), /setup\.exe/);
});
