import test from "node:test";
import assert from "node:assert/strict";
import { completeJson, isAiReplyError, collectUsage, type AiReplyError } from "./index.js";

/**
 * Research Engine audit, Phase 1: a reply cut off at the output budget is
 * continued and read as one; a prose reply is asked for once more as the
 * object alone; what still cannot be read is reported with a code, never as
 * `null`. A schema goes to providers that take one and falls back where
 * they do not.
 */
const KEYS = ["AI_API_URL", "AI_API_KEY", "AI_MODEL", "AI_WORKSPACE_ID", "AI_API_HEADERS"];
async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  try { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env); await fn(); }
  finally { for (const k of KEYS) { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; } }
}
type Sent = { url: string; body: { messages: { role: string; content: string }[]; response_format?: unknown } };
async function withFetch(reply: (b: Sent["body"], n: number) => Response, fn: (sent: Sent[]) => Promise<void>) {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body });
    return reply(body, sent.length);
  }) as never;
  try { await fn(sent); } finally { globalThis.fetch = real; }
}
const answer = (content: string, finish = "stop", tokens = 7) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 11, completion_tokens: tokens } }), { status: 200 });
const ENV = { AI_API_URL: "https://openai.example/v1", AI_API_KEY: "k" };
const failure = async (p: Promise<unknown>): Promise<AiReplyError> => {
  try { await p; } catch (e) { if (isAiReplyError(e)) return e; throw e; }
  throw new Error("did not fail");
};

test("a reply cut off at max_tokens is continued from where it stopped and read as one object", async () => {
  const whole = JSON.stringify({ kind: "proposal", actions: Array.from({ length: 6 }, (_, i) => ({ op: "create_question", text: `Question ${i + 1}` })) });
  const cut = Math.floor(whole.length / 2);
  await withEnv(ENV, () => withFetch((b, n) => {
    if (n === 1) return answer(whole.slice(0, cut), "length", 40);
    // the continuation carries the partial answer as the assistant's turn and one instruction
    const last = b.messages[b.messages.length - 1];
    assert.equal(b.messages[b.messages.length - 2].role, "assistant");
    assert.equal(b.messages[b.messages.length - 2].content, whole.slice(0, cut));
    assert.match(last.content, /Continue EXACTLY from where it stopped/);
    return answer(whole.slice(cut), "stop", 40);
  }, async (sent) => {
    const { value, usage } = await collectUsage(() => completeJson("s", "u", 40, { timeoutMs: 5000 }));
    assert.deepEqual(value, JSON.parse(whole));
    assert.equal(sent.length, 2);
    assert.equal(usage.length, 2, "both calls are metered");
    assert.equal(usage.reduce((a, u) => a + (u.outputTokens ?? 0), 0), 80);
  }));
});

test("still cut off after the continuations: reported as truncated, with the budget", async () => {
  await withEnv(ENV, () => withFetch(() => answer('{"kind":"proposal","actions":[{"op":"create_question","text":"never ends', "length", 50), async (sent) => {
    const e = await failure(completeJson("s", "u", 50, { timeoutMs: 5000, continuations: 2 }));
    assert.equal(e.code, "truncated");
    assert.match(e.message, /cut off at the output limit \(50 tokens, continued 2×\)/);
    assert.equal(sent.length, 3, "one call and two continuations");
    assert.equal(e.detail.outputTokens, 150);
    assert.equal(e.detail.continuations, 2, "the detail carries how often it was continued");
    assert.equal(e.detail.maxTokens, 50);
  }));
  await withEnv(ENV, () => withFetch(() => answer('{"a":', "length", 5), async (sent) => {
    const e = await failure(completeJson("s", "u", 5, { timeoutMs: 5000, continuations: 0 }));
    assert.equal(e.code, "truncated");
    assert.equal(sent.length, 1, "continuations: 0 never continues");
  }));
});

