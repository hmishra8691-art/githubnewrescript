/**
 * ADVANCED MODELS FROM THE PLAN, INTELLIGENTLY (2026-10-22) — browser checks:
 * a sentence becomes a plan item, the item is edited with its method's settings,
 * applying runs it (hierarchical Bayes as a chunked job whose progress the page
 * follows), the result is read in plain language (diagnostics, caveats, the SEM
 * path diagram) and interpreted through the claim gate, a stale result is flagged
 * and re-run, and the drafted report carries the advanced section.
 *
 *   §1 sentences → actions: the engine's deterministic reading (`interpretRequest`,
 *      the code Intelligent mode runs before any model) of "run HB on the conjoint",
 *      "segment respondents with latent class using U1–U6", "test H2 as a mediation
 *      through trust", "check reliability of trust with omega", "fit a structural
 *      equation model of the hypotheses" — saved through `PUT plan` from the page;
 *      "run HB on the satisfaction question" is refused with the rule, nothing saved
 *   §2 the item editor: HB burn-in / draws, the latent-class K range, ω's three-item
 *      rule (Save disabled with the reason — the one readiness rule)
 *   §3 Apply: HB is started as a background job (the outcome says so), the Advanced
 *      models card follows its progress chunk by chunk, and when it is done the plan
 *      runs once so its result joins the findings — every item then up to date
 *   §4 the reading: SEM (fit diagnostics, path diagram SVG), HB (importances,
 *      convergence), the bootstrapped mediation (BCa), ω; "Interpret with AI" through
 *      the gate — a sentence with an invented number is withheld
 *   §5 live updating: new completes flag every advanced result stale (kept, not
 *      replaced), the threshold policy is saved to the plan, Re-run re-runs inline
 *      items and restarts HB on the new data
 *   §6 the report: the drafted report has the "Advanced models — what they show"
 *      section with the readings, the gated interpretations and the key tables
 *
 * The analytics API is a FAKE BACKEND running the REAL services over the in-memory
 * store: the plan service (`apps/studio/lib/analysisPlanCore.ts`), the chunked job
 * service (`modelJobsCore.ts`), the advanced-models state (`advancedModelsCore.ts`)
 * and the analytics engine (runPlan, advancedNarrative, gateInterpretation,
 * draftReport) on the seeded fixture `intelligentFixture` (300 respondents, a CBC,
 * a MaxDiff, six latent-class indicators, three constructs of three items).
 * What it does NOT prove: the model (the interpretation reply is a fixture through
 * the real gate), the SQL of 0066, the route's auth (covered by unit tests).
 *
 *   node --experimental-strip-types --no-warnings scripts/advanced-models-intelligent-test.mjs                 (studio on 3000)
 *   node --experimental-strip-types --no-warnings scripts/advanced-models-intelligent-test.mjs --backend-only   (no browser: the same flow through the fake API)
 */
import assert from "node:assert/strict";
import { SurveyDefinition } from "../packages/schema/dist/index.js";
import {
  buildDataset, runPlan, compactRun, runAnalysis, recommendCharts, variableMetadata, plannedAnalyses, analysisReadiness, inputHashOf,
  advancedNarrative, narrativeMarkdown, semPathDiagramSvg, draftReport, gateInterpretation, plannedIdOf, withPlannedVariables,
} from "../packages/analytics/dist/index.js";
import { intelligentFixture } from "../packages/analytics/dist/models/fixture.js";
import { interpretRequest } from "../packages/engine/dist/index.js";
import { FakeDb, uuid, stamp } from "./lib/fakeSupabase.mjs";
import { applyPlan, editPlan, planPayload } from "../apps/studio/lib/analysisPlanCore.ts";
import { continueJob, startJob } from "../apps/studio/lib/modelJobsCore.ts";
import { advancedStatus, isAdvancedDefinition, rerunTargets } from "../apps/studio/lib/advancedModelsCore.ts";

let passed = 0;
const ok = (msg) => { passed++; console.log(`  ok   ${msg}`); };
const STUDIO = process.env.STUDIO_URL ?? "http://localhost:3000";
const SURVEY = "44444444-4444-4444-8444-444444444444";
const BACKEND_ONLY = process.argv.includes("--backend-only");
/* the server advances HB 5 s on apply and ≤ 40 s per continue; here short chunks so several requests happen */
const CHUNK_MS = Number(process.env.ADV_CHUNK_MS ?? 700);
const LIVE = { environment: "LIVE", dataset: "all" };

