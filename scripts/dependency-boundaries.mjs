/**
 * STATIC AUDIT — the layering rules, as code (audit 2026-10-16, ARCH-03).
 *
 * Until now the dependency rules were prose ("engine depends on schema only
 * and is network-, env- and Node-free; Supabase clients only in apps/*\/lib;
 * runtime never imports Studio" — docs/INTELLIGENT-MODE-AUDIT-2026-10-05.md,
 * docs/audit-2026-10-16/raw/architecture.md §2). Prose does not fail a build.
 * This walks every import in packages/*\/src and apps/* (parsed with the
 * TypeScript compiler, so comments and strings never count) and checks:
 *
 *   R1 package→app      a package never imports an app (relative path or `@/`)
 *   R2 app→app          an app never imports another app
 *   R3 layer            schema imports no @rescript package; engine imports only schema
 *   R4 declared         a @rescript import must be declared in that workspace's package.json
 *                       (dependencies/peerDependencies; tests and fixtures may also use devDependencies)
 *   R5 renderer         the renderer ships to the browser: no server-only package
 *                       (ai, billing, mail, access, reportvideo, interviews, `…/server`), no Supabase
 *   R6 browser-safe     no `node:`/Node built-in import and no `process.env` in code that ships to the
 *                       browser: engine, schema, renderer (all non-test files), and everything reachable
 *                       from the `.` entry of analytics and exporters
 *   R7 no-framework     no package imports next, server-only or @supabase/*; only the renderer imports react
 *   R8 deep-import      non-test code never reaches into another workspace's src/ or dist/ by relative path
 *
 * Tests (`*.test.ts[x]`), `fixture(s).ts` and `*.test-support.ts` are test support: R4 lets them use
 * devDependencies and R6/R8 skip them. Known, reasoned exceptions live in ALLOW below; an entry that no
 * longer matches anything is reported as stale so the list cannot rot.
 *
 *   node scripts/dependency-boundaries.mjs            (exit 1 on any violation)
 *   node scripts/dependency-boundaries.mjs --verbose  (also list the allow-listed hits)
 *   node scripts/dependency-boundaries.mjs --self-test (builds a throw-away tree that breaks every rule
 *                                                       once, and fails unless each break is reported)
 */
import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, dirname, resolve, sep } from "node:path";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERBOSE = process.argv.includes("--verbose");

/* typescript is a devDependency of every package, not of the root */
function loadTs() {
  for (const p of ["packages/schema", "packages/engine", "apps/studio"]) {
    try { return createRequire(join(REPO, p, "package.json"))("typescript"); } catch { /* next */ }
  }
  console.error("dependency-boundaries: typescript not found (run pnpm install)");
  process.exit(2);
}
const ts = loadTs();

/* ------------------------------------------------------------------ policy */

const BROWSER_ALL = new Set(["engine", "schema", "renderer"]);
/** packages whose `.` entry (and what it reaches) ships to the browser */
const BROWSER_ENTRY = { analytics: "src/index.ts", exporters: "src/index.ts" };
const SERVER_ONLY = /^(@rescript\/(ai|billing|mail|access|reportvideo|interviews)(\/|$)|@rescript\/[^/]+\/server$|@supabase\/|server-only$|next(\/|$))/;
const LAYER = { schema: [], engine: ["@rescript/schema"] };

/**
 * Reasoned exceptions: { rule, file (repo-relative, exact), spec (import specifier, exact or RegExp), reason }.
 */
const ALLOW = [];

/* ------------------------------------------------------------------ files */

const SKIP_DIRS = new Set(["node_modules", "dist", "public", "coverage"]);
const isSource = (f) => /\.(ts|tsx|mts|cts|mjs|js|jsx)$/.test(f) && !/\.d\.ts$/.test(f);
const isTestSupport = (rel) => /\.test\.(ts|tsx|mts|mjs|js)$/.test(rel) || /(^|\/)fixtures?\.(ts|tsx)$/.test(rel) || /\.test-support\.(ts|tsx)$/.test(rel) || /(^|\/)__tests__\//.test(rel);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (isSource(name)) out.push(p);
  }
  return out;
}

const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_")));
const isBuiltin = (spec) => spec.startsWith("node:") || BUILTINS.has(spec) || BUILTINS.has(spec.split("/")[0]);
/** package name of a bare specifier: "@scope/name/sub" → "@scope/name" */
const pkgOfSpec = (spec) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

