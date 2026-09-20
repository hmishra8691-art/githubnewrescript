import test from "node:test";
import assert from "node:assert/strict";
import { confirmUpload, beginUpload, resetBucketCache, MediaError } from "./store.js";
import { mediaStores, supabaseObjectStore, type ObjectStore, type SupabaseStorageLike } from "./objectStore.js";
import { stub } from "./store.test.js";

/*
 * WHEN AN UPLOAD DOES NOT ARRIVE, THE ROW HAS TO SAY WHY.
 *
 * Production held eleven `media_objects` rows — six question videos and five
 * survey assets, over two days — all at `status = 'pending'` with `error`
 * NULL, all on the R2 provider, none of them ever stored. Every one of them
 * was a browser that had been refused by the store.
 *
 * That combination of nulls was indistinguishable from the one legitimate
 * reason a row sits at `pending`: somebody closed the tab mid-transfer. So
 * eleven failures of a single, fixable, configuration fault looked exactly
 * like eleven people changing their minds — and the product had no way to
 * tell anyone otherwise, because the one code path that knew threw without
 * writing anything down:
 *
 *     catch (e) { throw new MediaError(`could not confirm the upload: …`); }
 *
 * The object's absence was recorded. The store's REFUSAL TO SAY was not.
 * These tests hold both branches to the same standard.
 */

/** An object store that answers a question with a slammed door. */
function refusingStore(message: string, status = 502): ObjectStore {
  const boom = () => { const e = new Error(message) as Error & { status: number }; e.status = status; throw e; };
  return {
    name: "cloudflare-r2",
    multipart: true,
    async ceiling(_bucket: string, wanted: number) { return wanted; },
    async grantUpload() { return { url: "https://store.test/signed", uploadId: null, parts: [], partBytes: 0, partCount: 1 } as never; },
    async resumeUpload() { return { uploaded: [], parts: [], partBytes: 0, partCount: 1 }; },
    async completeUpload() { return boom(); },
    async abortUpload() { /* nothing to abort */ },
    async head() { return boom(); },
    async signDownload() { return "https://store.test/read"; },
    async read() { return boom(); },
    async remove() { return { removed: 0, warnings: [] } as never; },
    async copy() { return boom(); },
  } as unknown as ObjectStore;
}

const BEGIN = {
  kind: "survey_asset" as const,
  customerId: "cust-1",
  surveyId: "sv-1",
  questionId: "q-1",
  fileName: "logo.png",
  mimeType: "image/png",
  bytes: 483_940,
  now: 1_700_000_000_000,
};

test("a store that refuses the HEAD writes its refusal onto the row", async () => {
  resetBucketCache();
  const store = refusingStore("Reading the object failed (403) — AccessDenied: token is not authorised", 502);
  const s = stub({ stores: mediaStores(store) });
  const ticket = await beginUpload(s.db, BEGIN);

  await assert.rejects(
    () => confirmUpload(s.db, ticket.mediaId, { bytes: BEGIN.bytes }),
    (e: MediaError) => e.status === 502 && /AccessDenied/.test(e.message),
    "the store's own words have to reach the caller, not a generic 500",
  );

  const row = s.rows.get(ticket.mediaId)!;
  assert.notEqual(row.error, null, "THE REGRESSION: the row was left with no reason at all");
  assert.match(
    String(row.error), /AccessDenied/,
    "the reason on the row has to be the store's, not a paraphrase — 'AccessDenied' and "
    + "'NoSuchBucket' are different faults with different fixes",
  );
});

test("…and stays `pending`, because nobody has been able to look", async () => {
  /*
   * Deliberately NOT `failed`. A refused HEAD says the store could not be
   * asked; the object may well be sitting in the bucket. Marking it failed
   * would be asserting something nobody checked, and `sweepAbandonedUploads`
   * already knows what to do with an old pending row.
   */
  resetBucketCache();
  const s = stub({ stores: mediaStores(refusingStore("Reading the object failed (403) — AccessDenied")) });
  const ticket = await beginUpload(s.db, BEGIN);
  await assert.rejects(() => confirmUpload(s.db, ticket.mediaId, {}));
  assert.equal(s.rows.get(ticket.mediaId)!.status, "pending");
});

