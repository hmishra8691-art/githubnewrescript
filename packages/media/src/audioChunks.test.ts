import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planChunks, encodeWav, floatToInt16, downmix, resampleLinear, mergeChunkTranscripts, decodeBudget,
  CHUNK_TARGET_BYTES, CHUNK_SAMPLE_RATE, WAV_HEADER_BYTES, readWav, type ChunkTranscript,
} from "./index.js";

/* #17 — the arithmetic of transcribing any browser-decodable recording in parts */

test("planChunks: every part fits 25 MB as WAV, parts overlap by 2 s, together they cover every sample once plus the overlaps", () => {
  const hours = 2;
  const total = hours * 3600 * CHUNK_SAMPLE_RATE;
  const plan = planChunks(total);
  assert.ok(plan.length >= 9, `${plan.length} parts`);
  for (const p of plan) assert.ok(p.bytes <= CHUNK_TARGET_BYTES && p.bytes <= 25 * 1024 * 1024, `part ${p.index}: ${p.bytes}`);
  assert.equal(plan[0].startSample, 0);
  assert.equal(plan[plan.length - 1].endSample, total);
  for (let i = 1; i < plan.length; i++) {
    assert.equal(plan[i - 1].endSample - plan[i].startSample, 2 * CHUNK_SAMPLE_RATE, "2 s shared");
    assert.equal(plan[i].overlapBefore, 2);
    assert.equal(plan[i - 1].overlapAfter, 2);
    assert.equal(plan[i].offsetSeconds, plan[i].startSample / CHUNK_SAMPLE_RATE);
  }
  assert.deepEqual(planChunks(0), []);
  const one = planChunks(10 * CHUNK_SAMPLE_RATE);
  assert.equal(one.length, 1);
  assert.equal(one[0].overlapBefore, 0);
});

test("encodeWav: a valid 16 kHz mono 16-bit WAV that the server split reads back", () => {
  const pcm = floatToInt16(new Float32Array([0, 0.5, -0.5, 1, -1, 2]));
  assert.deepEqual([...pcm], [0, 16384, -16384, 32767, -32768, 32767]);
  const wav = encodeWav(pcm);
  assert.equal(wav.length, WAV_HEADER_BYTES + pcm.length * 2);
  const info = readWav(wav)!;
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataBytes, pcm.length * 2);
});

test("downmix averages the channels over a range; resampleLinear keeps duration and a tone's shape", () => {
  const l = new Float32Array([1, 1, 1, 1]), r = new Float32Array([0, 0, 1, -1]);
  assert.deepEqual([...downmix([l, r], 1, 4)], [0.5, 1, 0]);
  const rate = 48000, f = 440;
  const tone = new Float32Array(rate).map((_, i) => Math.sin((2 * Math.PI * f * i) / rate));
  const down = resampleLinear(tone, rate, 16000);
  assert.equal(down.length, 16000, "one second stays one second");
  let maxErr = 0;
  for (let i = 0; i < down.length; i++) maxErr = Math.max(maxErr, Math.abs(down[i] - Math.sin((2 * Math.PI * f * i) / 16000)));
  assert.ok(maxErr < 0.01, `max error ${maxErr}`);
});

test("decodeBudget refuses what the browser cannot hold, in seconds", () => {
  assert.equal(decodeBudget(3600, 1).ok, true);
  assert.equal(decodeBudget(4 * 3600, 2).ok, false);
  assert.equal(decodeBudget(0, 2).maxSeconds, Math.floor((640 * 1024 * 1024) / (16000 * 4 * 2)));
});

const words = (list: [string, number, number][]) => list.map(([word, start, end]) => ({ word, start, end }));

test("merge: offsets onto the recording's clock; the overlap's words kept once, cut at its midpoint", () => {
  /* part 0 covers 0–10 s, part 1 starts at 8 s (2 s overlap, seam at 9 s); both heard "and the price" around 8.2–9.6 */
  const parts: ChunkTranscript[] = [
    { index: 0, offsetSeconds: 0, durationSeconds: 10, overlapBefore: 0, overlapAfter: 2, text: "I liked it and the price",
      words: words([["I", 0.5, 0.7], ["liked", 0.8, 1.2], ["it", 1.3, 1.5], ["and", 8.2, 8.5], ["the", 8.6, 8.8], ["price", 9.1, 9.6]]),
      segments: [{ start: 0.5, end: 9.6, text: "I liked it and the price" }] },
    { index: 1, offsetSeconds: 8, durationSeconds: 10, overlapBefore: 2, overlapAfter: 0, text: "and the price was fair",
      words: words([["and", 0.2, 0.5], ["the", 0.6, 0.8], ["price", 1.1, 1.6], ["was", 1.8, 2.0], ["fair", 2.1, 2.5]]),
      segments: [{ start: 0.2, end: 2.5, text: "and the price was fair" }] },
  ];
  const m = mergeChunkTranscripts(parts);
  assert.deepEqual(m.words.map((w) => w.word), ["I", "liked", "it", "and", "the", "price", "was", "fair"]);
  assert.equal(m.words.find((w) => w.word === "was")!.start, 9.8, "shifted by the part's offset");
  assert.equal(m.text, "I liked it and the price was fair");
  assert.equal(m.wordTimings, true);
  assert.ok(m.deduplicated >= 3);
  assert.equal(m.segments.length, 2);
  assert.ok(m.segments.every((s) => s.start < s.end));
});

test("merge: a phrase heard on both sides of the seam with shifted timings is still kept once", () => {
  const parts: ChunkTranscript[] = [
    { index: 0, offsetSeconds: 0, durationSeconds: 10, overlapBefore: 0, overlapAfter: 2, text: "we tried it", words: words([["we", 8.0, 8.3], ["tried", 8.4, 8.95]]), segments: [] },
    { index: 1, offsetSeconds: 8, durationSeconds: 10, overlapBefore: 2, overlapAfter: 0, text: "tried it twice", words: words([["tried", 1.0, 1.4], ["it", 1.5, 1.6], ["twice", 1.7, 2.0]]), segments: [] },
  ];
  const m = mergeChunkTranscripts(parts);
  assert.deepEqual(m.words.map((w) => w.word), ["we", "tried", "it", "twice"]);
});

test("merge without word timings: segments by where they start, and the warning says clips play the turn", () => {
  const parts: ChunkTranscript[] = [
    { index: 0, offsetSeconds: 0, durationSeconds: 10, overlapBefore: 0, overlapAfter: 2, text: "one. two.", segments: [{ start: 0, end: 4, text: "one." }, { start: 8.5, end: 10, text: "two." }] },
    { index: 1, offsetSeconds: 8, durationSeconds: 10, overlapBefore: 2, overlapAfter: 0, text: "two. three.", segments: [{ start: 0.5, end: 2, text: "two." }, { start: 3, end: 6, text: "three." }] },
  ];
  const m = mergeChunkTranscripts(parts);
  assert.deepEqual(m.segments.map((s) => s.text), ["one.", "two.", "three."]);
  assert.equal(m.segments[2].start, 11);
  assert.equal(m.wordTimings, false);
  assert.ok(m.warnings.some((w) => /whole turn/.test(w)));
});
