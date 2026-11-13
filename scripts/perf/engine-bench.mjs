/**
 * CPU cost of the respondent hot path, measured — not estimated (scalability audit 2026-11-13).
 *
 * For each survey: simulate respondents, then time what the save route runs per save:
 *   checkSubmission (server replay of every page so far), once per page, as the browser saves after each page;
 * and what the FINAL save runs: the quality engine's assess() against 100 / 1,000 / 3,000 peers.
 * Also: JSON.parse + schema parse of the definition (a TEST session re-parses the draft on every save).
 *
 *   node scripts/perf/engine-bench.mjs
 */
import { performance } from "node:perf_hooks";
import { checkSubmission } from "../../packages/engine/dist/index.js";
import { buildScaleSurvey, buildMasterDemoSurvey, simulateRespondent, MASTER_DEMO_TEST_PATHS } from "../../packages/templates/dist/index.js";
import { assess } from "../../packages/quality/dist/index.js";
import { SurveyDefinition } from "../../packages/schema/dist/index.js";

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const fmt = (x) => x.toFixed(2);

function walk(def, seed, answers) {
  const sim = simulateRespondent(def, { seed, answers: answers ?? {} });
  return sim;
}

function benchSaves(name, def, seeds, answersFor) {
  const perSave = [], perInterview = [], pagesPer = [];
  let unfinished = 0;
  for (const seed of seeds) {
    const sim = walk(def, seed, answersFor?.(seed));
    if (!sim.endStatus) unfinished++;
    const st = sim.state;
    const pages = sim.pages.length;
    pagesPer.push(pages);
    let total = 0;
    // one save per page: the replay covers every page before stepIndex k
    for (let k = 1; k <= pages; k++) {
      const final = k === pages && !!sim.endStatus;
      const t0 = performance.now();
      checkSubmission({
        def,
        prior: { seed: st.seed, sessionId: "bench-session-0000000000", startedAt: st.startedAt },
        posted: { answers: st.answers, calculated: st.calculated, embedded: st.embedded, flags: st.flags, stepIndex: final ? st.stepIndex : k, status: final ? (sim.endStatus ?? "complete") : "in_progress", completed: final },
        quotaCounts: {}, recompute: true, balanceClaims: {},
      });
      const ms = performance.now() - t0;
      perSave.push(ms); total += ms;
    }
    perInterview.push(total);
  }
  return {
    name, questions: def.questions.length, interviews: seeds.length, unfinished,
    pagesMean: pagesPer.reduce((a, b) => a + b, 0) / pagesPer.length,
    saveP50: pct(perSave, 50), saveP95: pct(perSave, 95), saveP99: pct(perSave, 99), saveMax: Math.max(...perSave),
    interviewMeanMs: perInterview.reduce((a, b) => a + b, 0) / perInterview.length,
  };
}

function benchQuality(def, peerCounts) {
  const peerPool = [];
  for (let i = 0; i < Math.max(...peerCounts) + 1; i++) {
    const sim = walk(def, 1000 + (i % 300));
    peerPool.push({
      sessionId: `peer-${i}`, status: "complete", answers: sim.state.answers,
      startedAt: new Date(Date.now() - 600_000).toISOString(), completedAt: new Date().toISOString(),
      ipHash: `ip${i % 977}`, deviceHash: `dev${i % 811}`,
    });
  }
  const me = walk(def, 4242).state;
  const response = { sessionId: "me", status: "complete", answers: me.answers, calculated: me.calculated, embedded: me.embedded, flags: [], startedAt: new Date(Date.now() - 500_000).toISOString(), completedAt: new Date().toISOString(), telemetry: null, ipHash: "ipx", deviceHash: "devx" };
  const qdef = { ...def, quality: { ...(def.quality ?? {}), enabled: true } };
  const out = [];
  for (const n of peerCounts) {
    const peers = peerPool.slice(0, n);
    const times = [];
    for (let r = 0; r < 5; r++) { const t0 = performance.now(); assess({ def: qdef, response, peers, history: [] }); times.push(performance.now() - t0); }
    out.push({ peers: n, p50: pct(times, 50), max: Math.max(...times), peerBytes: JSON.stringify(peers.map((p) => p.answers)).length });
  }
  return out;
}

function benchParse(def) {
  const raw = JSON.stringify(def);
  const times = [];
  for (let i = 0; i < 20; i++) { const t0 = performance.now(); SurveyDefinition.safeParse(JSON.parse(raw)); times.push(performance.now() - t0); }
  return { bytes: raw.length, p50: pct(times, 50) };
}

const seeds = Array.from({ length: 20 }, (_, i) => 7 + i);
const scale60 = buildScaleSurvey(60);
const master = buildMasterDemoSurvey();
const paths = MASTER_DEMO_TEST_PATHS;

// warm up the JIT once
benchSaves("warm", scale60, [1, 2, 3]);

const results = [
  benchSaves("60-question survey (scale fixture: display logic, skips, matrices, calculations)", scale60, seeds),
  benchSaves("Master Demo (160 questions: nested loops, List Fills, conjoint, MaxDiff)", master, paths.map((p) => p.seed), (seed) => paths.find((p) => p.seed === seed)?.answers),
];
console.log(JSON.stringify({ node: process.version, cpu: (await import("node:os")).cpus()[0]?.model, saves: results, quality60: benchQuality(scale60, [100, 1000, 3000]), parse: { scale60: benchParse(scale60), master: benchParse(master) } }, null, 2));
