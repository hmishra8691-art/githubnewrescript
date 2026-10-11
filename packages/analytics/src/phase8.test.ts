import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import type { SurveyDefinition } from "@rescript/schema";
import { def as base, synthRows, spec } from "./analyses/fixture.js";
import { buildDataset, type AnalyticsRow } from "./dataset.js";
import { briefText, compactRun, runPlan, type AnalysisRun } from "./findings.js";
import { compareRuns, describeSince, findingKey, kpiSnapshot, waveNumbers } from "./waves.js";
import { deckFromRun, waveSlide } from "./deck.js";
import { gateNarrative } from "./narrative.js";
import { buildDeckPptx } from "./export/deck.js";
import { buildFindingsDocx, buildProposalDocx } from "./export/docx.js";

/**
 * RESEARCH ENGINE PHASE 8 — waves across runs and the project brief: every
 * KPI measured on each run, the comparison with the previous comparable run
 * (KPIs with deltas and significance, findings matched by what they test,
 * verdicts), told the same way in the brief, the deck, the report; the brief
 * on the proposal, the report and the deck.
 */
/** one entry of a zip, by its central directory (sizes are there even when the local header defers them) */
function zipText(buf: Buffer, entry: string): string {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return "";
  let p = buf.readUInt32LE(eocd + 16);
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const method = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== entry) continue;
    const ln = buf.readUInt16LE(local + 26), le = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + ln + le, local + 30 + ln + le + comp);
    const xml = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    return xml.replace(/<[^>]+>/g, " ").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  }
  return "";
}
const pptxTexts = (buf: Buffer): string[] => { const out: string[] = []; for (let i = 1; i < 40; i++) { const t = zipText(buf, `ppt/slides/slide${i}.xml`); if (!t) break; out.push(t); } return out; };

function tracker(): SurveyDefinition {
  const def = structuredClone(base);
  def.research = {
    objective: "Track satisfaction and recommendation", population: "Adults 18+", methodology: "Online panel",
    hypotheses: ["Women are more satisfied than men", "Satisfaction differs by region"], hypothesisDetails: [], researchQuestions: [],
    kpis: [
      { name: "Satisfaction", variable: "SAT", measure: "top-2-box share", target: "60%", direction: "higher" },
      { name: "NPS", variable: "NPS", measure: "NPS" },
      { name: "Age", variable: "AGE", measure: "mean" },
      { name: "Alpha awareness", variable: "AWARE", measure: "share Alpha" },
      { name: "Effort", variable: "SAT", measure: "mean", direction: "lower" },
      { name: "Nowhere", variable: "NOPE" },
      { name: "No variable" },
    ],
    constructs: [{ name: "Satisfaction", role: "dependent", questionIds: ["q_sat"] }], analysis: [], assumptions: [], sources: [],
    brief: { client: "Acme Foods", businessQuestion: "Should we keep investing in service?", decision: "whether to fund the 2027 service programme", background: "Satisfaction fell in 2025", stakeholders: ["the CMO"], deadline: "30 November 2026", deliverables: ["a findings report"] },
    analysisPlan: {
      crosstabs: [{ id: "x1", rows: ["SAT"], columns: ["GENDER"], priority: 1, hypotheses: ["H1"] }],
      tests: [{ id: "t1", method: "t_test", outcome: "SAT", variables: ["SAT"], groupBy: "GENDER", priority: 1, hypotheses: ["H1"] }, { id: "t2", method: "anova", outcome: "SAT", variables: ["SAT"], groupBy: "REGION", priority: 1, hypotheses: ["H2"] }],
      derived: [], segments: [],
    },
  } as never;
  return def;
}
/** the next wave: more satisfied (+1 on the scale), the gender gap closed, and the region effect planted */
function nextWave(rows: AnalyticsRow[]): AnalyticsRow[] {
  return rows.map((r) => { const a = r.answers as Record<string, unknown>; const sat = Math.min(5, Number(a.q_sat) + (a.q_gender === 1 ? 1 : 0) + (a.q_region === 1 ? 1 : 0)); return { ...r, answers: { ...a, q_sat: sat, q_nps: Math.min(10, Number(a.q_nps) + 1) } }; });
}

