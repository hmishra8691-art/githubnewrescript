import { normalQuantile } from "./distributions.js";

/**
 * SAMPLE SIZE BEFORE FIELDWORK (ResLens roadmap 2.4, tracker 2.2).
 *
 * The four calculations a research plan needs, with the standard closed forms (normal approximation), each
 * returning the completes required and the working that produced them so a researcher can check it:
 *
 *   proportion   estimate a share to ± margin:           n = z² p(1−p) / E², then finite-population correction
 *   twoProportions detect p1 vs p2 (two groups):         n per group = (z_α √(2 p̄ q̄) + z_β √(p1q1 + p2q2))² / (p1 − p2)²
 *   twoMeans     detect a standardised difference d:      n per group = 2 (z_α + z_β)² / d² + z_α² / 4
 *   correlation  detect a correlation r:                  n = ((z_α + z_β) / atanh r)² + 3
 *
 * Every result is multiplied by the design effect (weighting, clustering) and rounded UP. Two-sided tests.
 * Checked against published reference values in sampleSize.test.ts.
 */
export interface SampleSizeResult { n: number; perGroup?: number; groups?: number; working: string }

const z2 = (alpha: number) => normalQuantile(1 - alpha / 2);
const zb = (power: number) => normalQuantile(power);
const up = (x: number) => Math.ceil(x - 1e-9);
function check(name: string, v: number, lo: number, hi: number) { if (!(v > lo && v < hi)) throw new Error(`${name} must be between ${lo} and ${hi}`); }

export function sampleSizeProportion(o: { margin: number; p?: number; confidence?: number; population?: number; designEffect?: number }): SampleSizeResult {
  const p = o.p ?? 0.5, conf = o.confidence ?? 0.95, deff = o.designEffect ?? 1;
  check("margin", o.margin, 0, 0.5); check("p", p, 0, 1); check("confidence", conf, 0.5, 1);
  const z = z2(1 - conf);
  const n0 = (z * z * p * (1 - p)) / (o.margin * o.margin);
  const n1 = o.population && o.population > 0 ? n0 / (1 + (n0 - 1) / o.population) : n0;
  const n = up(n1 * deff);
  return { n, working: `z = ${z.toFixed(3)} (${Math.round(conf * 100)} %), n₀ = z²·p(1−p)/E² = ${n0.toFixed(1)}${o.population ? `, finite population ${o.population}: ${n1.toFixed(1)}` : ""}${deff !== 1 ? `, × design effect ${deff}` : ""} → ${n}` };
}

export function sampleSizeTwoProportions(o: { p1: number; p2: number; alpha?: number; power?: number; designEffect?: number }): SampleSizeResult {
  const alpha = o.alpha ?? 0.05, power = o.power ?? 0.8, deff = o.designEffect ?? 1;
  check("p1", o.p1, 0, 1); check("p2", o.p2, 0, 1); if (o.p1 === o.p2) throw new Error("p1 and p2 must differ");
  const a = z2(alpha), b = zb(power), pbar = (o.p1 + o.p2) / 2;
  const n0 = (a * Math.sqrt(2 * pbar * (1 - pbar)) + b * Math.sqrt(o.p1 * (1 - o.p1) + o.p2 * (1 - o.p2))) ** 2 / (o.p1 - o.p2) ** 2;
  const per = up(n0 * deff);
  return { n: per * 2, perGroup: per, groups: 2, working: `z_α/2 = ${a.toFixed(3)}, z_β = ${b.toFixed(3)}, p̄ = ${pbar.toFixed(3)}: ${n0.toFixed(1)} per group${deff !== 1 ? ` × design effect ${deff}` : ""} → ${per} per group, ${per * 2} in all` };
}

export function sampleSizeTwoMeans(o: { d: number; alpha?: number; power?: number; designEffect?: number; groups?: number }): SampleSizeResult {
  const alpha = o.alpha ?? 0.05, power = o.power ?? 0.8, deff = o.designEffect ?? 1, groups = o.groups ?? 2;
  check("d (standardised difference)", Math.abs(o.d), 0, 5);
  const a = z2(alpha), b = zb(power);
  const n0 = (2 * (a + b) ** 2) / (o.d * o.d) + (a * a) / 4;
  const per = up(n0 * deff);
  return { n: per * groups, perGroup: per, groups, working: `d = ${o.d}: 2(z_α/2 + z_β)²/d² + z_α/2²/4 = ${n0.toFixed(1)} per group${deff !== 1 ? ` × design effect ${deff}` : ""} → ${per} per group${groups > 2 ? ` (each pair of ${groups} groups)` : ""}` };
}

export function sampleSizeCorrelation(o: { r: number; alpha?: number; power?: number; designEffect?: number }): SampleSizeResult {
  const alpha = o.alpha ?? 0.05, power = o.power ?? 0.8, deff = o.designEffect ?? 1;
  check("r", Math.abs(o.r), 0, 1);
  const a = z2(alpha), b = zb(power);
  const n0 = ((a + b) / Math.atanh(Math.abs(o.r))) ** 2 + 3;
  const n = up(n0 * deff);
  return { n, working: `atanh(r) = ${Math.atanh(Math.abs(o.r)).toFixed(4)}: ((z_α/2 + z_β)/atanh r)² + 3 = ${n0.toFixed(1)}${deff !== 1 ? ` × design effect ${deff}` : ""} → ${n}` };
}

/** completes → invitations / starts, given the incidence and completion rates the fieldwork expects */
export function startsNeeded(completes: number, incidence = 1, completionRate = 1): number {
  check("incidence", incidence, 0, 1.000001); check("completion rate", completionRate, 0, 1.000001);
  return up(completes / (incidence * completionRate));
}