/* ------------------------------------------------------------ the study and the in-memory store */
const fx = intelligentFixture({ n: 300 });
const rows = [...fx.rows];
const db = new FakeDb();
db.tables.analytics_model_jobs = db.tables.analytics_model_jobs ?? [];
db.tables.surveys.push({ id: SURVEY, title: "Phone buyers", revision: 1, draft_definition: JSON.parse(JSON.stringify(fx.def)), current_version_id: null });
const pushResponses = (rs) => { for (const r of rs) db.tables.responses.push({ id: r.id ?? uuid(), survey_id: SURVEY, status: "complete", is_test: false, deleted_at: null, completed_at: r.completed_at ?? "2026-10-01T10:05:00Z" }); };
pushResponses(rows);
const ctxOf = () => { const s = db.tables.surveys[0]; return { def: SurveyDefinition.parse(s.draft_definition), version: "1.0", revision: Number(s.revision), customerId: null, versionId: null, source: "draft", draftUpdatedAt: null }; };

/* one dataset per (definition revision, data size): the plan's derived columns added as the Studio's compute() does */
const dsMemo = new Map();
function dataset(def, spec = LIVE) {
  const k = `${JSON.stringify(def.research?.analysisPlan ?? null).length}:${def.research?.analysisPlan?.updatedAt ?? ""}:${rows.length}:${JSON.stringify(spec)}`;
  if (!dsMemo.has(k)) {
    const built = buildDataset(def, rows, { spec });
    const ds = withPlannedVariables(def, built).dataset;
    ds.dataVersion = `rows:${rows.length}`; ds.surveyVersion = "1.0";
    dsMemo.set(k, ds);
  }
  return dsMemo.get(k);
}
/* one clock for runs and arrivals: the store's stamp() lags wall time, and a job's finished_at is wall time */
let lastClock = 0;
const clockNow = () => { lastClock = Math.max(Date.now(), Date.parse(stamp()), lastClock + 1); return new Date(lastClock).toISOString(); };
const cache = new Map();
const keyOf = (def, ds) => inputHashOf(def, { dataVersion: ds.dataVersion ?? null, surveyVersion: ds.surveyVersion ?? null });
const jobDeps = (chunkMs = CHUNK_MS) => ({
  db, surveyId: SURVEY, userId: "u1", chunkMs,
  dataset: async (def) => dataset(ctxOf().def, def.dataset ?? LIVE),
  inputHash: async (def) => ({ def, key: keyOf(def, dataset(ctxOf().def, def.dataset ?? LIVE)) }),
  cachePut: async (key, payload) => { cache.set(key, payload); },
});
const deps = {
  latestRun: async (_db, surveyId, environment) => {
    const r = db.tables.analytics_runs.filter((x) => x.survey_id === surveyId && (!environment || x.environment === environment)).sort((a, b) => String(b.computed_at).localeCompare(String(a.computed_at)))[0];
    return r ? { id: r.id, computedAt: r.computed_at, trigger: r.trigger, environment: r.environment, n: r.n, items: r.items, findings: r.findings, verdicts: r.verdicts, warnings: r.warnings, surveyVersion: "1.0", dataset: r.dataset } : null;
  },
  runPlanFor: async (_db, surveyId, ctx, o) => {
    const spec = { environment: o.environment ?? "LIVE", dataset: o.dataset ?? "all" };
    const ds = dataset(ctx.def, spec);
    const items = plannedAnalyses(ctx.def, spec).filter((p) => !o.exclude?.has(String(p.definition.options?.planned)));
    /* HB from its finished job, as lib/analytics.ts runPlanFor reads the result cache */
    const run = runPlan(ctx.def, ds, { items, trigger: o.trigger ?? "manual", discover: false, precomputed: (it) => (it.definition.kind === "hb" ? cache.get(keyOf(it.definition, ds)) : undefined) });
    const compact = compactRun(run);
    const row = { id: uuid(), survey_id: surveyId, trigger: run.trigger, environment: run.environment, n: run.n, dataset: spec, computed_at: clockNow(), items: compact.items, findings: compact.findings, verdicts: compact.verdicts, warnings: compact.warnings };
    db.tables.analytics_runs.push(row);
    lastRunResults = run.items;
    return { run, stored: { ...compact, id: row.id, computedAt: row.computed_at, surveyVersion: "1.0", dataset: spec } };
  },
  reportFacts: async () => ({}),
  startModelJob: async (_db, _sid, _ctx, definition, analysisId) => startJob(jobDeps(), definition, analysisId).then((o) => (o.body.job ? { job: o.body.job } : { error: o.body.error ?? "not started" })),
};
let lastRunResults = [];

