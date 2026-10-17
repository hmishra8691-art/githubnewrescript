import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  createResponseState, start, advance, compileFlow, resolvePiping, resolvePipingText, lintPipingTokens,
  coerceEmbedded, effectiveEmbeddedType, describeDetectedType, embeddedCatalog, EMBEDDED_TYPES,
  applyEmbeddedFieldInFlow, lintEmbeddedPiping, embeddedValueProblems, testEmbeddedValue, testReferences,
  setPipeClock, formatDatePattern, randomPipeValue, describeDevice, runtimePipeMeta,
  parsePipeBody, serializePipeToken, isSystemPipeRef, buildVariableDictionary,
  pipeSourceCatalog, searchPipeSources, buildRandomToken, withPipeFormat,
  lintSurveyLogic, coerceSurveyActions,
  type ResponseState,
} from "./index.js";

/*
 * SURVEY FLOW — EMBEDDED DATA (document 15/10/2026, items A, C, E, G).
 * Reproduced first: `ZIP_TEST = {{ed.ZIP_CODE}}` stored the literal text.
 */

afterEach(() => setPipeClock(null));

type Field = { name: string; source: "url" | "panel" | "static" | "expression"; value?: string; dataType?: string; defaultValue?: string };
const survey = (fields: Field[][], extra: Record<string, unknown> = {}) => SurveyDefinition.parse({
  meta: { id: "s1", code: "FLOWED", title: "Calories study", version: "1.2" },
  questions: [
    { id: "q1", code: "Q1", variableName: "Q1", type: "open_text", text: "Name?" },
    { id: "q2", code: "Q2", variableName: "Q2", type: "single_select", text: "Pick", options: [{ code: 1, label: "Apple" }, { code: 2, label: "Ben & Jerry" }] },
  ],
  flow: [
    ...fields.map((f, i) => ({ type: "embedded_data", id: `ed${i + 1}`, fields: f })),
    { type: "page", id: "p1", questionIds: ["q1", "q2"] },
    { type: "end", id: "end", status: "complete" },
  ],
  ...extra,
});
const run = (def: SurveyDefinition, state?: ResponseState) => {
  const s = state ?? createResponseState(def, { seed: 7, sessionId: "sess-1" });
  start(def, s);
  return s;
};

/* ------------------------------------------------------------- item A */

test("A: a Fixed value pipes — TOTAL_CALORIES = {{ed.LOWCAL_1}} stores 10, not the token", () => {
  const def = survey([[
    { name: "LOWCAL_1", source: "static", value: "10", dataType: "auto" },
    { name: "TOTAL_CALORIES", source: "static", value: "{{ed.LOWCAL_1}}", dataType: "integer" },
    { name: "ZIP_CODE", source: "url", dataType: "auto" },
    { name: "ZIP_TEST", source: "static", value: "{{ed.ZIP_CODE}}", dataType: "string" },
  ]]);
  const s = createResponseState(def, { seed: 7, embedded: { ZIP_CODE: "02108" } });
  run(def, s);
  assert.equal(s.embedded.LOWCAL_1, 10, "auto reads 10 as a number");
  assert.equal(s.embedded.TOTAL_CALORIES, 10, "the resolved value, typed by the field");
  assert.equal(s.embedded.ZIP_TEST, "02108", "the screenshot's case: the value, not \"{{ed.ZIP_CODE}}\"");
});

test("A: chained text values resolve in order, across and within elements", () => {
  const def = survey([
    [{ name: "CustomerName", source: "static", value: "Rahul", dataType: "auto" },
     { name: "FirstName", source: "static", value: "Asha", dataType: "auto" }],
    [{ name: "LastName", source: "static", value: "Rao", dataType: "auto" },
     { name: "GREETING", source: "static", value: "Customer: {{ed.CustomerName}}", dataType: "auto" },
     { name: "FULL_NAME", source: "static", value: "{{ed.FirstName}} {{ed.LastName}}", dataType: "string" },
     { name: "LABEL", source: "static", value: "{{ed.FULL_NAME}} ({{ed.GREETING}})", dataType: "auto" }],
  ]);
  const s = run(def);
  assert.equal(s.embedded.GREETING, "Customer: Rahul");
  assert.equal(s.embedded.FULL_NAME, "Asha Rao");
  assert.equal(s.embedded.LABEL, "Asha Rao (Customer: Rahul)", "a field piping fields that themselves piped");
});