test("every KPI of the design is measured on the run — top-2-box, NPS, mean, a share of an option — and what cannot be says why", () => {
  const def = tracker();
  const ds = buildDataset(def, synthRows(400), { spec });
  const k = kpiSnapshot(def, ds);
  assert.deepEqual(k.map((x) => [x.name, x.measure]), [["Satisfaction", "top-2-box share"], ["NPS", "NPS"], ["Age", "mean"], ["Alpha awareness", "share Alpha"], ["Effort", "mean"], ["Nowhere", "not in this run's data"], ["No variable", "no variable"]]);
  assert.ok(k[0].value! > 20 && k[0].value! < 90 && k[0].n === 400, JSON.stringify(k[0]));
  assert.ok(k[1].value! > -100 && k[1].value! < 100);
  assert.ok(k[2].value! > 40 && k[2].value! < 55 && k[2].sd! > 10, JSON.stringify(k[2]));
  assert.ok(k[3].value! > 0 && k[3].value! <= 100);
  assert.equal(k[5].value, null); assert.equal(k[6].value, null);
  assert.equal(k[0].target, "60%"); assert.equal(k[4].direction, "lower");
  // the run carries them, and the brief prints them
  const run = runPlan(def, ds, { trigger: "first_results", now: "2026-10-01T10:00:00Z" });
  assert.equal(run.kpis?.length, 7);
  assert.match(briefText(run), /KPIs: Satisfaction \d+(\.\d)?% \(top-2-box share, n=400\), target 60%; NPS -?\d+/);
  // a design with no KPIs has none
  const plain = structuredClone(def); plain.research!.kpis = [];
  assert.equal(runPlan(plain, ds, { trigger: "manual" }).kpis, undefined);
});