/* the plan's advanced items and the result of each, as lib/advancedModels.ts builds them */
const advancedItems = (def, spec = LIVE) => plannedAnalyses(def, spec).filter((p) => isAdvancedDefinition(p.definition)).map((p) => {
  const id = plannedIdOf(p.definition);
  const saved = db.tables.analytics_analyses.find((a) => !a.deleted_at && plannedIdOf(a.definition) === id);
  return { planned: id, title: p.definition.name, definition: p.definition, analysisId: saved ? saved.id : null };
});
const statusOf = async (def) => advancedStatus(db, SURVEY, { items: advancedItems(def), run: await deps.latestRun(db, SURVEY, "LIVE"), environment: "LIVE", policy: def.research?.analysisPlan?.advancedRerun });
function resultOf(def, d) {
  const ds = dataset(def);
  if (d.kind === "hb") return cache.get(keyOf(d, ds)) ?? { tables: [], tests: [], chart: {}, insights: [], warnings: [], base: { n: 0 }, error: { code: "job_pending", message: "no finished run" } };
  return runAnalysis(d, ds);
}
/* the model's interpretation (a FIXTURE through the REAL gate): the engine's first sentence, and one with an invented number */
const fakeModel = (narr) => ({ implications: [narr.summary[0], "Trust explains 97.3% of every purchase decision."], recommendations: [] });

