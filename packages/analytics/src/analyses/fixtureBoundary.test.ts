import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * ARCH-06: the synthetic fixtures (analyses/fixture.ts, story/fixture.ts)
 * import the devDependency @rescript/designs. They are test support: only
 * test files (and other fixtures) may import them, no shipped module may
 * import @rescript/designs, and the packed package leaves them out.
 */

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = join(pkgRoot, "src");
const isTestSupport = (rel: string) => /\.test\.ts$/.test(rel) || /(^|\/)fixtures?\.ts$/.test(rel);

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (f.endsWith(".ts") && !f.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

test("ARCH-06: no shipped analytics module imports a fixture or the devDependency @rescript/designs", () => {
  const offenders: string[] = [];
  for (const file of walk(src)) {
    const rel = relative(src, file).split("\\").join("/");
    if (isTestSupport(rel)) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (/(^|\/)fixtures?(\.js)?$/.test(spec)) offenders.push(`${rel} → ${spec}`);
      if (spec === "@rescript/designs" || spec.startsWith("@rescript/designs/")) offenders.push(`${rel} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("ARCH-06: the packed build leaves tests and fixtures out, and no export entry points at one", () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { files?: string[]; exports: Record<string, { default: string }>; dependencies?: Record<string, string> };
  assert.ok(pkg.files?.includes("dist"));
  for (const neg of ["!dist/**/fixture.js", "!dist/**/fixture.d.ts", "!dist/**/*.test.js"]) assert.ok(pkg.files?.includes(neg), `files lacks ${neg}`);
  for (const [k, v] of Object.entries(pkg.exports)) assert.doesNotMatch(v.default, /fixture|\.test\./, `export ${k}`);
  assert.equal(pkg.dependencies?.["@rescript/designs"], undefined, "designs stays a devDependency (test-only)");
});
