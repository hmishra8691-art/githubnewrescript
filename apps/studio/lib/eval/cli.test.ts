import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * THE HARNESS END TO END (`pnpm eval:ai`): the real /api/copilot/turn handler, in-process.
 *   1. the fake provider, every golden case: the deterministic pipeline passes and matches the stored baseline
 *   2. a local stand-in for an OpenAI-compatible provider (NOT a real model, no key): --record writes a cassette,
 *      --replay re-scores it with no network and reproduces the run — the same outcomes and the same tokens,
 *      cache reads included, because the replay goes through the real provider client and the real meter.
 */
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const run = (args: string[], env: Record<string, string | undefined> = {}) => new Promise<{ code: number; out: string }>((resolve) => {
  const p = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "scripts/eval-ai.mjs"), ...args], { cwd: ROOT, env: { ...process.env, EVAL_AI_API_URL: "", EVAL_AI_API_KEY: "", ...env } });
  let out = "";
  p.stdout.on("data", (b) => { out += b; }); p.stderr.on("data", (b) => { out += b; });
  p.on("close", (code) => resolve({ code: code ?? -1, out }));
});

test("fake provider: every golden case passes and nothing regresses against the stored baseline", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-fake-"));
  const r = await run(["--out", dir]);
  assert.equal(r.code, 0, r.out);
  const rep = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  assert.equal(rep.meta.mode, "fake");
  assert.equal(rep.summary.passRate, 1, rep.cases.filter((c: { passed: boolean }) => !c.passed).map((c: { id: string }) => c.id).join(", "));
  assert.ok(rep.summary.cases >= 25);
  assert.ok(rep.comparison?.baseline, "the stored baseline for fake:fake was compared");
  assert.deepEqual(rep.comparison.regressions, []);
  assert.match(readFileSync(join(dir, "latest.md"), "utf8"), /Fake provider/);
});

test("record against a stand-in provider, then replay offline: same outcomes, same tokens and cache reads", { timeout: 120_000 }, async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      calls++;
      const j = JSON.parse(body || "{}");
      const sys = String(j.messages?.[0]?.content ?? "");
      const content = JSON.stringify({ kind: "answer", reply: "Understood — nothing to change.", actions: [] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "stand-in-model", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: Math.ceil(body.length / 4), completion_tokens: 20, prompt_tokens_details: { cached_tokens: Math.min(2048, Math.ceil(sys.length / 4)) } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "eval-rec-"));
  const cassette = join(dir, "cassette.json");
  try {
    const filter = "edit-required|translate-hindi|scope-unsupported";
    const rec = await run(["--filter", filter, "--record", cassette, "--out", join(dir, "rec")], { EVAL_AI_API_URL: `http://127.0.0.1:${port}/v1`, EVAL_AI_API_KEY: "stand-in", EVAL_AI_MODEL: "stand-in-model" });
    assert.equal(rec.code, 0, rec.out);
    assert.ok(calls >= 2, "the stand-in was called");
    assert.ok(existsSync(cassette));
    const cas = JSON.parse(readFileSync(cassette, "utf8"));
    assert.equal(JSON.stringify(cas).includes("stand-in\""), false, "no key in the cassette");
    assert.ok(cas.cases["edit-required"].turns[0].exchanges.length >= 1);
    const callsBefore = calls;
    const rep = await run(["--replay", cassette, "--out", join(dir, "rep")]);
    assert.equal(rep.code, 0, rep.out);
    assert.equal(calls, callsBefore, "the replay made no network call");
    const a = JSON.parse(readFileSync(join(dir, "rec", "latest.json"), "utf8"));
    const b = JSON.parse(readFileSync(join(dir, "rep", "latest.json"), "utf8"));
    assert.equal(a.meta.mode, "live"); assert.equal(b.meta.mode, "replay");
    assert.deepEqual(b.cases.map((c: { id: string; passed: boolean }) => [c.id, c.passed]), a.cases.map((c: { id: string; passed: boolean }) => [c.id, c.passed]));
    assert.deepEqual(b.summary.tokens, a.summary.tokens);
    assert.ok(a.summary.tokens.cacheRead > 0, "the cache reads the provider reported reach the report");
    /* the stand-in answers nothing useful: the edit case fails on the model, the unsupported one passes without a model */
    const byId = Object.fromEntries(a.cases.map((c: { id: string; passed: boolean }) => [c.id, c.passed]));
    assert.equal(byId["edit-required"], false); assert.equal(byId["scope-unsupported"], true);
  } finally { server.close(); }
});