async function api(m, parts, body, search) {
  const [head, itemId, action] = parts;
  const ctx = ctxOf();
  if (head === "access") return [200, { role: "owner", capabilities: ["analytics.read", "analytics.edit", "analytics.publish", "analytics.export", "survey.edit"] }];
  if (head === "plan" && !itemId && m === "GET") return [200, await planPayload(db, SURVEY, ctx, { environment: search.get("environment") ?? "LIVE", dataset: "all" }, deps)];
  if (head === "plan" && !itemId && m === "PUT") { const r = await editPlan(db, SURVEY, ctx, { actions: body.actions, baseRevision: body.baseRevision ?? null, userId: "u1" }); return [r.ok ? 200 : r.status, r.ok ? r : { error: r.error, results: r.results ?? [] }]; }
  if (head === "plan" && itemId === "apply") { const r = await applyPlan(db, SURVEY, ctx, { dataset: LIVE, userId: "u1" }, deps); return [r.ok ? 200 : r.status, r.ok ? r : { error: r.error }]; }
  if (head === "models" && itemId && action === "continue") { const o = await continueJob(jobDeps(), itemId); return [o.status, o.body]; }
  if (head === "advanced" && !itemId) return [200, { items: await statusOf(ctx.def), policy: ctx.def.research?.analysisPlan?.advancedRerun ?? { mode: "manual" } }];
  if (head === "advanced" && itemId === "narrative") {
    const it = advancedItems(ctx.def).find((i) => i.planned === body.planned);
    if (!it) return [404, { error: "That is not an advanced model of this survey's analysis plan." }];
    const result = resultOf(ctx.def, it.definition);
    const run = await deps.latestRun(db, SURVEY, "LIVE");
    const narrative = advancedNarrative(it.definition, result, { objective: ctx.def.research?.objective, hypotheses: ctx.def.research.hypotheses.map((text, i) => ({ label: `H${i + 1}`, text })), verdicts: run?.verdicts });
    let interpretation = null, model = { status: "not_asked", detail: "Interpretation was not requested." };
    if (body.interpretation === true && narrative?.valid) {
      const g = gateInterpretation([{ id: it.planned, name: it.title, definition: it.definition, result }], fakeModel(narrative), { objective: ctx.def.research?.objective });
      interpretation = { implications: g.implications, recommendations: g.recommendations, rejected: g.rejected };
      model = { status: "ok", detail: "fixture through the gate" };
    }
    return [200, { planned: it.planned, title: it.title, narrative, markdown: narrativeMarkdown(narrative, interpretation), svg: it.definition.kind === "sem" && !result.error ? semPathDiagramSvg(result) : null, interpretation, model, pending: result.error?.code === "job_pending" }];
  }
  if (head === "advanced" && itemId === "rerun") {
    const items = advancedItems(ctx.def);
    const t = rerunTargets(await statusOf(ctx.def));
    const jobs = [];
    for (const planned of t.hb) { const it = items.find((i) => i.planned === planned); const o = await startJob(jobDeps(), it.definition, it.analysisId); if (o.body.job) jobs.push({ planned, title: it.title, analysisId: it.analysisId, job: o.body.job }); }
    const after = await statusOf(ctx.def);
    const latest = await deps.latestRun(db, SURVEY, "LIVE");
    const hbJoined = after.some((s) => s.kind === "hb" && s.job?.status === "done" && s.job.finishedAt && (!latest || s.job.finishedAt > latest.computedAt));
    let runId = null;
    if (t.runPlan || hbJoined) { const r = await deps.runPlanFor(db, SURVEY, ctx, { environment: "LIVE", dataset: "all", trigger: "advanced_rerun", skipEmpty: true }); runId = r.stored?.id ?? null; }
    return [200, { status: runId ? await statusOf(ctx.def) : after, jobs, continued: 0, runId }];
  }
  if (head === "report-builder" && itemId === "draft") {
    const def = ctx.def;
    const items = advancedItems(def).filter((i) => i.analysisId).map((i) => ({ id: i.analysisId, name: i.title, definition: i.definition, result: resultOf(def, i.definition) }));
    const brief = { objective: def.research.objective, audience: "researcher", tone: "plain", keyQuestions: ["What segments exist?", "What drives purchase intent?"] };
    const adv = {};
    if (body.interpretation === true) for (const it of items.slice(0, 3)) {
      const n = advancedNarrative(it.definition, it.result);
      if (!n?.valid) continue;
      const g = gateInterpretation([it], fakeModel(n), brief);
      if (g.implications.length) adv[it.id] = { implications: g.implications, recommendations: g.recommendations };
    }
    return [200, { ...draftReport(brief, items, variableMetadata(def), { advancedInterpretations: adv }), model: { status: "ok", detail: "" }, truncated: false, analysesRead: items.length }];
  }
  if (head === "variables") return [200, { variables: variableMetadata(ctx.def).filter((v) => !v.hidden), counts: { LIVE: rows.length, TEST: 0 }, surveyVersion: "1.0", revision: ctx.revision }];
  if (head === "home") { const t = (k) => db.tables[k].filter((r) => r.survey_id === SURVEY && !r.deleted_at); return [200, { analyses: t("analytics_analyses"), charts: t("analytics_charts"), reports: t("analytics_reports"), shares: [] }]; }
  if (head === "run") {
    const d = body.definition;
    const ready = analysisReadiness({ ...d, variables: Array.isArray(d.variables) ? d.variables : [] });
    if (!ready.ready) return [422, { error: ready.missing.join(" "), code: "incomplete_definition", missing: ready.missing }];
    const result = resultOf(ctx.def, { ...d, name: d.name || d.kind });
    return [200, { result: { ...result, recommendations: result.error ? [] : recommendCharts(result) } }];
  }
  if (head === "report-templates") return [200, { templates: [], available: true }];
  const COLL = { analyses: "analytics_analyses", charts: "analytics_charts", segments: "analytics_segments", themes: "analytics_themes", reports: "analytics_reports", shares: "analytics_shares" };
  if (head in COLL) {
    const table = db.tables[COLL[head]] ?? (db.tables[COLL[head]] = []);
    if (!itemId && m === "GET") return [200, { items: table.filter((r) => r.survey_id === SURVEY && !r.deleted_at) }];
    const row = table.find((r) => r.id === itemId);
    if (!row) return [404, { error: "Unknown item." }];
    if (action === "versions") return [200, { versions: [] }];
    return [200, { item: row }];
  }
  return [404, { error: `fake backend: unhandled ${m} ${parts.join("/")}` }];
}

/* ------------------------------------------------------------ the flow, through the API (both modes use it for setup) */
const call = async (m, path, body = {}) => { const u = new URL(`http://x/${path}`); const [s, b] = await api(m, u.pathname.slice(1).split("/").filter(Boolean), body, u.searchParams); return { status: s, body: b }; };
const SENTENCES = ["run HB on the conjoint", "segment respondents with latent class using U1–U6", "test H2 as a mediation through trust", "check reliability of trust with omega", "fit a structural equation model of the hypotheses"];
const REFUSED = "run HB on the satisfaction question";
const methodOf = (t) => (t.method === "regression" && t.options?.bootstrap ? "mediation" : t.method === "reliability" && t.options?.omega ? "omega" : t.method);
const planTests = () => ctxOf().def.research.analysisPlan?.tests ?? [];
const idOf = (kind) => planTests().find((t) => methodOf(t) === kind)?.id;

