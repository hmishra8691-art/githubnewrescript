import { test } from "node:test";
import assert from "node:assert/strict";
import { trackerAnswer, trackerQuestion } from "./trackerRequest.ts";
import type { TrackerSession } from "../tracker/session.ts";

const wave = (id: string, order: number, aware: number, n = 400) => ({
  id, label: `Wave ${order}`, order,
  columns: [{ name: "AWARE", label: "Aware of Brand A" }, { name: "AGE", label: "Age" }],
  rows: Array.from({ length: n }, (_, i) => ({ AWARE: i < aware * n ? 1 : 0, AGE: i % 2 ? 1 : 2 })),
});

test("reads tracking questions, not questionnaire edits", () => {
  assert.ok(trackerQuestion("Is the change in awareness between wave 2 and wave 3 genuine?"));
  assert.ok(trackerQuestion("compare the waves"));
  assert.ok(trackerQuestion("show the tracker trend"));
  assert.ok(!trackerQuestion("add a question about the wave pool"));
  assert.ok(!trackerQuestion("make Q3 required"));
});

test("answers from the deterministic tracker; says what is missing", () => {
  const base: TrackerSession = { surveyId: "x", waves: [], state: { kpis: [], composition: [], segment: null, alpha: 0.05, manual: {} }, persisted: false, note: null };
  assert.match(trackerAnswer("compare waves", base).answer, /no waves/);
  const two = { ...base, waves: [wave("a", 1, 0.3), wave("b", 2, 0.45)] };
  assert.match(trackerAnswer("compare waves", two).answer, /no KPI/);
  const ready = { ...two, state: { ...two.state, kpis: [{ id: "k", label: "Awareness", variable: "AWARE", measure: "share" as const, codes: ["1"] }] } };
  const a = trackerAnswer("did awareness change since the last wave?", ready);
  assert.match(a.answer, /1 of 1 KPI changed significantly/);
  assert.match(a.sections[0].items[0].label, /Awareness: 45% in Wave 2, \+15 pts vs Wave 1 — a genuine change/);
});
