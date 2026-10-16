// Playwright resolver for the browser suites (audit ARCH-10). The suites used to import it from an
// absolute path on one machine. Resolution order: the installed `playwright` package (a devDependency),
// then PLAYWRIGHT_MODULE (a path to playwright/index.mjs), then the common global install locations.
const tried = [];
async function load() {
  const candidates = ["playwright", process.env.PLAYWRIGHT_MODULE, "/home/claude/.npm-global/lib/node_modules/playwright/index.mjs"].filter(Boolean);
  for (const c of candidates) {
    try { return await import(c); } catch (e) { tried.push(`${c}: ${e.code ?? e.message}`); }
  }
  throw new Error(`Playwright is not installed. Run \`pnpm install\` (it is a devDependency) or set PLAYWRIGHT_MODULE. Tried:\n  ${tried.join("\n  ")}`);
}
const pw = await load();
export const chromium = pw.chromium ?? pw.default?.chromium;
export const firefox = pw.firefox ?? pw.default?.firefox;
export const webkit = pw.webkit ?? pw.default?.webkit;