/* the browser's AxApi, from the page: `PUT plan` with the actions the sentence became */
async function sayAll(post) {
  for (const s of SENTENCES) {
    const r = interpretRequest(ctxOf().def, s);
    assert.equal(r?.kind, "actions", `${s} → ${r?.kind}: ${r?.reason ?? ""}`);
    const out = await post({ actions: r.actions, baseRevision: ctxOf().revision });
    assert.equal(out.status, 200, `${s}: ${JSON.stringify(out.body).slice(0, 300)}`);
    assert.ok(out.body.results.every((x) => x.ok), `${s}: ${JSON.stringify(out.body.results)}`);
  }
  const refused = interpretRequest(ctxOf().def, REFUSED);
  assert.equal(refused?.kind, "refused");
  assert.match(refused.reason, /Hierarchical Bayes reads a CBC, ACBC, menu-based or MaxDiff exercise; Q20 is a single select question/);
  assert.deepEqual(planTests().map(methodOf).sort(), ["hb", "latent_class", "mediation", "omega", "sem"]);
}
/* new completes arrive NOW on the store's clock: after the runs so far, before the re-run (a date in the future would stay "since" every run) */
const arrive = (n) => { const at = clockNow(); pushResponses(Array.from({ length: n }, (_, i) => ({ id: `new${i}`, completed_at: at }))); rows.push(...fx.rows.slice(0, n).map((r, i) => ({ ...r, id: `new${i}`, completed_at: at }))); };
/* the drafted report: the advanced section, a reading per model with its gated interpretation, the key tables */
function checkDraft(blocks) {
  const at = blocks.findIndex((b) => b.type === "section" && /Advanced models — what they show/.test(b.title ?? ""));
  assert.ok(at >= 0, blocks.map((b) => `${b.type}:${b.title ?? ""}`).join(" | "));
  const mine = blocks.slice(at + 1);
  assert.ok(mine.filter((b) => b.type === "text").length >= 4, "a reading per advanced model");
  assert.ok(mine.some((b) => b.type === "text" && /What it may mean/.test(b.markdown ?? "") && !/97\.3/.test(b.markdown ?? "")), "a gated interpretation, without the invented number");
  assert.ok(mine.some((b) => b.type === "table"), "the key tables");
}
/* HB settings a test can afford (the generator's 5,000 + 5,000 is for real studies) */
const QUICK_HB = { burnIn: 3000, draws: 2000 };

if (BACKEND_ONLY) {
  console.log("\n(backend only) the same flow through the fake API, no browser");
  await sayAll((b) => call("PUT", "plan", b));
  ok("§1 five sentences → five advanced plan items; the HB-on-a-rating sentence refused with the rule");
  await call("PUT", "plan", { actions: [{ op: "update_analysis_test", id: idOf("hb"), options: QUICK_HB }], baseRevision: ctxOf().revision });
  const a = await call("POST", "plan/apply");
  assert.equal(a.status, 200, JSON.stringify(a.body).slice(0, 400));
  assert.equal(a.body.jobs?.length, 1, "HB started as a job");
  assert.equal(a.body.summary.items.find((i) => i.id === idOf("hb")).status, "job_running");
  ok("§3 apply: HB started as a background job; the other advanced items ran inline");
  let job = a.body.jobs[0].job, steps = 0;
  while (job.status === "running" && steps++ < 400) job = (await call("POST", `models/${job.id}/continue`)).body.job;
  assert.equal(job.status, "done", JSON.stringify(job).slice(0, 300));
  const rr = await call("POST", "advanced/rerun");
  assert.ok(rr.body.runId, "the finished job joined a new run");
  const st = (await call("GET", "advanced")).body.items;
  assert.deepEqual([...new Set(st.map((s) => s.staleness.state))], ["fresh"], JSON.stringify(st.map((s) => [s.kind, s.staleness.state])));
  ok(`§3 HB done after ${steps} continues; the plan ran again; all ${st.length} advanced items up to date`);
  for (const kind of ["sem", "hb", "mediation", "omega", "latent_class"]) {
    const n = await call("POST", "advanced/narrative", { planned: idOf(kind), interpretation: true });
    assert.equal(n.status, 200);
    assert.ok(n.body.narrative?.summary.length, `${kind} has a reading`);
    if (kind === "sem") assert.match(n.body.svg ?? "", /^<svg/);
    if (n.body.narrative.valid) assert.equal(n.body.interpretation.rejected.length, 1, `${kind}: the invented number is withheld`);
    console.log(`       ${kind}: ${n.body.narrative.summary[0].slice(0, 110)}…`);
  }
  ok("§4 a reading per advanced model; the SEM diagram; the gate withholds the invented number");
  arrive(12);
  const stale = (await call("GET", "advanced")).body.items;
  assert.ok(stale.every((s) => s.staleness.state === "stale" && s.staleness.newResponses === 12), JSON.stringify(stale.map((s) => s.staleness)));
  ok("§5 twelve new completes: every advanced result flagged stale, none replaced");
  const re1 = await call("POST", "advanced/rerun");
  assert.equal(re1.body.jobs.length, 1, "HB restarted on the new data");
  let j2 = re1.body.jobs[0].job;
  while (j2.status === "running") j2 = (await call("POST", `models/${j2.id}/continue`)).body.job;
  const re2 = await call("POST", "advanced/rerun");
  assert.ok(re2.body.runId, "the finished job joined a new run");
  const back = (await call("GET", "advanced")).body.items;
  assert.deepEqual([...new Set(back.map((x) => x.staleness.state))], ["fresh"], JSON.stringify(back.map((x) => x.staleness)));
  ok("§5 Re-run: inline models re-ran, HB restarted and finished on the new data — all up to date");
  const draft = await call("POST", "report-builder/draft", { interpretation: true });
  checkDraft(draft.body.report.blocks);
  ok("§6 the drafted report has the advanced section");
  console.log(`\n${passed} checks passed (backend only)`);
  process.exit(0);
}

