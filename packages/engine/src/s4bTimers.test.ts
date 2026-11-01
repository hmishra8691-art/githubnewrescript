import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition, Question, ConditionSource } from "@rescript/schema";
import { applySurveyActions, coerceSurveyActions, SURVEY_ACTION_OPS, type SurveyAction } from "./surveyActions.js";
import { start } from "./flow.js";
import { createResponseState } from "./state.js";
import { checkSubmission } from "./serverValidation.js";
import { evaluateCondition } from "./evaluate.js";
import { parseLogicExpression, formatCondition } from "./logicExpression.js";
import { interpretRequest } from "./nlIntent.js";
import { lintSurveyLogic } from "./lintLogic.js";
import { nativeRouteFor, NATIVE_FEATURES } from "./capabilityRegistry.js";
import {
  advanceTimedOut, behaviorValue, clockView, deviceClass, formatClock, pageTimers, resolveTimer, setBehavior, timedOutSkips, timerKey, timerParadata, lintTimers,
} from "./timers.js";
import { behaviorFor, lintBehaviorConditions } from "./behaviorLint.js";
import "./index.js"; // the registered survey lints (timers, behaviour, SYSTEM_*)

/* S4b — native timers (GA-05, IM-19), behaviour conditions (LO-07), SYSTEM_* only where computed (D15 / TE-11) */

const q = (id: string, extra: Record<string, unknown> = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "single_select", text: id, required: true, options: [{ code: 1, label: "Yes" }, { code: 2, label: "No" }], settings: {}, ...extra });
const num = (id: string, extra: Record<string, unknown> = {}) => ({ id, code: id.toUpperCase(), variableName: id.toUpperCase(), type: "numeric", text: id, required: true, settings: {}, validation: [{ kind: "max_value", value: 10 }], ...extra });
const survey = (questions: unknown[], flow: unknown[]) => SurveyDefinition.parse({ meta: { id: "s4b", code: "S", title: "x" }, questions, flow: [...flow, { type: "end", id: "e", status: "complete" }] });

const timed = survey([q("q1"), num("q2"), q("q3")], [
  { type: "page", id: "p1", questionIds: ["q1", "q2"], timer: { limitSeconds: 30, onTimeout: "advance" } },
  { type: "page", id: "p2", questionIds: ["q3"] },
]);

test("S4b schema: timer on a question and on a page (defaults applied); behaviour sources parse; old surveys unchanged", () => {
  const page = timed.flow[0] as { timer?: { show: string; onTimeout: string; limitSeconds: number } };
  assert.deepEqual(page.timer, { limitSeconds: 30, show: "countdown", onTimeout: "advance" });
  const qt = Question.parse(q("x", { timer: { limitSeconds: 10, onTimeout: "lock", warnAtSeconds: 3, minSeconds: 2 } }));
  assert.equal(qt.timer?.onTimeout, "lock");
  assert.equal(Question.parse(q("y")).timer, undefined);
  assert.equal(ConditionSource.parse({ kind: "behavior", ref: "device" }).kind, "behavior");
  assert.throws(() => Question.parse(q("z", { timer: { limitSeconds: 0 } })));
  assert.equal(resolveTimer({ show: "countdown" }), null, "neither limit nor minimum = no timer");
});

test("S4b engine: pageTimers (page + question, loop suffix), clockView, paradata keys, formatClock", () => {
  const def = survey([q("q1", { timer: { limitSeconds: 10, show: "hidden" } }), q("q2")], [{ type: "page", id: "p1", questionIds: ["q1", "q2"], timer: { limitSeconds: 20, warnAtSeconds: 5, minSeconds: 3 } }]);
  const st = createResponseState(def);
  const nav = start(def, st, {});
  const step = nav.steps[nav.stepIndex] as never;
  const ts = pageTimers(def, step, def.questions);
  assert.deepEqual(ts.map((t) => [t.ref, t.key, t.scope]), [["p1", "TIMER_P1", "page"], ["Q1", "TIMER_Q1", "question"]]);
  assert.equal(timerKey("p1@apple"), "TIMER_P1_APPLE");
  const v = clockView(ts, 16.2);
  assert.equal(v.countdown?.ref, "p1"); // Q1's clock is hidden
  assert.equal(v.countdown?.remaining, 4);
  assert.equal(v.countdown?.warn, true);
  assert.deepEqual(v.expired.map((t) => t.ref), ["Q1"]);
  assert.equal(clockView(ts, 1).minWait, 2);
  assert.deepEqual(timerParadata(ts, 12.34, new Set(["Q1"])), { TIMER_P1_ELAPSED: 12.3, TIMER_P1_TIMED_OUT: 0, TIMER_Q1_ELAPSED: 12.3, TIMER_Q1_TIMED_OUT: 1 });
  assert.equal(formatClock(65), "1:05");
});

