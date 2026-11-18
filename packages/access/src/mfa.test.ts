import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { base32Decode, base32Encode, mfaPolicy, mfaRequiredFor, newRecoveryCodes, newTotpSecret, otpauthUrl, readEnrolTicket, signEnrolTicket, stepOf, totpAt, useRecoveryCode, verifyTotp } from "./mfa.js";

/* RFC 6238 appendix B, SHA-1, secret "12345678901234567890": the 8-digit values, of which the 6-digit code is the tail */
const RFC = base32Encode(Buffer.from("12345678901234567890"));
const VECTORS: [number, string][] = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];

test("TOTP matches the RFC 6238 test vectors", () => {
  for (const [t, code] of VECTORS) assert.equal(totpAt(RFC, Math.floor(t / 30), 8), code, `T = ${t}`);
  assert.equal(totpAt(RFC, Math.floor(59 / 30)), "287082");
  assert.deepEqual(base32Decode(base32Encode(Buffer.from("hello world!"))), Buffer.from("hello world!"));
});

test("a code is accepted within one step of drift, once; a later replay, a wrong code and a malformed one are refused", () => {
  const secret = newTotpSecret();
  const now = 1_800_000_000_000;
  const code = totpAt(secret, stepOf(now));
  const r = verifyTotp(secret, code, { now });
  assert.deepEqual(r, { ok: true, step: stepOf(now) });
  assert.deepEqual(verifyTotp(secret, code, { now, lastStep: stepOf(now) }), { ok: false, reason: "replayed" });
  assert.equal(verifyTotp(secret, totpAt(secret, stepOf(now) - 1), { now }).ok, true, "30 s of clock drift is fine");
  assert.equal(verifyTotp(secret, totpAt(secret, stepOf(now) - 3), { now }).ok, false, "90 s is not");
  assert.deepEqual(verifyTotp(secret, code === "000000" ? "111111" : "000000", { now }), { ok: false, reason: "wrong" });
  assert.deepEqual(verifyTotp(secret, "12345", { now }), { ok: false, reason: "format" });
  assert.equal(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { now }).ok, true, "a space in the middle, as apps show it");
  assert.match(otpauthUrl("Rescript", "ana@example.test", secret), /^otpauth:\/\/totp\/Rescript%3Aana%40example\.test\?secret=[A-Z2-7]+&issuer=Rescript&algorithm=SHA1&digits=6&period=30$/);
});

test("recovery codes: ten, stored as hashes, each works once, case and dash do not matter", () => {
  const { codes, hashes } = newRecoveryCodes();
  assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10);
  assert.ok(hashes.every((h) => /^[0-9a-f]{64}$/.test(h)) && !hashes.some((h) => codes.includes(h)));
  const left = useRecoveryCode(hashes, codes[3].toLowerCase().replace("-", ""))!;
  assert.equal(left.length, 9);
  assert.equal(useRecoveryCode(left, codes[3]), null, "used up");
  assert.equal(useRecoveryCode(hashes, "ZZZZ-ZZZZ"), null);
});

test("policy: administrators always need a second factor; the workspace can extend it to everyone, not remove it from admins", () => {
  assert.equal(mfaRequiredFor(mfaPolicy(null), "platform_admin"), true);
  assert.equal(mfaRequiredFor(mfaPolicy({ require: "off" }), "platform_admin"), true);
  assert.equal(mfaRequiredFor(mfaPolicy(null), "programmer"), false);
  assert.equal(mfaRequiredFor(mfaPolicy({ require: "everyone" }), "programmer"), true);
  assert.equal(mfaPolicy({ require: "nonsense" as never }).require, "admins");
});

test("the enrolment ticket is signed and expires", () => {
  const key = randomBytes(32);
  const t = signEnrolTicket(key, { userId: "u1", sealedSecret: "blob", exp: 2_000 });
  assert.deepEqual(readEnrolTicket(key, t, 1_000), { userId: "u1", sealedSecret: "blob", exp: 2_000 });
  assert.equal(readEnrolTicket(key, t, 3_000), null, "expired");
  assert.equal(readEnrolTicket(randomBytes(32), t, 1_000), null, "another key");
  const [body, mac] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ userId: "admin", sealedSecret: "blob", exp: 2_000 })).toString("base64url");
  assert.equal(readEnrolTicket(key, `${forged}.${mac}`, 1_000), null, "a changed body fails its signature");
  assert.ok(body);
});
