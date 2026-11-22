import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { buildDataset, codedVariables, withCodedVariables, openEndSegments, answerText, runAnalysis, type AnalyticsRow, type QualCodebook, type QualExcerpt } from "./index.js";

/*
 * Q7 — VIDEO ANSWERS, TRANSCRIBED AND CODED, AS VARIABLES IN TABLES: the transcript on a video answer is read as an
 * open-ended answer; the codes a researcher (or the AI, labelled) put on it become 0/1 columns whose base is the
 * answers that were coded — a crosstab of a code by a segment runs on them.
 */
const def = SurveyDefinition.parse({
  meta: { id: "s", code: "S", title: "Kitchens" },
  questions: [
    { id: "q1", code: "S1", variableName: "REGION", type: "single_select", text: "Region", options: [{ code: 1, label: "North" }, { code: 2, label: "South" }] },
    { id: "v1", code: "V1", variableName: "V1", type: "upload", variant: "media.video_recording", text: "Show us your kitchen" },
  ],
  flow: [{ type: "block", id: "b", title: "B", children: [{ type: "page", id: "p", questionIds: ["q1", "v1"] }] }, { type: "end", id: "e", status: "complete" }],
});
const video = (text?: string) => ({ url: "/api/media/x", name: "r.webm", size: 10, type: "video/webm", ...(text ? { transcript: { text, source: "provider" } } : {}) });
const rows: AnalyticsRow[] = [
  { id: "r1", session_id: "s1", status: "complete", answers: { q1: 1, v1: video("The fridge is too small and too pricey") } },
  { id: "r2", session_id: "s2", status: "complete", answers: { q1: 1, v1: video("Lovely light in the morning") } },
  { id: "r3", session_id: "s3", status: "complete", answers: { q1: 2, v1: video("Too expensive to redo") } },
  { id: "r4", session_id: "s4", status: "complete", answers: { q1: 2, v1: video() } }, // not transcribed yet
  { id: "r5", session_id: "s5", status: "complete", answers: { q1: 2, v1: video("Small but fine") } }, // answered after the source was added
] as AnalyticsRow[];

const codebook: QualCodebook = { version: 3, method: "inductive", codes: [
  { id: "c1", name: "Price", definition: "cost", status: "human_reviewed", origin: "inductive", themeId: "t1" },
  { id: "c2", name: "Space", definition: "size", status: "ai_suggested", origin: "inductive" },
  { id: "c3", name: "Noise", definition: "", status: "rejected", origin: "inductive" },
], themes: [{ id: "t1", name: "Value", status: "human_reviewed" }], relationships: [] };
const ex = (id: string, codeId: string, rid: string, status: QualExcerpt["status"] = "human_reviewed"): QualExcerpt => ({ id, codeId, sourceKind: "response", sourceId: "src", segmentId: `${rid}:v1`, responseId: rid, charStart: 0, charEnd: 3, quote: "The", coder: "u1", status });

test("a video answer's transcript is read as an open-ended answer; one not transcribed is left out", () => {
  assert.equal(answerText(video("Hello")), "Hello");
  assert.equal(answerText([video("Hi")]), "Hi");
  assert.equal(answerText(video()), "");
  const segs = openEndSegments("src", rows.slice(0, 4).map((r) => ({ responseId: r.id!, answers: r.answers as Record<string, unknown> })), [{ id: "v1", code: "V1" }]);
  assert.deepEqual(segs.map((s) => s.id), ["r1:v1", "r2:v1", "r3:v1"]);
});

test("codes become 0/1 columns over the coded answers; rejected codes and excerpts are left out; later answers are missing, not 0", () => {
  const segs = openEndSegments("src", rows.slice(0, 4).map((r) => ({ responseId: r.id!, answers: r.answers as Record<string, unknown> })), [{ id: "v1", code: "V1" }])
    .map((s) => ({ segmentId: s.id, responseId: s.responseId!, questionId: s.questionId! }));
  const excerpts = [ex("e1", "c1", "r1"), ex("e2", "c2", "r1", "ai_suggested"), ex("e3", "c1", "r3"), ex("e4", "c3", "r2"), ex("e5", "c2", "r2", "rejected")];
  const coded = codedVariables(def, { codebook, excerpts }, segs);
  assert.deepEqual(coded.variables.map((v) => v.name), ["V1_CODED", "V1_PRICE", "V1_SPACE"]);
  assert.equal(coded.variables[1].label, "V1 — coded: Price (theme: Value)");
  assert.match(coded.variables[2].note!, /0 of 1 excerpts reviewed by a person/);
  assert.deepEqual(coded.values.get("r1"), { V1_CODED: 1, V1_PRICE: 1, V1_SPACE: 1 });
  assert.deepEqual(coded.values.get("r2"), { V1_CODED: 0, V1_PRICE: 0, V1_SPACE: 0 }, "coded with a rejected code only: read, nothing counted");
  assert.deepEqual(coded.values.get("r3"), { V1_CODED: 1, V1_PRICE: 1, V1_SPACE: 0 });
  assert.equal(coded.values.has("r4"), false);
  assert.deepEqual(coded.questions, [{ questionId: "v1", code: "V1", answers: 3, codes: 2, reviewedShare: 66.7 }]);

  const ds = withCodedVariables(buildDataset(def, rows, { spec: { environment: "ALL" } as never }), coded);
  const col = (id: string) => ds.cases.find((c) => c.id === id)!.vars.V1_PRICE;
  assert.deepEqual(["r1", "r2", "r3", "r4", "r5"].map(col), [1, 0, 1, null, null]);
  assert.equal(ds.cases.find((c) => c.id === "r1")!.vars.V1_TRANSCRIPT, "The fridge is too small and too pricey", "the transcript column is there too");

  /* a crosstab of the code by region: 1 of 2 coded North answers, 1 of 1 coded South answer */
  const r = runAnalysis({ name: "x", kind: "crosstab", dataset: { environment: "ALL" } as never, variables: ["V1_PRICE"], banner: ["REGION"] } as never, ds);
  assert.ok(!r.error, String(r.error));
  assert.equal(r.base.n, 3, "the base is the coded answers");
});

test("no coding or no coded source: nothing added", () => {
  const ds = buildDataset(def, rows, { spec: { environment: "ALL" } as never });
  assert.equal(withCodedVariables(ds, codedVariables(def, null, [])), ds);
  assert.equal(codedVariables(def, { codebook, excerpts: [] }, []).variables.length, 0);
});
