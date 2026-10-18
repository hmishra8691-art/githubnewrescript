/**
 * AI COST AND CACHE — MEASURED FROM BILLING (2026-10-18). The same report as the /platform panel, in a terminal.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     node --experimental-strip-types --no-warnings scripts/ai-cache-report.mjs [--days 30] [--since 2026-10-17] [--until …] [--exclude-eval] [--json]
 *
 * Reads the AI usage events of the window (read-only: SELECTs on usage_events, billing_rates, billing_config),
 * prices them with the rates and configuration the meter uses (the database's, else the package defaults) and
 * prints per day × operation × model: calls, the token split, the hit rate, actual provider cost vs the same calls
 * with no caching, the saving, and the warnings (prefix churn, below the provider's minimum, never cached).
 * The arithmetic is @rescript/billing's `cacheReport` (tested in packages/billing/src/cacheReport.test.ts).
 * The service-role key is read from the environment and never printed.
 */
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STUDIO = join(ROOT, "apps/studio");
const req = createRequire(join(STUDIO, "package.json"));
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const flag = (name) => process.argv.includes(`--${name}`);

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (read-only use: this script only SELECTs). Nothing was read.");
  process.exit(2);
}
const { createClient } = await import(pathToFileURL(req.resolve("@supabase/supabase-js")).href);
const billing = await import(pathToFileURL(req.resolve("@rescript/billing")).href);
const { buildCacheReport, supabaseCachePage } = await import(pathToFileURL(join(STUDIO, "lib/aiCacheReport.ts")).href);

const db = createClient(url, key, { auth: { persistSession: false } });
const meter = new billing.Meter(new billing.SupabaseMeterStore(db));
const [rates, config] = await Promise.all([meter.rates(), meter.config()]);
const days = Number(arg("days") ?? 30);
const report = await buildCacheReport(supabaseCachePage(db), { days, since: arg("since"), until: arg("until"), excludeEval: flag("exclude-eval") }, { rates, config });
if (flag("json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(billing.cacheReportMarkdown(report));
  console.log(`\nWindow ${report.window.since} → ${report.window.until}${report.truncated ? " (TRUNCATED — narrow the window)" : ""}.`);
}
