import test from "node:test";
import assert from "node:assert/strict";
import { fakeTranscribe, transcribe } from "./index.js";

/*
 * Diarization, and the one lie this must never tell.
 *
 * Asking a provider to separate the speakers is not the same as it having done
 * so. The OpenAI Whisper endpoint cannot; several OpenAI-compatible gateways
 * can. A transcript of three people from a provider that cannot diarize has
 * one voice in it — and if `diarized` said true because we asked, the product
 * would render a participant's name over every line, and be wrong about two
 * thirds of them.
 */

const bytes = new Uint8Array(32_000).fill(7);

test("plain transcription is unchanged — no segments asked for, none returned", () => {
  const t = fakeTranscribe(bytes, { durationSeconds: 12 });
  assert.equal(typeof t.text, "string");
  assert.equal(t.segments, undefined);
  assert.equal(t.diarized, undefined, "a caller that did not ask is told nothing either way");
});

test("asking for segments gets timings", () => {
  const t = fakeTranscribe(bytes, { durationSeconds: 12, segments: true });
  assert.ok(t.segments && t.segments.length > 0);
  for (const s of t.segments!) {
    assert.ok(Number.isFinite(s.start) && Number.isFinite(s.end), "every segment is placed in time");
    assert.ok(s.end >= s.start, "and does not run backwards");
    assert.ok(s.text.length > 0);
  }
});

test("segments without diarization carry no speaker at all", () => {
  const t = fakeTranscribe(bytes, { durationSeconds: 12, segments: true });
  for (const s of t.segments!) {
    assert.equal(s.speaker, undefined, "a speaker nobody asked for is a speaker nobody checked");
  }
});

test("asking to diarize gets anonymous labels, never names", () => {
  const t = fakeTranscribe(bytes, { durationSeconds: 12, diarize: true });
  assert.equal(t.diarized, true);
  assert.ok((t.speakerCount ?? 0) >= 2);
  for (const s of t.segments!) {
    assert.match(s.speaker!, /^Speaker \d+$/,
      "the provider's labels are anonymous — mapping them to people is a later judgement");
  }
});

test("diarizing implies segments, because a label needs something to attach to", () => {
  const t = fakeTranscribe(bytes, { durationSeconds: 12, diarize: true });
  assert.ok(t.segments && t.segments.length > 0);
});

test("the timings span the recording rather than piling up at zero", () => {
  const t = fakeTranscribe(bytes, { durationSeconds: 60, segments: true });
  const last = t.segments![t.segments!.length - 1];
  assert.ok(last.end > 1, `the last segment ends at ${last.end}s, which is not a real timing`);
});

test("A PROVIDER THAT IGNORES THE REQUEST MUST REPORT diarized: false", async () => {
  /*
   * The assertion the whole feature turns on. A gateway that has never heard
   * of the field returns a perfectly good transcript with no speaker keys.
   * Saying "diarized" there would put a name over every line of a
   * three-person conversation recorded as one voice.
   */
  const previous = { ...process.env };
  process.env.AI_STT_API_URL = "http://stt.invalid";
  process.env.AI_STT_API_KEY = "test";
  delete process.env.AI_API_URL;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        text: "Hello there. How are you.",
        duration: 12,
        /* verbose_json, with timings and NO speaker keys — the common case */
        segments: [
          { start: 0, end: 5, text: "Hello there." },
          { start: 5, end: 12, text: "How are you." },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  try {
    const out = await transcribe(bytes, { durationSeconds: 12, diarize: true });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.value.diarized, false, "asked for, not delivered — and it says so");
      assert.equal(out.value.speakerCount, 0);
      assert.equal(out.value.segments?.length, 2, "the timings are still kept — they are useful");
      assert.equal(out.value.segments?.[0].speaker, undefined);
    }
  } finally {
    globalThis.fetch = realFetch;
    process.env = previous;
  }
});

test("a provider that DOES diarize is believed, and its labels kept verbatim", async () => {
  const previous = { ...process.env };
  process.env.AI_STT_API_URL = "http://stt.invalid";
  delete process.env.AI_API_URL;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        text: "Tell me about your morning. I get up at six.",
        duration: 20,
        segments: [
          { start: 0, end: 4, text: "Tell me about your morning.", speaker: "Speaker 1" },
          /* the other spelling some gateways use */
          { start: 4, end: 20, text: "I get up at six.", speaker_label: "Speaker 2" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  try {
    const out = await transcribe(bytes, { durationSeconds: 20, diarize: true });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.value.diarized, true);
      assert.equal(out.value.speakerCount, 2);
      assert.equal(out.value.segments?.[0].speaker, "Speaker 1");
      assert.equal(out.value.segments?.[1].speaker, "Speaker 2", "speaker_label is read too");
    }
  } finally {
    globalThis.fetch = realFetch;
    process.env = previous;
  }
});

test("segments with unusable timings are dropped rather than shown as zero", async () => {
  /*
   * A transcript that looks navigable and jumps to the start every time is
   * worse than one that plainly has no timings.
   */
  const previous = { ...process.env };
  process.env.AI_STT_API_URL = "http://stt.invalid";
  delete process.env.AI_API_URL;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        text: "Hello.",
        duration: 5,
        segments: [
          { text: "Hello." },
          { start: 0, end: 5, text: "Hello." },
          { start: 5, end: 9, text: "   " },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;

  try {
    const out = await transcribe(bytes, { durationSeconds: 5, segments: true });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.value.segments?.length, 1, "only the one with timings AND text survives");
    }
  } finally {
    globalThis.fetch = realFetch;
    process.env = previous;
  }
});
