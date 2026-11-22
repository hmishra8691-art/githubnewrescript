import { test } from "node:test";
import assert from "node:assert/strict";
import { crossSurveyDuplicates, textsFromAnswers, type CrossSurveyRecord } from "./crossSurvey.js";

const FARM = "I really like how easy it is to use and the customer service team always helps me quickly when I call them.";
const rec = (surveyId: string, sessionId: string, identity: string | null, text: string, customerId = "c1"): CrossSurveyRecord => ({ customerId, surveyId, sessionId, identity, texts: [{ key: "q9", text }] });
const own = (i: number) => `My answer number ${i} is about the colour of the box, which I thought looked rather cheap compared with last year.`;

test("the same paragraph from different people in different surveys is reported; their own answers are not", () => {
  const r = crossSurveyDuplicates([
    rec("s1", "a", "t1", FARM), rec("s2", "b", "t2", FARM), rec("s3", "c", "t3", FARM.replace("quickly", "quickly!")),
    rec("s1", "d", "t4", own(1)), rec("s2", "e", "t5", own(2)), rec("s3", "f", "t6", own(3)),
  ]);
  assert.equal(r.findings.length, 1);
  const f = r.findings[0]!;
  assert.equal(f.kind, "text_reuse");
  assert.equal(f.strength, "strong");
  assert.deepEqual(f.surveys, ["s1", "s2", "s3"]);
  assert.equal(f.members.length, 3);
  assert.match(f.reason, /3 different respondents in 3 surveys/);
});

test("near-duplicates join; the same text inside one survey is the in-survey rule's job, not this one", () => {
  const near = FARM.replace("quickly when", "promptly when");
  const r = crossSurveyDuplicates([rec("s1", "a", "t1", FARM), rec("s2", "b", "t2", near)]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.strength, "moderate", "two respondents, not word for word");
  const one = crossSurveyDuplicates([rec("s1", "a", "t1", FARM), rec("s1", "b", "t2", FARM)]);
  assert.equal(one.findings.length, 0);
});

test("one person reusing their own paragraph is informational; short and generic answers are never evidence", () => {
  const self = crossSurveyDuplicates([rec("s1", "a", "t1", FARM), rec("s2", "b", "t1", FARM)]);
  assert.equal(self.findings[0]!.kind, "same_person_reuse");
  assert.equal(self.findings[0]!.riskScore, 0);
  const short = crossSurveyDuplicates([rec("s1", "a", "t1", "very good product overall"), rec("s2", "b", "t2", "very good product overall")]);
  assert.equal(short.findings.length, 0);
  assert.equal(short.compared.texts, 0);
});

test("boilerplate shared by very many sessions across many surveys is dropped with a note", () => {
  const recs = Array.from({ length: 60 }, (_, i) => rec(`s${i % 6}`, `x${i}`, `t${i}`, FARM));
  const r = crossSurveyDuplicates(recs);
  assert.equal(r.findings.length, 0);
  assert.match(r.notes[0]!, /60 sessions in 6 surveys was treated as boilerplate/);
});

test("one trust id behind several participant IDs of one vendor; the signature is stable", () => {
  const recs = [rec("s1", "a", "t1", own(1)), rec("s2", "b", "t1", own(2))];
  const maps = [{ customerId: "c1", identity: "t1", integrationId: "v1", participantId: "P-1" }, { customerId: "c1", identity: "t1", integrationId: "v1", participantId: "P-2" }, { customerId: "c1", identity: "t9", integrationId: "v1", participantId: "P-9" }];
  const r = crossSurveyDuplicates(recs, maps);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.kind, "pid_switch");
  assert.deepEqual(r.findings[0]!.participantIds, ["P-1", "P-2"]);
  assert.equal(crossSurveyDuplicates(recs, [...maps].reverse()).findings[0]!.signature, r.findings[0]!.signature);
});

test("two organisations are never compared", () => {
  assert.throws(() => crossSurveyDuplicates([rec("s1", "a", "t1", FARM, "c1"), rec("s2", "b", "t2", FARM, "c2")]), /one organisation/);
});

test("free text is read out of stored answers; codes and labels are not", () => {
  const t = textsFromAnswers({ q1: "2", q2: ["1", "3"], q3: FARM, grid: { r1: "4", other: own(5) }, q4: "Too short to count" });
  assert.deepEqual(t.map((x) => x.key), ["q3", "grid.other"]);
});