/* ------------------------------------------------------------ browser */
const { chromium } = await import("./lib/playwright.mjs");
const { axTab } = await import("./lib/axNav.mjs");
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
async function fakeApi(route) {
  const req = route.request(); const url = new URL(req.url()); const m = req.method();
  const body = m === "POST" || m === "PUT" || m === "PATCH" ? JSON.parse(req.postData() || "{}") : {};
  const parts = url.pathname.replace(`/api/surveys/${SURVEY}/analytics`, "").replace(/^\//, "").split("/").filter(Boolean);
  try { const [s, b] = await api(m, parts, body, url.searchParams); return json(route, b, s); }
  catch (e) { console.error("FAKE API ERROR", m, url.pathname, e); return json(route, { error: e.message }, 500); }
}
const browser = await chromium.launch();
const bctx = await browser.newContext({ viewport: { width: 1500, height: 1050 } });
await bctx.addCookies([{ name: "rescript_session", value: "fake", url: STUDIO }]);
const page = await bctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
if (process.env.ADV_DEBUG) { let nreq = 0; page.on("console", (m) => console.log("  [console]", m.type(), m.text().slice(0, 200))); page.on("request", (r) => { if (++nreq < 400) console.log("  [req]", r.method(), r.url().slice(0, 160)); }); page.on("crash", () => console.log("  [CRASH] after", nreq, "requests")); }
page.on("dialog", (d) => d.accept());
await page.route("**/api/auth/me", (r) => json(r, { userId: "u1", userCode: "U-0001", name: "Ana Lyst", email: "ana@example.com", platformRole: "user", isPlatformAdmin: false, sessionId: "s1", unread: 0, policies: { heartbeatSeconds: 600 } }));
await page.route("**/api/auth/heartbeat**", (r) => json(r, { ok: true }));
await page.route("**/api/notifications**", (r) => json(r, { items: [], unread: 0 }));
await page.route("**/api/surveys", (r) => json(r, { surveys: [{ id: SURVEY, code: "PHN", title: "Phone buyers", status: "live", myRole: "owner", roleSource: "owner", updated_at: stamp(), version: "1.0" }] }));
await page.route("**/api/surveys/*/analytics/**", fakeApi);
await page.route("**/api/surveys/*/analytics?*", fakeApi);
const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, " ").trim());
const openPlan = async () => {
  await page.goto(`${STUDIO}/analytics?survey=${SURVEY}&tab=plan`, { waitUntil: "networkidle", timeout: 120000 });
  try { await page.waitForSelector('[data-testid="ap-workspace"], [data-testid="ap-none"]', { timeout: 90000 }); }
  catch (e) { console.error("openPlan: page errors:", pageErrors, "\nbody:", (await page.textContent("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 1500)); throw e; }
};
const shot = async (name) => { if (process.env.AX_SHOTS) await page.screenshot({ path: `${process.env.AX_SHOTS}/advi-${name}.png`, fullPage: true }); };
const until = async (fn, what, ms = 30000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 100)); } };
const testRow = (id) => `[data-testid="ap-test"][data-id="${id}"]`;

console.log("\n§1 SENTENCES → PLAN ITEMS (the engine's deterministic reading, saved through PUT plan from the page)");
await openPlan();
await sayAll(async (b) => page.evaluate(async ([sid, bb]) => { const r = await fetch(`/api/surveys/${sid}/analytics/plan`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(bb) }); return { status: r.status, body: await r.json() }; }, [SURVEY, b]));
await openPlan();
await page.click('[data-testid="ap-section-tests"]');
for (const k of ["hb", "latent_class", "mediation", "omega", "sem"]) await page.waitForSelector(testRow(idOf(k)));
assert.match(await text(`${testRow(idOf("hb"))} .ap-item-sub`), /hb · CBC/);
assert.match(await text(`${testRow(idOf("mediation"))} .ap-item-sub`), /via TRUST_SCORE/);
ok("five sentences became five plan items (HB, latent class, bootstrapped mediation, ω, SEM); the HB-on-a-rating sentence was refused with the rule");
await page.waitForSelector('[data-testid="ap-advanced"]');
assert.equal(await page.$$eval('[data-testid="ap-adv-item"]', (es) => es.every((e) => e.getAttribute("data-state") === "never_run")), true);
ok("the Advanced models card lists them, none run yet");
await shot("1-plan");