test("the comparison with the previous run: KPI deltas with their significance and direction, findings matched by what they test, verdicts; told in the brief, the deck, the report", async () => {
  const def = tracker();
  const first = runPlan(def, buildDataset(def, synthRows(400, 11), { spec }), { trigger: "first_results", now: "2026-09-01T10:00:00Z" });
  const second = runPlan(def, buildDataset(def, nextWave(synthRows(400, 11)), { spec }), { trigger: "halfway", now: "2026-10-01T10:00:00Z" });
  const since = compareRuns({ ...second, id: "r2" }, { ...first, id: "r1" });
  assert.deepEqual(since.previous, { id: "r1", computedAt: "2026-09-01T10:00:00Z", n: 400, trigger: "first_results" });
  const sat = since.kpis.find((k) => k.name === "Satisfaction")!;
  assert.ok(sat.delta! > 10, `satisfaction rose: ${JSON.stringify(sat)}`);
  assert.equal(sat.significant, true); assert.ok(sat.p! < 0.001);
  assert.equal(sat.verdict, "better");
  const effort = since.kpis.find((k) => k.name === "Effort")!;
  assert.equal(effort.verdict, "worse", "a lower-is-better KPI that rose is worse");
  assert.equal(effort.significant, true, "a mean's move is tested with Welch's t from the two summaries");
  const age = since.kpis.find((k) => k.name === "Age")!;
  assert.equal(age.verdict, "flat"); assert.equal(age.delta, 0);
  assert.equal(since.kpis.find((k) => k.name === "Nowhere")!.verdict, "unknown");
  // findings: the gender difference weakened or vanished, the region difference is new or stronger
  const gender = since.findings.find((f) => /GENDER/.test(f.key) && f.change !== "same");
  assert.ok(gender && (gender.change === "weaker" || gender.change === "reversed"), JSON.stringify(since.findings.map((f) => [f.key, f.change])));
  const region = since.findings.find((f) => /REGION/.test(f.key));
  assert.ok(region && (region.change === "stronger" || region.change === "new"), JSON.stringify(region));
  assert.ok(since.verdicts.some((v) => v.label === "H2" && v.to === "supported"), JSON.stringify(since.verdicts));
  assert.match(since.summary, /^Since the previous run \(2026-09-01, 400 completes → 400\) · \d of 7 KPIs moved \(\d significantly\): /);
  assert.match(since.summary, /verdicts? changed: H\d/);
  // the key is stable across dataset specs — the hash is not
  const f = second.findings[0];
  assert.equal(findingKey(f), findingKey({ ...f, id: "other-hash", analysis: { ...f.analysis, hash: "x" } }));
  // nothing moved: a run compared with itself
  const still = compareRuns(second, first === second ? second : second);
  assert.ok(still.kpis.every((k) => k.verdict === "flat" || k.verdict === "unknown"));
  assert.ok(still.findings.every((x) => x.change === "same"));
  assert.match(still.summary, /KPIs unchanged · the planned findings stand/);
  // the brief, the gate, the deck, the report
  const withSince: AnalysisRun = { ...second, since };
  const brief = briefText(withSince);
  assert.match(brief, /Since the previous run/);
  assert.match(brief, /KPI Satisfaction \(top-2-box share\): [\d.]+ → [\d.]+ \(\+[\d.]+\), significant — better/);
  const nums = waveNumbers(since);
  assert.ok(nums.includes(400) && nums.includes(sat.delta!));
  const gated = gateNarrative(withSince, { summary: [`Satisfaction rose by ${sat.delta} points since the last wave.`, "Satisfaction rose by 97 points since the last wave."] });
  assert.equal(gated.accepted.summary?.length, 1, JSON.stringify(gated));
  assert.equal(gated.rejected[0]?.reason, "the number 97 is not in the run");
  assert.deepEqual(describeSince(since).slice(0, 1), [since.summary]);
  const slide = waveSlide(withSince)!;
  assert.equal(slide.type, "wave_change");
  assert.equal(slide.kpis.length, 7);
  assert.match(slide.kpis[0].delta, /^\+[\d.]+ pts$/);
  assert.ok(slide.changes.length >= 1 && slide.verdicts.length >= 1);
  assert.equal(waveSlide(second), null, "no previous run, no slide");
  const deck = deckFromRun(def, compactRun(withSince), {});
  assert.equal(deck.slides[2].type, "wave_change", "right after the summary");
  assert.equal(deck.slides[0].type === "title" && deck.slides[0].client, "Acme Foods", "the brief's client on the title");
  const summary = deck.slides[1] as Extract<typeof deck.slides[number], { type: "summary" }>;
  assert.match(summary.bullets[0], /^Business question: Should we keep investing in service\?/);
  assert.match(summary.bullets[1], /^Decision this informs: whether to fund/);
  const pptx = await buildDeckPptx({ deck, results: {} });
  const texts = pptxTexts(pptx);
  assert.ok(texts[2].includes("Since the last wave") && texts[2].includes("Satisfaction (top-2-box share)") && texts[2].includes("Last wave"), texts[2].slice(0, 300));
  assert.ok(texts[0].includes("for Acme Foods"));
  const docx = zipText(await buildFindingsDocx(def, compactRun(withSince), {}), "word/document.xml");
  assert.ok(docx.includes("Since the last wave") && docx.includes("Prepared for Acme Foods") && docx.includes("Last wave") && /Satisfaction \(top-2-box share\)/.test(docx), docx.slice(0, 500));
  const plainDocx = zipText(await buildFindingsDocx(def, compactRun(second), {}), "word/document.xml");
  assert.ok(!plainDocx.includes("Since the last wave"));
  // the proposal carries the brief
  const proposal = zipText(await buildProposalDocx(def, {}), "word/document.xml");
  for (const s of ["Prepared for Acme Foods", "Findings due 30 November 2026", "BUSINESS QUESTION", "Should we keep investing in service?", "DECISION THIS RESEARCH INFORMS", "whether to fund the 2027 service programme", "Satisfaction fell in 2025", "the CMO", "a findings report"]) assert.ok(proposal.includes(s), s);
});
