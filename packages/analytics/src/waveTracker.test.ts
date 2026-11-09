import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWave, harmonize, trackWaves, suggestKpis, rake, measureKpi, trackerCsv, type WaveData } from "./waveTracker.js";

/* deterministic pseudo-random so the fixtures are stable */
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

/** a wave: `aware` depends on age (young 70 %, old 30 %) plus `lift`; the young share is `young` */
function wave(id: string, order: number, n: number, young: number, lift: number, seed: number, rename = false, satScale = 5): WaveData {
  const r = rng(seed);
  const rows = Array.from({ length: n }, () => {
    const y = r() < young;
    const aware = r() < (y ? 0.7 : 0.3) + lift ? 1 : 0;
    return { [rename ? `AWARE_W${order}` : "AWARE"]: aware, AGE: y ? 1 : 2, SAT: 1 + Math.floor(r() * satScale), NPS: Math.floor(r() * 11) };
  });
  return {
    id, label: `Wave ${order}`, order, rows,
    columns: [
      { name: rename ? `AWARE_W${order}` : "AWARE", label: "Are you aware of Brand A?" },
      { name: "AGE", label: "Age group", values: [{ code: "1", label: "18-34" }, { code: "2", label: "35+" }] },
      { name: "SAT", label: "How satisfied are you with Brand A?" },
      { name: "NPS", label: "How likely are you to recommend Brand A?" },
    ],
  };
}

test("mapping: same names, renamed with a wave suffix, scale change, recoded codes, added and removed", () => {
  const b = wave("w1", 1, 50, 0.5, 0, 1);
  const w = wave("w2", 2, 50, 0.5, 0, 2, true, 7);
  w.columns.push({ name: "NEWQ", label: "Something new" });
  w.columns.find((c) => c.name === "AGE")!.values = [{ code: "2", label: "18-34" }, { code: "1", label: "35+" }];
  const m = mapWave(b, w);
  const aware = m.matches.find((x) => x.base === "AWARE")!;
  assert.equal(aware.other, "AWARE_W2");
  assert.equal(aware.how, "renamed");
  const age = m.matches.find((x) => x.base === "AGE")!;
  assert.deepEqual(age.recode, { "2": "1", "1": "2" });
  const sat = m.matches.find((x) => x.base === "SAT")!;
  assert.ok(sat.changes.some((c) => /scale changed: 1–5 → 1–7/.test(c)), sat.changes.join());
  assert.equal(sat.comparable, false);
  assert.deepEqual(m.added, ["NEWQ"]);
  assert.deepEqual(m.removed, []);
});

test("mapping: by wording when the name is unrelated; manual override and not-asked", () => {
  const b = wave("w1", 1, 20, 0.5, 0, 1);
  const w = wave("w2", 2, 20, 0.5, 0, 2);
  w.columns[0] = { name: "Q7", label: "Are you aware of Brand A?" };
  for (const r of w.rows) { r.Q7 = r.AWARE; delete r.AWARE; }
  const m = mapWave(b, w);
  assert.equal(m.matches.find((x) => x.base === "AWARE")!.how, "by_wording");
  const forced = mapWave(b, w, { NPS: null });
  assert.equal(forced.matches.find((x) => x.base === "NPS")!.other, null);
  assert.ok(forced.removed.includes("NPS"));
  assert.ok(forced.added.includes("NPS"));
});

test("harmonize: one dataset with the baseline's names and codes", () => {
  const b = wave("w1", 1, 10, 0.5, 0, 1);
  const w = wave("w2", 2, 10, 0.5, 0, 2, true);
  w.columns.find((c) => c.name === "AGE")!.values = [{ code: "2", label: "18-34" }, { code: "1", label: "35+" }];
  const h = harmonize([w, b], { w2: mapWave(b, w) });
  assert.equal(h.rows.length, 20);
  assert.equal(h.rows[0].WAVE, "Wave 1");
  const w2first = h.rows[10];
  assert.equal(w2first.AWARE, w.rows[0].AWARE_W2);
  assert.equal(w2first.AGE, w.rows[0].AGE === 1 ? "2" : "1");
});

test("a genuine change survives the composition adjustment", () => {
  const ws = [wave("w1", 1, 800, 0.5, 0, 11), wave("w2", 2, 800, 0.5, 0.15, 12)];
  const maps = { w2: mapWave(ws[0], ws[1]) };
  const r = trackWaves(ws, maps, { kpis: [{ id: "a", label: "Awareness", variable: "AWARE", measure: "share", codes: ["1"] }], composition: ["AGE"] });
  const c = r.kpis[0].waveOnWave[0];
  assert.equal(c.verdict, "genuine_change", c.why);
  assert.ok((c.diff ?? 0) > 10);
});

test("a change caused by a younger sample is reported as composition", () => {
  const ws = [wave("w1", 1, 800, 0.3, 0, 21), wave("w2", 2, 800, 0.7, 0, 22)];
  const r = trackWaves(ws, { w2: mapWave(ws[0], ws[1]) }, { kpis: [{ id: "a", label: "Awareness", variable: "AWARE", measure: "share", codes: ["1"] }], composition: ["AGE"] });
  const c = r.kpis[0].waveOnWave[0];
  assert.equal(c.verdict, "composition", c.why);
  assert.ok(Math.abs(c.adjustedDiff ?? 99) < 5, String(c.adjustedDiff));
  assert.ok(r.composition.find((x) => x.variable === "AGE")!.shifted);
  /* without composition variables it would have been called genuine */
  const naive = trackWaves(ws, { w2: mapWave(ws[0], ws[1]) }, { kpis: [{ id: "a", label: "Awareness", variable: "AWARE", measure: "share" }] });
  assert.equal(naive.kpis[0].waveOnWave[0].verdict, "genuine_change");
});