test("A: the stored value is plain text — an answer with & is not stored as &amp;", () => {
  const def = survey([[], [{ name: "PICK", source: "static", value: "You chose {{Q2}}", dataType: "auto" }]]);
  // the second element runs after the page: move it there
  def.flow = [def.flow[0], def.flow[2], def.flow[1], def.flow[3]] as never;
  const s = createResponseState(def, { seed: 1 });
  start(def, s);
  s.answers.q2 = 2;
  advance(def, s);
  assert.equal(s.embedded.PICK, "You chose Ben & Jerry");
  assert.equal(resolvePipingText("{{Q2}}", { def, state: s }), "Ben & Jerry");
});

test("A: a missing reference follows calculationSettings.emptyEmbedded (zero / error / skip) and the default", () => {
  const fields: Field[] = [
    { name: "N", source: "static", value: "{{ed.NOPE}}", dataType: "integer" },
    { name: "T", source: "static", value: "Hello {{ed.FirstName}}!", dataType: "auto" },
    { name: "FirstName", source: "url", dataType: "auto" },
    { name: "D", source: "static", value: "{{ed.FirstName}}", dataType: "auto", defaultValue: "friend" },
  ];
  // zero (default): a lone numeric reference is 0, text reads the missing part as empty
  let s = run(survey([fields]));
  assert.equal(s.embedded.N, 0);
  assert.equal(s.embedded.T, "Hello !");
  assert.equal(s.embedded.D, "friend", "nothing resolved: the field's default value");
  // error: no value, and the reason recorded for the test console
  s = run(survey([fields], { calculationSettings: { emptyEmbedded: "error" } }));
  assert.equal(s.embedded.T, null);
  assert.match(s.calcErrors?.T ?? "", /Embedded Data field "FirstName" has no value at this point/);
  assert.match(s.calcErrors?.N ?? "", /Embedded Data field "NOPE" was not found\./);
  // skip: left exactly as it was
  const def = survey([fields], { calculationSettings: { emptyEmbedded: "skip" } });
  const st = createResponseState(def, { seed: 7 });
  st.embedded.T = "earlier";
  run(def, st);
  assert.equal(st.embedded.T, "earlier");
});

test("A: builder warnings — not found, and set later in the flow", () => {
  const def = survey([
    [{ name: "EARLY", source: "static", value: "{{ed.LATE}} and {{ed.FirstName}}", dataType: "auto" }],
    [{ name: "LATE", source: "static", value: "x", dataType: "auto" }, { name: "Z", source: "url" }],
  ]);
  const msgs = lintEmbeddedPiping(def).map((i) => i.message);
  assert.ok(msgs.some((m) => /"LATE" is only set later in the flow/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /Embedded Data field "FirstName" was not found\./.test(m)), msgs.join("\n"));
  assert.deepEqual(embeddedValueProblems(def, "{{ed.Z}} {{Q1}} {{date.today}}"), [], "URL fields, questions and system sources resolve");
  assert.match(embeddedValueProblems(def, "{{quota.nope.count}}")[0], /No quota named "nope"/);
});

test("A: an Integer field whose fixed value pipes is not a release error (it is read after resolving)", () => {
  assert.deepEqual(coerceEmbedded("integer", "{{ed.LOWCAL_1}}"), { value: null });
  assert.equal(coerceEmbedded("integer", "abc").error, '"abc" is not a number', "a real non-number still is");
});

test("A: an element inside a loop pipes the current iteration", () => {
  const def = survey([]);
  def.flow = [
    { type: "loop", id: "lp", loopVar: "brand", source: { kind: "static", items: [{ code: "a", label: "Apple" }, { code: "g", label: "Google" }] },
      children: [{ type: "embedded_data", id: "edl", fields: [{ name: "LAST_BRAND", source: "static", value: "{{loop.index}}:{{loop.label}}", dataType: "auto" }] }, { type: "page", id: "pl", questionIds: ["q1"] }] },
    { type: "end", id: "end", status: "complete" },
  ] as never;
  const s = createResponseState(def, { seed: 3 });
  start(def, s);
  assert.equal(s.embedded.LAST_BRAND, "1:Apple");
  const steps = compileFlow(def, s).filter((x) => x.kind === "embedded_data");
  assert.equal((steps[1] as any).loop.label, "Google", "each iteration's step carries its loop");
});

