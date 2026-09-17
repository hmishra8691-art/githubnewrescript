import test from "node:test";
import assert from "node:assert/strict";
import { stub } from "./store.test.js";
import { assetFor, findDuplicateAsset, listAssets, updateAsset, mediaFamily } from "./store.js";
import { ASSET_MAX_BYTES, acceptsType, assetFamilyFor, assetWithinLimit } from "./plan.js";

/**
 * THE ASSET LIBRARY — what a survey sees, what it may change, what is one file.
 */

const SHA = "a".repeat(64);
function seed(s: ReturnType<typeof stub>) {
  const base = { kind: "survey_asset", status: "stored", bucket: "rescript-assets", storage_provider: "supabase", created_at: "2026-09-01T00:00:00Z" };
  s.rows.set("own", { id: "own", customer_id: "c1", survey_id: "s1", path: "s1/a/1-logo.png", original_filename: "logo.png", mime_type: "image/png", bytes: 1000, sha256: SHA, shared: false, display_name: "Client logo", ...base });
  s.rows.set("shared", { id: "shared", customer_id: "c1", survey_id: "s2", path: "s2/a/1-brand.mp4", original_filename: "brand.mp4", mime_type: "video/mp4", bytes: 5000, shared: true, ...base, created_at: "2026-09-02T00:00:00Z" });
  s.rows.set("private", { id: "private", customer_id: "c1", survey_id: "s2", path: "s2/a/1-secret.pdf", original_filename: "secret.pdf", mime_type: "application/pdf", bytes: 700, shared: false, ...base });
  s.rows.set("other-customer", { id: "oc", customer_id: "c9", survey_id: "s9", path: "s9/a/1-x.png", original_filename: "x.png", mime_type: "image/png", bytes: 10, shared: true, ...base });
  s.rows.set("pending", { id: "pending", customer_id: "c1", survey_id: "s1", path: "s1/a/2-half.png", original_filename: "half.png", mime_type: "image/png", bytes: 10, shared: false, ...base, status: "pending" });
  s.rows.set("recording", { id: "rec", customer_id: "c1", survey_id: "s1", path: "s1/q/1.webm", original_filename: "1.webm", mime_type: "video/webm", bytes: 10, ...base, kind: "question_video" });
}

test("the library as survey s1 sees it: its own stored assets plus the customer's shared ones — nothing else", async () => {
  const s = stub(); seed(s);
  const list = await listAssets(s.db, { surveyId: "s1", customerId: "c1" });
  assert.deepEqual(list.map((a) => a.id).sort(), ["own", "shared"]);
  const own = list.find((a) => a.id === "own")!;
  assert.equal(own.name, "Client logo", "display name wins over the file name");
  assert.equal(own.family, "image");
  assert.equal(own.fromOtherSurvey, false);
  assert.equal(own.url, "/api/media/own/logo.png");
  const shared = list.find((a) => a.id === "shared")!;
  assert.equal(shared.name, "brand.mp4", "no display name → the file name");
  assert.equal(shared.family, "video");
  assert.equal(shared.fromOtherSurvey, true);
  // a private asset of another survey is invisible, whoever asks
  assert.equal(await assetFor(s.db, "private", { surveyId: "s1", customerId: "c1" }), null);
  // another customer's shared asset is invisible too
  assert.equal(await assetFor(s.db, "oc", { surveyId: "s1", customerId: "c1" }), null);
  // no customer → own assets only
  assert.deepEqual((await listAssets(s.db, { surveyId: "s1", customerId: null })).map((a) => a.id), ["own"]);
});

test("the same bytes are one asset: found in this survey, or shared across the customer — never private elsewhere", async () => {
  const s = stub(); seed(s);
  const dup = await findDuplicateAsset(s.db, { surveyId: "s1", customerId: "c1", sha256: SHA, bytes: 1000 });
  assert.equal(dup?.id, "own");
  // a different size with the same hash is not a match
  assert.equal(await findDuplicateAsset(s.db, { surveyId: "s1", customerId: "c1", sha256: SHA, bytes: 999 }), null);
  // another survey's private copy is not offered
  assert.equal(await findDuplicateAsset(s.db, { surveyId: "s3", customerId: "c1", sha256: SHA }), null);
  // a shared one is
  s.rows.get("own")!.shared = true;
  assert.equal((await findDuplicateAsset(s.db, { surveyId: "s3", customerId: "c1", sha256: SHA }))?.id, "own");
  assert.equal(await findDuplicateAsset(s.db, { surveyId: "s1", customerId: "c1", sha256: "not-a-hash" }), null);
});

test("rename, describe and share — from the owning survey only", async () => {
  const s = stub(); seed(s);
  const a = await updateAsset(s.db, "own", "s1", { displayName: "Logo 2026", altText: "Acme Corp", shared: true });
  assert.equal(a?.name, "Logo 2026");
  assert.equal(a?.altText, "Acme Corp");
  assert.equal(a?.shared, true);
  // s2 sees the shared asset but may not edit it
  assert.equal(await updateAsset(s.db, "own", "s2", { displayName: "Mine now" }), null);
  assert.equal(s.rows.get("own")!.display_name, "Logo 2026");
  // clearing the name falls back to the file name
  const b = await updateAsset(s.db, "own", "s1", { displayName: null });
  assert.equal(b?.name, "logo.png");
});

test("what the library takes: an allowlist by family, with a ceiling per family", () => {
  assert.equal(assetFamilyFor("image/png"), "image");
  assert.equal(assetFamilyFor("video/quicktime"), "video");
  assert.equal(assetFamilyFor("audio/mpeg"), "audio");
  assert.equal(assetFamilyFor("application/pdf"), "document");
  assert.equal(assetFamilyFor("text/html"), null, "an HTML file served from the asset store would be a page on this origin");
  assert.equal(assetFamilyFor("application/zip"), null);
  assert.equal(assetFamilyFor("application/x-msdownload"), null);
  assert.equal(acceptsType("survey_asset", "text/html").ok, false);
  assert.equal(acceptsType("survey_asset", "image/svg+xml").ok, true);
  assert.equal(assetWithinLimit("image/png", ASSET_MAX_BYTES.image + 1).ok, false);
  assert.equal(assetWithinLimit("video/mp4", ASSET_MAX_BYTES.image + 1).ok, true, "a video may be larger than a picture");
  assert.equal(assetWithinLimit("video/mp4", ASSET_MAX_BYTES.video + 1).ok, false);
  assert.equal(mediaFamily("audio/wav"), "audio");
  assert.equal(mediaFamily(null), "document");
});
