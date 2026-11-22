import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadReportFonts, planReel, renderReel, runFfmpeg, probe, cardSeconds, type ReelSource, type ReelItemIn } from "./index.js";

const FONT_DIR = fileURLToPath(new URL("../../../apps/studio/public/report-fonts/", import.meta.url));
const brand = { title: "Why people switch broadband", subtitle: "Six interviews, November 2026", color: "#e8590c" };
const sources: ReelSource[] = [
  { sourceId: "s1", file: "/rec/s1.mp4", hasVideo: true, consent: { recording: true } },
  { sourceId: "s2", file: "/rec/s2.mp4", hasVideo: true, consent: { recording: false } },
  { sourceId: "s3", file: null, consent: { recording: true } },
];
const items: ReelItemIn[] = [
  { excerptId: "e1", sourceId: "s1", quote: "The price went up twice in a year.", speaker: "Asha", start: 12.4, end: 15.1 },
  { excerptId: "e2", sourceId: "s2", quote: "Nobody answered the support line for days.", speaker: "Ravi", start: 40, end: 43 },
  { excerptId: "e3", sourceId: "s3", quote: "The new provider was half the price.", start: 5, end: 7 },
  { excerptId: "e4", sourceId: "s1", quote: "" },
];

test("each clip is checked before anything is cut: consented and timed → footage; no consent or no recording → a text card; speakers anonymised", () => {
  const p = planReel(items, sources, { brand });
  assert.deepEqual(p.clips.map((c) => c.mode), ["footage", "card", "card", "skip"]);
  assert.match(p.clips[1]!.reason, /no recording consent/);
  assert.match(p.clips[2]!.reason, /recording is not available/);
  assert.deepEqual(p.clips.slice(0, 3).map((c) => c.speaker), ["Participant 1", "Participant 2", "Participant 3"], "names are not shown by default");
  assert.equal(p.clips[0]!.start, 12.15); assert.equal(p.clips[0]!.seconds, 3.2);
  assert.equal(planReel(items, sources, { brand, showSpeakers: true }).clips[0]!.speaker, "Asha");
  assert.ok(p.notes.some((n) => /text cards/.test(n)));
});

test("withoutConsent 'skip' leaves unconsented quotes out; the budget drops from the end and says so", () => {
  const skip = planReel(items, sources, { brand, withoutConsent: "skip" });
  assert.equal(skip.clips[1]!.mode, "skip");
  assert.equal(skip.clips[2]!.mode, "card", "consented but no recording is still a card, not a consent problem");
  const tight = planReel(items, sources, { brand, maxSeconds: 3 + 3.2 + cardSeconds(items[1]!.quote) });
  assert.deepEqual(tight.dropped, ["e3"]);
  assert.ok(tight.seconds <= 3 + 3.2 + cardSeconds(items[1]!.quote) + 0.01);
});

test("renders one MP4: title card, the consented clip with its caption, and the text card — at one size and length", { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "reeltest-"));
  try {
    const rec = join(dir, "s1.mp4");
    const mk = await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=20", "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", rec]);
    assert.equal(mk.code, 0, mk.stderr.slice(-300));
    const fonts = loadReportFonts(FONT_DIR);
    const plan = planReel(items.slice(0, 2), [{ ...sources[0]!, file: rec }, sources[1]!], { brand });
    const out = await renderReel(plan, fonts);
    assert.equal(out.segments, 3);
    assert.equal(out.footage, 1); assert.equal(out.cards, 1);
    const expected = 3 + 3.2 + cardSeconds(items[1]!.quote);
    assert.ok(Math.abs(out.seconds - expected) < 0.35, `${out.seconds} vs ${expected}`);
    const f = join(dir, "reel.mp4");
    (await import("node:fs")).writeFileSync(f, out.bytes);
    const info = await probe(f);
    assert.equal(info.video?.width, 1280); assert.equal(info.video?.height, 720);
    assert.equal(info.audio?.codec, "aac");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
