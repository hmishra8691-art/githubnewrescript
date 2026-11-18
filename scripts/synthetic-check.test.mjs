/**
 * The synthetic check against planted endpoints (audit P1-13 gate: an alert fires on a planted failure).
 *   node scripts/synthetic-check.test.mjs      (run by `pnpm audit:code`)
 */
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

const alerts = [];
const server = http.createServer((req, res) => {
  if (req.url === "/hook") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { alerts.push(JSON.parse(b)); res.end("ok"); }); return; }
  if (req.url === "/up/api/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ status: "degraded", checks: [{ name: "database", ok: true, critical: true }, { name: "error-alerts", ok: false, critical: false, detail: "not set" }] })); }
  if (req.url === "/down/api/health") { res.writeHead(503, { "content-type": "application/json" }); return res.end(JSON.stringify({ status: "down", checks: [{ name: "database", ok: false, critical: true, detail: "planted: connection refused" }] })); }
  if (req.url === "/hang/api/health") return; /* never answers */
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const run = (env) => new Promise((resolve) => {
  const p = spawn(process.execPath, ["scripts/synthetic-check.mjs"], { env: { PATH: process.env.PATH, ...env } });
  let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  p.on("close", (code) => resolve({ code, out }));
});

const healthy = await run({ STUDIO_URL: `${base}/up`, ALERT_WEBHOOK_URL: `${base}/hook` });
assert.equal(healthy.code, 0, healthy.out);
assert.equal(alerts.length, 0, "a degraded but working app raises no alert");
assert.match(healthy.out, /ok {3}studio health 200 degraded/);

const planted = await run({ STUDIO_URL: `${base}/up`, RUNTIME_URL: `${base}/down`, INTERVIEWS_URL: `${base}/hang`, SYNTHETIC_BUDGET_MS: "800", ALERT_WEBHOOK_URL: `${base}/hook` });
assert.equal(planted.code, 1, planted.out);
assert.equal(alerts.length, 1, "one alert for the run");
assert.match(alerts[0].text, /Synthetic check failed \(2\)/);
assert.match(alerts[0].text, /runtime: \/api\/health answered 503 \(down\) — database: planted: connection refused/);
assert.match(alerts[0].text, /interviews: \/api\/health answered no answer within 800 ms/);

const none = await run({});
assert.equal(none.code, 0);
assert.match(none.out, /no URLs configured/);
server.close();
console.log("synthetic check: healthy passes quietly, a planted 503 and a hung app raise one alert, unconfigured is a no-op — 3 checks passed");
