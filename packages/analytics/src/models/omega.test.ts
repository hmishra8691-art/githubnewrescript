import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fitSem } from "./sem.js";
import { mcdonaldOmega, omegaFromSem } from "./omega.js";
import { numericSurvey } from "./fixture.js";
import { runAnalysis } from "../analyses/index.js";
import { findingsFor } from "../findings.js";
import type { AnalysisDefinition } from "../types.js";

/**
 * McDonald's ω against two references:
 *  1. the PUBLISHED semTools `reliability()` output for the Holzinger–Swineford three-factor CFA
 *     (lavaan's HS.model; semTools documentation): alpha 0.6261171 / 0.8827069 / 0.6884550 and
 *     omega 0.6253180 / 0.8851754 / 0.6877612 for visual / textual / speed. Our α reproduces the
 *     published α exactly (so the data are the same), and ω from our CFA fit reproduces the published ω;
 *  2. a HAND computation: a one-factor model of three items is just-identified, so its ML solution is
 *     closed-form from the covariance matrix S (divisor N): λᵢ² = sᵢⱼ·sᵢₖ / sⱼₖ, θᵢ = sᵢᵢ − λᵢ²,
 *     ω = (Σλ)² / ((Σλ)² + Σθ).
 */
const FX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "stats-reference", "fixtures", "sem.json"), "utf8")) as { hs: { syntax: string; data: Record<string, number[]> } };
const HS = FX.hs.data;
const SEMTOOLS = { visual: { alpha: 0.6261171, omega: 0.625318 }, textual: { alpha: 0.8827069, omega: 0.8851754 }, speed: { alpha: 0.688455, omega: 0.6877612 } };
const ITEMS: Record<keyof typeof SEMTOOLS, string[]> = { visual: ["x1", "x2", "x3"], textual: ["x4", "x5", "x6"], speed: ["x7", "x8", "x9"] };

function handOmega(cols: number[][]): number {
  const n = cols[0].length, mean = cols.map((c) => c.reduce((t, v) => t + v, 0) / n);
  const s = (i: number, j: number) => cols[i].reduce((t, v, k) => t + (v - mean[i]) * (cols[j][k] - mean[j]), 0) / n;
  const l2 = [s(0, 1) * s(0, 2) / s(1, 2), s(0, 1) * s(1, 2) / s(0, 2), s(0, 2) * s(1, 2) / s(0, 1)];
  const sumL = l2.reduce((t, v) => t + Math.sqrt(v), 0);
  const theta = [0, 1, 2].reduce((t, i) => t + s(i, i) - l2[i], 0);
  return sumL ** 2 / (sumL ** 2 + theta);
}

test("ω from the Holzinger–Swineford three-factor CFA equals the published semTools reliability() values", () => {
  const r = fitSem({ syntax: FX.hs.syntax, data: HS });
  assert.equal(r.status, "done");
  const om = omegaFromSem(r.output!);
  assert.equal(om.length, 3);
  for (const f of ["visual", "textual", "speed"] as const) {
    const o = om.find((x) => x.factor === f)!;
    assert.ok(Math.abs(o.omega - SEMTOOLS[f].omega) < 2e-5, `${f}: ${o.omega} vs semTools ${SEMTOOLS[f].omega}`);
  }
});

test("ω of a one-factor model of three items equals the closed-form hand computation; α equals the published α", () => {
  const { ds } = numericSurvey(HS);
  for (const f of ["visual", "textual", "speed"] as const) {
    const run = mcdonaldOmega(HS, ITEMS[f]);
    assert.ok(run.result, run.reason);
    const hand = handOmega(ITEMS[f].map((v) => HS[v]));
    assert.ok(Math.abs(run.result!.omega - hand) < 1e-6, `${f}: ${run.result!.omega} vs hand ${hand}`);
    assert.equal(run.fit?.df, 0, "three items: just-identified");
    /* the reliability analysis with omega: α as published, ω beside it */
    const def: AnalysisDefinition = { name: `${f} scale`, kind: "reliability", dataset: ds.spec, variables: ITEMS[f], options: { omega: true } };
    const res = runAnalysis(def, ds);
    const alpha = res.tables.find((t) => t.id === "alpha")!.rows[0].value as number;
    assert.ok(Math.abs(alpha - Number(SEMTOOLS[f].alpha.toFixed(3))) < 1e-9, `${f} α ${alpha}`);
    const omega = res.tables.find((t) => t.id === "omega")!.rows[0].value as number;
    assert.equal(omega, Math.round(hand * 1000) / 1000);
    assert.ok(res.chart.kpis?.some((k) => k.label === "McDonald's ω"));
    assert.match(findingsFor(def, res)[0].headline, /McDonald's ω = /);
  }
});

test("ω needs three items; a negatively loading item is named; without omega the analysis is exactly as before", () => {
  const two = mcdonaldOmega(HS, ["x1", "x2"]);
  assert.equal(two.result, null);
  assert.match(two.reason ?? "", /at least three items/);
  const flipped = { ...HS, x5r: HS.x5.map((v) => 10 - v) };
  const neg = mcdonaldOmega(flipped, ["x4", "x5r", "x6", "x1"]);
  assert.ok(neg.result && neg.result.negative.includes("x5r") && neg.warnings.some((w) => /x5r load.* negatively/.test(w)), JSON.stringify(neg.warnings));
  const { ds } = numericSurvey(HS);
  const plain = runAnalysis({ name: "scale", kind: "reliability", dataset: ds.spec, variables: ["x4", "x5", "x6"] }, ds);
  assert.deepEqual(plain.tables.map((t) => t.id), ["alpha", "items"]);
  assert.deepEqual(plain.chart.kpis?.map((k) => k.label), ["Cronbach's α"]);
});