/** Scan one repository tree; returns what it found. */
function audit(ROOT, ALLOW) {
const workspaces = [];
for (const kind of ["packages", "apps"]) {
  if (!existsSync(join(ROOT, kind))) continue;
  for (const name of readdirSync(join(ROOT, kind))) {
    const dir = join(ROOT, kind, name);
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) continue;
    const pkg = JSON.parse(readFileSync(pj, "utf8"));
    const srcDir = kind === "packages" ? join(dir, "src") : dir;
    workspaces.push({
      kind, name, dir, pkgName: pkg.name,
      deps: new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]),
      devDeps: new Set(Object.keys(pkg.devDependencies ?? {})),
      files: walk(srcDir).filter((f) => !(kind === "apps" && /\.config\.(m?js|ts)$/.test(f))),
    });
  }
}
const wsOf = (abs) => workspaces.find((w) => abs === w.dir || abs.startsWith(w.dir + sep));
const rel = (abs) => relative(ROOT, abs).split(sep).join("/");

/* ------------------------------------------------------------------ parse */

const parsed = new Map();
/** imports of a file: { spec, typeOnly, line } and whether it reads process.env */
function parse(abs) {
  if (parsed.has(abs)) return parsed.get(abs);
  const text = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, false, abs.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports = [];
  let env = 0;
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause;
      const typeOnly = !!c && (c.isTypeOnly || (!c.name && !!c.namedBindings && ts.isNamedImports(c.namedBindings) && c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((e) => e.isTypeOnly)));
      imports.push({ spec: n.moduleSpecifier.text, typeOnly, line: lineOf(n) });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      imports.push({ spec: n.moduleSpecifier.text, typeOnly: n.isTypeOnly, line: lineOf(n) });
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
      imports.push({ spec: n.moduleReference.expression.text, typeOnly: n.isTypeOnly, line: lineOf(n) });
    } else if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteral(n.arguments[0]) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      imports.push({ spec: n.arguments[0].text, typeOnly: false, line: lineOf(n) });
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      imports.push({ spec: n.argument.literal.text, typeOnly: true, line: lineOf(n) });
    } else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "process" && n.name.text === "env") {
      env = env || lineOf(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const out = { imports, env };
  parsed.set(abs, out);
  return out;
}

/** a relative specifier as the source file it names (TS NodeNext writes `./x.js` for `./x.ts`) */
function resolveRelative(fromAbs, spec) {
  const base = resolve(dirname(fromAbs), spec);
  const stem = base.replace(/\.(m?js|jsx)$/, "");
  for (const c of [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return base;
}

/* ------------------------------------------------------------------ check */

const violations = [];
const allowedHits = [];
const allowUsed = new Set();
function report(rule, abs, imp, message) {
  const file = rel(abs);
  const i = ALLOW.findIndex((a) => a.rule === rule && a.file === file && (a.spec instanceof RegExp ? a.spec.test(imp?.spec ?? "") : a.spec === (imp?.spec ?? "")));
  const entry = { rule, file, line: imp?.line ?? 0, spec: imp?.spec ?? "", message };
  if (i >= 0) { allowUsed.add(i); allowedHits.push({ ...entry, reason: ALLOW[i].reason }); }
  else violations.push(entry);
}

/* the browser closure of analytics/exporters: files reachable by runtime imports from the entry */
const browserFiles = new Set();
for (const w of workspaces) {
  if (w.kind !== "packages") continue;
  if (BROWSER_ALL.has(w.name)) for (const f of w.files) if (!isTestSupport(rel(f))) browserFiles.add(f);
  const entry = BROWSER_ENTRY[w.name];
  if (entry) {
    const stack = [join(w.dir, entry)];
    while (stack.length) {
      const f = stack.pop();
      if (browserFiles.has(f) || !existsSync(f)) continue;
      browserFiles.add(f);
      for (const imp of parse(f).imports) if (!imp.typeOnly && imp.spec.startsWith(".")) stack.push(resolveRelative(f, imp.spec));
    }
  }
}

let checkedFiles = 0;
let checkedImports = 0;
for (const w of workspaces) {
  for (const abs of w.files) {
    checkedFiles++;
    const r = rel(abs);
    const test = isTestSupport(r);
    const { imports, env } = parse(abs);
    if (browserFiles.has(abs) && env) report("R6 browser-safe", abs, { spec: "process.env", line: env }, "reads process.env in code that ships to the browser");
    for (const imp of imports) {
      checkedImports++;
      const { spec } = imp;
      /* ---- relative and alias paths */
      if (spec.startsWith(".") || spec.startsWith("@/")) {
        const target = spec.startsWith("@/") ? (w.kind === "apps" ? null : "@/") : resolveRelative(abs, spec);
        if (target === "@/") { report("R1 package→app", abs, imp, "the `@/` alias is app-local; a package cannot use it"); continue; }
        if (!target) continue;
        const tw = wsOf(target);
        if (!tw || tw === w) {
          if (!tw && w.kind === "packages" && rel(target).startsWith("apps/")) report("R1 package→app", abs, imp, "imports an app");
          continue;
        }
        if (w.kind === "packages" && tw.kind === "apps") report("R1 package→app", abs, imp, `imports ${tw.kind}/${tw.name}`);
        else if (w.kind === "apps" && tw.kind === "apps") report("R2 app→app", abs, imp, `apps/${w.name} imports apps/${tw.name}`);
        else if (!test) report("R8 deep-import", abs, imp, `reaches into ${rel(tw.dir)} by path; import ${tw.pkgName} instead`);
        continue;
      }
      /* ---- bare specifiers */
      if (isBuiltin(spec)) {
        if (browserFiles.has(abs) && !imp.typeOnly) report("R6 browser-safe", abs, imp, "Node built-in in code that ships to the browser");
        continue;
      }
      const name = pkgOfSpec(spec);
      if (w.kind === "packages") {
        if (!test && !imp.typeOnly && (/^(next|server-only)$/.test(name) || name.startsWith("@supabase/") || ((name === "react" || name === "react-dom") && w.name !== "renderer")))
          report("R7 no-framework", abs, imp, `${name} belongs to the apps`);
        if (LAYER[w.name] && name.startsWith("@rescript/") && !LAYER[w.name].includes(name))
          report("R3 layer", abs, imp, `${w.pkgName} may import only ${LAYER[w.name].join(", ") || "no @rescript package"}`);
        if (w.name === "renderer" && !test && !imp.typeOnly && SERVER_ONLY.test(spec))
          report("R5 renderer", abs, imp, "server-only module in the browser renderer");
      }
      if (name.startsWith("@rescript/") && name !== w.pkgName) {
        const ok = w.deps.has(name) || (test && w.devDeps.has(name)) || (imp.typeOnly && w.devDeps.has(name));
        if (!ok) report("R4 declared", abs, imp, w.devDeps.has(name) ? `${name} is only a devDependency of ${w.pkgName}` : `${name} is not declared by ${w.pkgName}`);
      }
    }
  }
}

const stale = ALLOW.map((a, i) => ({ a, i })).filter(({ i }) => !allowUsed.has(i));
return { violations, allowedHits, stale, checkedFiles, checkedImports, workspaces: workspaces.length, browserFiles: browserFiles.size };
}

/* ------------------------------------------------------------------ self-test */

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "rescript-boundaries-"));
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  const pkg = (dir, name, deps = {}, dev = {}, peer = {}) => put(`${dir}/package.json`, JSON.stringify({ name, dependencies: deps, devDependencies: dev, peerDependencies: peer }));
  try {
    pkg("packages/schema", "@rescript/schema", { "@rescript/engine": "*" });
    put("packages/schema/src/index.ts", `import { x } from "@rescript/engine";\nexport const y = x;\n`);
    pkg("packages/engine", "@rescript/engine", { "@rescript/schema": "*" });
    put("packages/engine/src/a.ts", [
      `import { y } from "@rescript/schema";`,
      `import fs from "node:fs";`,
      `import { z } from "../../../apps/studio/lib/y";`,
      `// import "next";`,
      `const s = "import 'react'"; /* import "@supabase/supabase-js" */`,
      `export const d = process.env.DEBUG ? fs : y ?? z ?? s;`,
    ].join("\n"));
    put("packages/engine/src/a.test.ts", `import fs from "node:fs";\nimport { y } from "@rescript/schema";\nexport const t = [fs, y];\n`);
    pkg("packages/renderer", "@rescript/renderer", { "@rescript/engine": "*" }, {}, { react: "*" });
    put("packages/renderer/src/r.tsx", `import React from "react";\nimport { ask } from "@rescript/ai";\nimport type { T } from "@rescript/media/server";\nexport const r = [React, ask];\n`);
    pkg("packages/analytics", "@rescript/analytics", { "@rescript/engine": "*" }, { "@rescript/designs": "*" });
    put("packages/analytics/src/index.ts", `export * from "./core.js";\n`);
    put("packages/analytics/src/core.ts", `import { readFileSync } from "fs";\nexport const c = readFileSync;\n`);
    put("packages/analytics/src/export/x.ts", `import fs from "node:fs";\nexport const e = fs;\n`);
    put("packages/analytics/src/fixture.ts", `import { g } from "@rescript/designs";\nexport const f = g;\n`);
    put("packages/analytics/src/uses.ts", `import { g } from "@rescript/designs";\nimport { createClient } from "@supabase/supabase-js";\nimport { a } from "../../engine/src/a.js";\nexport const u = [g, createClient, a];\n`);
    pkg("apps/studio", "@rescript/studio", { "@rescript/engine": "*" });
    put("apps/studio/lib/y.ts", `import { k } from "@/lib/k";\nexport const z = k;\n`);
    put("apps/studio/lib/k.ts", `export const k = 1;\n`);
    pkg("apps/runtime", "@rescript/runtime", { "@rescript/engine": "*" });
    put("apps/runtime/lib/x.ts", `import { z } from "../../studio/lib/y";\nimport { b } from "@rescript/billing";\nexport const x = [z, b];\n`);

    const got = audit(root, [{ rule: "R6 browser-safe", file: "packages/engine/src/a.ts", spec: "node:fs", reason: "self-test allow" }, { rule: "R7 no-framework", file: "nowhere.ts", spec: "next", reason: "stale on purpose" }]);
    const key = (v) => `${v.rule} | ${v.file} | ${v.spec}`;
    const expected = [
      "R3 layer | packages/schema/src/index.ts | @rescript/engine",
      "R6 browser-safe | packages/engine/src/a.ts | process.env",
      "R1 package→app | packages/engine/src/a.ts | ../../../apps/studio/lib/y",
      "R4 declared | packages/renderer/src/r.tsx | @rescript/ai",
      "R5 renderer | packages/renderer/src/r.tsx | @rescript/ai",
      "R4 declared | packages/renderer/src/r.tsx | @rescript/media/server",
      "R6 browser-safe | packages/analytics/src/core.ts | fs",
      "R4 declared | packages/analytics/src/uses.ts | @rescript/designs",
      "R7 no-framework | packages/analytics/src/uses.ts | @supabase/supabase-js",
      "R8 deep-import | packages/analytics/src/uses.ts | ../../engine/src/a.js",
      "R2 app→app | apps/runtime/lib/x.ts | ../../studio/lib/y",
      "R4 declared | apps/runtime/lib/x.ts | @rescript/billing",
    ].sort();
    const actual = got.violations.map(key).sort();
    const problems = [];
    for (const e of expected) if (!actual.includes(e)) problems.push(`missed: ${e}`);
    for (const a of actual) if (!expected.includes(a)) problems.push(`unexpected: ${a}`);
    if (got.allowedHits.length !== 1 || got.allowedHits[0].spec !== "node:fs") problems.push(`allow-list not applied: ${JSON.stringify(got.allowedHits)}`);
    if (got.stale.length !== 1) problems.push(`stale allow entry not reported: ${got.stale.length}`);
    if (problems.length) {
      console.error(`dependency-boundaries self-test FAILED:\n  ${problems.join("\n  ")}`);
      return 1;
    }
    console.log(`dependency-boundaries self-test: ${expected.length} planted violations reported, comments/strings/tests/type-only/out-of-entry imports ignored, allow-list and stale detection work.`);
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-test")) process.exit(selfTest());

/* ------------------------------------------------------------------ output */

const { violations, allowedHits, stale, checkedFiles, checkedImports, workspaces, browserFiles } = audit(REPO, ALLOW);
if (VERBOSE && allowedHits.length) {
  console.log(`Allow-listed (${allowedHits.length}):`);
  for (const h of allowedHits) console.log(`  [${h.rule}] ${h.file}:${h.line} ${h.spec} — ${h.reason}`);
}
if (violations.length) {
  console.error(`Dependency boundaries: ${violations.length} violation(s)\n`);
  const byRule = new Map();
  for (const v of violations) byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v]);
  for (const [rule, list] of byRule) {
    console.error(`${rule} (${list.length})`);
    for (const v of list) console.error(`  ${v.file}:${v.line}  "${v.spec}"  — ${v.message}`);
    console.error("");
  }
}
if (stale.length) {
  console.error(`Stale allow-list entries (${stale.length}) — remove them:`);
  for (const { a } of stale) console.error(`  [${a.rule}] ${a.file} ${a.spec}`);
}
console.log(`${checkedFiles} files, ${checkedImports} imports checked across ${workspaces} workspaces; ${browserFiles} browser-shipped files; ${violations.length} violation(s), ${allowedHits.length} allow-listed.`);
process.exit(violations.length || stale.length ? 1 : 0);
