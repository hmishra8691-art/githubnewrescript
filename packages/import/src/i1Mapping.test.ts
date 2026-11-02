import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { SurveyDefinition } from "@rescript/schema";
import { analyzeImport, classifyMapping, mappingSummary, readZip, ZIP_LIMITS, type CanonicalQuestion } from "./index.js";
import { qsfFixture } from "./fixtures.js";

/**
 * I1 — mapping decisions, the native page timer for Qualtrics Timing
 * questions, explicit guidance for Captcha / drill-down / highlight, and the
 * zip limits.
 */
let n = 0;
const uid = (p: string) => `${p}_${++n}`;
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const cq = (over: Partial<CanonicalQuestion>): CanonicalQuestion => ({ sourceId: "QID1", variable: "Q1", text: "t", kind: "single", sourceType: "MC/SAVR", options: [], rows: [], required: false, validation: [], skips: [], custom: [], confidence: "confirmed", notes: [], ...over });

test("classifyMapping: native, converted, unknown, guided types and custom JS each get their class", () => {
  assert.equal(classifyMapping(cq({})).decision, "exact");
  assert.equal(classifyMapping(cq({ confidence: "review", notes: ["selector X imported as a single choice"] })).decision, "components");
  assert.match(classifyMapping(cq({ confidence: "review", notes: ["why"] })).note, /why/);
  assert.equal(classifyMapping(cq({ kind: "unknown", sourceType: "Weird/X" })).decision, "unsupported");
  const cap = classifyMapping(cq({ kind: "unknown", sourceType: "Captcha/V2" }));
  assert.equal(cap.decision, "unsupported"); assert.match(cap.note, /no CAPTCHA/);
  assert.equal(classifyMapping(cq({ kind: "unknown", sourceType: "DD/DL" })).decision, "needs_runtime");
  /* a guided type that WAS converted keeps its guided class; one that came out unknown is unsupported, never "components" */
  assert.equal(classifyMapping(cq({ kind: "bucket", sourceType: "PGR/DragAndDrop", confidence: "review" })).decision, "components");
  assert.equal(classifyMapping(cq({ kind: "unknown", sourceType: "PGR/DragAndDrop" })).decision, "unsupported");
  assert.equal(classifyMapping(cq({ kind: "maxdiff", sourceType: "Matrix/MaxDiff", confidence: "review" })).decision, "components");
  const js = classifyMapping(cq({ custom: [{ language: "javascript", code: "x()", location: "QID1", role: "question JavaScript" } as never] }));
  assert.equal(js.decision, "needs_js");
  assert.deepEqual(mappingSummary([cap, js, classifyMapping(cq({}))]), { exact: 1, components: 0, needs_runtime: 0, needs_js: 1, unsupported: 1 });
});

test("report.mapping: one decision per source question, the fixture's Captcha named with its reason", async () => {
  const a = await analyzeImport(enc(qsfFixture()), "demo.qsf", { surveyId: "s1", uid });
  const r = a.report!;
  assert.equal(r.mapping.decisions.length, a.canonical!.questions.length);
  const cap = r.mapping.decisions.find((d) => d.sourceId === "QID11")!;
  assert.equal(cap.decision, "unsupported");
  const issue = a.result!.issues.find((i) => i.refs?.includes("QID11") && i.type === "unsupported");
  assert.ok(issue && /no CAPTCHA question/.test(issue.message), "the issue says why, not only that");
  const total = Object.values(r.mapping.summary).reduce((x, y) => x + y, 0);
  assert.equal(total, r.mapping.decisions.length);
  assert.ok(r.summary.some((s) => /Question types: \d+ native/.test(s)), "the summary states the classes");
});