test("S4b advance on timeout: unanswered questions are skipped; an answered invalid one still stops the page", () => {
  const st = createResponseState(timed);
  const step = start(timed, st, {}).steps[0] as never;
  const ts = pageTimers(timed, step, timed.questions.slice(0, 2));
  const errs = [{ questionId: "q1", message: "required" }, { questionId: "q2", message: "too big" }];
  st.answers.q2 = 99;
  assert.equal(advanceTimedOut(ts, st.embedded), false);
  assert.equal(timedOutSkips(errs, st, step, ts, st.embedded).kept.length, 2, "no timeout → nothing skipped");
  st.embedded.TIMER_P1_TIMED_OUT = 1;
  const r = timedOutSkips(errs, st, step, ts, st.embedded);
  assert.deepEqual(r.skipped.map((e) => e.questionId), ["q1"]);
  assert.deepEqual(r.kept.map((e) => e.questionId), ["q2"]);
});

test("S4b replay: a timed-out advance page is not refused for missing answers; an invalid answer still is; no timeout → refused", () => {
  const prior = { seed: 1, sessionId: "s4b-replay-0001" };
  const post = (answers: Record<string, unknown>, embedded: Record<string, unknown>) => checkSubmission({ def: timed, prior, posted: { answers, embedded, stepIndex: 1, status: "in_progress" } });
  const refused = post({}, {});
  assert.equal(refused.ok, false);
  assert.ok(refused.hard.some((p) => p.code === "invalid_answer" && p.questionId === "q1"));
  const skipped = post({}, { TIMER_P1_TIMED_OUT: 1, TIMER_P1_ELAPSED: 30 });
  assert.equal(skipped.ok, true, JSON.stringify(skipped.hard));
  assert.deepEqual(skipped.soft.filter((p) => p.code === "timed_out").map((p) => p.questionId).sort(), ["q1", "q2"]);
  const invalid = post({ q2: 99 }, { TIMER_P1_TIMED_OUT: 1 });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.hard.some((p) => p.questionId === "q2"));
  /* a LOCK timer does not excuse a missing answer */
  const lock = survey([q("q1"), q("q3")], [{ type: "page", id: "p1", questionIds: ["q1"], timer: { limitSeconds: 5, onTimeout: "lock" } }, { type: "page", id: "p2", questionIds: ["q3"] }]);
  assert.equal(checkSubmission({ def: lock, prior, posted: { answers: {}, embedded: { TIMER_P1_TIMED_OUT: 1 }, stepIndex: 1, status: "in_progress" } }).ok, false);
});

test("S4b behaviour: the evaluator reads time on page, elapsed, device and timed_out", () => {
  const st = createResponseState(timed);
  const rule = (ref: string, operator: string, value: unknown, scope?: string) => ({ type: "rule", source: { kind: "behavior", ref, ...(scope ? { scope } : {}) }, operator, value }) as never;
  const ev = (c: never) => evaluateCondition(c, { def: timed, state: st });
  assert.equal(ev(rule("time_on_page", "gt", 5)), false, "unknown time is false (fail-closed)");
  setBehavior(st, { timeOnPage: 6, elapsed: 700, device: "mobile" });
  assert.equal(ev(rule("time_on_page", "gt", 5)), true);
  assert.equal(ev(rule("elapsed", "gte", 600)), true);
  assert.equal(ev(rule("device", "eq", "mobile")), true);
  assert.equal(ev(rule("device", "in", ["tablet", "desktop"])), false);
  assert.equal(ev(rule("timed_out", "eq", true)), false);
  st.embedded.TIMER_Q1_TIMED_OUT = 1;
  assert.equal(ev(rule("timed_out", "eq", true)), true);
  assert.equal(ev(rule("timed_out", "eq", true, "Q1")), true);
  assert.equal(ev(rule("timed_out", "eq", true, "p1")), false);
  assert.equal(behaviorValue("nope", undefined, st), null);
  assert.equal(deviceClass("Phone"), "mobile");
  assert.equal(deviceClass("watch"), undefined);
});