test("a KPI whose scale changed is not comparable; no change within sampling error", () => {
  const ws = [wave("w1", 1, 300, 0.5, 0, 31), wave("w2", 2, 300, 0.5, 0, 32, false, 7)];
  const r = trackWaves(ws, { w2: mapWave(ws[0], ws[1]) }, { kpis: [{ id: "s", label: "Sat", variable: "SAT", measure: "top_box", top: 2 }, { id: "n", label: "NPS", variable: "NPS", measure: "nps" }] });
  assert.equal(r.kpis[0].waveOnWave[0].verdict, "not_comparable");
  assert.ok(r.kpis[0].changes[0].includes("scale changed"));
  assert.equal(r.kpis[1].waveOnWave[0].verdict, "no_change", r.kpis[1].waveOnWave[0].why);
  assert.equal(r.kpis[1].waveOnWave[0].test, "NPS difference (z)");
});

test("trend across waves, vs-baseline, segments, CSV, recommendations", () => {
  const ws = [0, 0.05, 0.1, 0.15].map((l, i) => wave(`w${i + 1}`, i + 1, 400, 0.5, l, 40 + i));
  const maps = Object.fromEntries(ws.slice(1).map((w) => [w.id, mapWave(ws[0], w)]));
  const r = trackWaves(ws, maps, { kpis: [{ id: "a", label: "Awareness", variable: "AWARE", measure: "share" }, { id: "m", label: "Mean sat", variable: "SAT", measure: "mean" }], segment: "AGE" });
  const t = r.kpis[0];
  assert.equal(t.trend?.direction, "rising");
  assert.ok((t.trend?.p ?? 1) < 0.001);
  assert.equal(t.vsBaseline.length, 3);
  assert.equal(t.vsBaseline[2].verdict, "genuine_change");
  assert.equal(r.kpis[1].waveOnWave[0].test, "Welch's t");
  assert.equal(r.segments.filter((s) => s.kpi === "a").length, 2);
  const csv = trackerCsv(r);
  assert.equal(csv.split("\n").length, 1 + 2 * 4);
  assert.ok(csv.startsWith("KPI,Measure,Wave"));
  assert.ok(r.recommendations.some((x) => /Cochran/.test(x)));
});

test("raking reproduces the target composition; weighted measure; KPI suggestions", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ AGE: i < 80 ? 1 : 2, AWARE: i < 80 ? 1 : 0 }));
  const w = rake(rows, { AGE: { "1": 0.5, "2": 0.5 } });
  const young = w.slice(0, 80).reduce((a, b) => a + b, 0) / w.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(young - 0.5) < 0.01, String(young));
  const m = measureKpi({ id: "a", label: "a", variable: "AWARE", measure: "share" }, rows, w);
  assert.ok(Math.abs((m.value ?? 0) - 50) < 1);
  const s = suggestKpis(wave("w1", 1, 50, 0.5, 0, 1));
  assert.deepEqual(s.map((k) => k.measure).sort(), ["nps", "share", "top_box"]);
});

test("reading a file: a Qualtrics-style label row and 'Q1 - wording' headers", async () => {
  const { waveFromTable } = await import("./waveTracker.js");
  const rows = [
    { Q1: "Are you aware of Brand A?", Q2: "How old are you?", "Q3 - How satisfied are you?": "How satisfied are you?" },
    { Q1: '{"ImportId":"QID1"}', Q2: '{"ImportId":"QID2"}', "Q3 - How satisfied are you?": '{"ImportId":"QID3"}' },
    ...Array.from({ length: 12 }, (_, i) => ({ Q1: String(i % 2), Q2: String(20 + i), "Q3 - How satisfied are you?": String(1 + (i % 5)) })),
  ];
  const { wave, notes } = waveFromTable({ id: "w", label: "W", order: 1 }, ["Q1", "Q2", "Q3 - How satisfied are you?"], rows, [{ name: "Q1", label: "x", values: [{ code: "1", label: "Yes" }, { code: "0", label: "No" }] }]);
  assert.equal(wave.rows.length, 12);
  assert.deepEqual(wave.columns.map((c) => c.name), ["Q1", "Q2", "Q3"]);
  assert.equal(wave.columns[0].label, "Are you aware of Brand A?");
  assert.equal(wave.columns[0].values?.length, 2);
  assert.equal(wave.columns[2].label, "How satisfied are you?");
  assert.equal(wave.rows[0].Q3, "1");
  assert.ok(notes.length >= 1);
});

test("a real change hidden by a sample difference is found once the samples are matched", () => {
  /* wave 2 is younger (inflates awareness); wave 3 has the baseline's age mix and a real +15 lift: equal as fielded */
  const ws = [wave("w1", 1, 600, 0.3, 0, 1), wave("w2", 2, 600, 0.7, 0, 2), wave("w3", 3, 600, 0.3, 0.15, 3)];
  const maps = { w2: mapWave(ws[0], ws[1]), w3: mapWave(ws[0], ws[2]) };
  const k = [{ id: "a", label: "Awareness", variable: "AWARE", measure: "share" as const }];
  const raw = trackWaves(ws, maps, { kpis: k }).kpis[0].waveOnWave[1];
  assert.equal(raw.verdict, "no_change", raw.why);
  const adj = trackWaves(ws, maps, { kpis: k, composition: ["AGE"] }).kpis[0].waveOnWave[1];
  assert.equal(adj.verdict, "genuine_change", adj.why);
  assert.match(adj.why, /hidden as fielded/);
  assert.ok((adj.adjustedDiff ?? 0) > 10);
});
