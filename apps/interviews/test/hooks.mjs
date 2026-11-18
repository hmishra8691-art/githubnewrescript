/**
 * Module hooks for running the Interviews app's server code under plain Node (`pnpm test`): Next's `@/` alias,
 * extensionless relative imports and the `server-only` marker. Nothing here is loaded by Next.
 */
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const EMPTY = "data:text/javascript,export {};";
function probe(base) {
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of [".ts", ".tsx", ".js", ".mjs"]) if (existsSync(base + ext)) return base + ext;
  for (const idx of ["index.ts", "index.tsx", "index.js"]) if (existsSync(join(base, idx))) return join(base, idx);
  return null;
}
export async function resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: EMPTY, shortCircuit: true };
  if (specifier.startsWith("@/")) { const hit = probe(join(APP, specifier.slice(2))); if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true }; }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const parent = fileURLToPath(context.parentURL);
    if (parent.startsWith(APP) && !parent.includes("node_modules")) { const hit = probe(resolvePath(dirname(parent), specifier)); if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true }; }
  }
  try { return await next(specifier, context); }
  catch (e) { if (e?.code === "ERR_MODULE_NOT_FOUND" && /^[@a-z][^:]*\/[^.]+$/i.test(specifier)) return next(`${specifier}.js`, context); throw e; }
}
