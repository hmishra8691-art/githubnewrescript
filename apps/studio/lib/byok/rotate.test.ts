import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MemoryAiStore } from "./store.ts";
import { saveCredential, saveSetting } from "./service.ts";
import { rotateCredentials } from "./rotate.ts";
import { masterKeys, openSecret } from "./vault.ts";

const OLD = randomBytes(32).toString("hex"), NEW = randomBytes(32).toString("hex");
const A = "aaaaaaaa-0000-0000-0000-0000000000a1", B = "bbbbbbbb-0000-0000-0000-0000000000b2";

async function seeded() {
  const store = new MemoryAiStore();
  const oldEnv = { AI_CREDENTIAL_KEY: OLD };
  await saveSetting(A, { feature: "intelligent", mode: "user", config: { provider: "openai", model: "gpt-4.1" }, apiKey: "sk-proj-ROTATIONKEYAAAAAAAA0001" }, { store, env: oldEnv });
  await saveCredential(B, { provider: "deepl", apiKey: "deepl-rotation-key-bbbbbbbb:fx" }, { store, env: oldEnv });
  return store;
}

test("rotation re-wraps every credential under the new master key; the secrets still open and nothing else changed", async () => {
  const store = await seeded();
  const before = await store.listCredentialsPage(0, 10);
  const env = { AI_CREDENTIAL_KEY: NEW, AI_CREDENTIAL_KEY_PREVIOUS: OLD };
  const r = await rotateCredentials(store, env);
  assert.deepEqual([r.total, r.rewrapped, r.alreadyCurrent, r.unreadable], [2, 2, 0, 0]);
  const after = await store.listCredentialsPage(0, 10);
  for (const c of after) {
    assert.equal(c.keyId, r.activeKeyId); assert.notEqual(c.sealed, before.find((x) => x.id === c.id)!.sealed);
    assert.ok(openSecret(c.sealed, { userId: c.userId, credentialId: c.id }, env).length > 8);
    assert.equal(c.mask, before.find((x) => x.id === c.id)!.mask, "the mask is untouched");
  }
  assert.equal(openSecret(after.find((c) => c.userId === A)!.sealed, { userId: A, credentialId: after.find((c) => c.userId === A)!.id }, env), "sk-proj-ROTATIONKEYAAAAAAAA0001");
  /* the old key alone can no longer open them: it can now be dropped */
  assert.throws(() => openSecret(after[0].sealed, { userId: after[0].userId, credentialId: after[0].id }, { AI_CREDENTIAL_KEY: OLD }));
  assert.equal(masterKeys({ AI_CREDENTIAL_KEY: NEW }).active!.id, r.activeKeyId);
});

test("re-running is a no-op; a dry run changes nothing; a dropped retired key is reported and the row left as it was", async () => {
  const store = await seeded();
  const env = { AI_CREDENTIAL_KEY: NEW, AI_CREDENTIAL_KEY_PREVIOUS: OLD };
  const snapshot = JSON.stringify(await store.listCredentialsPage(0, 10));
  const dry = await rotateCredentials(store, env, { dryRun: true });
  assert.equal(dry.rewrapped, 2); assert.equal(JSON.stringify(await store.listCredentialsPage(0, 10)), snapshot, "a dry run writes nothing");
  await rotateCredentials(store, env);
  const again = await rotateCredentials(store, env);
  assert.deepEqual([again.rewrapped, again.alreadyCurrent], [0, 2]);

  const lost = await seeded();
  const forgot = await rotateCredentials(lost, { AI_CREDENTIAL_KEY: NEW });
  assert.equal(forgot.unreadable, 2); assert.equal(forgot.rewrapped, 0);
  assert.equal(Object.values(forgot.remainingByKey).reduce((a, b) => a + b, 0), 2, "it says which retired key still protects them");
  assert.equal((await lost.listCredentialsPage(0, 10)).length, 2, "nothing was deleted");
});

test("pagination covers every credential, and no key means no rotation", async () => {
  const store = new MemoryAiStore();
  const env = { AI_CREDENTIAL_KEY: OLD };
  for (let i = 0; i < 7; i++) await saveCredential(`cccccccc-0000-0000-0000-00000000000${i}`, { provider: "openai", apiKey: `sk-proj-PAGEDKEY00000000000${i}` }, { store, env });
  const r = await rotateCredentials(store, { AI_CREDENTIAL_KEY: NEW, AI_CREDENTIAL_KEY_PREVIOUS: OLD }, { pageSize: 3 });
  assert.equal(r.total, 7); assert.equal(r.rewrapped, 7);
  await assert.rejects(rotateCredentials(store, {}), /no credential encryption key/i);
  await assert.rejects(rotateCredentials(store, { AI_CREDENTIAL_KEY: "short" }), /32 random bytes/);
});
