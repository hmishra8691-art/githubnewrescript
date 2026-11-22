import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE MAIN ENTRY STAYS BROWSER-SAFE. Client pages (the share page among them) import "@rescript/analytics"; one
 * import of export/pptx.ts from a module of the main entry (limits.ts, 2026-11-29) pulled pptxgenjs and node:https
 * into the page bundle and broke the production build. The writers live behind "@rescript/analytics/export".
 */
test("nothing reachable from the main entry imports a Node built-in or an office writer", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const seen = new Set<string>(), bad: string[] = [];
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:import|export)[^"';]*?from\s*["']([^"']+)["']/g)) {
      const sp = m[1]!;
      if (sp.startsWith(".")) walk(resolve(dirname(f), sp));
      else if (/^node:|^(pptxgenjs|exceljs|docx|pdfkit|pdf-lib|fs|path|crypto|https?|child_process)$/.test(sp)) bad.push(`${sp} <- ${relative(here, f)}`);
    }
  };
  walk(join(here, "index.js"));
  assert.ok(seen.size > 50, `walked ${seen.size} modules`);
  assert.deepEqual(bad, []);
});
