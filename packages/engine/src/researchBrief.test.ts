import test from "node:test";
import assert from "node:assert/strict";
import { describeBrief, readResearchBrief } from "./researchBrief.js";

/* THE RESEARCH BRIEF, READ (IM1): the ten audit briefs and the master prompt's own sentence, and the edits that must not read as briefs */

test("the master prompt's healthcare sentence is a brief, read in full", () => {
  const b = readResearchBrief("I am conducting healthcare research among doctors in India. I need 1,000 completed responses, with age, specialty, and geographic quotas. I want a production-like test before launching the survey.");
  assert.equal(b.isBrief, true); assert.equal(b.survey, true);
  assert.equal(b.types[0], "healthcare");
  assert.equal(b.method, "quantitative");
  assert.equal(b.population, "doctors in India");
  assert.equal(b.professional, true);
  assert.equal(b.sampleSize, 1000);
  assert.deepEqual(b.countries, ["India"]);
  assert.deepEqual(b.quotas, ["age", "region", "specialty"]);
  assert.equal(b.testing, "production-like");
  assert.match(describeBrief(b), /^Healthcare · quantitative · doctors in India · n = 1,000 · India · quotas age, region, specialty · production-like test$|^Healthcare · quantitative · doctors in India · n = 1,000 · quotas age, region, specialty · production-like test$/);
  assert.ok(b.signals.some((s) => s.what === "sample size" && /1,000 completed responses/.test(s.words)));
});

const BRIEFS: [string, string, Partial<{ type: string; method: string; n: number; survey: boolean; loi: number; days: number; langs: string[]; methods: string[]; markets: number }>][] = [
  ["healthcare", "Design a 25-minute survey for 1,000 practising doctors in India on adoption of telemedicine: objectives, hypotheses on specialty and city tier, age/specialty/region quotas, consent screen, no back button, production-like test before launch.", { type: "healthcare", n: 1000, loi: 25, survey: true }],
  ["pharma", "Pharmaceutical research among 300 oncologists in Germany and France about a new biologic: treatment pathways, prescribing drivers, adverse-event concerns, and a MaxDiff on 10 product attributes; translate to German and French.", { type: "pharma", n: 300, langs: ["German", "French"], methods: ["maxdiff"] }],
  ["advertising", "Advertising effectiveness study: exposed vs control cells for a TV campaign in the UK, 800 completes per cell, ad recall, brand funnel, message takeout, with randomised ad exposure and quotas by age and gender.", { type: "advertising", n: 800, methods: ["ad_exposure"] }],
  ["consumer", "Consumer research on snacking habits among 1,500 urban Indian adults: usage and attitudes, brand awareness, purchase intent, a conjoint on pack size and price, and an open end on reasons.", { type: "consumer", n: 1500, methods: ["conjoint"] }],
  ["brand", "Brand tracking wave 3 for a bank in Singapore: awareness, consideration, usage, NPS, image statements, 600 completes monthly, compare against the previous wave.", { type: "brand", n: 600, methods: ["nps", "tracking"] }],
  ["political", "Political opinion poll in Maharashtra: voting intention, party favourability, issue importance, 2,000 completes with quotas by age, gender, region and urban/rural, and weighting to the census.", { type: "political", n: 2000 }],
  ["academic", "Academic study measuring the relation between perceived stress and academic performance among 400 university students, with validated scales (PSS-10), demographics, and an ethics consent page.", { type: "academic", n: 400, methods: ["validated_scale"] }],
  ["qual", "Create an in-depth interview guide for 20 interviews with first-time home buyers in Mumbai: opening, warm-up, decision journey, barriers, and closing, with probes, 60 minutes each.", { method: "qualitative", n: 20, survey: false, loi: 60 }],
  ["mixed", "Mixed-method study on employee engagement: 8 focus groups then a 15-minute survey for 3,000 employees across 5 countries, in English, Hindi and Spanish, with department and tenure quotas.", { type: "employee", method: "mixed", n: 3000, loi: 15, markets: 5, survey: true }],
  ["multi-country", "Multi-country consumer study in 12 countries with 1,000 completes each, local languages, country quotas, a global brand funnel and 60 questions.", { type: "consumer", n: 1000, markets: 12 }],
];

for (const [name, text, want] of BRIEFS) {
  test(`brief: ${name}`, () => {
    const b = readResearchBrief(text);
    assert.equal(b.isBrief, true, `${name}: ${JSON.stringify(b.signals)}`);
    if (want.type) assert.ok(b.types.includes(want.type as never), `${name} types ${b.types}`);
    if (want.method) assert.equal(b.method, want.method);
    if (want.n != null) assert.equal(b.sampleSize, want.n, `${name} n`);
    if (want.survey != null) assert.equal(b.survey, want.survey, `${name} survey`);
    if (want.loi != null) assert.equal(b.loiMinutes, want.loi);
    if (want.markets != null) assert.equal(b.marketCount, want.markets);
    for (const l of want.langs ?? []) assert.ok(b.languages.includes(l), `${name} ${l}`);
    for (const m of want.methods ?? []) assert.ok(b.methods.includes(m as never), `${name} ${m} in ${b.methods}`);
  });
}

test("fieldwork words: timeline, basis, constraints", () => {
  const b = readResearchBrief("Plan the fieldwork: 1,000 doctors in India, 15-minute survey, finish in three weeks, mobile-first, save and resume, no duplicates");
  assert.equal(b.timelineDays, 21); assert.equal(b.loiMinutes, 15); assert.equal(b.sampleSize, 1000);
  for (const c of ["mobileFirst", "saveResume", "duplicatePrevention"]) assert.ok(b.constraints.includes(c as never), c);
});

test("edits and questions are not briefs", () => {
  for (const s of [
    "Show Q5 only if Q3 is Yes", "Add a question about price", "Randomize the order of the options in Q2", "What does Q1 measure?",
    "Make the Next button dark blue", "Undo the last change", "Create a MaxDiff with 12 items and 10 tasks", "Translate the survey to Hindi",
    "Delete Q7", "Which test should I use to compare purchase intent across regions?", "Prepare a findings deck for the client",
  ]) assert.equal(readResearchBrief(s).isBrief, false, s);
});
