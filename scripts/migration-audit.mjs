/**
 * STATIC AUDIT — THE MIGRATION FILES (2026-11-23).
 *
 * Two sessions once wrote different migrations under the same numbers (0111 / 0112), and the clash was only found
 * when patches were applied on the Mac. This fails the build instead:
 *
 *   M1 name       every file in supabase/migrations is NNNN_snake_case.sql
 *   M2 unique     no two files share a number
 *   M3 sequence   numbers run 0001, 0002, … with no gap (a gap usually means a file was renumbered or lost)
 *   M4 mark       a file that records itself in schema_marks records ITS OWN number
 *   M5 reference  code that says "migration NNNN (some_table…)" names a migration that exists, and the table (the
 *                 part before any dot) appears in that file — so a renumbered migration cannot leave messages
 *                 pointing at someone else's file
 * (Whether every table is classified for tenancy is scripts/tenancy-audit.mjs's job, not repeated here.)
 *
 *   node scripts/migration-audit.mjs              (exit 1 on any finding)
 *   node scripts/migration-audit.mjs --self-test  (plants each break once in a throw-away tree; fails unless each
 *                                                  is reported)
 */
import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODE_DIRS = ["apps", "packages"];
const SKIP = new Set(["node_modules", ".next", "dist", ".turbo", "coverage"]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

export function audit(root) {
  const findings = [];
  const dir = join(root, "supabase/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const byNum = new Map();
  for (const f of files) {
    const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(f);
    if (!m) { findings.push(`M1 ${f}: not NNNN_snake_case.sql`); continue; }
    const n = m[1];
    if (byNum.has(n)) findings.push(`M2 ${n}: used by ${byNum.get(n)} and ${f}`);
    else byNum.set(n, f);
  }
  const nums = [...byNum.keys()].map(Number).sort((a, b) => a - b);
  for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) { findings.push(`M3 the numbers skip from ${String(nums[i - 1] ?? 0).padStart(4, "0")} to ${String(nums[i]).padStart(4, "0")}`); break; }
  const sqlOf = new Map();
  for (const f of files) {
    const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(f);
    if (!m) continue;
    const sql = readFileSync(join(dir, f), "utf8");
    if (byNum.get(m[1]) === f) sqlOf.set(m[1], sql.toLowerCase());
    for (const mk of sql.matchAll(/schema_marks\s*\([^)]*\)\s*values\s*\(\s*'(\d{4})'/gi)) if (mk[1] !== m[1]) findings.push(`M4 ${f}: records itself in schema_marks as ${mk[1]}`);
  }
  for (const d of CODE_DIRS) for (const file of walk(join(root, d))) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/migration (\d{4}) \(([a-z][a-z0-9_]*_[a-z0-9_]*)(?:\.[a-z0-9_]+)?/g)) {
      const [, n, table] = m;
      const rel = file.slice(root.length + 1);
      const sql = sqlOf.get(n);
      if (!sql) findings.push(`M5 ${rel}: mentions migration ${n}, which does not exist`);
      else if (!sql.includes(table)) findings.push(`M5 ${rel}: says migration ${n} has ${table}, but ${byNum.get(n)} never mentions it`);
    }
  }
  return { findings, count: byNum.size, last: nums.at(-1) ?? 0 };
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "migration-audit-"));
  try {
    mkdirSync(join(root, "supabase/migrations"), { recursive: true });
    mkdirSync(join(root, "apps/a/lib"), { recursive: true });
    const w = (p, s) => writeFileSync(join(root, p), s);
    w("supabase/migrations/0001_core.sql", "create table public.things (id uuid);\ninsert into public.schema_marks (migration, note) values ('0001', 'x');");
    w("supabase/migrations/0002_more.sql", "create table if not exists public.others (id uuid);\ninsert into public.schema_marks (migration, note) values ('0003', 'wrong');");
    w("supabase/migrations/0002_clash.sql", "select 1;");
    w("supabase/migrations/0005_gap.sql", "select 1;");
    w("supabase/migrations/Bad-Name.sql", "select 1;");
    w("apps/a/lib/x.ts", 'const a = "needs migration 0001 (things)"; const b = "needs migration 0002 (missing_table)"; const c = "needs migration 0009 (ghost_table)"; /* a plain mention: migration 0001 is fine */');
    const { findings } = audit(root);
    const want = [/^M1 Bad-Name\.sql/, /^M2 0002/, /^M3 the numbers skip from 0002 to 0005/, /^M4 0002_more\.sql: records itself in schema_marks as 0003/, /^M5 .*migration 0002 has missing_table/, /^M5 .*migration 0009, which does not exist/];
    const missed = want.filter((re) => !findings.some((f) => re.test(f)));
    const extra = findings.filter((f) => !want.some((re) => re.test(f)));
    if (missed.length || extra.length) { console.error("migration-audit self-test FAILED", { missed: missed.map(String), extra, findings }); process.exit(1); }
    console.log(`migration-audit self-test: ${want.length} planted breaks reported, nothing else`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const { findings, count, last } = audit(REPO);
    if (findings.length) { for (const f of findings) console.error(`  ✗ ${f}`); console.error(`migration-audit: ${findings.length} finding(s)`); process.exit(1); }
    console.log(`migration-audit: ${count} migrations, 0001–${String(last).padStart(4, "0")}, unique and in sequence; schema marks and code references agree`);
  }
}
