import { test } from "node:test";
import assert from "node:assert/strict";
import { splitAudio, splitWav, splitMp3, readWav, mp3Frame, sniffAudio, mergePartTranscripts } from "./audioSplit.js";

/* LONG RECORDINGS (2026-10-22): WAV and MP3 are cut without re-encoding into parts that are valid files, each with
 * the offset at which it starts; the transcripts' timestamps are moved back onto the recording's clock. */

function wav(dataBytes: number, rate = 8000, channels = 1, bits = 16): Uint8Array {
  const block = channels * bits / 8;
  const b = new Uint8Array(44 + 26 + dataBytes);
  const w = (at: number, s: string) => { for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i); };
  const p32 = (at: number, v: number) => { b[at] = v & 255; b[at + 1] = (v >>> 8) & 255; b[at + 2] = (v >>> 16) & 255; b[at + 3] = (v >>> 24) & 255; };
  const p16 = (at: number, v: number) => { b[at] = v & 255; b[at + 1] = (v >>> 8) & 255; };
  w(0, "RIFF"); p32(4, b.length - 8); w(8, "WAVE");
  /* a LIST chunk before fmt, as some recorders write: the reader must walk the chunks */
  w(12, "LIST"); p32(16, 18); w(20, "INFOISFT"); p32(28, 6); w(32, "rescr\0");
  w(38, "fmt "); p32(42, 16); p16(46, 1); p16(48, channels); p32(50, rate); p32(54, rate * block); p16(58, block); p16(60, bits);
  w(62, "data"); p32(66, dataBytes);
  for (let i = 0; i < dataBytes; i++) b[70 + i] = i % 251;
  return b;
}

test("WAV: cut on block boundaries; every part a valid WAV; offsets exact; the data intact", () => {
  const b = wav(100_000);
  assert.equal(sniffAudio(b), "wav");
  const info = readWav(b)!;
  assert.deepEqual([info.byteRate, info.blockAlign, info.dataBytes], [16000, 2, 100_000]);
  const r = splitWav(b, 30_044);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.parts.map((p) => p.offsetSeconds), [0, 1.875, 3.75, 5.625]);
  assert.equal(r.durationSeconds, 6.25);
  const joined: number[] = [];
  for (const p of r.parts) {
    const pi = readWav(p.bytes)!;
    assert.equal(pi.dataBytes, p.bytes.length - 44);
    assert.equal(pi.sampleRate, 8000);
    assert.ok(p.bytes.length <= 30_044);
    joined.push(...p.bytes.subarray(44));
  }
  assert.equal(joined.length, 100_000);
  assert.ok(joined.every((v, i) => v === i % 251));
});

function mp3(frames: number): Uint8Array {
  /* MPEG-1 Layer III, 128 kb/s, 44.1 kHz, no padding → 417-byte frames of 1152 samples, after a 20-byte ID3v2 tag */
  const tag = [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)];
  const out = new Uint8Array(tag.length + frames * 417);
  out.set(tag, 0);
  for (let f = 0; f < frames; f++) out.set([0xff, 0xfb, 0x90, 0x00], tag.length + f * 417);
  return out;
}

test("MP3: frames read from their headers; cut on frame boundaries after the ID3 tag; offsets by samples", () => {
  const b = mp3(100);
  assert.equal(sniffAudio(b), "mp3");
  assert.deepEqual(mp3Frame(b, 20), { at: 20, length: 417, samples: 1152, sampleRate: 44100 });
  const r = splitMp3(b, 417 * 30 + 10);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.parts.map((p) => p.bytes.length / 417), [30, 30, 30, 10]);
  assert.deepEqual(r.parts.map((p) => Math.round(p.offsetSeconds * 1e4) / 1e4), [0, 0.7837, 1.5673, 2.351]);
  for (const p of r.parts) assert.ok(mp3Frame(p.bytes, 0), "each part starts on a frame");
  assert.equal(Math.round(r.durationSeconds * 1000) / 1000, Math.round((100 * 1152 / 44100) * 1000) / 1000);
});

test("other formats are refused with the reason, not cut", () => {
  const m4a = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
  const r = splitAudio(m4a, "audio/mp4");
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.code, "unsupported"); assert.match(r.reason, /only WAV and MP3/); }
});

test("part transcripts are moved onto the recording's clock; cuts and per-part speakers are warned about", () => {
  const m = mergePartTranscripts([
    { offsetSeconds: 0, text: "hello there", segments: [{ start: 0, end: 2, text: "hello there", speaker: "Speaker 1" }], diarized: true },
    { offsetSeconds: 754.5, text: "and then", segments: [{ start: 1.25, end: 3, text: "and then", speaker: "Speaker 1" }], diarized: true },
  ]);
  assert.deepEqual(m.segments.map((s) => [s.start, s.end]), [[0, 2], [755.75, 757.5]]);
  assert.equal(m.text, "hello there and then");
  assert.match(m.warnings[0], /2 parts \(cut at 12:34\)/);
  assert.match(m.warnings[0], /Speaker 1” in one part is not necessarily/);
});