test("A: {{ed.RESPONSE_ID}} / {{ed.SURVEY_CODE}} — offered by the redirect picker, now resolved", () => {
  const def = survey([]);
  const s = createResponseState(def, { sessionId: "abc123" });
  assert.equal(resolvePiping("{{ed.RESPONSE_ID}}-{{ed.SURVEY_CODE}}", { def, state: s }), "abc123-FLOWED");
  assert.deepEqual(lintPipingTokens(def, "{{ed.RESPONSE_ID}}"), []);
  s.embedded.RESPONSE_ID = "own";
  assert.equal(resolvePiping("{{ed.RESPONSE_ID}}", { def, state: s }), "own", "a captured field of that name wins");
});

test("A: an over-quota redirect resolves its tokens", () => {
  const def = survey([], {
    quotas: [{ id: "qa", name: "All", cells: [{ id: "c", label: "all", when: { type: "group", op: "and", children: [] }, limit: 1 }] }],
  });
  def.flow = [{ type: "quota_check", id: "qc", quotaIds: ["qa"], onFull: { kind: "redirect", url: "https://x.com/over?rid={{response.id}}" } }, ...def.flow] as never;
  const s = createResponseState(def, { sessionId: "r 1" });
  const nav = start(def, s, { qa: { c: 1 } });
  assert.equal(nav.redirectUrl, "https://x.com/over?rid=r%201");
});

/* ------------------------------------------------------------- item G */

test("G: Auto detects integer / decimal / boolean / list / text — 02108 stays 02108", () => {
  assert.equal(EMBEDDED_TYPES[0].value, "auto", "Auto is offered first");
  assert.ok(EMBEDDED_TYPES.some((t) => t.value === "list"));
  assert.deepEqual(coerceEmbedded("auto", "25"), { value: 25 });
  assert.deepEqual(coerceEmbedded("auto", "25.75"), { value: 25.75 });
  assert.deepEqual(coerceEmbedded("auto", "TRUE"), { value: true });
  assert.deepEqual(coerceEmbedded("auto", "02108"), { value: "02108" });
  assert.deepEqual(coerceEmbedded("auto", "2000, 2001, 2002"), { value: "2000, 2001, 2002" });
  assert.deepEqual(coerceEmbedded("auto", "India"), { value: "India" });
  assert.deepEqual(coerceEmbedded("auto", 7), { value: 7 });
  assert.deepEqual(coerceEmbedded("list", "02108, 10001"), { value: "02108, 10001" });
  assert.equal(describeDetectedType("2000, 2001, 2002, 2003"), "List of 4 items");
  assert.equal(describeDetectedType("02108"), "Text — leading zero kept");
  assert.equal(describeDetectedType("25"), "Whole number");
});

test("G: a list under Integer says it is a list and suggests Auto or List", () => {
  const r = coerceEmbedded("integer", "2000, 2001, 2002");
  assert.equal(r.value, null);
  assert.match(r.error ?? "", /is a list of 3 items, not a single number — choose the Auto or List type/);
});

test("G: existing types behave exactly as before", () => {
  assert.deepEqual(coerceEmbedded(undefined, "02108"), { value: "02108" });
  assert.deepEqual(coerceEmbedded("string", " 25 "), { value: " 25 " });
  assert.deepEqual(coerceEmbedded("integer", "25"), { value: 25 });
  assert.deepEqual(coerceEmbedded("integer", "02108"), { value: 2108 }, "an explicit Integer still reads as a number");
  assert.equal(coerceEmbedded("url", "https://a.com/x?a=1,2").error, undefined, "a URL with commas is not a list");
});