console.log("\n§2 THE ITEM EDITOR — the method's settings, the one readiness rule");
await page.click(`${testRow(idOf("hb"))} [data-testid="ap-item-edit"]`);
await page.waitForSelector('[data-testid="ap-ed-options"][data-method="hb"]');
assert.equal(await page.inputValue('[data-testid="ap-opt-burnin"]'), "5000");
await page.fill('[data-testid="ap-opt-burnin"]', String(QUICK_HB.burnIn));
await page.fill('[data-testid="ap-opt-draws"]', String(QUICK_HB.draws));
await page.click('[data-testid="ap-ed-save"]');
await until(() => planTests().find((t) => t.method === "hb").options.draws === QUICK_HB.draws, "the HB options saved");
assert.deepEqual({ burnIn: planTests().find((t) => t.method === "hb").options.burnIn, draws: planTests().find((t) => t.method === "hb").options.draws }, QUICK_HB);
ok("HB burn-in and draws edited in the item editor and saved to the plan item's options (the rest kept)");
await page.click(`${testRow(idOf("omega"))} [data-testid="ap-item-edit"]`);
await page.waitForSelector('[data-testid="ap-opt-omega"]');
assert.equal(await page.isChecked('[data-testid="ap-opt-omega"]'), true);
await page.click('[data-testid="ap-ed-variables"] .ax-pill:has-text("M3") button');
assert.equal(await page.getAttribute('[data-testid="ap-ed-save"]', "data-ready"), "0");
assert.match(await page.getAttribute('[data-testid="ap-ed-save"]', "title"), /ω needs at least three items|three items/);
ok("ω with two items: Save is not ready and says why (the rule the apply uses)");
await page.click('[data-testid="ap-ed-cancel"]');
await page.click(`${testRow(idOf("latent_class"))} [data-testid="ap-item-edit"]`);
await page.waitForSelector('[data-testid="ap-ed-options"][data-method="latent_class"]');
await page.fill('[data-testid="ap-opt-kmax"]', "4");
await page.click('[data-testid="ap-ed-save"]');
await until(() => planTests().find((t) => t.method === "latent_class").options.maxClasses === 4, "the K range saved");
ok("latent class K range edited (at most 4 classes)");

