/**
 * STATIC AUDIT — A QUERY PARAMETER WITH THE SAME NAME AS THE ROUTE'S OWN PATH PARAMETER (2026-11-23).
 *
 * On Vercel the path parameters of a dynamic route are added to the request's query, overwriting a query
 * parameter of the same name. A route under `surveys/[id]` that read `?id=<room>` therefore never saw the room:
 * the live-session console crashed on "Moderate" in production while every local run (development and
 * `next start`) worked. This fails the build when a route.ts reads `searchParams.get("<name>")` for a name that is
 * one of its own `[name]` path segments.
 *
 *   node scripts/route-param-audit.mjs              (exit 1 on any finding)
 *   node scripts/route-param-audit.mjs --self-test
 */
import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function routes(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) routes(p, out);
    else if (/^route\.(ts|tsx|js)$/.test(name)) out.push(p);
  }
  return out;
}

export function audit(root) {
  const findings = [];
  let checked = 0;
  for (const app of ["apps/studio/app", "apps/runtime/app", "apps/interviews/app"]) {
    for (const file of routes(join(root, app))) {
      const rel = file.slice(root.length + 1);
      const segs = [...rel.split(sep).join("/").matchAll(/\[(?:\.\.\.)?([A-Za-z_][A-Za-z0-9_]*)\]/g)].map((m) => m[1]);
      if (!segs.length) continue;
      checked++;
      const src = readFileSync(file, "utf8");
      for (const s of new Set(segs)) {
        for (const m of src.matchAll(new RegExp(`searchParams\\.(?:get|getAll|has)\\(\\s*["'\`]${s}["'\`]`, "g"))) {
          const line = src.slice(0, m.index).split("\n").length;
          findings.push(`${rel}:${line} reads ?${s}= but [${s}] is part of its own path — on Vercel the path value replaces it`);
        }
      }
    }
  }
  return { findings, checked };
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "route-param-audit-"));
  try {
    const w = (p, s) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s); };
    w("apps/studio/app/api/surveys/[id]/live/route.ts", 'const a = req.nextUrl.searchParams.get("id"); const b = req.nextUrl.searchParams.get("room");');
    w("apps/studio/app/api/things/[thingId]/x/route.ts", "const c = url.searchParams.has('thingId');");
    w("apps/studio/app/api/plain/route.ts", 'const d = req.nextUrl.searchParams.get("id");');
    const { findings } = audit(root);
    const want = [/surveys\/\[id\]\/live\/route\.ts:1 reads \?id=/, /things\/\[thingId\]\/x\/route\.ts:1 reads \?thingId=/];
    const missed = want.filter((re) => !findings.some((f) => re.test(f)));
    if (missed.length || findings.length !== want.length) { console.error("route-param-audit self-test FAILED", { findings, missed: missed.map(String) }); process.exit(1); }
    console.log("route-param-audit self-test: 2 planted shadowed parameters reported; a different name and a static route ignored");
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const { findings, checked } = audit(REPO);
    if (findings.length) { for (const f of findings) console.error(`  ✗ ${f}`); console.error(`route-param-audit: ${findings.length} finding(s)`); process.exit(1); }
    console.log(`route-param-audit: ${checked} dynamic routes; none reads a query parameter its own path overwrites`);
  }
}
