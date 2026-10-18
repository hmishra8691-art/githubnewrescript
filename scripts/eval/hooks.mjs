/**
 * MODULE HOOKS FOR RUNNING STUDIO SERVER CODE IN PLAIN NODE (the AI evaluation harness).
 *
 * The Studio's route handlers are written for Next.js: `@/` path aliases, extensionless relative imports and the
 * `server-only` marker. Node with --experimental-strip-types runs the TypeScript itself; these hooks supply the rest,
 * so `scripts/eval-ai.mjs` can import the REAL `/api/copilot/turn` handler in-process — no forked prompt code.
 *
 *   @/x           → apps/studio/x(.ts|.tsx|/index.ts)
 *   ./x (no ext)  → ./x.ts | ./x.tsx | ./x/index.ts, when the importer is Studio source
 *   server-only   → an empty module (this process IS the server)
 *   @/lib/guard   → scripts/eval/guard-shim.mjs when EVAL_GUARD_SHIM=1: the real guard, with `requireUser` answering
 *                   the harness's own test user for a request carrying this process's random eval token. Nothing in
 *                   the Studio build is changed; this file is never loaded by Next.
 */
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STUDIO = join(ROOT, "apps", "studio");
const SHIM = pathToFileURL(join(ROOT, "scripts", "eval", "guard-shim.mjs")).href;
const EMPTY = "data:text/javascript,export {};";

function probe(base) {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of [".ts", ".tsx", ".js", ".mjs"]) if (existsSync(base + ext)) return base + ext;
  for (const idx of ["index.ts", "index.tsx", "index.js"]) if (existsSync(join(base, idx))) return join(base, idx);
  return null;
}

export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: EMPTY, shortCircuit: true };
  const fromShim = context.parentURL === SHIM;
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    if (!fromShim && process.env.EVAL_GUARD_SHIM === "1" && /^lib\/guard(\.ts)?$/.test(rel)) return { url: SHIM, shortCircuit: true };
    const hit = probe(join(STUDIO, rel));
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const parent = fileURLToPath(context.parentURL);
    if (parent.startsWith(STUDIO) && !parent.includes("node_modules")) {
      const abs = resolvePath(dirname(parent), specifier);
      if (!fromShim && process.env.EVAL_GUARD_SHIM === "1" && abs === join(STUDIO, "lib", "guard")) return { url: SHIM, shortCircuit: true };
      const hit = probe(abs);
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }
  }
  try { return await next(specifier, context); }
  catch (e) {
    /* a package without an exports map (next): its deep imports need the file's extension under Node's ESM resolver */
    if (e?.code === "ERR_MODULE_NOT_FOUND" && /^[@a-z][^:]*\/[^.]+$/i.test(specifier)) return next(`${specifier}.js`, context);
    throw e;
  }
}
