import test from "node:test";
import assert from "node:assert/strict";
import { NDJSON, NdjsonDecoder, clientStreaming, encodeEvent, readTurnResponse, streamTurn, streamingAllowed, wantsStream, type TurnEvent, type TurnSink } from "./stream.ts";

/**
 * THE STREAMED TURN (2026-10-18): the NDJSON protocol, the server's wrapper
 * (nothing changes until the route starts the stream; then one terminal event
 * carrying the JSON path's exact body and status), and the browser's reader
 * (JSON or NDJSON, a broken stream = a dropped connection).
 */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function events(r: Response): Promise<TurnEvent[]> {
  const d = new NdjsonDecoder();
  return [...d.push(await r.text()), ...d.end()];
}
const crash = () => ({ status: 500, body: { ok: false, error: "crashed" } });

test("encodeEvent / NdjsonDecoder: one event per line, lines split anywhere, unicode intact, blank and foreign lines skipped", () => {
  const evs: TurnEvent[] = [
    { type: "start", v: 1, heartbeatMs: 8000 },
    { type: "text", delta: "नमस्ते 😀\nline \"two\" ", part: "reply" },
    { type: "result", status: 200, body: { ok: true, reply: { reply: "x" } } },
  ];
  const wire = `${encodeEvent(evs[0])}\n${encodeEvent(evs[1])}not json\n{"type":"unknown"}\n${encodeEvent(evs[2])}`;
  assert.equal(encodeEvent(evs[1]).split("\n").length, 2, "a newline inside a string never breaks the line");
  for (const n of [1, 3, 7, 1000]) {
    const d = new NdjsonDecoder();
    const got: TurnEvent[] = [];
    for (let i = 0; i < wire.length; i += n) got.push(...d.push(wire.slice(i, i + n)));
    got.push(...d.end());
    assert.deepEqual(got, evs, `chunk ${n}`);
    assert.equal(d.skipped, 2);
  }
  const d = new NdjsonDecoder();
  assert.deepEqual([...d.push('{"type":"heartbeat","at":1}'), ...d.end()], [{ type: "heartbeat", at: 1 }], "a last line without its newline");
});

test("wantsStream / streamingAllowed / clientStreaming", () => {
  assert.equal(wantsStream("application/x-ndjson"), true);
  assert.equal(wantsStream("application/x-ndjson, application/json;q=0.9"), true);
  assert.equal(wantsStream("Application/X-NDJSON; charset=utf-8"), true);
  for (const a of [null, "", "*/*", "application/json", "text/html,application/xhtml+xml"]) assert.equal(wantsStream(a), false, String(a));
  assert.equal(streamingAllowed({}, false, false), true, "a real provider streams when asked");
  assert.equal(streamingAllowed({}, true, false), false, "the fake streams only with the test seam");
  assert.equal(streamingAllowed({}, true, true), true);
  assert.equal(streamingAllowed({ COPILOT_STREAMING: "off" }, false, true), false);
  assert.equal(streamingAllowed({ COPILOT_STREAMING: "on" }, true, false), true);
  assert.equal(clientStreaming(null, undefined), true);
  assert.equal(clientStreaming("off", undefined), false);
  assert.equal(clientStreaming(null, "off"), false);
  assert.equal(clientStreaming("on", "off"), true, "the browser's own switch wins");
});

test("streamTurn: a route that answers before starting is returned untouched (same object: status, headers, body)", async () => {
  const res = json({ error: "say what you want" }, 400, { "x-mine": "1" });
  const out = await streamTurn(async (sink) => { sink.configure({ enabled: true }); return res; }, { crash });
  assert.equal(out, res);
  /* not enabled: start() is a no-op, the route's JSON comes back even after "starting" */
  const res2 = json({ ok: true, reply: null });
  const out2 = await streamTurn(async (sink) => { sink.configure({ enabled: false }); sink.start(); sink.text("x"); await sleep(5); return res2; }, { crash });
  assert.equal(out2, res2);
  /* an exception before streaming propagates, as it always did */
  await assert.rejects(streamTurn(async () => { throw new Error("boom"); }, { crash }), /boom/);
});

test("streamTurn: started — 200 NDJSON with no-buffering headers: start, progress, text, checkpoint, heartbeats while pending, ONE terminal result with the exact body", async () => {
  const body = { ok: true, stage: "executed", reply: { kind: "proposal", reply: "Done — नमस्ते" }, usage: { charge: 0.12 } };
  const res = await streamTurn(async (sink) => {
    sink.configure({ enabled: true, heartbeatMs: 50 });
    sink.progress({ stage: "turn" });                 /* before start: the latest is kept and sent after start */
    sink.text("lost");                                /* other events before start are not */
    sink.start(); sink.start();
    sink.progress({ stage: "item", item: 1, of: 2, id: "p1", label: "Screener" });
    sink.text("Done", "reply"); sink.text("", "reply"); sink.text(" — नमस्ते", "reply");
    sink.checkpoint("p1", { actions: [] });
    await sleep(150);
    return json(body);
  }, { crash });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), `${NDJSON}; charset=utf-8`);
  assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  const evs = await events(res);
  assert.deepEqual(evs[0], { type: "start", v: 1, heartbeatMs: 50 });
  assert.deepEqual(evs.filter((e) => e.type !== "heartbeat").map((e) => e.type), ["start", "progress", "progress", "text", "text", "checkpoint", "result"]);
  assert.deepEqual(evs[1], { type: "progress", stage: "turn" });
  assert.ok(evs.filter((e) => e.type === "heartbeat").length >= 2, "heartbeats while the route worked");
  assert.deepEqual(evs.at(-1), { type: "result", status: 200, body });
  assert.equal(evs.filter((e) => e.type === "result" || e.type === "error").length, 1);
});

