import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { SurveyDefinition } from "@rescript/schema";
import {
  LOGIC_SHIM, logicSnapshot, logicStatics, prepareLogicScripts, literalCallArgs, logicScriptScope, type LogicScriptOutcome,
} from "./logicSandbox.js";
import { createScriptCtx, runScript, type ScriptRunResult } from "./scripts.js";
import { applyScriptWrite } from "./scriptWrites.js";
import { answerKey, createResponseState, getQuestionByCodeOrVar, type LoopContext, type ResponseState } from "./state.js";
import { compileFlow } from "./flow.js";

/*
 * S1b item 1: the ctx shim the sandboxed frame runs. It is run here exactly as the frame runs it — the source text
 * in a vm context of its own, compiled with that context's Function — and compared with the main-thread runner
 * (runScript) on the 14 Scripts-panel scripts production carries (master demo + beverage/mask demo).
 */

function shim() {
  const ctx = vm.createContext({});
  vm.runInContext(`${LOGIC_SHIM}; globalThis.__rsLogic = __rsLogic;`, ctx);
  const api = (ctx as { __rsLogic: { statics(s: unknown): void; run(req: unknown, compile: unknown): LogicScriptOutcome[] } }).__rsLogic;
  const compile = vm.runInContext(`(function (params, body) { return Function.apply(null, params.concat([body])); })`, ctx);
  return { api, compile };
}

/** run code through the shim; returns the outcomes (writes are NOT applied) */
function viaShim(def: SurveyDefinition, state: ResponseState, loop: LoopContext | null, codes: string[], value?: unknown): LogicScriptOutcome[] {
  const { api, compile } = shim();
  api.statics(JSON.parse(JSON.stringify(logicStatics(def))));
  const d = { ...def, scripts: codes.map((code, i) => ({ id: `s${i}`, name: `s${i}`, scope: "survey" as const, event: "on_load" as const, code, enabled: true })) };
  const prep = prepareLogicScripts(d as SurveyDefinition, state, "on_load");
  assert.deepEqual(prep.refused, []);
  const snap = logicSnapshot(def, state, loop, codes, value);
  return JSON.parse(JSON.stringify(api.run(JSON.parse(JSON.stringify({ scripts: prep.scripts, snap })), compile)));
}

/** the writes, applied without the engine's checks — what the old runner did to the state */
function applyRaw(def: SurveyDefinition, state: ResponseState, loop: LoopContext | null, outs: LogicScriptOutcome[]) {
  for (const o of outs) for (const w of o.writes) {
    if (w.kind === "answer") state.answers[answerKey(getQuestionByCodeOrVar(def, w.ref)?.id ?? w.ref, loop)] = w.value as never;
    else if (w.kind === "calculated") state.calculated[w.name] = w.value as never;
    else if (w.kind === "embedded") state.embedded[w.name] = w.value as never;
    else if (!state.flags.includes(w.name)) state.flags.push(w.name);
  }
}

function legacy(def: SurveyDefinition, state: ResponseState, loop: LoopContext | null, code: string, value?: unknown): ScriptRunResult {
  const r: ScriptRunResult = { logs: [], errors: [] };
  const ctx = createScriptCtx(def, state, loop, r);
  runScript(code, value === undefined ? ctx : ({ ...ctx, value } as never), r);
  return r;
}

const Q = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, code: id, variableName: id, type, text: id, ...extra });
const BRANDS = [{ code: 1, label: "Apple" }, { code: 2, label: "Samsung" }, { code: 3, label: "Google" }];
const def = SurveyDefinition.parse({
  meta: { id: "s1b", code: "S1B", title: "S1b", version: "1.0" },
  questions: [
    Q("q_monthly_spend", "numeric"), Q("q_used", "multi_select", { options: BRANDS }), Q("q_trusted", "multi_select", { options: BRANDS }),
    Q("q_rank", "ranking", { options: BRANDS }),
    Q("h_lf_source", "hidden", { options: BRANDS }), Q("q_seg", "hidden"),
    Q("q_years_used", "matrix_numeric", { rows: [{ code: "1", label: "Apple" }, { code: "2", label: "Samsung" }] }), Q("q_age", "numeric"),
    Q("q_last_purchase", "date"), Q("q_warranty_end", "date"), Q("q_upgrade_dates", "text"),
    Q("q_recontact", "single_select", { options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }] }),
    Q("q_frequency", "numeric"), Q("q_spend_total", "numeric"), Q("q_spend_out", "numeric"),
    Q("q_b_nps", "numeric"),
  ],
  embeddedData: [
    { name: "PANEL_ID", source: "url", defaultValue: "P1" }, { name: "SOURCE", source: "url", defaultValue: "Panel" }, { name: "WAVE", source: "static", defaultValue: "W1" },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["q_used", "q_trusted", "q_rank", "q_monthly_spend", "q_frequency"] },
    { type: "loop", id: "loop_b", loopVar: "brand", source: { kind: "question", questionId: "q_used", filter: "selected" },
      references: { columns: [{ name: "Client_Code", dataType: "text" }], values: { "1": { Client_Code: "C001" }, "2": { Client_Code: "C002" }, "3": { Client_Code: "C003" } } },
      children: [{ type: "page", id: "p_b", questionIds: ["q_b_nps"] }] },
    { type: "page", id: "p9", questionIds: ["q_age", "q_years_used", "q_recontact", "q_spend_total", "q_spend_out"] },
    { type: "end", id: "e", status: "complete" },
  ],
});