test("G: effectiveEmbeddedType — explicit wins, Auto from the value, untyped is string", () => {
  const def = survey([[
    { name: "A", source: "url", dataType: "auto" }, { name: "I", source: "url", dataType: "integer" }, { name: "U", source: "url" },
  ]]);
  assert.equal(effectiveEmbeddedType(def, "A", 25), "integer");
  assert.equal(effectiveEmbeddedType(def, "A", "02108"), "string");
  assert.equal(effectiveEmbeddedType(def, "A", "1, 2"), "list");
  assert.equal(effectiveEmbeddedType(def, "A", undefined, { embedded: { A: 2.5 } }), "decimal");
  assert.equal(effectiveEmbeddedType(def, "I", "abc"), "integer");
  assert.equal(effectiveEmbeddedType(def, "U", 5), "string");
  assert.equal(embeddedCatalog(def).find((e) => e.name === "A")?.dataType, "auto");
});

test("G: the variable dictionary keeps Auto / List as text, says why, and leaves other fields alone", () => {
  const def = survey([[
    { name: "A", source: "url", dataType: "auto" }, { name: "L", source: "static", value: "1, 2", dataType: "list" }, { name: "I", source: "url", dataType: "integer" },
  ]]);
  const dict = buildVariableDictionary(def);
  const v = (n: string) => dict.find((x) => x.name === n)!;
  assert.equal(v("A").dataType, "text");
  assert.match(v("A").notes ?? "", /Auto type — .*02108 keep their leading zero/);
  assert.match(v("L").notes ?? "", /List — comma-separated/);
  assert.equal(v("I").notes, "url", "an explicit type's entry is unchanged");
});

test("G: a ZIP list stays text end to end (runtime)", () => {
  const def = survey([[{ name: "ZIPS", source: "static", value: "02108, 10001, 90210", dataType: "auto" }]]);
  const s = run(def);
  assert.equal(s.embedded.ZIPS, "02108, 10001, 90210");
});

/* ------------------------------------------------------------- item C sources */

test("C: date / time with formats, resolved and stored where the element runs", () => {
  setPipeClock(() => new Date(2026, 9, 17, 9, 5, 7)); // local time
  assert.equal(formatDatePattern(new Date(2026, 9, 17, 21, 5, 7), "dddd, D MMMM YYYY [at] hh:mm A"), "Saturday, 17 October 2026 at 09:05 PM");
  const def = survey([[
    { name: "TODAY", source: "static", value: "{{date.today|fmt:DD/MM/YYYY}}", dataType: "string" },
    { name: "STAMP", source: "static", value: "{{date.now}}", dataType: "auto" },
    { name: "YEAR", source: "static", value: "{{date.year}}", dataType: "auto" },
    { name: "WD", source: "static", value: "{{date.weekday}} {{date.time|fmt:hh:mm A}}", dataType: "auto" },
  ]]);
  const s = run(def);
  assert.equal(s.embedded.TODAY, "17/10/2026");
  assert.equal(s.embedded.STAMP, "2026-10-17 09:05:07");
  assert.equal(s.embedded.YEAR, 2026);
  assert.equal(s.embedded.WD, "Saturday 09:05 AM");
  const st = createResponseState(def);
  st.startedAt = new Date(2026, 0, 2, 3, 4, 5).toISOString();
  assert.equal(resolvePiping("{{date.start_date|fmt:MMM D, YYYY}} {{date.start_time}}", { def, state: st }), "Jan 2, 2026 03:04");
  assert.match(resolvePiping("{{date.unix}}", { def, state: st }), /^\d{10}$/);
});