test("streamTurn: a failure after start is the terminal error with the JSON path's status, body and Retry-After; a crash is a 500 error event", async () => {
  const failure = { ok: false, error: "busy", failure: { code: "capacity", retryable: true }, retryable: true, saved: true };
  const res = await streamTurn(async (sink) => { sink.configure({ enabled: true }); sink.start(); return json(failure, 503, { "retry-after": "7" }); }, { crash });
  assert.equal(res.status, 200, "the stream began, so the HTTP status is 200; the turn's is in the event");
  assert.deepEqual((await events(res)).at(-1), { type: "error", status: 503, body: failure, retryAfter: 7 });
  const res2 = await streamTurn(async (sink) => { sink.configure({ enabled: true }); sink.start(); throw new Error("late"); }, { crash });
  assert.deepEqual((await events(res2)).at(-1), { type: "error", status: 500, body: { ok: false, error: "crashed" } });
});

test("streamTurn: the drop seam ends the stream without a terminal event and tells the route (cancelled)", async () => {
  let seen: TurnSink | null = null;
  let finished = false;
  const res = await streamTurn(async (sink) => {
    seen = sink;
    sink.configure({ enabled: true, dropAfterCheckpoints: 1 });
    sink.start();
    sink.checkpoint("p1", {});
    sink.checkpoint("p2", {});
    await sleep(20);
    finished = true;
    return json({ ok: true });
  }, { crash });
  const evs = await events(res);
  assert.deepEqual(evs.map((e) => e.type), ["start", "checkpoint"]);
  assert.equal(seen!.cancelled, true);
  await sleep(40);
  assert.equal(finished, true, "the route ran to its end (its metering and storage as always)");
});

test("readTurnResponse: JSON as before; a stream → its terminal event, handlers called in order; a broken or idle stream → status 0", async () => {
  const plain = await readTurnResponse(json({ ok: false, error: "x" }, 402));
  assert.deepEqual(plain, { status: 402, ok: false, d: { ok: false, error: "x" }, streamed: false });
  const notJson = await readTurnResponse(new Response("<html>504</html>", { status: 504, headers: { "content-type": "text/html" } }));
  assert.deepEqual(notJson, { status: 504, ok: false, d: null, streamed: false });

  const body = { ok: true, reply: { kind: "answer", reply: "Hi" } };
  const res = await streamTurn(async (sink) => {
    sink.configure({ enabled: true, heartbeatMs: 50 });
    sink.start();
    sink.progress({ stage: "turn" });
    sink.text("H", "reply"); await sleep(120); sink.text("i", "reply");
    sink.checkpoint("p1", { a: 1 });
    return json(body);
  }, { crash });
  const seen: string[] = [];
  const got = await readTurnResponse(res, { onStart: () => seen.push("start"), onHeartbeat: () => seen.push("hb"), onProgress: (e) => seen.push(`progress:${e.stage}`), onText: (d, p) => seen.push(`text:${p}:${d}`), onCheckpoint: (id) => seen.push(`cp:${id}`) });
  assert.deepEqual(got, { status: 200, ok: true, d: body, streamed: true });
  assert.deepEqual(seen.filter((s) => s !== "hb"), ["start", "progress:turn", "text:reply:H", "text:reply:i", "cp:p1"]);
  assert.ok(seen.includes("hb"));

  const err = await readTurnResponse(await streamTurn(async (s) => { s.configure({ enabled: true }); s.start(); return json({ ok: false }, 503); }, { crash }));
  assert.deepEqual(err, { status: 503, ok: false, d: { ok: false }, streamed: true });

  const broken = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(encodeEvent({ type: "start", v: 1, heartbeatMs: 10 }) + '{"type":"text","delta":"par')); c.close(); } }), { headers: { "content-type": NDJSON } });
  assert.deepEqual(await readTurnResponse(broken), { status: 0, ok: false, d: null, streamed: true, broken: true });

  const silent = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(encodeEvent({ type: "start", v: 1, heartbeatMs: 10 }))); } }), { headers: { "content-type": NDJSON } });
  const t0 = Date.now();
  assert.deepEqual(await readTurnResponse(silent, {}, { idleMs: 60 }), { status: 0, ok: false, d: null, streamed: true, broken: true, idle: true });
  assert.ok(Date.now() - t0 < 2000);
});

test("the two paths agree: the streamed result's body is the JSON path's body, byte for byte once parsed", async () => {
  const route = async (sink: TurnSink | null) => { sink?.configure({ enabled: true }); sink?.start(); sink?.text("x"); return json({ ok: true, reply: { kind: "answer", reply: "x — ü", actions: [] }, usage: { charge: 0.0042 } }, 200); };
  const a = await route(null);
  const b = await readTurnResponse(await streamTurn(route, { crash }));
  assert.deepEqual(b.d, await a.json());
});
