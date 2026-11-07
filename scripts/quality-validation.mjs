#!/usr/bin/env node
/**
 * QUALITY ENGINE VALIDATION REPORT (ResLens roadmap Phase 1).
 *
 *   node scripts/quality-validation.mjs                    the SYNTHETIC labelled benchmark (labels true by construction)
 *   node scripts/quality-validation.mjs labelled.json      a person-labelled sample: { "definition": <survey>,
 *                                                          "responses": [{ "response": <ResponseRecord>, "label": "genuine"|…,
 *                                                          "persona": "…", "segments": { "device": "mobile" } }] }
 *   QV_JSON=out.json …                                      also writes the full report
 *
 * Prints precision, recall and false-positive rates (overall, per label, per segment), the genuine respondents the
 * engine sent to review with its reasons, and whether automatic exclusion may be switched on (the gate). Exits 0;
 * the gate's verdict is information, not a test failure.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import { syntheticLabelledCorpus, evaluateQuality, exclusionGate } from "../packages/quality/dist/index.js";

const file = process.argv[2];
let def, responses;
if (file) {
  const j = JSON.parse(readFileSync(file, "utf8"));
  def = SurveyDefinition.parse(j.definition);
  responses = j.responses.map((r) => ({ ...r, persona: r.persona ?? r.label, segments: r.segments ?? {}, source: "manual" }));
} else ({ def, responses } = syntheticLabelledCorpus());

const t0 = Date.now();
const r = evaluateQuality(def, responses);
const ms = Date.now() - t0;
const pct = (x) => `${(x.rate * 100).toFixed(1)} % (${x.hits}/${x.n})`;
console.log(`\nQuality engine validation — ${r.responses} labelled responses, source: ${r.source}${r.source === "synthetic" ? " (labels true by construction — a regression benchmark, not real-world accuracy)" : ""} — ${ms} ms\n`);
console.log("Persona".padEnd(50), "Label".padEnd(12), "PASS  REVIEW  FLAGGED");
for (const [k, v] of Object.entries(r.byPersona)) console.log(k.padEnd(50), v.label.padEnd(12), String(v.PASS).padStart(4), String(v.REVIEW).padStart(7), String(v.FLAGGED).padStart(8));
console.log(`\nFLAGGED (exclusion candidates): precision ${pct(r.flagged.precision)} · recall ${pct(r.flagged.recall)} · genuine flagged ${pct(r.flagged.genuineFalsePositive)}`);
console.log(`Not PASS (review queue):        precision ${pct(r.detected.precision)} · recall ${pct(r.detected.recall)} · genuine sent to review ${pct(r.detected.genuineFalsePositive)}`);
console.log("\nRecall by label:", Object.entries(r.recallByLabel).map(([k, v]) => `${k} ${pct(v)}`).join(" · "));
console.log("\nGenuine respondents by segment (flagged · sent to review):");
for (const [k, s] of Object.entries(r.genuineBySegment)) console.log(`  ${k.padEnd(18)} ${pct(s.flagged).padEnd(20)} ${pct(s.detected)}`);
const reasons = {};
for (const f of r.falsePositives) for (const x of f.reasons) { const k = x.split(":")[0]; reasons[k] = (reasons[k] ?? 0) + 1; }
console.log("\nWhy genuine respondents were sent to review:", Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join(" · ") || "none");
if (r.misses.length) console.log("Problems that passed:", r.misses.map((m) => `${m.sessionId} ${m.label}`).join(", "));
const g = exclusionGate(r);
console.log(`\nAutomatic exclusion: ${g.open ? "MAY BE ENABLED — every check passed" : "LOCKED"}`);
for (const c of g.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
if (process.env.QV_JSON) writeFileSync(process.env.QV_JSON, JSON.stringify({ report: r, gate: g }, null, 2));
