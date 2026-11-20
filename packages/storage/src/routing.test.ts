import test from "node:test";
import assert from "node:assert/strict";
import { makeTenantRouter, type DirectoryRow } from "./routing.js";
import { readTenancyConfig, type TenancyConfig } from "./tenancy.js";

const ACME = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";
const base = { SUPABASE_URL: "https://primary.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc" };

function rig(config: TenancyConfig, active?: boolean) {
  const rows: DirectoryRow[] = [];
  let reads = 0;
  const router = makeTenantRouter<string>({
    config: () => config,
    ...(active === undefined ? {} : { active: () => active }),
    customerDb: (id) => (id && config.tenants.has(id) ? `db:${config.tenants.get(id)}` : "db:primary"),
    readDirectory: async (kind, key) => { reads++; return rows.find((r) => r.kind === kind && r.key === key)?.customer_id ?? null; },
    writeDirectory: async (row) => { if (row.key === "fail") throw new Error("down"); if (!rows.some((r) => r.kind === row.kind && r.key === row.key)) rows.push(row); },
    log: () => {},
  });
  return { router, rows, reads: () => reads };
}

test("routing off (today): no directory read or write, every key on the primary, one database to sweep", async () => {
  const { router, rows, reads } = rig(readTenancyConfig(base));
  assert.equal(router.active(), false);
  assert.equal(await router.keyDb("survey", "s1"), "db:primary");
  assert.equal(await router.customerOf("interview_project", "p1"), null);
  assert.equal(await router.registerKeyFor("survey", "s1", ACME), true);
  assert.equal(await router.registerKeyLike("session", "x", "survey", "s1"), true);
  assert.equal(reads(), 0); assert.equal(rows.length, 0);
  assert.deepEqual(router.everyDatabase().map((d) => d.id), ["primary"]);
});

test("routing on: rows only for mapped clients, an owner's client inherited, a failed write reported, every database swept", async () => {
  const cfg = readTenancyConfig({
    ...base, RESCRIPT_DATABASES: "acme",
    RESCRIPT_DB_ACME_URL: "https://acme.supabase.co", RESCRIPT_DB_ACME_SERVICE_KEY: "k", RESCRIPT_TENANT_DATABASES: `${ACME}:acme`,
  });
  const { router, rows } = rig(cfg, true);
  assert.equal(await router.registerKeyFor("survey", "s1", ACME, "s1"), true);
  assert.equal(await router.registerKeyFor("survey", "s2", OTHER), true);
  assert.deepEqual(rows.map((r) => r.key), ["s1"], "a client on the primary gets no row");
  assert.equal(await router.keyDb("survey", "s1"), "db:acme");
  assert.equal(await router.keyDb("survey", "s2"), "db:primary");
  assert.equal(await router.keyDb("survey", null), "db:primary");
  assert.equal(await router.registerKeyLike("session", "sess", "survey", "s1", "s1"), true);
  assert.equal(await router.keyDb("session", "sess"), "db:acme");
  assert.equal(await router.registerKeyLike("session", "orphan", "survey", "s2"), true, "owner on the primary: nothing to write");
  assert.equal(rows.length, 2);
  assert.equal(await router.registerKeyFor("survey", "fail", ACME), false);
  assert.deepEqual(router.everyDatabase().map((d) => [d.id, d.db]), [["primary", "db:primary"], ["acme", "db:acme"]]);
});
