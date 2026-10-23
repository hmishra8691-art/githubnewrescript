import test from "node:test";
import assert from "node:assert/strict";
import { fakeTranscribe, transcribe } from "./index.js";

/*
 * WORD-LEVEL TIMINGS (2026-10-22, engine item #17) — what lets a coded excerpt
 * play exactly its own words. Asked for with `words: true`; present only when
 * the provider returned them.
 */

const bytes = new Uint8Array(32_000).fill(3);

test("the fake returns word timings only when asked, spread over the clip in order", () => {
  assert.equal(fakeTranscribe(bytes, { durationSeconds: 10, segments: true }).words, undefined);
  const t = fakeTranscribe(bytes, { durationSeconds: 10, segments: true, words: true });
  assert.ok(t.words && t.words.length >= 8);
  for (let i = 1; i < t.words!.length; i++) assert.ok(t.words![i].start >= t.words![i - 1].start);
  assert.ok(t.words![t.words!.length - 1].end <= 10.001);
  assert.equal(t.words!.map((w) => w.word).join(" "), t.segments!.map((s) => s.text).join(" "), "the words are the segments' words, in order");
});

test("OpenAI-compatible: asks timestamp_granularities[]=word beside segment, and parses `words`", async () => {
  const previous = { ...process.env };
  process.env.AI_STT_API_URL = "http://stt.invalid";
  process.env.AI_STT_API_KEY = "test";
  delete process.env.AI_API_URL;
  const realFetch = globalThis.fetch;
  let sent: FormData | null = null;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    sent = init.body as FormData;
    return new Response(JSON.stringify({
      text: "the price went up", duration: 2,
      segments: [{ start: 0, end: 2, text: "the price went up" }],
      words: [{ word: "the", start: 0, end: 0.3 }, { word: "price", start: 0.3, end: 0.9 }, { word: "went", start: 0.9, end: 1.3 }, { word: "up", start: 1.3, end: 1.8 }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  try {
    const out = await transcribe(bytes, { segments: true, words: true, mimeType: "audio/wav", fileName: "a.wav", durationSeconds: 2 });
    assert.ok(out.ok);
    if (!out.ok) return;
    assert.deepEqual(sent!.getAll("timestamp_granularities[]"), ["segment", "word"]);
    assert.equal(sent!.get("response_format"), "verbose_json");
    assert.deepEqual(out.value.words?.map((w) => w.word), ["the", "price", "went", "up"]);
    assert.equal(out.value.words?.[1].start, 0.3);
    // not asked → not requested, and not returned even if the provider sends them
    const plain = await transcribe(bytes, { segments: true, mimeType: "audio/wav", fileName: "a.wav", durationSeconds: 2 });
    assert.deepEqual(sent!.getAll("timestamp_granularities[]"), ["segment"]);
    assert.ok(plain.ok && plain.value.words === undefined);
  } finally {
    globalThis.fetch = realFetch;
    process.env = previous;
  }
});
