/**
 * Respondent load test against a running respondent app (scalability audit 2026-11-13).
 *
 * N virtual respondents, each: POST /api/session/start → one POST /api/session/save per page with the answers so far
 * (exactly what the runner sends) → a final save with completed:true. Answers come from the engine's own simulated
 * respondent, so every save is a valid payload the server replays in full.
 *
 * Targets the in-memory session SANDBOX (a runtime started with no database): it measures the app layer — Next.js,
 * JSON, the server-side replay — not Postgres. Database cost is measured separately (see the audit report).
 *
 *   node scripts/perf/respondent-load.mjs --url http://localhost:3001 --vus 500 --survey scale60|master [--think 0] [--duration 60]
 *
 * STAGING (a deployed respondent app with its own database — never production): publish a test survey there, export
 * its definition JSON, then
 *   node scripts/perf/respondent-load.mjs --url https://<staging-runtime> --client <client> --study <study> --def survey.json \
 *     --mode test --vus 1000 --think 20000 --ramp 120 --duration 900
 * `--ramp` spreads the virtual respondents' arrival over that many seconds (a spike test is --ramp 0).
 */
import { performance } from "node:perf_hooks";
import { buildScaleSurvey, buildMasterDemoSurvey, simulateRespondent } from "../../packages/templates/dist/index.js";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg("url", "http://localhost:3001");
const VUS = Number(arg("vus", 100));
const THINK = Number(arg("think", 0));           // ms between pages per respondent
const DURATION = Number(arg("duration", 60)) * 1000;
const SURVEY = arg("survey", "scale60");
const CLIENT = arg("client", null), STUDY = arg("study", null), MODE = arg("mode", "test");
const RAMP = Number(arg("ramp", 0)) * 1000;
const DEF_FILE = arg("def", null);
const def = DEF_FILE ? JSON.parse((await import("node:fs")).readFileSync(DEF_FILE, "utf8")) : SURVEY === "master" ? buildMasterDemoSurvey() : buildScaleSurvey(60);

/* pre-compute a pool of interviews: per page, the state the browser would post */
const pool = [];
for (let s = 0; s < 30; s++) {
  const sim = simulateRespondent(def, { seed: 100 + s, answers: {} });
  const st = sim.state;
  const pages = sim.pages.length;
  pool.push({ pages, end: sim.endStatus ?? "complete", answers: st.answers, calculated: st.calculated, embedded: st.embedded, stepIndex: st.stepIndex });
}

const post = async (path, body) => {
  const t0 = performance.now();
  try {
    const r = await fetch(`${URL_}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    return { ok: r.ok, status: r.status, ms: performance.now() - t0, bytes: text.length, text };
  } catch (e) {
    return { ok: false, status: e.name === "TimeoutError" ? "timeout" : "error", ms: performance.now() - t0, bytes: 0, text: String(e) };
  }
};

let token = null;
if (!CLIENT) {
  const launch = await post("/api/session/sandbox", { action: "launch", definition: def });
  if (!launch.ok) { console.error("launch failed", launch.status, launch.text.slice(0, 200)); process.exit(1); }
  token = JSON.parse(launch.text).token;
}
const startBody = () => (CLIENT ? { client: CLIENT, study: STUDY, mode: MODE, urlParams: { src: "loadtest" } } : { client: "sandbox", study: token, mode: "test" });

const lat = { start: [], save: [], final: [] };
const errors = {};
let completes = 0, requests = 0, bytesIn = 0;
const deadline = performance.now() + DURATION;
const t0 = performance.now();

async function respondent(vu) {
  if (RAMP) await new Promise((res) => setTimeout(res, (vu / VUS) * RAMP));
  while (performance.now() < deadline) {
    const iv = pool[(vu + completes) % pool.length];
    const st = await post("/api/session/start", startBody());
    requests++; bytesIn += st.bytes; lat.start.push(st.ms);
    if (!st.ok) { errors[`start ${st.status}`] = (errors[`start ${st.status}`] ?? 0) + 1; continue; }
    const sessionId = JSON.parse(st.text).session.sessionId;
    for (let k = 1; k <= iv.pages && performance.now() < deadline; k++) {
      const final = k === iv.pages;
      const r = await post("/api/session/save", {
        sessionId, seq: k, stepIndex: final ? iv.stepIndex : k, status: final ? iv.end : "in_progress", completed: final,
        answers: iv.answers, calculated: iv.calculated, embedded: iv.embedded, flags: [],
      });
      requests++; bytesIn += r.bytes; (final ? lat.final : lat.save).push(r.ms);
      if (!r.ok) { const key = `save ${r.status}`; errors[key] = (errors[key] ?? 0) + 1; break; }
      if (final) completes++;
      if (THINK) await new Promise((res) => setTimeout(res, THINK * (0.5 + Math.random())));
    }
  }
}

await Promise.all(Array.from({ length: VUS }, (_, i) => respondent(i)));
const secs = (performance.now() - t0) / 1000;
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1); };
const sum = (xs) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? +Math.max(...xs).toFixed(1) : null });
const failed = Object.values(errors).reduce((a, b) => a + b, 0);
console.log(JSON.stringify({
  survey: SURVEY, questions: def.questions.length, vus: VUS, thinkMs: THINK, seconds: +secs.toFixed(1),
  requests, rps: +(requests / secs).toFixed(1), savesPerSec: +((lat.save.length + lat.final.length) / secs).toFixed(1), completes,
  errorRate: +(failed / Math.max(1, requests)).toFixed(4), errors,
  latencyMs: { start: sum(lat.start), save: sum(lat.save), finalSave: sum(lat.final) },
}));
