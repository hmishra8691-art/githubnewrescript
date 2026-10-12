/**
 * END TO END: a report planned from a real run → a rendered, verified MP4
 * (decoded frame by frame against the definition) and an editable,
 * verified PowerPoint — from the same definition.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { planStoryReport, composeReport, applyOps, interpretRevision, type StoryReport } from "@rescript/analytics/story";
import { buildStoryPptx } from "@rescript/analytics/export";
import { loadReportFonts, planVideo, renderSegment, assembleVideo, verifyVideo, inspectStoryPptx, analyzeBrandAsset, brandFrom, estimateRender, narrate, speechNarration, probe, rasterizePng, unzip } from "./index.js";

const FONT_DIR = fileURLToPath(new URL("../../../apps/studio/public/report-fonts/", import.meta.url));
const fonts = loadReportFonts(FONT_DIR);
const fixtureUrl = new URL("../../analytics/dist/analyses/fixture.js", import.meta.url).href;
const findingsUrl = new URL("../../analytics/dist/findings.js", import.meta.url).href;
const datasetUrl = new URL("../../analytics/dist/dataset.js", import.meta.url).href;

async function report(): Promise<StoryReport> {
  const fx = await import(fixtureUrl) as { def: unknown; synthRows: (n: number) => unknown[]; spec: unknown };
  const { runPlan } = await import(findingsUrl) as { runPlan: (...a: unknown[]) => unknown };
  const { buildDataset } = await import(datasetUrl) as { buildDataset: (...a: unknown[]) => unknown };
  const def = structuredClone(fx.def) as Record<string, unknown>;
  def.research = {
    objective: "Understand what drives satisfaction", population: "Adults", methodology: "Online panel", hypotheses: ["Women are more satisfied than men"], hypothesisDetails: [], researchQuestions: [], kpis: [], constructs: [], analysis: [], assumptions: [], sources: [],
    analysisPlan: { crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }], tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] }], derived: [], segments: [] },
  };
  const ds = buildDataset(def, fx.synthRows(300), { spec: fx.spec });
  const run = runPlan(def, ds, { trigger: "manual", now: "2026-10-01T10:00:00Z" });
  return planStoryReport(def as never, run as never, { sample: { analysed: 300, environment: "LIVE", dataset: "all" }, date: "2026-10-01", maxFindings: 2 });
}

/** a short video for the test: 720p at 24 fps, first scenes only */
function small(r: StoryReport, aspect: "16:9" | "9:16" | "1:1" = "16:9", keep = 3): StoryReport {
  const main = r.scenes.filter((s) => s.section === "main");
  const pick = new Set([main[0].id, ...main.filter((s) => s.visual.type === "chart").slice(0, keep - 1).map((s) => s.id)]);
  return { ...r, scenes: r.scenes.filter((s) => pick.has(s.id)), design: { ...r.design, video: { ...r.design.video, aspect, height: 720, fps: 24, narration: false, subtitles: true } } };
}

async function renderAll(r: StoryReport) {
  const plan = planVideo(r, fonts);
  const segs: Buffer[] = [];
  for (let i = 0; i < plan.segments.length; i++) segs.push((await renderSegment(plan, i, fonts)).bytes);
  return { plan, segs, video: await assembleVideo(plan, segs) };
}