test("a prose answer is asked for once more as the object alone; words twice is unparseable, not null", async () => {
  await withEnv(ENV, () => withFetch((b, n) => {
    if (n === 1) return answer("Sure! I would add three questions about price.");
    assert.match(b.messages[b.messages.length - 1].content, /ONLY the JSON object/);
    return answer('{"kind":"answer","reply":"three questions about price"}');
  }, async (sent) => {
    assert.deepEqual(await completeJson("s", "u", 20, { timeoutMs: 5000 }), { kind: "answer", reply: "three questions about price" });
    assert.equal(sent.length, 2);
  }));
  await withEnv(ENV, () => withFetch(() => answer("I cannot produce that."), async (sent) => {
    const e = await failure(completeJson("s", "u", 20, { timeoutMs: 5000 }));
    assert.equal(e.code, "unparseable");
    assert.equal(sent.length, 2);
    assert.match(e.detail.sample ?? "", /cannot produce/);
  }));
  await withEnv(ENV, () => withFetch(() => answer(""), async () => {
    const e = await failure(completeJson("s", "u", 20, { timeoutMs: 5000 }));
    assert.equal(e.code, "empty");
  }));
});

test("a schema is sent as json_schema; a provider that refuses it gets json_object; one that refuses both gets nothing", async () => {
  const schema = { name: "reply", schema: { type: "object", properties: { kind: { type: "string" } } } };
  await withEnv({ AI_API_URL: "https://schema.example/v1", AI_API_KEY: "k" }, () => withFetch(() => answer('{"kind":"x"}'), async (sent) => {
    assert.deepEqual(await completeJson("s", "u", 20, { timeoutMs: 5000, schema }), { kind: "x" });
    assert.deepEqual(sent[0].body.response_format, { type: "json_schema", json_schema: { name: "reply", schema: schema.schema } });
  }));
  await withEnv({ AI_API_URL: "https://noschema.example/v1", AI_API_KEY: "k" }, () => withFetch((b) => {
    const f = b.response_format as { type?: string } | undefined;
    if (f?.type === "json_schema") return new Response('{"error":{"message":"response_format: json_schema is not supported"}}', { status: 400 });
    return answer('{"kind":"y"}');
  }, async (sent) => {
    assert.deepEqual(await completeJson("s", "u", 20, { timeoutMs: 5000, schema }), { kind: "y" });
    assert.deepEqual(sent.map((x) => (x.body.response_format as { type?: string } | undefined)?.type), ["json_schema", "json_object"]);
    await completeJson("s", "u", 20, { timeoutMs: 5000, schema });
    assert.equal((sent[2].body.response_format as { type?: string }).type, "json_object", "the refusal is remembered");
  }));
  // a 400 that is not about the response format is the provider's answer, not a reason to retry without the schema
  await withEnv({ AI_API_URL: "https://badreq.example/v1", AI_API_KEY: "k" }, () => withFetch(() => new Response('{"error":{"message":"model not found: gpt-nope"}}', { status: 400 }), async (sent) => {
    await assert.rejects(completeJson("s", "u", 20, { timeoutMs: 5000, schema }), /400/);
    assert.equal(sent.length, 1, "no json_object retry for an unrelated 400");
    await assert.rejects(completeJson("s", "u", 20, { timeoutMs: 5000, schema }));
    assert.equal((sent[1].body.response_format as { type?: string }).type, "json_schema", "…and the schema is still sent next time");
  }));
  await withEnv({ AI_API_URL: "https://nojson.example/v1", AI_API_KEY: "k" }, () => withFetch((b) => (b.response_format ? new Response('{"error":{"message":"response_format is not supported"}}', { status: 400 }) : answer('{"kind":"z"}')), async (sent) => {
    assert.deepEqual(await completeJson("s", "u", 20, { timeoutMs: 5000, schema }), { kind: "z" });
    assert.deepEqual(sent.map((x) => (x.body.response_format as { type?: string } | undefined)?.type ?? "none"), ["json_schema", "json_object", "none"]);
  }));
  await withEnv({ AI_API_URL: "https://api.anthropic.com/v1", AI_API_KEY: "k" }, () => withFetch(() => answer('{"kind":"a"}'), async (sent) => {
    await completeJson("s", "u", 20, { timeoutMs: 5000, schema });
    assert.equal((sent[0].body.response_format as { type?: string }).type, "json_schema", "Anthropic is sent a schema (it names json_schema as what it takes)");
    await completeJson("s", "u", 20, { timeoutMs: 5000 });
    assert.equal(sent[1].body.response_format, undefined, "…and still never json_object");
  }));
});
