import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hashSharePassword, verifySharePassword, needsRehash, tooManyGuesses, SHARE_GUESS_LIMIT, tooManyDownloads, SHARE_DOWNLOAD_LIMIT } from "./sharePassword.ts";

test("R-4: new hashes are scrypt, salted, and verify only the right password", async () => {
  const h = await hashSharePassword("correct horse");
  assert.ok(h.startsWith("scrypt$"));
  assert.notEqual(h, await hashSharePassword("correct horse"), "salted");
  assert.equal(await verifySharePassword("correct horse", h), true);
  assert.equal(await verifySharePassword("wrong", h), false);
  assert.equal(await verifySharePassword("", h), false);
  assert.equal(needsRehash(h), false);
});

test("R-4: an old single-pass SHA-256 hash still verifies and is flagged for re-hashing", async () => {
  const legacy = `abc123$${createHash("sha256").update("abc123:oldpass").digest("hex")}`;
  assert.equal(await verifySharePassword("oldpass", legacy), true);
  assert.equal(await verifySharePassword("nope", legacy), false);
  assert.equal(needsRehash(legacy), true);
  assert.equal(await verifySharePassword("x", "garbage"), false);
});

test("R-4: the guess limit", () => {
  assert.equal(tooManyGuesses(SHARE_GUESS_LIMIT - 1), false);
  assert.equal(tooManyGuesses(SHARE_GUESS_LIMIT), true);
});

test("R-2: the download limit", () => {
  assert.equal(tooManyDownloads(SHARE_DOWNLOAD_LIMIT - 1), false);
  assert.equal(tooManyDownloads(SHARE_DOWNLOAD_LIMIT), true);
});
