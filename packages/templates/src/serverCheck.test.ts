import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSubmission } from "@rescript/engine";
import { MASTER_DEMO_TEST_PATHS, SURVEY_TEMPLATES, buildMasterDemoSurvey, simulateRespondent } from "./index.js";

/**
 * RUNTIME-01 — NO FALSE REFUSALS. The server replay must accept every honest
 * interview the headless respondent can produce on every shipped template,
 * including the master demo (loops, List Fill, quotas, conjoint, MaxDiff,
 * calculations, scripts). A refusal here would strand a real respondent, so
 * this is the test that lets enforcement be switched on.
 */
const defs: { name: string; def: ReturnType<typeof buildMasterDemoSurvey>; runs: { seed: number; answers: Record<string, unknown> }[] }[] = [
  ...SURVEY_TEMPLATES.filter((t) => t.key !== "master_demo_2026").map((t) => ({ name: t.key, def: t.build("srv-check"), runs: [1, 7, 42].map((seed) => ({ seed, answers: {} })) })),
  // the master demo through its documented test paths: loops, nested loops, List Fill, quotas, conjoint, MaxDiff, scripts
  { name: "master-demo", def: buildMasterDemoSurvey(), runs: MASTER_DEMO_TEST_PATHS.map((p) => ({ seed: p.seed, answers: p.answers as Record<string, unknown> })) },
];

for (const { name, def, runs } of defs) {
  test(`server check accepts an honest completion of “${name}”`, () => {
    let walked = 0;
    for (const { seed, answers } of runs) {
      const sim = simulateRespondent(def, { seed, answers: answers as never });
      if (sim.blocked) continue; // the simulator itself could not finish this one (not the server's call)
      walked++;
      const posted = {
        answers: sim.state.answers, calculated: sim.state.calculated, embedded: sim.state.embedded, flags: sim.state.flags,
        stepIndex: sim.state.stepIndex, status: sim.state.status, completed: true,
      };
      const r = checkSubmission({ def, prior: { seed, sessionId: sim.state.sessionId }, posted });
      assert.equal(r.ok, true, `${name} seed ${seed}: ${JSON.stringify(r.hard)}`);
      // D7 (S0b): an honest interview's derived punches and calculations are exactly what the server recomputes
      const mism = r.soft.filter((x) => x.code === "server_mismatch");
      assert.deepEqual(mism, [], `${name} seed ${seed}: ${JSON.stringify(mism)}`);
      // intermediate positions must pass as "in progress" too (every page on small surveys; a stride on long ones — a
      // replay costs about a second on the 79-page demo, and the check is per save in production, not per page)
      const stride = sim.pages.length > 20 ? 9 : 1;
      for (const [i, page] of sim.pages.entries()) {
        if (i % stride !== 0 && i !== sim.pages.length - 1) continue;
        const partial = { ...posted, status: "in_progress", completed: false, stepIndex: i };
        const p = checkSubmission({ def, prior: { seed, sessionId: sim.state.sessionId }, posted: partial });
        assert.equal(p.ok, true, `${name} seed ${seed} page ${i} (${page.pageId}): ${JSON.stringify(p.hard)}`);
        const pm = p.soft.filter((x) => x.code === "server_mismatch");
        assert.deepEqual(pm, [], `${name} seed ${seed} page ${i}: ${JSON.stringify(pm)}`);
      }
    }
    assert.ok(walked > 0, `${name}: the simulator finished none of its runs, so nothing was checked`);
  });
}
