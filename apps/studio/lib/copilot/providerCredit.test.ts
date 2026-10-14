import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { completeJson, resetProviderState, setProviderLogger, isProviderError } from "@rescript/ai";
import { failureFromError } from "./failure.ts";

/**
 * "THE AI SERVICE COULD NOT PROCESS THIS REQUEST", end to end over real HTTP.
 *
 * A server that answers exactly as Anthropic's does for an account with no
 * credit — HTTP 400, invalid_request_error — and the Studio's own path from
 * that response to the researcher's card: the ai package's request manager,
 * then `failureFromError`. Before the fix this ended at the `provider` card
 * ("could not process this request … try rephrasing") and the provider's
 * words were nowhere in the log.
 */
const CREDIT = { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } };
const MALFORMED = { type: "error", error: { type: "invalid_request_error", message: "messages.1.content: Input should be a valid string" } };

async function withServer(body: unknown, fn: (hits: () => number, lines: { event: string; fields: Record<string, unknown> }[]) => Promise<void>) {
  let n = 0;
  const srv = http.createServer((req, res) => { req.resume(); req.on("end", () => { n++; res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  const saved = { u: process.env.AI_API_URL, k: process.env.AI_API_KEY, m: process.env.AI_MODEL };
  process.env.AI_API_URL = `http://127.0.0.1:${port}/v1`; process.env.AI_API_KEY = "sk-test-secret-value"; process.env.AI_MODEL = "claude-test";
  resetProviderState();
  const lines: { event: string; fields: Record<string, unknown> }[] = [];
  setProviderLogger((event, fields) => lines.push({ event, fields }));
  try { await fn(() => n, lines); }
  finally {
    setProviderLogger(null); resetProviderState();
    for (const [k, v] of [["AI_API_URL", saved.u], ["AI_API_KEY", saved.k], ["AI_MODEL", saved.m]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise((r) => srv.close(r));
  }
}

test("a credit-balance 400 reaches the researcher as the CREDIT card, not 'could not process this request'", async () => {
  await withServer(CREDIT, async (hits, lines) => {
    const e = await completeJson("system", "एक छोटा सा रिसर्च डिज़ाइन करो", 2000, { retryDelayMs: 1, schema: { name: "s", schema: { type: "object" } } }).catch((x) => x);
    assert.ok(isProviderError(e));
    const card = failureFromError(e as never);
    assert.equal(card.code, "quota");
    assert.match(card.title, /LIMIT|CREDIT|QUOTA/i);
    assert.match(card.admin ?? "", /billing|credit/i);
    assert.equal(hits(), 1, "no retry, no second request shape");
    const said = lines.find((l) => l.event === "refused")?.fields.said;
    assert.match(String(said), /credit balance is too low/, "the provider's words are in the log");
    assert.equal(JSON.stringify(lines).includes("sk-test-secret-value"), false);
  });
});

test("a genuinely malformed request is the 'provider' card — now with the provider's words in the log and a pointer for the administrator", async () => {
  await withServer(MALFORMED, async (_hits, lines) => {
    const e = await completeJson("system", "user", 2000, { retryDelayMs: 1 }).catch((x) => x);
    const card = failureFromError(e as never);
    assert.equal(card.code, "provider");
    assert.match(card.admin ?? "", /AI connection/);
    const refused = lines.find((l) => l.event === "refused");
    assert.match(String(refused?.fields.said), /Input should be a valid string/);
    assert.equal(refused?.fields.status, 400);
  });
});