console.log("\n§3 APPLY — HB as a background job with progress; the rest inline; the finished job joins the findings");
await page.click('[data-testid="ap-apply"]');
await page.waitForSelector('[data-testid="ap-outcome"]', { timeout: 120000 });
assert.match(await text('[data-testid="ap-outcome-jobs"]'), /running as a background job/);
ok("the apply outcome says HB runs as a background job");
await page.waitForSelector('[data-testid="ap-adv-item"][data-state="running"] [data-testid="ap-job"]', { timeout: 60000 });
const pct1 = Number(await page.getAttribute('[data-testid="ap-job"]', "data-pct"));
await page.waitForFunction((p) => { const e = document.querySelector('[data-testid="ap-job"]'); return !e || Number(e.getAttribute("data-pct")) > p; }, pct1, { timeout: 120000 });
ok(`the job's progress advances chunk by chunk (from ${pct1}%)`);
await shot("3-running");
await page.waitForSelector('[data-testid="ap-adv-msg"]', { timeout: 300000 });
assert.match(await text('[data-testid="ap-adv-msg"]'), /joined a new run of the plan/);
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="ap-adv-item"]')].every((e) => e.getAttribute("data-state") === "fresh"), null, { timeout: 60000 });
ok("HB finished; the plan ran once more; every advanced item is up to date");
assert.ok(db.tables.analytics_runs.at(-1).items.some((i) => i.definition.kind === "hb" && !i.error), "the latest run carries HB's result");
ok("the latest run carries the HB result (traceability: tested only with a run)");

console.log("\n§4 THE READING — engine narrative, diagnostics, the SEM diagram, the gated interpretation");
await page.click('[data-testid="ap-section-tests"]');
for (const k of ["sem", "hb", "mediation", "omega"]) {
  await page.click(`${testRow(idOf(k))} .ap-item-row`);
  const panel = `${testRow(idOf(k))} [data-testid="ap-adv-reading"]`;
  await page.click(`${panel} [data-testid="ap-adv-read"]`);
  await page.waitForSelector(`${panel} [data-testid="ap-adv-narrative"]`);
  const summary = await text(`${panel} [data-testid="ap-adv-summary"]`);
  if (k === "sem") { await page.waitForSelector(`${panel} [data-testid="ap-adv-svg"] svg`); assert.ok(await page.$(`${panel} [data-testid="ap-adv-diagnostics"]`)); }
  if (k === "hb") assert.match(summary, /importance|utilit/i);
  if (k === "mediation") assert.match(summary, /BCa|indirect/i);
  if (k === "omega") assert.match(summary, /ω|omega/i);
  if (k === "sem") {
    await page.click(`${panel} [data-testid="ap-adv-interpret"]`);
    await page.waitForSelector(`${panel} [data-testid="ap-adv-model"]`);
    assert.match(await text(`${panel} [data-testid="ap-adv-model"]`), /1 sentence withheld/);
  }
  await page.click(`${testRow(idOf(k))} .ap-item-row`);
  ok(`${k}: the reading${k === "sem" ? ", diagnostics, the path diagram, and the gated interpretation (the invented number withheld)" : ""}`);
}
await shot("4-reading");

console.log("\n§5 LIVE UPDATING — stale flagged and kept; the threshold policy; Re-run");
arrive(12);
await openPlan();
await page.waitForSelector('[data-testid="ap-advanced"]');
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="ap-adv-item"]')].every((e) => e.getAttribute("data-state") === "stale"));
assert.match(await text('[data-testid="ap-adv-item"]'), /12 new completes since this was computed/);
assert.match(await text('[data-testid="ap-adv-rerun"]'), /Re-run 5 stale/);
ok("12 new completes: every advanced result flagged stale (the earlier result kept), Re-run offered");
await page.selectOption('[data-testid="ap-adv-policy-mode"]', "threshold");
await page.waitForSelector('[data-testid="ap-adv-policy"][data-mode="threshold"]');
await until(() => ctxOf().def.research.analysisPlan.advancedRerun?.mode === "threshold", "the policy saved");
assert.equal(ctxOf().def.research.analysisPlan.advancedRerun.newResponses, 50);
ok("the threshold policy is saved to the plan (re-run automatically after N new completes, checked hourly)");
await page.click('[data-testid="ap-adv-rerun"]');
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="ap-adv-item"]')].every((e) => e.getAttribute("data-state") === "fresh"), null, { timeout: 300000 });
ok("Re-run: the inline models re-ran and HB restarted on the new data and finished — all up to date again");

console.log("\n§6 THE REPORT — the advanced section with readings, gated interpretations and key tables");
const draft = await page.evaluate(async (sid) => { const r = await fetch(`/api/surveys/${sid}/analytics/report-builder/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief: {}, interpretation: true }) }); return r.json(); }, SURVEY);
checkDraft(draft.report.blocks);
ok("the drafted report carries “Advanced models — what they show”: readings, interpretations, key tables");

assert.deepEqual(pageErrors, []);
ok("no page errors");
await browser.close();
console.log(`\n${passed} checks passed`);
