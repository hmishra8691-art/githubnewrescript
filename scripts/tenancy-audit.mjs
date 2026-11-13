/**
 * TENANCY AUDIT (2026-11-13) — keeps the road to "a big client gets its own database" open.
 *
 *   1. Every table the migrations create is classified in supabase/tenancy/tables.json
 *      (platform / customer / shared / review) — a new table cannot arrive without someone saying where it lives.
 *   2. The direct primary-database call sites (`supabaseAdmin()`, `supabaseService()`) may only go DOWN: new code uses
 *      `dbFor` / `platformDb` / `customerDb` (apps/<app>/lib/db.ts). The counts are in scripts/tenancy-baseline.json;
 *      `node scripts/tenancy-audit.mjs --update` lowers them after call sites are migrated (it never raises them).
 *   3. Reports the wiring progress.
 *
 *   node scripts/tenancy-audit.mjs [--update]
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const fail = [];

/* ---------------------------------------------------------------- 1. tables */
const created = new Set();
for (const f of readdirSync(join(ROOT, "supabase/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  const sql = readFileSync(join(ROOT, "supabase/migrations", f), "utf8").toLowerCase().replace(/--[^\n]*/g, "");
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/g)) created.add(m[1]);
  for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)/g)) created.delete(m[1]);
  for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+rename\s+to\s+([a-z_][a-z0-9_]*)/g)) { created.delete(m[1]); created.add(m[2]); }
}
/* from 0097 on, a migration records itself in schema_marks (0098 backfilled 0093–0096) — the per-database status check reads them */
for (const f of readdirSync(join(ROOT, "supabase/migrations")).filter((x) => /^\d{4}_.*\.sql$/.test(x))) {
  const n = Number(f.slice(0, 4));
  if (n >= 97 && !/insert\s+into\s+public\.schema_marks/i.test(readFileSync(join(ROOT, "supabase/migrations", f), "utf8"))) {
    fail.push(`supabase/migrations/${f} does not record itself: end it with insert into public.schema_marks (migration, note) values ('${f.slice(0, 4)}', '…') on conflict (migration) do update set applied_at = now(), note = excluded.note;`);
  }
}
const classified = JSON.parse(readFileSync(join(ROOT, "supabase/tenancy/tables.json"), "utf8")).tables;
const CLASSES = new Set(["platform", "customer", "shared", "review"]);
for (const t of created) if (!classified[t]) fail.push(`table ${t} (supabase/migrations) is not classified in supabase/tenancy/tables.json — say whether it is platform, customer, shared or review`);
for (const [t, v] of Object.entries(classified)) {
  if (!created.has(t)) fail.push(`supabase/tenancy/tables.json lists ${t}, which no migration creates (dropped or renamed?)`);
  if (!CLASSES.has(v.class)) fail.push(`supabase/tenancy/tables.json: ${t} has class "${v.class}"`);
}
const byClass = {};
for (const v of Object.values(classified)) byClass[v.class] = (byClass[v.class] ?? 0) + 1;

/* ---------------------------------------------------------------- 2. call sites */
const APPS = ["studio", "runtime", "interviews"];
const DIRECT = /\b(supabaseAdmin|supabaseService)\(\)/g;
const ROUTED = /\b(dbFor|platformDb|customerDb)\(/g;
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
};
const counts = {};
for (const app of APPS) {
  let direct = 0, routed = 0;
  for (const f of walk(join(ROOT, "apps", app))) {
    const src = readFileSync(f, "utf8");
    if (/\/lib\/(db|admin)\.ts$/.test(f)) continue; // the definitions themselves
    if (f.endsWith("/lib/authServer.ts")) { direct += (src.match(DIRECT) ?? []).length - 1; routed += (src.match(ROUTED) ?? []).length; continue; } // minus its own definition
    direct += (src.match(DIRECT) ?? []).length;
    routed += (src.match(ROUTED) ?? []).length;
  }
  counts[app] = { direct, routed };
}
const baselinePath = join(ROOT, "scripts/tenancy-baseline.json");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
for (const app of APPS) {
  const max = baseline.direct[app];
  if (counts[app].direct > max) fail.push(`apps/${app}: ${counts[app].direct} direct supabaseAdmin()/supabaseService() calls, the baseline allows ${max}. New code gets its client from lib/db.ts: dbFor({ kind: "customer", customerId }) for a client's data, platformDb() for sign-in, workspaces and billing.`);
}
if (process.argv.includes("--update")) {
  let lowered = false;
  for (const app of APPS) if (counts[app].direct < baseline.direct[app]) { baseline.direct[app] = counts[app].direct; lowered = true; }
  if (lowered) { writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n"); console.log("tenancy baseline lowered"); }
}

/* ---------------------------------------------------------------- 3. report */
const total = APPS.reduce((n, a) => n + counts[a].direct, 0), routed = APPS.reduce((n, a) => n + counts[a].routed, 0);
if (fail.length) { for (const f of fail) console.log(`  FAIL ${f}`); process.exit(1); }
console.log(`tenancy: ${created.size} tables classified (${Object.entries(byClass).map(([k, v]) => `${v} ${k}`).join(", ")}); database call sites: ${routed} routed through dbFor, ${total} still direct (${APPS.map((a) => `${a} ${counts[a].direct}`).join(", ")}) — 0 problem(s)`);
