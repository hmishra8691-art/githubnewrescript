import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * STATIC CONTAINMENT of the secret. A behavioural test covers the paths
 * somebody thought to test; this covers the paths somebody adds later.
 *
 *   - a key is DECRYPTED (`openSecret`) in two files only: the resolver (to
 *     build one request's connection) and the service (to test or list models
 *     with a saved key);
 *   - the ciphertext (`sealed`) is read by nothing outside the byok library;
 *   - no route reads the master key, and no module outside the vault does.
 */
const ROOT = new URL("../../", import.meta.url).pathname; // apps/studio
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".next" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n)) out.push(p);
  }
  return out;
}
const files = walk(ROOT).map((p) => ({ rel: relative(ROOT, p), text: readFileSync(p, "utf8") }));

test("openSecret is called only by the resolver and the service", () => {
  const users = files.filter((f) => /\bopenSecret\s*\(/.test(f.text)).map((f) => f.rel).sort();
  assert.deepEqual(users, ["lib/byok/resolve.ts", "lib/byok/service.ts", "lib/byok/vault.ts"]);
});

test("the ciphertext and the master key never appear outside the byok library", () => {
  const outside = files.filter((f) => !f.rel.startsWith("lib/byok/"));
  assert.deepEqual(outside.filter((f) => /\bsealed\b/.test(f.text) && /user_ai_credentials|CredentialRow/.test(f.text)).map((f) => f.rel), []);
  assert.deepEqual(outside.filter((f) => /AI_CREDENTIAL_KEY/.test(f.text)).map((f) => f.rel), [], "only the vault reads the master key");
  const inside = files.filter((f) => f.rel.startsWith("lib/byok/") && /AI_CREDENTIAL_KEY/.test(f.text)).map((f) => f.rel).sort();
  assert.deepEqual(inside, ["lib/byok/vault.ts"]);
});

test("no API route returns a credential row: routes go through the service, which returns views", () => {
  const routes = files.filter((f) => f.rel.startsWith("app/api/account/ai/"));
  assert.ok(routes.length >= 5);
  for (const r of routes) {
    assert.equal(/getCredential|listCredentials|\.sealed|\bmask\b.*sealed/.test(r.text), false, `${r.rel} touches the credential store directly`);
    assert.match(r.text, /requireUser\(req\)/, `${r.rel} is behind the gate`);
  }
});

test("the credential tables are never queried from anywhere but the store", () => {
  const q = files.filter((f) => /user_ai_credentials|user_ai_settings/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(q, ["lib/byok/store.ts"]);
});
