/**
 * RLS CONTRACT (audit 2026-11-17, P0-05) — every table the migrations create has row-level security enabled IN THE
 * MIGRATION CHAIN, so a database rebuilt from the repo is as closed as production.
 *
 * The platform audit of 2026-11-05 found 28 tables whose RLS had been switched on outside the chain (0091 moved
 * them in). Nothing stopped it from happening again: a new table with no `enable row level security` is readable
 * through PostgREST by any signed-in user until someone notices. This fails the build instead.
 *
 * It reads both spellings the chain uses:
 *   alter table [public.]name enable row level security;
 *   do $$ … foreach t in array array['a', 'b', …] loop execute format('alter table public.%I enable row level security', t) …
 *
 *   node scripts/rls-contract.mjs [--self-test]
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

export function rlsTables(sqlFiles) {
  const created = new Set();
  const enabled = new Set();
  for (const raw of sqlFiles) {
    const sql = raw.toLowerCase().replace(/--[^\n]*/g, "");
    /* in the order the statements appear: a table renamed away and re-created under its old name (0111) is a NEW
       table, which needs its own `enable row level security` */
    const ops = [
      ...[...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/g)].map((m) => ({ at: m.index, run: () => created.add(m[1]) })),
      ...[...sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)/g)].map((m) => ({ at: m.index, run: () => { created.delete(m[1]); enabled.delete(m[1]); } })),
      ...[...sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+rename\s+to\s+([a-z_][a-z0-9_]*)/g)].map((m) => ({ at: m.index, run: () => {
        created.delete(m[1]); created.add(m[2]);
        if (enabled.delete(m[1])) enabled.add(m[2]);
      } })),
      ...[...sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+enable\s+row\s+level\s+security/g)].map((m) => ({ at: m.index, run: () => enabled.add(m[1]) })),
    ].sort((a, b) => a.at - b.at);
    for (const op of ops) op.run();
    /* a loop over a literal array whose body enables RLS on %I */
    for (const block of sql.matchAll(/do\s+\$\$([\s\S]*?)\$\$\s*;/g)) {
      if (!/enable\s+row\s+level\s+security/.test(block[1]) || !/%i/.test(block[1])) continue;
      for (const arr of block[1].matchAll(/array\s*\[([^\]]*)\]/g)) for (const n of arr[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)) enabled.add(n[1]);
    }
  }
  return { created, enabled, missing: [...created].filter((t) => !enabled.has(t)).sort() };
}

if (process.argv.includes("--self-test")) {
  const r = rlsTables([
    "create table public.a (id int); alter table public.a enable row level security;",
    "create table b (id int); create table c (id int);\ndo $$ declare t text; begin foreach t in array array['b'] loop execute format('alter table public.%I enable row level security', t); end loop; end $$;",
    "create table d (x int); alter table d rename to e;",
    "create table f (x int); alter table f enable row level security; alter table f rename to f_old; create table f (like f_old);",
  ]);
  const ok = JSON.stringify(r.missing) === JSON.stringify(["c", "e", "f"]);
  console.log(ok ? "rls-contract self-test: planted gaps found (c, e, f); direct and loop forms read" : `rls-contract self-test FAILED: ${JSON.stringify(r.missing)}`);
  if (!ok) process.exit(1);
} else {
  const dir = join(ROOT, "supabase/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(dir, f), "utf8"));
  const { created, missing } = rlsTables(files);
  if (missing.length) {
    console.error(`rls-contract: ${missing.length} table(s) created in the chain without row-level security: ${missing.join(", ")}`);
    console.error("  add `alter table public.<name> enable row level security;` (and its policies) in a migration.");
    process.exit(1);
  }
  console.log(`rls-contract: ${created.size} tables, every one has row-level security enabled in the migration chain — 0 problem(s)`);
}