test("S4b grammar: time_on_page > 20, device = mobile, timed_out(.Q1) round-trip; a question code wins over the bare word", () => {
  for (const [text, printed] of [["time_on_page > 20", "time_on_page > 20"], ["device = mobile", "device = mobile"], ["elapsed >= 600 AND device != desktop", "elapsed >= 600 AND device != desktop"], ["timed_out", "timed_out = true"], ["timed_out.Q1", "timed_out.Q1 = true"], ["behavior.device = tablet", "device = tablet"]]) {
    const r = parseLogicExpression(timed, text);
    assert.deepEqual(r.errors, [], text);
    assert.equal(formatCondition(timed, r.condition), printed, text);
    const again = parseLogicExpression(timed, formatCondition(timed, r.condition));
    assert.deepEqual(again.condition, r.condition, `${text} round trip`);
  }
  assert.ok(parseLogicExpression(timed, "device").errors.length > 0, "device needs a comparison");
  const clash = survey([q("device")], [{ type: "page", id: "p1", questionIds: ["device"] }]);
  const asQ = parseLogicExpression(clash, "DEVICE = 1");
  assert.equal((asQ.condition as { source: { kind: string } }).source.kind, "question");
  const asB = parseLogicExpression(clash, "behavior.device = mobile");
  assert.equal(formatCondition(clash, asB.condition), "behavior.device = mobile");
});

test("S4b replay: time conditions are client-asserted (soft note, not refused); device is replayed from the stored class", () => {
  const def = survey([q("q1"), q("q2", { displayLogic: { type: "rule", source: { kind: "behavior", ref: "time_on_page" }, operator: "lt", value: 30 } }), q("q3", { displayLogic: { type: "rule", source: { kind: "behavior", ref: "device" }, operator: "eq", value: "mobile" } }), q("q4")], [
    { type: "page", id: "p1", questionIds: ["q1", "q2", "q3"] }, { type: "page", id: "p2", questionIds: ["q4"] },
  ]);
  const post = (device: string | null, answers: Record<string, unknown>) => checkSubmission({ def, prior: { seed: 1, sessionId: "s4b-replay-0002", device }, posted: { answers, stepIndex: 1, status: "in_progress" } });
  /* q2 (time) was shown in the browser and left unanswered — the server cannot know the time: soft, not refused */
  const t = post("desktop", { q1: 1 });
  assert.equal(t.ok, true, JSON.stringify(t.hard));
  assert.ok(t.soft.some((p) => p.code === "client_asserted" && !p.questionId), "the survey-level note");
  /* device is replayed: on mobile q3 is shown and required → refused when missing; on desktop it is hidden */
  const m = post("mobile", { q1: 1, q2: 1 });
  assert.equal(m.ok, false);
  assert.ok(m.hard.some((p) => p.questionId === "q3"));
  assert.equal(post("mobile", { q1: 1, q2: 1, q3: 2 }).ok, true);
  /* no stored class: device rules are client-asserted too */
  const u = post(null, { q1: 1, q2: 1 });
  assert.ok(u.ok, JSON.stringify(u.hard));
});

test("S4b set_timer: question and page, coerce gate, clear; IM recognisers; registry routes", () => {
  assert.ok((SURVEY_ACTION_OPS as readonly string[]).includes("set_timer"));
  const def = applySurveyActions(survey([], []), [{ op: "create_block", title: "Main" }, { op: "create_question", type: "single", text: "A?", options: ["x", "y"] }, { op: "create_question", type: "numeric", text: "B?" }] as SurveyAction[]).def;
  const run = (raw: unknown[], d = def) => { const c = coerceSurveyActions(raw); return { c, r: applySurveyActions(d, c.actions) }; };
  const a = run([{ op: "set_timer", target: "Q2", limitSeconds: 45, onTimeout: "lock", warnAtSeconds: 10 }]);
  assert.ok(a.r.valid, a.r.errors.join("; "));
  assert.deepEqual(a.r.def.questions.find((x) => x.code === "Q2")!.timer, { limitSeconds: 45, show: "countdown", onTimeout: "lock", warnAtSeconds: 10 });
  const p = run([{ op: "set_timer", target: "Q1", scope: "page", minSeconds: 10 }]);
  assert.ok(p.r.valid, p.r.errors.join("; "));
  const findPage = (nodes: unknown[]): { timer?: unknown } | undefined => { for (const n of nodes as { type: string; questionIds?: string[]; children?: unknown[]; timer?: unknown }[]) { if (n.type === "page" && n.timer) return n; const k = n.children ? findPage(n.children) : undefined; if (k) return k; } return undefined; };
  const pageNode = findPage(p.r.def.flow);
  assert.deepEqual(pageNode?.timer, { show: "countdown", onTimeout: "advance", minSeconds: 10 });
  assert.equal(coerceSurveyActions([{ op: "set_timer", target: "Q1", limitSeconds: 9999 }]).rejected.length, 1);
  assert.equal(coerceSurveyActions([{ op: "set_timer", target: "Q1" }]).rejected.length, 1);
  const cleared = run([{ op: "set_timer", target: "Q2", clear: true }], a.r.def);
  assert.equal(cleared.r.def.questions.find((x) => x.code === "Q2")!.timer, undefined);

  const sel = def.questions[0].id;
  for (const [text, expect] of [
    ["Give respondents 30 seconds on this page", { op: "set_timer", target: "Q1", scope: "page", limitSeconds: 30, show: "countdown", onTimeout: "advance" }],
    ["at least 10 seconds before Next", { op: "set_timer", target: "Q1", scope: "page", minSeconds: 10 }],
    ["Keep Next disabled for 5 seconds on the page of Q1", { op: "set_timer", target: "Q1", scope: "page", minSeconds: 5 }],
    ["Allow 2 minutes on this page and lock the answers when time is up", { op: "set_timer", target: "Q1", scope: "page", limitSeconds: 120, show: "countdown", onTimeout: "lock" }],
  ] as const) {
    const i = interpretRequest(def, text, { selectedId: sel });
    assert.equal(i.kind, "actions", `${text}: ${JSON.stringify(i).slice(0, 300)}`);
    assert.deepEqual(i.kind === "actions" ? i.actions : null, [expect], text);
  }
  assert.equal(interpretRequest(def, "Give respondents 30 seconds on this page").kind, "clarify", "no page known");
  assert.ok(nativeRouteFor("add a countdown timer to the page")?.actions.includes("set_timer"));
  assert.ok(nativeRouteFor("a 5 minute time limit")?.actions.includes("set_timer"), "the long-timer route is the native timer now");
  assert.ok(NATIVE_FEATURES.find((f) => f.id === "behaviour_conditions")!.need.test("show it only after the time on page passes 5 s"));
});