/* the 14 production scripts (master demo a–h, beverage/mask demo i–n), verbatim */
const SCRIPTS: Record<string, string> = {
  a: `const s = Number(get('q_monthly_spend'));\nsetCalc('SPEND_BAND_TEXT', !Number.isFinite(s) ? '' : s < 50 ? 'a light' : s < 200 ? 'a moderate' : 'a heavy');`,
  b: `setCalc('BUILD_TAG', 'MASTER_DEMO_2026_v1');\nlog('panel', getEmbedded('PANEL_ID'), 'source', getEmbedded('SOURCE'));`,
  c: `const used = (get('q_used') || []).map(String);\nconst trusted = (get('q_trusted') || []).map(String);\nconst both = used.filter((c) => trusted.includes(c)).map(Number);\nset('h_lf_source', both);\nsetCalc('N_USED_AND_TRUSTED', both.length);\nlog('hidden list source', both);`,
  d: `const years = get('q_years_used') || {};\nconst age = Number(get('q_age'));\nconst bad = [];\nfor (const [code, y] of Object.entries(years)) {\n  const n = Number(y);\n  setCalc('INVALID_YEARS_' + code, Number.isFinite(n) ? n : '');\n  if (Number.isFinite(n) && Number.isFinite(age) && n > age) bad.push({ code, label: String(n) });\n}\nsetCalc('INVALID_BRANDS', bad);\nsetCalc('N_INVALID_BRANDS', bad.length);\nif (bad.length) flag('implausible_years_used');\nlog('invalid brands', bad);`,
  e: `const score = Number(getCalc('ENGAGEMENT_SCORE'));\nif (score >= 70) flag('digital_native');\nif (get('q_recontact') === 1) flag('recontact_ok');`,
  f: `const item = getCurrentLoopItem();\nif (item) {\n  log('LOOP_001 iteration', getCurrentLoopIndex(), 'of', getLoopCount(), item.code, item.label, item.references);\n  setCalc('LAST_CLIENT_CODE', getCurrentLoopReference('Client_Code'));\n  setCalc('LOOP_001_VISITED_' + item.code, 1);\n}`,
  g: `const w = (get('q_upgrade_dates') || {}).w || {};\nif (w.c_from && w.c_to && String(w.c_to) < String(w.c_from)) error('The end of your upgrade window cannot be before its start.', 'q_upgrade_dates');`,
  h: `const bought = get('q_last_purchase'); const ends = get('q_warranty_end');\nif (bought && ends && String(ends) < String(bought)) error('The warranty cannot end before the purchase date (' + bought + ').', 'q_warranty_end');`,
  i: `const f = Number(get('q_frequency'));\nsetCalc('FREQ_BAND', !Number.isFinite(f) ? '' : f <= 2 ? 'a frequent' : f <= 4 ? 'an occasional' : 'a rare');`,
  j: `const item = getCurrentLoopItem('brand');\nconst idx = getCurrentLoopIndex('brand');\nconst n = getLoopCount('brand');\nsetCalc('LAST_RATED_BRAND', item ? String(item.label || item.code) : '');\nsetCalc('LOOP_PROGRESS', idx + ' of ' + n);\nlog('rated', item && item.code, 'at position', idx, 'of', n);`,
  k: `const nps = [];\nconst items = getLoopItems('brand') || [];\nfor (const it of items) {\n  const v = getLoopAnswer('q_b_nps', it.code, 'brand');\n  if (v != null && v !== '') nps.push(Number(v));\n}\nif (nps.length) setCalc('NPS_MEAN', Math.round((nps.reduce((a, b) => a + b, 0) / nps.length) * 10) / 10);\nsetCalc('BRANDS_EVALUATED', items.length);\nlog('finished', getEmbedded('PANEL_ID'), 'brands', items.length);`,
  l: `setCalc('BUILD_TAG', 'BEV_MASK_DEMO_2026_v1');\nconst src = String(getEmbedded('SOURCE') || 'direct').toLowerCase();\nsetEmbedded('SOURCE', src);\nsetCalc('IS_PANEL', src !== 'direct' ? 1 : 0);\nlog('opened', getEmbedded('PANEL_ID'), 'wave', getEmbedded('WAVE'));`,
  m: `const used = (get('q_used') || []).map(String).filter((c) => c !== '97');\nconst ranked = (get('q_rank') || []).map(String);\nconst ordered = ranked.filter((c) => used.includes(c)).concat(used.filter((c) => !ranked.includes(c)));\nset('h_lf_source', ordered.map(Number));\nsetCalc('N_USED_ORDERED', ordered.length);\nsetCalc('TOP_BRAND_CODE', ordered.length ? Number(ordered[0]) : null);\nif (ordered.length === 0) set('q_seg', 'light');\nlog('list fill source punched', ordered);`,
  n: `const total = Number(get('q_spend_total'));\nconst out = Number(get('q_spend_out'));\nif (Number.isFinite(total) && Number.isFinite(out) && out > total) {\n  error('Spending while out (' + out + ') cannot be more than your total (' + total + ').', 'q_spend_out');\n}\nif (Number.isFinite(total) && total === 0 && Number(get('q_frequency')) <= 2) {\n  error('You told us you drink these most days — please check your monthly spend.', 'q_spend_total');\n}`,
};