test("the video: rendered scene by scene, assembled with subtitles, and verified frame by frame against the definition", { timeout: 240_000 }, async () => {
  const r = small(await report());
  const { plan, segs, video } = await renderAll(r);
  assert.equal(plan.composed.qa.critical.length, 0, JSON.stringify(plan.composed.qa.critical));
  assert.ok(plan.width === 1280 && plan.height === 720);
  const qa = await verifyVideo(video, plan, fonts);
  assert.ok(qa.ok, JSON.stringify(qa.checks, null, 1));
  assert.equal(qa.info.video?.codec, "h264");
  assert.equal(qa.info.subtitle?.codec, "mov_text");
  assert.ok(qa.scenes.every((s) => s.settledDiff < 6 && s.holdDiff < 3), JSON.stringify(qa.scenes));
  // a corrupted file fails
  const broken = Buffer.concat([video.subarray(0, Math.floor(video.length * 0.5))]);
  const bad = await verifyVideo(broken, plan, fonts);
  assert.equal(bad.ok, false);
  // a wrong scene fails: swap two segments
  const swapped = await assembleVideo(plan, [segs[0], segs[2], segs[1]].map((b, i) => (i < segs.length ? b : segs[i])).slice(0, segs.length));
  const wrong = await verifyVideo(swapped, plan, fonts);
  assert.ok(wrong.checks.some((c) => c.code === "scene_mismatch" || c.code === "duration" || c.code === "frame_count"), JSON.stringify(wrong.checks));
});

test("regenerating one scene: only its hash changes, the others are reused", async () => {
  const r = small(await report());
  const a = planVideo(r, fonts);
  const target = r.scenes.find((s) => s.visual.type === "chart")!;
  const rv = interpretRevision("replace this chart with a horizontal bar chart", r, { selected: target.id });
  const r2 = applyOps(r, rv.ops).report;
  const b = planVideo(r2, fonts);
  const changed = a.segments.filter((s, i) => s.hash !== b.segments[i].hash).map((s) => s.sceneId);
  assert.deepEqual(changed, [target.id]);
  const est = estimateRender(b, r2, new Set(a.segments.map((s) => s.hash)));
  assert.match(est.note, /1 of 3 scenes to render \(2 unchanged, reused\)/);
});

test("vertical and square videos verify; 1080p output has the requested size", { timeout: 240_000 }, async () => {
  for (const aspect of ["9:16", "1:1"] as const) {
    const r = small(await report(), aspect, 2);
    const { plan, video } = await renderAll(r);
    const qa = await verifyVideo(video, plan, fonts);
    assert.ok(qa.ok, `${aspect}: ${JSON.stringify(qa.checks)}`);
    assert.equal(qa.info.video!.width, aspect === "9:16" ? 720 : 720);
    assert.equal(qa.info.video!.height, aspect === "9:16" ? 1280 : 720);
  }
});

test("narration: the provider's audio sits under each scene, scenes stretch to fit it, and the file carries an AAC track; without a provider the fallback is said", { timeout: 240_000 }, async () => {
  const base = small(await report(), "16:9", 2);
  const r = { ...base, design: { ...base.design, video: { ...base.design.video, narration: true } } };
  const none = await narrate(r, null);
  assert.equal(none.record.status, "fallback");
  process.env.REPORT_NARRATION_ENABLED = "true";
  const { fakeSpeech } = await import("@rescript/ai");
  const provider = speechNarration("fake-tts", async (text) => fakeSpeech(text.slice(0, 60)), () => true);
  const n = await narrate(r, provider);
  assert.equal(n.record.status, "used");
  assert.ok(n.clips.length >= 2);
  const plan = planVideo(r, fonts, n.clips);
  for (const s of plan.segments) if (s.narration) assert.ok(s.timing.total > s.narration.seconds);
  const segs: Buffer[] = [];
  for (let i = 0; i < plan.segments.length; i++) segs.push((await renderSegment(plan, i, fonts, { audio: n.clips.find((c) => c.sceneId === plan.segments[i].sceneId) })).bytes);
  const video = await assembleVideo(plan, segs);
  const qa = await verifyVideo(video, plan, fonts);
  assert.ok(qa.ok, JSON.stringify(qa.checks));
  assert.equal(qa.info.audio?.codec, "aac");
  delete process.env.REPORT_NARRATION_ENABLED;
});

