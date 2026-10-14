import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sealSecret, openSecret, rewrap, maskSecret, vaultStatus, masterKeys, VaultError } from "./vault.ts";

const K1 = randomBytes(32).toString("hex"), K2 = randomBytes(32).toString("base64");
const env = (o: Record<string, string> = {}) => ({ AI_CREDENTIAL_KEY: K1, ...o });
const who = { userId: "11111111-1111-1111-1111-111111111111", credentialId: "c0000000-0000-0000-0000-000000000001" };

test("seal and open: the key comes back exactly; the stored blob contains neither the key nor any part of it", () => {
  const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUV0123456789";
  const { sealed, keyId } = sealSecret(secret, who, env());
  assert.equal(openSecret(sealed, who, env()), secret);
  assert.equal(sealed.includes(secret), false); assert.equal(sealed.includes("ABCDEFGH"), false); assert.equal(Buffer.from(sealed).toString("base64").includes("QUJDREVGR0g"), false);
  assert.match(keyId, /^[0-9a-f]{12}$/);
  assert.notEqual(sealSecret(secret, who, env()).sealed, sealed, "a fresh data key and nonce each time");
  assert.equal(openSecret(sealSecret("é中🔑 unicode", who, env()).sealed, who, env()), "é中🔑 unicode");
});

test("a sealed blob is bound to its owner and its row: another user, another credential, a tampered byte — none opens", () => {
  const { sealed } = sealSecret("the-secret-key-value", who, env());
  const expectCannot = (fn: () => unknown) => assert.throws(fn, (e: Error) => e instanceof VaultError && /cannot_open|malformed/.test((e as VaultError).code));
  expectCannot(() => openSecret(sealed, { ...who, userId: "22222222-2222-2222-2222-222222222222" }, env()));
  expectCannot(() => openSecret(sealed, { ...who, credentialId: "c0000000-0000-0000-0000-000000000002" }, env()));
  const b = JSON.parse(sealed); const flip = (s: string) => Buffer.from(Buffer.from(s, "base64").map((x, i) => (i === 0 ? x ^ 1 : x))).toString("base64");
  for (const field of ["c", "wk", "n", "wn"] as const) expectCannot(() => openSecret(JSON.stringify({ ...b, [field]: flip(b[field]) }), who, env()));
  expectCannot(() => openSecret("not json", who, env())); expectCannot(() => openSecret("{}", who, env()));
  expectCannot(() => openSecret(sealed, who, { AI_CREDENTIAL_KEY: randomBytes(32).toString("hex") }));
});

test("no master key, no vault: nothing is sealed, and nothing is ever stored unencrypted", () => {
  assert.deepEqual(vaultStatus({}), { ready: false, reason: vaultStatus({}).reason }); assert.match(vaultStatus({}).reason!, /not enabled|no credential encryption key/i);
  assert.throws(() => sealSecret("x", who, {}), (e: Error) => (e as VaultError).code === "not_configured");
  assert.throws(() => sealSecret("x", who, { AI_CREDENTIAL_KEY: "short" }), (e: Error) => (e as VaultError).code === "bad_master_key");
  assert.equal(vaultStatus({ AI_CREDENTIAL_KEY: "short" }).ready, false);
  assert.throws(() => openSecret(sealSecret("x", who, env()).sealed, who, {}), (e: Error) => (e as VaultError).code === "not_configured");
  assert.equal(vaultStatus(env()).ready, true); assert.equal(vaultStatus({ AI_CREDENTIAL_KEY: K2 }).ready, true, "base64 keys work too");
});

test("rotation: a new active key seals new secrets; old secrets still open with the old key retained; rewrap moves them without decrypting; dropping the old key then strands only un-rewrapped rows", () => {
  const old = sealSecret("rotate-me-please-1234", who, env());
  const rotated = { AI_CREDENTIAL_KEY: K2, AI_CREDENTIAL_KEY_PREVIOUS: K1 };
  assert.equal(openSecret(old.sealed, who, rotated), "rotate-me-please-1234");
  assert.notEqual(masterKeys(rotated).active!.id, old.keyId);
  const moved = rewrap(old.sealed, who, rotated)!;
  assert.equal(moved.keyId, masterKeys(rotated).active!.id);
  assert.equal(openSecret(moved.sealed, who, { AI_CREDENTIAL_KEY: K2 }), "rotate-me-please-1234", "the old key is no longer needed");
  assert.equal(rewrap(moved.sealed, who, rotated), null, "already on the active key");
  assert.throws(() => openSecret(old.sealed, who, { AI_CREDENTIAL_KEY: K2 }), (e: Error) => e instanceof VaultError);
  assert.equal(JSON.parse(moved.sealed).c, JSON.parse(old.sealed).c, "the ciphertext itself was not touched");
});

test("a mask shows a prefix and four characters — never enough to use the key", () => {
  assert.equal(maskSecret("sk-proj-ABCDEFGHIJKLMNOPQRSTUV0123456789"), "sk-proj-••••••••6789");
  assert.equal(maskSecret("sk-ant-api03-abcdefghijklmnop"), "sk-ant-••••••••mnop");
  assert.equal(maskSecret("AIzaSyDabcdefghijklmnop"), "AIza••••••••mnop");
  assert.equal(maskSecret("short"), "••••••••");
  assert.ok(maskSecret("0123456789abcdef0123456789abcdef").length < 20);
});