test("C: random values — stable per respondent / session / loop, fresh per:each, and within range", () => {
  const def = survey([]);
  const a = createResponseState(def, { seed: 11, sessionId: "s-a" });
  const b = createResponseState(def, { seed: 11, sessionId: "s-a" });
  const tok = { ref: "random.int(1,1000)" };
  assert.equal(randomPipeValue(tok, a), randomPipeValue(tok, a), "same respondent, same value");
  assert.equal(randomPipeValue(tok, a), randomPipeValue(tok, b), "derived from the seed a resume keeps");
  const other = createResponseState(def, { seed: 12 });
  const draws = new Set(Array.from({ length: 20 }, (_, i) => randomPipeValue(tok, createResponseState(def, { seed: 100 + i }))));
  assert.ok(draws.size > 10, "different respondents draw different values");
  assert.notEqual(randomPipeValue({ ref: "random.uuid" }, a), randomPipeValue({ ref: "random.uuid" }, other));
  // respondent id: the same person gets the same value in a new session
  const r1 = createResponseState(def, { seed: 1, respondentId: "P-9" });
  const r2 = createResponseState(def, { seed: 2, respondentId: "P-9" });
  assert.equal(randomPipeValue(tok, r1), randomPipeValue(tok, r2));
  assert.notEqual(randomPipeValue({ ...tok, per: "session" }, r1), randomPipeValue({ ...tok, per: "session" }, r2));
  // loop: one value per iteration
  const l1 = { loopVar: "b", code: "a", label: "A", index: 1 }, l2 = { loopVar: "b", code: "g", label: "G", index: 2 };
  const perLoop = new Set(["a", "b", "c", "d", "e", "f"].map((c) => randomPipeValue({ ...tok, per: "loop" }, a, { ...l1, code: c })));
  assert.ok(perLoop.size > 1);
  assert.equal(randomPipeValue({ ...tok, per: "loop" }, a, l2), randomPipeValue({ ...tok, per: "loop" }, a, l2));
  // each: a new value every time
  const each = new Set(Array.from({ length: 30 }, () => randomPipeValue({ ref: "random.id(12)", per: "each" }, a)));
  assert.equal(each.size, 30);
  // key: two identical tokens can draw independently
  assert.notEqual(randomPipeValue({ ...tok, key: "x" }, a), randomPipeValue({ ...tok, key: "y" }, a));
  // ranges and shapes
  for (let i = 0; i < 200; i++) {
    const s = createResponseState(def, { seed: i });
    const n = Number(randomPipeValue({ ref: "random.int(5,7)" }, s));
    assert.ok(n >= 5 && n <= 7 && Number.isInteger(n));
    assert.match(randomPipeValue({ ref: "random.decimal(0,1,3)" }, s), /^0\.\d{3}$|^1\.000$/);
    assert.ok(["Red", "Green"].includes(randomPipeValue({ ref: "random.pick(Red, Green)" }, s)));
    assert.match(randomPipeValue({ ref: "random.id(6)" }, s), /^[A-Z0-9]{6}$/);
    assert.match(randomPipeValue({ ref: "random.bool" }, s), /^(true|false)$/);
    assert.match(randomPipeValue({ ref: "random.uuid" }, s), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  // stored once in Embedded Data, it survives (the value is what is stored)
  const d2 = survey([[{ name: "R", source: "static", value: "{{random.int(1,100)}}", dataType: "auto" }]]);
  const s2 = run(d2);
  assert.equal(typeof s2.embedded.R, "number");
});

test("C: survey metadata, device, distribution, quota tokens", () => {
  const def = survey([], {
    deployment: { clientSlug: "c", studySlug: "s", access: { mode: "unique_links" } },
    quotas: [{ id: "q_gender", name: "Gender", cells: [
      { id: "m", label: "Male", when: { type: "rule", source: { kind: "question", ref: "q2" }, operator: "eq", value: 1 }, limit: 50 },
      { id: "f", label: "Female", when: { type: "rule", source: { kind: "question", ref: "q2" }, operator: "eq", value: 2 }, limit: 50 },
    ] }],
  });
  const state = createResponseState(def, { sessionId: "sess-9", respondentId: "R-1" });
  state.answers.q2 = 2;
  state.meta = runtimePipeMeta({ channel: "test", language: "en", device: {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    screenWidth: 390, screenHeight: 844, viewportWidth: 390, viewportHeight: 700, language: "en-GB" } });
  const ctx = { def, state, quotaCounts: { q_gender: { m: 30, f: 45 } } };
  const pipe = (t: string) => resolvePiping(t, ctx);
  assert.equal(pipe("{{survey.name}} v{{survey.version}} ({{survey.id}}/{{survey.code}})"), "Calories study v1.2 (s1/FLOWED)");
  assert.equal(pipe("{{response.id}} {{response.respondent_id}} {{response.status}} {{response.language}}"), "sess-9 R-1 in_progress en");
  assert.equal(pipe("{{device.type}}/{{device.os}}/{{device.browser}}/{{device.screen}}/{{device.language}}"), "mobile/iOS/Safari/390x844/en-GB");
  assert.equal(pipe("{{distribution.channel}} {{distribution.link_type}}"), "test unique_links");
  assert.equal(pipe("{{quota.q_gender.count}}/{{quota.Gender.limit}} {{quota.q_gender.remaining}} {{quota.q_gender.percent}}% {{quota.q_gender.status}} {{quota.q_gender.cell}}"), "75/100 25 75% open Female");
  assert.equal(pipe("{{device.type}}"), "mobile");
  assert.equal(resolvePiping("{{device.type}}", { def, state: createResponseState(def) }), "", "no device reported: empty, never a guess");
  assert.equal(describeDevice({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0" }).browser, "Edge");
  assert.equal(describeDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 }).type, "tablet");
});

test("C: system names never take over a question coded like the namespace", () => {
  const def = survey([]);
  def.questions.push({ ...def.questions[1], id: "qd", code: "date", variableName: "date" } as never);
  const s = createResponseState(def);
  s.answers.qd = 1;
  assert.equal(resolvePiping("{{date.today}}", { def, state: s }), "Apple", "the question, as before system sources existed");
  assert.deepEqual(lintPipingTokens(def, "{{date.today}}"), []);
});

test("C: token grammar round-trips", () => {
  for (const t of ["{{date.today|fmt:DD/MM/YYYY}}", "{{random.int(1,100)|per:loop}}", "{{random.pick(A,B,C)|key:R2}}", "{{quota.q1.count}}", "{{device.os|upper}}"]) {
    const m = /^\{\{(.*)\}\}$/.exec(t)!;
    const p = parsePipeBody(m[1], t)!;
    assert.equal(p.kind, "system", t);
    assert.equal(serializePipeToken(p), t);
  }
  assert.equal(parsePipeBody("Q1.label")!.kind, "question");
  assert.equal(isSystemPipeRef("date.label"), false, "not a system key: still a question token");
  assert.equal(buildRandomToken("int", { min: "1", max: "10" }, "session"), "{{random.int(1,10)|per:session}}");
  assert.equal(buildRandomToken("pick", { values: "Red, Green" }), "{{random.pick(Red,Green)}}");
  assert.equal(withPipeFormat("{{date.today}}", "MMM D, YYYY"), "{{date.today|fmt:MMM D, YYYY}}");
  assert.match(lintPipingTokens(survey([]), "{{random.int(9,1)}}")[0], /minimum is larger/);
});

/* ------------------------------------------------------------- the menu catalog */

test("C: the Insert Piped Text catalog offers only what resolves, and says why the rest cannot", () => {
  const def = survey([[{ name: "LOWCAL_1", source: "static", value: "10", dataType: "auto" }, { name: "City", source: "url", dataType: "string" }]]);
  def.flow.push({ type: "loop", id: "lp", loopVar: "b", source: { kind: "static", items: [{ code: "a", label: "A" }] },
    references: { columns: [{ name: "Product_ID", dataType: "text" }], values: {} },
    children: [{ type: "embedded_data", id: "edin", fields: [] }] } as never);
  const cats = pipeSourceCatalog(def, { accept: "any", flowPosition: "ed1" });
  const by = (id: string) => cats.find((c) => c.id === id)!;
  assert.deepEqual(cats.map((c) => c.id), ["question", "embedded", "quota", "survey", "device", "loop", "datetime", "distribution", "geo", "random"]);
  assert.match(by("loop").disabled ?? "", /not inside a loop/);
  assert.match(by("quota").disabled ?? "", /no quotas/);
  assert.match(by("geo").items[0].disabled ?? "", /does not look up locations from IP/);
  assert.match(by("distribution").items.find((i) => i.id === "distribution.contact")!.disabled ?? "", /Anonymous link/);
  assert.deepEqual(by("embedded").items.map((i) => [i.label, i.token]), [["LOWCAL_1", "{{ed.LOWCAL_1}}"], ["City", "{{ed.City}}"]]);
  const q2 = by("question").items.find((i) => i.id === "q2")!;
  assert.deepEqual(q2.options!.map((o) => o.token), ["{{Q2}}", "{{Q2.value}}"]);
  const today = by("datetime").items.find((i) => i.id === "date.today")!;
  assert.ok(today.options!.some((o) => o.token === "{{date.today|fmt:DD/MM/YYYY}}"));

  const inLoop = pipeSourceCatalog(def, { flowPosition: "edin" });
  const loop = inLoop.find((c) => c.id === "loop")!;
  assert.equal(loop.disabled, undefined);
  assert.ok(loop.items.some((i) => i.token === "{{loop.Product_ID}}"), "the loop's own reference columns");

  const num = pipeSourceCatalog(def, { accept: "number" });
  const numEd = num.find((c) => c.id === "embedded")!.items.map((i) => i.label);
  assert.deepEqual(numEd, ["LOWCAL_1"], "a number field offers only numeric sources");
  assert.ok(num.find((c) => c.id === "question")!.items.every((i) => i.options!.every((o) => o.valueType === "number")));
  assert.match(num.find((c) => c.id === "device")!.disabled ?? "", /takes a number/);

  const calc = pipeSourceCatalog(def, { accept: "number", syntax: "calc" });
  assert.equal(calc.find((c) => c.id === "embedded")!.items[0].token, "ed.LOWCAL_1", "the Calc DSL's own syntax");
  assert.match(calc.find((c) => c.id === "datetime")!.disabled ?? "", /calculation language cannot read this/);

  const hits = searchPipeSources(cats, "lowcal");
  assert.equal(hits[0].item.token, "{{ed.LOWCAL_1}}");
  assert.ok(searchPipeSources(cats, "dd/mm").some((h) => h.item.token === "{{date.today|fmt:DD/MM/YYYY}}"));
});

/* ------------------------------------------------------------- item E */

test("E: Test Value resolves with SAMPLE data and warns on an invalid reference", () => {
  const def = survey([[{ name: "LOWCAL_1", source: "static", value: "10", dataType: "auto" }, { name: "CustomerName", source: "url" }]]);
  const field = { name: "T", source: "static" as const, value: "Customer: {{ed.CustomerName}} — {{ed.FirstName}} ({{ed.LOWCAL_1}})", dataType: "auto" as const };
  const refs = testReferences(def, field);
  assert.deepEqual(refs.map((r) => [r.ref, r.suggested ?? null, r.problem ?? null]), [
    ["CustomerName", null, null],
    ["FirstName", null, 'Embedded Data field "FirstName" was not found.'],
    ["LOWCAL_1", "10", null],
  ]);
  const r = testEmbeddedValue(def, field, { "{{ed.CustomerName}}": "Rahul" });
  assert.equal(r.sample, true);
  assert.equal(r.resolved, "Customer: Rahul —  (10)");
  assert.equal(r.stored, "Customer: Rahul —  (10)");
  assert.ok(r.warnings.includes('Embedded Data field "FirstName" was not found.'));
  const n = testEmbeddedValue(def, { name: "TOTAL", source: "static", value: "{{ed.LOWCAL_1}}", dataType: "integer" }, {});
  assert.equal(n.stored, 10);
  assert.equal(n.storedType, "integer");
  const e = testEmbeddedValue(def, { name: "E", source: "expression", value: "LOWCAL_1 * 2", dataType: "auto" }, { LOWCAL_1: "21" });
  assert.equal(e.stored, 42, "a calculation is tested with the same sample data");
});


test("the survey's own logic check carries the piped Embedded Data warnings (missing / set later in the flow)", () => {
  const def = survey([[{ name: "TOTAL", source: "static", value: "{{ed.NOPE}}" }]]);
  const w = lintSurveyLogic(def).filter((i) => i.questionCode === "Flow");
  assert.equal(w.length, 1);
  assert.equal(w[0].level, "warning", "a warning — it does not block deploying");
  assert.match(w[0].message, /NOPE/);
  assert.equal(w[0].objectKey, "flowNode:ed1");
  assert.equal(lintSurveyLogic(survey([[{ name: "A", source: "static", value: "10" }], [{ name: "B", source: "static", value: "{{ed.A}}" }]])).filter((i) => i.questionCode === "Flow").length, 0);
});

test("Intelligent Mode may create Embedded Data fields with the new auto / list types", () => {
  for (const t of ["list", "auto"]) {
    const r = coerceSurveyActions([{ op: "update_embedded", name: "ZIP", dataType: t }]);
    assert.equal(r.rejected.length, 0, JSON.stringify(r.rejected));
    assert.equal((r.actions[0] as { dataType?: string }).dataType, t);
  }
  assert.equal(coerceSurveyActions([{ op: "update_embedded", name: "ZIP", dataType: "zipcode" }]).rejected.length, 1, "an unknown type is still refused");
});
