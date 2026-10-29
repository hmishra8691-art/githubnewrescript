// Playwright resolver for the browser suites (audit ARCH-10). The suites used to import it from an
// absolute path on one machine. Resolution order: the installed `playwright` package (a devDependency),
// then PLAYWRIGHT_MODULE (a path to playwright/index.mjs), then the common global install locations.
import { existsSync } from "node:fs";
const tried = [];
async function load() {
  const candidates = ["playwright", process.env.PLAYWRIGHT_MODULE, "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs"].filter(Boolean);
  for (const c of candidates) {
    try {
      const mod = await import(c);
      /* a package whose browser build is not installed (2026-10-29: a lockfile bump past the downloaded revision) is skipped for the next candidate that can launch */
      const ch = mod.chromium ?? mod.default?.chromium;
      let exe = "";
      try { exe = ch?.executablePath?.() ?? ""; } catch { exe = ""; }
      if (exe && !existsSync(exe)) { tried.push(`${c}: browser not installed at ${exe}`); continue; }
      return mod;
    } catch (e) { tried.push(`${c}: ${e.code ?? e.message}`); }
  }
  throw new Error(`Playwright is not installed. Run \`pnpm install\` (it is a devDependency) or set PLAYWRIGHT_MODULE. Tried:\n  ${tried.join("\n  ")}`);
}
const pw = await load();
export const chromium = pw.chromium ?? pw.default?.chromium;
export const firefox = pw.firefox ?? pw.default?.firefox;
export const webkit = pw.webkit ?? pw.default?.webkit;