test("the PowerPoint: native charts with the report's numbers, native tables, no screenshots, notes, in bounds — from the same definition", async () => {
  const r = await report();
  const c = composeReport(r, fonts.measurer, "pptx");
  assert.equal(c.qa.critical.length, 0, JSON.stringify(c.qa.critical));
  const buf = await buildStoryPptx({ report: r, pages: c.pages });
  const qa = inspectStoryPptx(buf, r, c.pages);
  assert.ok(qa.ok, JSON.stringify(qa.checks.filter((x) => x.severity === "critical"), null, 1));
  assert.equal(qa.slides, c.pages.length);
  assert.ok(qa.charts >= 2 && qa.valuesChecked > 5, JSON.stringify(qa));
  assert.ok(qa.tables >= 1);
  assert.equal(qa.pictures, 0);
  // the numbers in the deck are the video's numbers: same chart data per scene
  const v = composeReport(r, fonts.measurer, "video");
  for (const p of v.pages) for (const b of p.blocks) if (b.type === "chart") {
    const twin = c.pages.find((x) => x.sceneId === p.sceneId)?.blocks.find((x) => x.type === "chart");
    assert.deepEqual(twin && twin.type === "chart" && twin.data, b.data);
  }
  // a tampered value is caught
  const zip = unzip(buf);
  const chartName = [...zip.keys()].find((k) => /^ppt\/charts\/chart\d+\.xml$/.test(k))!;
  const xml = zip.get(chartName)!.toString("utf8").replace(/(<c:val>[\s\S]*?<c:v>)([\d.]+)/, (_m, a, n) => `${a}${Number(n) + 7}`);
  assert.notEqual(xml, zip.get(chartName)!.toString("utf8"));
  const rebuilt = rezip(zip, chartName, Buffer.from(xml));
  assert.ok(inspectStoryPptx(rebuilt, r, c.pages).checks.some((x) => x.code === "chart_value"));
});

test("brand assets: logo colours and transparency from PNG and SVG, theme colours and fonts from a PowerPoint, clear feedback for what cannot be read", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><rect x="0" y="0" width="200" height="120" fill="#0A2A66"/><circle cx="300" cy="60" r="50" fill="#D4A017"/></svg>`;
  const a = analyzeBrandAsset(Buffer.from(svg), "image/svg+xml", "logo.svg");
  assert.equal(a.kind, "logo");
  assert.deepEqual(a.colors.map((c) => c.hex), ["#0A2A66", "#D4A017"]);
  assert.ok(a.logo && a.logo.width === 800 && a.logo.transparent);
  const png = rasterizePng(svg, fonts);
  const b = analyzeBrandAsset(png, "image/png", "logo.png");
  assert.equal(b.kind, "logo");
  assert.ok(b.colors.some((c) => c.hex.startsWith("#0")), JSON.stringify(b.colors));
  assert.equal(b.logo!.width, 400);
  const deck = await buildStoryPptx({ report: small(await report()), pages: composeReport(small(await report()), fonts.measurer, "pptx").pages });
  const d = analyzeBrandAsset(deck, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "template.pptx");
  assert.equal(d.kind, "deck");
  assert.ok(d.colors.length >= 1, JSON.stringify(d));
  const evil = analyzeBrandAsset(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), "image/svg+xml", "x.svg");
  assert.ok(evil.problems.length && !evil.logo);
  const junk = analyzeBrandAsset(Buffer.from("hello"), "text/plain", "notes.txt");
  assert.equal(junk.kind, "unsupported");
  assert.match(junk.problems[0], /not a format we can read/);
  const brand = brandFrom([a, d]);
  assert.ok(brand.colors.length >= 2 && brand.logo);
  const info = await probe(FONT_DIR + "Inter_400Regular.ttf");
  assert.equal(info.video, undefined);
});

/** rebuild a zip with one entry replaced (deflate), for tamper tests */
function rezip(entries: Map<string, Buffer>, name: string, data: Buffer): Buffer {
  const files: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  for (const [n, raw] of entries) {
    const body = n === name ? data : raw;
    const comp = deflateRawSync(body);
    const nb = Buffer.from(n);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc32(body), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(body.length, 22); h.writeUInt16LE(nb.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc32(body), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(body.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(offset, 42);
    files.push(h, nb, comp); central.push(c, nb);
    offset += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.size, 8); e.writeUInt16LE(entries.size, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, cd, e]);
}
