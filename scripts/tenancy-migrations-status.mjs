/**
 * EVERY DATABASE ON THE SAME MIGRATIONS (tenancy groundwork, 2026-11-13). READ-ONLY.
 *
 * Reads the databases this deployment is configured for (the primary, plus RESCRIPT_DATABASES — the same variables
 * the apps read, via @rescript/storage/tenancy) and compares each one's `schema_marks` with supabase/migrations.
 * Marks exist from 0091 on (0098 backfills 0093–0096), so older migrations are not checked here.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… [RESCRIPT_DATABASES=acme RESCRIPT_DB_ACME_URL=… …] \
 *     node scripts/tenancy-migrations-status.mjs
 *
 * Exit 1 when any database is behind (or unreachable): run the missing migrations on it before routing a client there.
 */
import { readdirSync } from "node:fs";
import { readTenancyConfig, describeTenancy } from "../packages/storage/dist/tenancy.js";

const FIRST_MARKED = 91;
const local = readdirSync(new URL("../supabase/migrations", import.meta.url)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => f.slice(0, 4)).filter((m) => Number(m) >= FIRST_MARKED).sort();
const config = readTenancyConfig(process.env);
for (const p of config.problems) console.log(`  configuration problem: ${p}`);
if (!config.databases.size) { console.log("no database configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)"); process.exit(1); }
console.log(describeTenancy(config));

let behind = 0;
for (const db of config.databases.values()) {
  try {
    const r = await fetch(`${db.url.replace(/\/$/, "")}/rest/v1/schema_marks?select=migration&order=migration`, {
      headers: { apikey: db.serviceKey, authorization: `Bearer ${db.serviceKey}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const marks = new Set((await r.json()).map((x) => String(x.migration)));
    const missing = local.filter((m) => !marks.has(m));
    if (missing.length) behind++;
    console.log(`  ${db.id.padEnd(12)} ${missing.length ? `BEHIND — not recorded: ${missing.join(", ")}` : `up to date (${local[local.length - 1]})`}`);
  } catch (e) {
    behind++;
    console.log(`  ${db.id.padEnd(12)} UNREACHABLE — ${e.message}`);
  }
}
process.exit(behind ? 1 : 0);