function filled(): ResponseState {
  const s = createResponseState(def, { seed: 3, embedded: { PANEL_ID: "P1", SOURCE: "Panel", WAVE: "W1" } });
  Object.assign(s.answers, {
    q_monthly_spend: 120, q_used: [1, 2, 3], q_trusted: [2, 3], q_rank: [3, 1], q_years_used: { "1": 3, "2": 40 }, q_age: 30,
    q_last_purchase: "2026-05-01", q_warranty_end: "2026-01-01", q_upgrade_dates: { w: { c_from: "2026-06", c_to: "2026-01" } },
    q_recontact: 1, q_frequency: 2, q_spend_total: 0, q_spend_out: 5, "q_b_nps@1": 9, "q_b_nps@2": 6, "q_b_nps@3": 10,
  });
  s.calculated.ENGAGEMENT_SCORE = 80;
  return s;
}
const loopPages = (s: ResponseState) => compileFlow(def, s).filter((x) => x.kind === "page" && x.loop) as { loop: LoopContext }[];

test("S1b shim: each of the 14 production scripts behaves exactly as the main-thread runner (state, logs, errors)", () => {
  for (const [k, code] of Object.entries(SCRIPTS)) {
    for (const where of ["outside", "loop"] as const) {
      const a = filled(), b = filled();
      const loop = where === "loop" ? loopPages(a)[1]!.loop : null;
      const old = legacy(def, a, loop, code);
      const outs = viaShim(def, b, loop, [code]);
      applyRaw(def, b, loop, outs);
      assert.equal(outs[0]!.failed, old.failed, `${k}/${where}: failed`);
      assert.deepEqual(outs[0]!.logs, old.logs, `${k}/${where}: logs`);
      assert.deepEqual(outs[0]!.errors, old.errors, `${k}/${where}: errors`);
      assert.deepEqual(b.answers, a.answers, `${k}/${where}: answers`);
      assert.deepEqual(b.calculated, a.calculated, `${k}/${where}: calculated`);
      assert.deepEqual(b.embedded, a.embedded, `${k}/${where}: embedded`);
      assert.deepEqual(b.flags, a.flags, `${k}/${where}: flags`);
    }
  }
  // the loop helpers really ran: k averaged three iterations' NPS, j saw position 2 of 3
  const s = filled(); const loop = loopPages(s)[1]!.loop;
  const outs = viaShim(def, s, loop, [SCRIPTS.j!, SCRIPTS.k!]);
  assert.deepEqual(outs[1]!.writes.find((w) => w.kind === "calculated" && w.name === "NPS_MEAN"), { kind: "calculated", name: "NPS_MEAN", value: 8.3 });
  assert.deepEqual(outs[0]!.writes.find((w) => w.kind === "calculated" && w.name === "LOOP_PROGRESS"), { kind: "calculated", name: "LOOP_PROGRESS", value: "2 of 3" });
});

test("S1b shim: the overlay — a later get in the same run (and a later script of the batch) sees the run's own writes", () => {
  const s = filled();
  const outs = viaShim(def, s, null, [
    `set('q_age', 41); setCalc('X', { a: [1, 2] }); setEmbedded('WAVE', 'W2'); flag('f1'); flag('f1');
     log(get('q_age'), JSON.stringify(getCalc('X')), getEmbedded('WAVE'));`,
    `log(get('q_age'), getCalc('X').a.length, getEmbedded('WAVE'));`,
  ]);
  assert.deepEqual(outs[0]!.logs, ['41 {"a":[1,2]} W2']);
  assert.deepEqual(outs[1]!.logs, ["41 2 W2"], "the second script of the batch reads the first one's writes");
  assert.equal(s.answers.q_age, 30, "the live state is untouched: writes are requests");
});

