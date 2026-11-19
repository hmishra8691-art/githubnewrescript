import test from "node:test";
import assert from "node:assert/strict";
import { makeDirectory, routingActive } from "./directory.js";
import { readTenancyConfig, ROUTING_WIRED } from "./tenancy.js";

const ACME = "11111111-2222-4333-8444-555555555555";

test("routing is not active today, so the apps never pay for a directory lookup", () => {
  const base = { SUPABASE_URL: "https://primary.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc" };
  assert.equal(routingActive(readTenancyConfig(base)), false);
  const mapped = readTenancyConfig({
    ...base, RESCRIPT_TENANCY: "routed", RESCRIPT_DATABASES: "acme",
    RESCRIPT_DB_ACME_URL: "https://acme.supabase.co", RESCRIPT_DB_ACME_SERVICE_KEY: "k", RESCRIPT_TENANT_DATABASES: `${ACME}:acme`,
  });
  assert.equal(routingActive(mapped), ROUTING_WIRED, "routed + a mapped client is active only once the wiring is declared finished");
});

test("answers are cached, concurrent asks share one query, misses expire sooner, errors are not cached", async () => {
  let t = 0, calls = 0, fail = false;
  const dir = makeDirectory({
    now: () => t,
    lookups: {
      survey: async (id: string) => { calls++; await new Promise((r) => setTimeout(r, 5)); if (fail) throw new Error("down"); return id === "s1" ? ACME : null; },
    },
  });
  const [a, b] = await Promise.all([dir.customerOf("survey", "s1"), dir.customerOf("survey", "s1")]);
  assert.equal(a, ACME); assert.equal(b, ACME); assert.equal(calls, 1);
  t = 9 * 60_000; await dir.customerOf("survey", "s1"); assert.equal(calls, 1, "still fresh");
  t = 11 * 60_000; await dir.customerOf("survey", "s1"); assert.equal(calls, 2, "expired after 10 minutes");

  assert.equal(await dir.customerOf("survey", "nope"), null); assert.equal(calls, 3);
  t += 20_000; await dir.customerOf("survey", "nope"); assert.equal(calls, 3);
  t += 20_000; await dir.customerOf("survey", "nope"); assert.equal(calls, 4, "a miss is re-asked after 30 s");

  assert.equal(await dir.customerOf("survey", null), null); assert.equal(calls, 4, "no id, no query");

  fail = true;
  await assert.rejects(dir.customerOf("survey", "s2"), /down/);
  fail = false;
  assert.equal(await dir.customerOf("survey", "s2"), null, "the failure was not cached");

  dir.forget("survey", "s1"); await dir.customerOf("survey", "s1"); assert.equal(calls, 7);
});

test("the cache is bounded", async () => {
  const dir = makeDirectory({ max: 3, lookups: { survey: async (id: string) => id } });
  for (const id of ["a", "b", "c", "d"]) await dir.customerOf("survey", id);
  assert.equal(dir.size(), 3);
});
