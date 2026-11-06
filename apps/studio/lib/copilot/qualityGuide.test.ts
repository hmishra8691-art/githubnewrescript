import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions } from "@rescript/engine";
import { COPILOT_QUALITY_GUIDE, qualityIntent } from "./qualityGuide.ts";
import { COPILOT_SYSTEM_PROMPT, copilotUserPrompt } from "./prompt.ts";
import { COPILOT_STABLE_GUIDES, copilotCall } from "../aiPromptCache.ts";

/* S5b (TE-12/13): the response-quality & paradata guide — sent for quality / paradata requests, cached, examples apply */
const lines = (g: string) => g.split("\n").filter((l) => l.startsWith('{"op":')).map((l) => JSON.parse(l));
const def = () => SurveyDefinition.parse({ meta: { id: "g", code: "G", title: "Study" }, questions: [], flow: [{ type: "end", id: "e", status: "complete" }] });

test("sent for quality and paradata requests, not otherwise; cached; the system prompt untouched", () => {
  for (const m of ["make the survey anonymous", "use unique links and close the survey on 21 December", "make the quality checks strict and flag speeders below 35% of the median", "turn off clipboard telemetry", "ask idle respondents if they are still there after 90 seconds", "record scroll depth", "can a script read the time on page with rs.getTiming"]) {
    assert.ok(qualityIntent(m), m);
    const p = copilotUserPrompt({ outline: "(survey)", surveyLanguage: "English", mode: "edit", message: m });
    const [system] = copilotCall(p);
    assert.ok(system.some((b) => b.includes(COPILOT_QUALITY_GUIDE)), `lifted into the cached prefix: ${m}`);
  }
  for (const m of ["Add a question about price", "make Q3 required", "add a 30 second timer to Q4", "improve the wording quality of Q2"]) assert.ok(!qualityIntent(m), m);
  assert.ok(COPILOT_STABLE_GUIDES.includes(COPILOT_QUALITY_GUIDE));
  assert.ok(COPILOT_SYSTEM_PROMPT.length < 14_800);
  /* IM2 (2026-11-06): the deployment settings (set_deployment) ride in this guide — 2.6k → 3k */
  assert.ok(COPILOT_QUALITY_GUIDE.length < 3_000, `${COPILOT_QUALITY_GUIDE.length}`);
  for (const w of ["READ-ONLY", "never writes paradata", "destructive", "never promise them"]) assert.ok(COPILOT_QUALITY_GUIDE.includes(w), w);
});

test("the worked examples apply as written", () => {
  const ex = lines(COPILOT_QUALITY_GUIDE);
  assert.equal(ex.length, 5);
  const c = coerceSurveyActions(ex);
  assert.deepEqual(c.rejected, []);
  const r = applySurveyActions(def(), c.actions);
  assert.deepEqual(r.errors, []);
  const q = r.def.quality!;
  assert.equal(q.strictness, "strict");
  assert.equal(q.rules["timing.overall_speeding"].params!.ratio, 0.35);
  assert.equal(q.telemetry.idleSeconds, 90);
  assert.equal(q.telemetry.idlePrompt, true);
  assert.equal(q.telemetry.clipboard, false);
  assert.equal(q.telemetry.answerHistory, false);
  /* IM2: set_deployment */
  assert.equal(r.def.deployment.access.mode, "unique_links");
  assert.equal(r.def.deployment.access.allowRetake, false);
  assert.match(r.def.deployment.activeUntil ?? "", /^2026-12-21/);
  assert.equal(q.telemetry.network, false); assert.equal(q.telemetry.device, false);
});

test("the rule ids the guide names exist", async () => {
  const { QUALITY_RULE_PARAMS } = await import("@rescript/schema");
  for (const m of COPILOT_QUALITY_GUIDE.matchAll(/\b((?:timing|matrix|attention|openend|interaction|navigation)\.[a-z_]+) \{([^}]*)\}/g)) {
    assert.ok(QUALITY_RULE_PARAMS[m[1]], m[1]);
    for (const k of m[2].split(",").map((s) => s.trim())) assert.ok(QUALITY_RULE_PARAMS[m[1]].includes(k), `${m[1]}.${k}`);
  }
});