function withQuestions(extra: Record<string, unknown>[], blockQids: string[]): Record<string, unknown> {
  const f = qsfFixture() as { SurveyElements: Record<string, unknown>[] };
  const bl = f.SurveyElements.find((e) => e.Element === "BL") as { Payload: { ID: string; BlockElements: unknown[] }[] };
  const end = bl.Payload.find((b) => b.ID === "BL_end")!;
  for (const id of blockQids) end.BlockElements.push({ Type: "Question", QuestionID: id });
  f.SurveyElements.push(...extra);
  return f;
}
const sq = (id: string, payload: Record<string, unknown>) => ({ SurveyID: "SV_demo", Element: "SQ", PrimaryAttribute: id, Payload: { QuestionID: id, ...payload } });

test("a Qualtrics Timing question becomes S4b's native page timer on its page (min submit + auto-advance)", async () => {
  const f = withQuestions([sq("QID50", { QuestionText: "Timing", DataExportTag: "T50", QuestionType: "Timing", Selector: "PageTimer", Configuration: { MinSeconds: "10", MaxSeconds: "45" }, Choices: { 1: { Display: "First Click" }, 2: { Display: "Last Click" }, 3: { Display: "Page Submit" }, 4: { Display: "Click Count" } } })], ["QID50"]);
  const a = await analyzeImport(enc(f), "timing.qsf", { surveyId: "s1", uid });
  const def = a.result!.def!;
  assert.ok(SurveyDefinition.safeParse(def).success);
  const t50 = def.questions.find((q) => q.variableName === "T50")!;
  const page = JSON.stringify(def.flow).length && findPageOf(def.flow as never, t50.id);
  assert.ok(page, "the timing question sits on a page");
  assert.deepEqual(page!.timer, { show: "hidden", onTimeout: "advance", limitSeconds: 45, minSeconds: 10 });
  assert.equal(a.result!.inventory.find((i) => i.feature === "timer" && i.sourceId === "QID50")?.status, "imported");
  /* 0 = off in Qualtrics: no timer at all */
  const g = withQuestions([sq("QID51", { QuestionText: "Timing", DataExportTag: "T51", QuestionType: "Timing", Selector: "PageTimer", Configuration: { MinSeconds: "0", MaxSeconds: "0" } })], ["QID51"]);
  const b = await analyzeImport(enc(g), "timing0.qsf", { surveyId: "s1", uid });
  const t51 = b.result!.def!.questions.find((q) => q.variableName === "T51")!;
  assert.equal(findPageOf(b.result!.def!.flow as never, t51.id)!.timer, undefined);
});

test("drill-down and highlight are refused with their specific guidance, never turned into a basic question", async () => {
  const f = withQuestions([
    sq("QID60", { QuestionText: "Pick a car", DataExportTag: "Car", QuestionType: "DD", Selector: "DL" }),
    sq("QID61", { QuestionText: "Highlight words", DataExportTag: "HL1", QuestionType: "HL", Selector: "Text" }),
  ], ["QID60", "QID61"]);
  const a = await analyzeImport(enc(f), "dd.qsf", { surveyId: "s1", uid });
  const dd = a.report!.mapping.decisions.find((d) => d.sourceId === "QID60")!;
  assert.equal(dd.decision, "needs_runtime"); assert.match(dd.note, /single\.cascade/);
  assert.equal(a.report!.mapping.decisions.find((d) => d.sourceId === "QID61")!.decision, "unsupported");
  const car = a.result!.def!.questions.find((q) => q.variableName === "Car")!;
  assert.match(car.text, /Not migrated/, "a placeholder, not a guessed single choice");
});

function findPageOf(nodes: { type: string; questionIds?: string[]; children?: unknown[]; branches?: { children: unknown[] }[]; otherwise?: unknown[]; timer?: unknown }[], qid: string): { timer?: unknown } | null {
  for (const n of nodes) {
    if (n.type === "page" && n.questionIds?.includes(qid)) return n;
    for (const kids of [n.children, ...(n.branches ?? []).map((b) => b.children), n.otherwise]) if (kids) { const f = findPageOf(kids as never, qid); if (f) return f; }
  }
  return null;
}

