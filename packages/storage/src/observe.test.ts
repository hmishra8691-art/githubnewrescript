import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { observed, reportError, resetErrorDedupe, runHealth, scrub } from "./observe.js";

/* a real HTTP receiver: the alert path is a POST over the network, as in production */
async function receiver() {
  const got: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push(JSON.parse(b)); res.end("ok"); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/hook`, got, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("a planted error in a wrapped route fires one alert, carries an incident id, and is answered with a 500 that says so (audit P1-13 gate)", async () => {
  resetErrorDedupe();
  const hook = await receiver();
  const env = { ERROR_WEBHOOK_URL: hook.url, RESCRIPT_ENV: "test" };
  const route = observed(async (_req: Request) => { throw new Error("planted failure for anna@example.test with token=abc123secret"); }, { app: "runtime", route: "/api/session/save" }, { env });
  const res = await route(new Request("http://x/api/session/save", { method: "POST" }));
  assert.equal(res.status, 500);
  const body = await res.json() as { incident: string; error: string };
  assert.match(body.incident, /^inc_/);
  assert.equal(hook.got.length, 1, "one alert");
  const a = hook.got[0] as { text: string; incident: string; message: string; route: string; method: string; environment: string };
  assert.equal(a.incident, body.incident, "the alert and the response quote the same incident");
  assert.equal(a.route, "/api/session/save"); assert.equal(a.method, "POST"); assert.equal(a.environment, "test");
  assert.match(a.text, /runtime POST \/api\/session\/save — Error: planted failure/);
  assert.doesNotMatch(JSON.stringify(a), /anna@example\.test|abc123secret/, "no email or secret leaves the process");
  /* the same failure again within a minute: logged, not re-sent */
  await route(new Request("http://x/api/session/save", { method: "POST" }));
  assert.equal(hook.got.length, 1, "a crash loop is one alert");
  /* a handler that works is untouched */
  const fine = observed(async (_req: Request) => new Response("ok"), { app: "runtime", route: "/ok" }, { env });
  assert.equal(await (await fine(new Request("http://x/ok"))).text(), "ok");
  await hook.close();
});

test("without a webhook the report is a structured log line only; a dead webhook never throws", async () => {
  resetErrorDedupe();
  const lines: string[] = [];
  const orig = console.error; console.error = (s: string) => lines.push(String(s));
  try {
    const r = await reportError(new Error("x"), { app: "studio", route: "/a" }, { env: {} });
    assert.equal(r.sent, "log-only");
    assert.ok(lines.some((l) => l.startsWith("[rescript:error] {") && JSON.parse(l.slice(16)).route === "/a"));
    const dead = await reportError(new Error("y"), { app: "studio", route: "/b" }, { env: { ERROR_WEBHOOK_URL: "http://127.0.0.1:9/none" }, timeoutMs: 500 });
    assert.equal(dead.sent, "webhook");
    assert.ok(lines.some((l) => /alert webhook failed/.test(l)));
  } finally { console.error = orig; }
});

test("health: critical failure is down, other failure degraded, a hung check times out", async () => {
  const ok = await runHealth([{ name: "db", run: async () => {} }]);
  assert.equal(ok.status, "ok");
  const deg = await runHealth([{ name: "db", run: async () => {} }, { name: "mail", critical: false, run: async () => { throw new Error("no key"); } }]);
  assert.equal(deg.status, "degraded");
  const down = await runHealth([{ name: "db", run: () => new Promise(() => {}) }], { timeoutMs: 50 });
  assert.equal(down.status, "down");
  assert.match(down.checks[0].detail!, /timed out/);
  assert.equal(scrub("see https://x.test/a?token=zzz&b=2 for bob@x.io"), "see https://x.test/a?…&… for [email]");
});