test("an object that is definitively absent is still marked failed, as before", async () => {
  /*
   * The other branch, unchanged — and asserted here so that the fix above
   * cannot be "simplified" by collapsing the two. A store that ANSWERS
   * "not there" is evidence; a store that will not answer is not.
   */
  resetBucketCache();
  const s = stub();                       // legacy store, no object written
  const ticket = await beginUpload(s.db, BEGIN);
  await assert.rejects(
    () => confirmUpload(s.db, ticket.mediaId, {}),
    (e: MediaError) => e.status === 409 && /did not reach storage/.test(e.message),
  );
  const row = s.rows.get(ticket.mediaId)!;
  assert.equal(row.status, "failed");
  assert.match(String(row.error), /not found in storage/);
});

/* ================================================= the emulated HEAD's reach */

/**
 * A Supabase Storage double whose `list` behaves like the real one: capped by
 * `limit`, paged by `offset`, narrowed by `search`.
 */
function pagedStorage(names: string[], opts: { honourSearch?: boolean } = {}): SupabaseStorageLike {
  return {
    listBuckets: async () => ({ data: [{ name: "rescript-assets" }], error: null }),
    createBucket: async () => ({ error: null }),
    from: () => ({
      createSignedUploadUrl: async (path: string) => ({ data: { signedUrl: "https://s/x", token: "t", path }, error: null }),
      createSignedUrl: async () => ({ data: { signedUrl: "https://s/read" }, error: null }),
      download: async () => ({ data: null, error: { message: "no" } }),
      remove: async () => ({ data: null, error: null }),
      list: async (_folder: string, o?: { limit?: number; offset?: number; search?: string }) => {
        const pool = opts.honourSearch !== false && o?.search
          ? names.filter((n) => n.includes(o.search!))
          : names;
        const from = o?.offset ?? 0;
        const page = pool.slice(from, from + (o?.limit ?? 100));
        return { data: page.map((name) => ({ name, metadata: { size: 11, mimetype: "image/png" } })), error: null };
      },
    }),
  } as SupabaseStorageLike;
}

test("the emulated HEAD finds an object past the first page of its folder", async () => {
  /*
   * A single `list(folder, { limit: 1000 })` answered "not there" for any
   * object with more than a thousand siblings — and `confirmUpload` reads
   * that answer as proof the upload failed, marks the row `failed` and tells
   * the researcher their file did not arrive. For a file that did.
   *
   * An assets folder reaches a thousand objects on its own. The failure would
   * have begun at one particular upload and never stopped.
   */
  const names = Array.from({ length: 1500 }, (_, i) => `file-${i}.png`);
  const store = supabaseObjectStore(pagedStorage(names, { honourSearch: false }));
  const late = await store.head("rescript-assets", "sv-1/question/file-1400.png");
  assert.ok(late, "an object at position 1400 was reported absent");
  assert.equal(late!.size, 11);

  const early = await store.head("rescript-assets", "sv-1/question/file-3.png");
  assert.ok(early, "and the first page still works");
});

test("…and asks for the one name when the store can narrow it", async () => {
  const names = Array.from({ length: 1500 }, (_, i) => `file-${i}.png`);
  const store = supabaseObjectStore(pagedStorage(names, { honourSearch: true }));
  assert.ok(await store.head("rescript-assets", "sv-1/question/file-1400.png"));
});

test("an object that truly is not there is still absent, however many pages", async () => {
  /*
   * The paging loop must not turn "not found" into "keep looking for ever",
   * and must not accidentally match a sibling — `file-14.png` is a prefix of
   * `file-140.png`, which is exactly the confusion a `search` filter invites.
   */
  const names = Array.from({ length: 1500 }, (_, i) => `file-${i}.png`);
  const store = supabaseObjectStore(pagedStorage(names));
  assert.equal(await store.head("rescript-assets", "sv-1/question/file-9999.png"), null);
  const exact = await store.head("rescript-assets", "sv-1/question/file-14.png");
  assert.ok(exact, "and an exact name is matched exactly, not by prefix collision");
});
