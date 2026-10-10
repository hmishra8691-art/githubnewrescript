/**
 * Generate (or check) the public reference pages from the code.
 *   node scripts/gen-public-docs.mjs            write
 *   node scripts/gen-public-docs.mjs --check    exit 1 when a committed page differs
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DOCS_DIR, generate } from "./lib/publicDocs.mjs";

const check = process.argv.includes("--check");
const pages = await generate();
mkdirSync(DOCS_DIR, { recursive: true });
let stale = 0;
for (const [name, text] of Object.entries(pages)) {
  const path = join(DOCS_DIR, name);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (check) { if (current !== text) { console.error(`stale: ${name}`); stale++; } }
  else { writeFileSync(path, text); console.log(`wrote ${name} (${text.length} chars)`); }
}
if (check) { console.log(stale ? `${stale} page(s) stale — run node scripts/gen-public-docs.mjs` : "public reference pages are current"); process.exit(stale ? 1 : 0); }