test("S1b shim: write ordering — writes are returned in call order, values copied at the time of the call", () => {
  const outs = viaShim(def, filled(), null, [`const a = [1]; setCalc('A', a); a.push(2); set('q_seg', 'x'); setEmbedded('SOURCE', 'y'); flag('z'); setCalc('A', a);`]);
  assert.deepEqual(outs[0]!.writes, [
    { kind: "calculated", name: "A", value: [1] }, { kind: "answer", ref: "q_seg", value: "x", loopKey: null },
    { kind: "embedded", name: "SOURCE", value: "y" }, { kind: "flag", name: "z" }, { kind: "calculated", name: "A", value: [1, 2] },
  ]);
});

test("S1b shim: error(), log formatting, failures, loop guard, value, element getters, expr/pipe literals", () => {
  const outs = viaShim(def, filled(), null, [
    `error('bad', 'q_age'); error('page level'); log({ a: 1 }, null, 2, 'x');`,
    `throw new Error('boom')`,
    `let i = 0; while (true) { i++; }`,
    `log(value, getQuestion('q_age').id, getQuestion('nope'), getElement('p1') ? getElement('p1').kind : null, getOption('p1'));`,
    `log(expr('q_age + 1'), pipe('Age {{q_age}}'), expr(String('q_age')));`,
  ], 7);
  assert.deepEqual(outs[0]!.errors, [{ message: "bad", questionRef: "q_age" }, { message: "page level" }]);
  assert.deepEqual(outs[0]!.logs, ['{"a":1} null 2 x']);
  assert.equal(outs[1]!.failed, "boom");
  assert.match(outs[2]!.failed ?? "", /a loop ran more than/);
  assert.match(outs[3]!.logs[0]!, /^7 q_age null page null$/);
  assert.match(outs[4]!.logs[0]!, /expr\("q_age"\) is not available/, "a computed argument is said, once, when it is called");
  assert.equal(outs[4]!.logs[1], "31 Age 30 null");
  assert.deepEqual(literalCallArgs(`expr("a + b"); pipe('x {{Q}}'); expr(v); x.expr('no')`, "expr"), ["a + b"]);
});

test("S1b: the gate runs before any code is sent; a write scope is the script's declared scope", () => {
  const d = { ...def, scripts: [
    { id: "ok", name: "ok", scope: "page", ref: "p1", event: "on_submit", code: "setCalc('A', 1)", enabled: true },
    { id: "bad", name: "bad", scope: "page", ref: "p1", event: "on_submit", code: "(()=>{}).constructor('return globalThis')()", enabled: true },
  ] } as unknown as SurveyDefinition;
  const p = prepareLogicScripts(d, filled(), "on_submit", { scopeRef: ["p1"] });
  assert.deepEqual(p.scripts.map((s) => s.name), ["ok"]);
  assert.equal(p.refused[0]!.name, "bad");
  assert.ok(!JSON.stringify(p.scripts).includes("constructor"));
  assert.deepEqual(logicScriptScope({ scope: "page", ref: "p1" }), { kind: "page", pageId: "p1" });
  assert.deepEqual(logicScriptScope({ scope: "question", ref: "q_age" }), { kind: "question", questionId: "q_age" });
  assert.deepEqual(logicScriptScope({ scope: "survey" }), { kind: "survey" });
});

test("S1b: the production scripts' writes pass the engine channel (hidden list source, INVALID_BRANDS list, embedded, flags)", () => {
  const s = filled();
  const outs = viaShim(def, s, null, [SCRIPTS.c!, SCRIPTS.d!, SCRIPTS.l!, SCRIPTS.m!]);
  const refusals: string[] = [];
  for (const o of outs) for (const w of o.writes) {
    const r = applyScriptWrite(def, s, w, { scriptId: o.name, scope: { kind: "page", pageId: "p9" }, shown: ["q_age", "q_years_used"] });
    if (!r.ok) refusals.push(`${o.name}: ${r.reason}`);
  }
  assert.deepEqual(refusals, []);
  assert.deepEqual(s.calculated.INVALID_BRANDS, [{ code: "2", label: "40" }]);
  assert.deepEqual(s.answers.h_lf_source, [3, 1, 2]);
  assert.equal(s.embedded.SOURCE, "panel");
  assert.ok(s.flags.includes("implausible_years_used"));
});