test("S4b lint: timers that cannot work; SYSTEM_* outside custom quality rules (fixture) points at the behaviour condition", () => {
  const bad = survey([q("q1", { timer: { limitSeconds: 10, warnAtSeconds: 10, minSeconds: 12 } })], [{ type: "page", id: "p1", questionIds: ["q1"], timer: { show: "countdown" } }]);
  const tl = lintTimers(bad).map((i) => i.message).join(" | ");
  assert.match(tl, /warning \(10s left\) is not shorter/);
  assert.match(tl, /minimum time \(12s\) is not shorter/);
  assert.match(tl, /neither a limit nor a minimum/);

  /* FIXTURE: a survey saved before S4b with SYSTEM_* in a display condition, a skip, a quota and a punch */
  const sys = (ref: string) => ({ type: "rule", source: { kind: "calculation", ref }, operator: "lt", value: 0.3 });
  const fixture = SurveyDefinition.parse({
    meta: { id: "fx", code: "FX", title: "fixture" },
    questions: [
      q("q1", { displayLogic: sys("SYSTEM_SPEEDER_SCORE") }),
      q("q2", { skipLogic: [{ id: "sk1", when: sys("SYSTEM_DEVICE_TYPE"), target: { kind: "end" } }] }),
      q("q3", { punches: [{ id: "pu1", when: sys("SYSTEM_ATTENTION_SCORE"), source: { kind: "codes", codes: [1] } }] }),
      q("q4", { displayLogic: { type: "rule", source: { kind: "behavior", ref: "device" }, operator: "eq", value: "watch" } }),
    ],
    flow: [{ type: "page", id: "p1", questionIds: ["q1", "q2", "q3", "q4"] }, { type: "end", id: "end", status: "complete" }],
    quality: { customRules: [{ id: "c1", name: "speeder", when: sys("SYSTEM_DURATION_RATIO") }] },
  });
  const issues = lintBehaviorConditions(fixture);
  const sysIssues = issues.filter((i) => /SYSTEM_/.test(i.message));
  assert.deepEqual(sysIssues.map((i) => i.questionCode), ["Q1", "Q2", "Q3"], "the custom quality rule itself is not flagged");
  assert.match(sysIssues[0].message, /SYSTEM_SPEEDER_SCORE.*time_on_page/);
  assert.match(sysIssues[1].message, /SYSTEM_DEVICE_TYPE.*device \(mobile/);
  assert.match(sysIssues[2].message, /Quality → Custom rules/);
  assert.ok(issues.some((i) => /device is compared with “watch”/.test(i.message)));
  assert.equal(behaviorFor("SYSTEM_TOTAL_DURATION")?.startsWith("time_on_page"), true);
  /* and the survey's own logic check carries them (registered lint) */
  const all = lintSurveyLogic(fixture).map((i) => i.message).join(" | ");
  assert.match(all, /SYSTEM_SPEEDER_SCORE/);
  assert.match(lintSurveyLogic(bad).map((i) => i.message).join(" | "), /not shorter than the limit/);
});
