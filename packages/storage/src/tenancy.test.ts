import test from "node:test";
import assert from "node:assert/strict";
import { readTenancyConfig, resolveDatabase, describeTenancy, PRIMARY, ROUTING_WIRED } from "./tenancy.js";

const base = { SUPABASE_URL: "https://primary.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc-primary" };
const ACME = "11111111-2222-4333-8444-555555555555";

test("today's deployment: one database, every scope resolves to it", () => {
  const c = readTenancyConfig(base);
  assert.equal(c.mode, "single");
  assert.deepEqual(c.problems, []);
  for (const scope of [{ kind: "platform" as const }, { kind: "customer" as const, customerId: ACME }, { kind: "customer" as const, customerId: null }]) {
    assert.equal(resolveDatabase(scope, c).url, "https://primary.supabase.co");
  }
  assert.throws(() => resolveDatabase({ kind: "platform" }, readTenancyConfig({})), /not configured/);
});

test("extra databases and the client map are read and validated ahead of time", () => {
  const c = readTenancyConfig({
    ...base,
    RESCRIPT_DATABASES: "acme, Globex",
    RESCRIPT_DB_ACME_URL: "https://acme.supabase.co", RESCRIPT_DB_ACME_SERVICE_KEY: "svc-acme",
    RESCRIPT_DB_GLOBEX_URL: "https://globex.supabase.co", RESCRIPT_DB_GLOBEX_SERVICE_KEY: "svc-globex",
    RESCRIPT_TENANT_DATABASES: `${ACME}:acme`,
  });
  assert.deepEqual(c.problems, []);
  assert.deepEqual([...c.databases.keys()], [PRIMARY, "acme", "globex"]);
  assert.equal(c.tenants.get(ACME), "acme");
  assert.match(c.notes[0]!, /RESCRIPT_TENANCY is "single": everything uses the primary/);
  assert.equal(resolveDatabase({ kind: "customer", customerId: ACME }, c).id, PRIMARY, "mapped, but inactive in single mode");
  assert.doesNotMatch(describeTenancy(c), /svc-/, "no key in the description");
  assert.match(describeTenancy(c), /primary, acme, globex.*1 \(inactive\)/);
});

test("mistakes are reported, not guessed around", () => {
  const c = readTenancyConfig({
    ...base, RESCRIPT_TENANCY: "sharded",
    RESCRIPT_DATABASES: "acme,primary,Bad-Id,dup,dup,same",
    RESCRIPT_DB_DUP_URL: "https://dup.supabase.co", RESCRIPT_DB_DUP_SERVICE_KEY: "k",
    RESCRIPT_DB_SAME_URL: "https://primary.supabase.co", RESCRIPT_DB_SAME_SERVICE_KEY: "k",
    RESCRIPT_TENANT_DATABASES: `not-a-uuid:dup,${ACME}:nowhere,${ACME.toUpperCase()}:dup,${ACME}:dup`,
  });
  const all = c.problems.join("\n");
  for (const re of [/must be "single" or "routed"/, /"acme" needs RESCRIPT_DB_ACME_URL/, /"primary"/, /"Bad-Id"/, /"dup" is listed twice/, /points at the primary/, /must be a workspace id/, /"nowhere" is not one of/, /mapped twice/]) assert.match(all, re);
});

test("routing stays locked until the wiring is finished", () => {
  assert.equal(ROUTING_WIRED, false);
  const c = readTenancyConfig({ ...base, RESCRIPT_TENANCY: "routed" });
  assert.match(c.problems.join(" "), /not available yet.*split its data/);
  assert.equal(resolveDatabase({ kind: "platform" }, c).id, PRIMARY, "platform data is always the primary");
  assert.equal(resolveDatabase({ kind: "customer", customerId: ACME }, c).id, PRIMARY, "refused by staying on the primary — never a split");
});