/* a minimal zip whose one entry is DEFLATEd, with the sizes it declares */
function deflatedZip(name: string, payload: Uint8Array, declare?: number): Uint8Array {
  const data = deflateRawSync(payload); const nm = new TextEncoder().encode(name);
  const usize = declare ?? payload.length;
  const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(8, 8, true); h.setUint32(18, data.length, true); h.setUint32(22, usize, true); h.setUint16(26, nm.length, true);
  const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(10, 8, true); c.setUint32(20, data.length, true); c.setUint32(24, usize, true); c.setUint16(28, nm.length, true); c.setUint32(42, 0, true);
  const local = 30 + nm.length + data.length, cd = 46 + nm.length;
  const e = new DataView(new ArrayBuffer(22)); e.setUint32(0, 0x06054b50, true); e.setUint16(8, 1, true); e.setUint16(10, 1, true); e.setUint32(12, cd, true); e.setUint32(16, local, true);
  const parts = [new Uint8Array(h.buffer), nm, data, new Uint8Array(c.buffer), nm, new Uint8Array(e.buffer)];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

test("zip limits: a zip bomb's ratio, an oversized part and a lying declared size are all refused", () => {
  /* 8 MB of zeros deflates to a few KB: ~1000:1 */
  const bomb = deflatedZip("word/document.xml", new Uint8Array(8 * 1024 * 1024));
  assert.throws(() => readZip(bomb), /zip bomb/);
  assert.throws(() => readZip(deflatedZip("a.xml", new Uint8Array(10), ZIP_LIMITS.maxEntryBytes + 1)), /over the 100 MB limit/);
  /* the declared size says 10 bytes, the data inflates to 2 MB of random-ish text: inflate stops at the cap instead of trusting the header */
  const text = new TextEncoder().encode(Array.from({ length: 200_000 }, (_, i) => (i * 7919 % 9973).toString(36)).join(""));
  const liar = readZip(deflatedZip("b.xml", text, 10));
  assert.equal(liar.get("b.xml")!.data().length, text.length, "below the cap the real content comes out");
  /* an honest normal part still reads */
  const ok = readZip(deflatedZip("c.xml", new TextEncoder().encode("<w:document/>")));
  assert.equal(new TextDecoder().decode(ok.get("c.xml")!.data()), "<w:document/>");
});

test("malformed QSF files fail gracefully: a reason, never an exception or a half survey passed off as whole", async () => {
  const good = JSON.stringify(qsfFixture());
  const cases: [string, string][] = [
    ["truncated", good.slice(0, Math.floor(good.length / 2))],
    ["empty object", "{}"],
    ["elements not a list", JSON.stringify({ SurveyEntry: { SurveyName: "x" }, SurveyElements: { a: 1 } })],
    ["null payloads", JSON.stringify({ SurveyEntry: { SurveyName: "x" }, SurveyElements: [{ Element: "SQ", PrimaryAttribute: "QID1", Payload: null }, { Element: "BL", Payload: null }, { Element: "FL", Payload: null }] })],
    ["flow names a missing block", JSON.stringify({ ...JSON.parse(good), SurveyElements: [...(JSON.parse(good).SurveyElements as Record<string, unknown>[]).filter((e) => e.Element !== "BL")] })],
  ];
  for (const [name, text] of cases) {
    const a = await analyzeImport(new TextEncoder().encode(text), `${name}.qsf`, { surveyId: "s1", uid });
    const issues = [...a.issues, ...(a.canonical?.issues ?? []), ...(a.result?.issues ?? [])];
    if (a.result?.def) assert.ok(SurveyDefinition.safeParse(a.result.def).success, `${name}: whatever was created is a valid survey`);
    assert.ok(issues.length > 0 || (a.result?.def?.questions.length ?? 0) === 0, `${name}: the reader says what was wrong`);
  }
  const t = await analyzeImport(new TextEncoder().encode(cases[0][1]), "t.qsf", { surveyId: "s1", uid });
  assert.ok([...t.issues, ...(t.canonical?.issues ?? [])].some((i) => /not valid JSON/.test(i.message)), "a truncated file is named as such");
});
