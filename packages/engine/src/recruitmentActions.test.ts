import test from "node:test";
import assert from "node:assert/strict";
import type { SurveyDefinition } from "@rescript/schema";
import {
  applyRecruitmentAction, audienceWords, coerceRecruitmentAction, countryCode,
  describeRecruitmentAction, isRecruitmentOp, recruitmentDiff,
} from "./recruitmentActions.js";

const def = (): SurveyDefinition => ({
  id: "s", version: "1", title: "T", questions: [], flow: [{ type: "end", id: "e", status: "complete" }],
} as unknown as SurveyDefinition);

const coerce = (o: Record<string, unknown>) => coerceRecruitmentAction("define_audience", o);

test("the ops are registered and nothing else is claimed", () => {
  assert.equal(isRecruitmentOp("define_audience"), true);
  assert.equal(isRecruitmentOp("clear_audience"), true);
  assert.equal(isRecruitmentOp("connect_panel"), false);
  assert.equal(coerceRecruitmentAction("connect_panel", {}), null, "another module's op is not ours to coerce");
});

test("countries are codes, names, or a comma-separated string — and never a guess", () => {
  assert.equal(countryCode("US"), "US");
  assert.equal(countryCode("us"), "US");
  assert.equal(countryCode("United States"), "US");
  assert.equal(countryCode("Great Britain"), "GB");
  assert.equal(countryCode("uk"), "GB", "UK looks like a code and is not one — GB is");
  assert.equal(countryCode("Deutschland"), "DE");
  assert.equal(countryCode("Narnia"), null);
  assert.equal(countryCode(""), null);
});

test("an unrecognised country is an error, not a quietly dropped market", () => {
  const r = coerce({ audience: { demographics: { countries: ["US", "Freedonia"] } } });
  assert.equal(typeof r, "string");
  assert.match(r as string, /do not recognise .*Freedonia/);
  assert.match(r as string, /two-letter code/);
});

test("an audience with no country asks for one rather than pricing against nothing", () => {
  const r = coerce({ audience: { demographics: { ageMin: 25, ageMax: 45 } } });
  assert.equal(typeof r, "string");
  assert.match(r as string, /which country/i);
});

test("a comma-separated country string and duplicate names resolve to unique codes", () => {
  const r = coerce({ audience: { demographics: { countries: "US, United States, uk, GB" } } });
  assert.notEqual(typeof r, "string");
  assert.deepEqual((r as { audience: { demographics: { countries: string[] } } }).audience.demographics.countries, ["US", "GB"]);
});

test("an invalid specification is reported with the field, not swallowed", () => {
  const r = coerce({ audience: { demographics: { countries: ["US"], ageMin: 50, ageMax: 30 } } });
  assert.equal(typeof r, "string");
  assert.match(r as string, /ageMax|ageMin/);
});

test("defining an audience records what the researcher typed", () => {
  const r = coerce({ audience: { demographics: { countries: ["US"], ageMin: 25, ageMax: 45 } }, from: "US adults 25 to 45" });
  const d = def();
  const applied = applyRecruitmentAction(d, r as never);
  assert.equal(d.audience!.demographics.ageMin, 25);
  assert.equal(d.audience!.naturalLanguage, "US adults 25 to 45");
  assert.match(applied.description, /^Define the audience: US; aged 25–45/);
  assert.equal(applied.warnings.length, 0);
});

test("refining MERGES, so a filter the researcher is still paying for is not silently dropped", () => {
  const d = def();
  applyRecruitmentAction(d, coerce({ audience: { demographics: { countries: ["US"], ageMin: 25, ageMax: 45, incomeBands: ["$75k+"] } } }) as never);
  // a later turn says only "make it women" — the income band must survive it
  const applied = applyRecruitmentAction(d, coerce({ audience: { demographics: { countries: ["US"], genders: ["female"] } } }) as never);
  assert.deepEqual(d.audience!.demographics.incomeBands, ["$75k+"], "the income filter survived");
  assert.deepEqual(d.audience!.demographics.genders, ["female"]);
  assert.equal(d.audience!.version, 2);
  assert.match(applied.description, /^Refine the audience/);
  assert.match(applied.warnings.join(" "), /merged into the existing audience/);
});

test("replace starts from scratch when that is what was asked for", () => {
  const d = def();
  applyRecruitmentAction(d, coerce({ audience: { demographics: { countries: ["US"], incomeBands: ["$75k+"] } } }) as never);
  applyRecruitmentAction(d, coerce({ audience: { demographics: { countries: ["DE"] } }, replace: true }) as never);
  assert.deepEqual(d.audience!.demographics.countries, ["DE"]);
  assert.deepEqual(d.audience!.demographics.incomeBands, [], "replace means replace");
});

test("quota shares over 100% and multi-market audiences are warned about, not refused", () => {
  const d = def();
  const applied = applyRecruitmentAction(d, coerce({ audience: {
    demographics: { countries: ["US", "GB"] },
    quotas: [{ id: "m", label: "Men", target: 60, mode: "percent" }, { id: "w", label: "Women", target: 60, mode: "percent" }],
  } }) as never);
  assert.match(applied.warnings.join(" "), /add up to 120%/);
  assert.match(applied.warnings.join(" "), /2 markets/);
  assert.match(applied.warnings.join(" "), /priced against US/);
});

test("clearing is destructive and confirmed, and refuses when there is nothing to clear", () => {
  const d = def();
  assert.throws(() => applyRecruitmentAction(d, { op: "clear_audience" }), /no audience to clear/);
  applyRecruitmentAction(d, coerce({ audience: { demographics: { countries: ["US"] } } }) as never);
  const applied = applyRecruitmentAction(d, { op: "clear_audience" });
  assert.equal(d.audience, undefined);
  assert.ok(applied.destructive, "a destructive action is confirmed by the gate");
  assert.match(applied.warnings.join(" "), /keep the audience they were created with/);
});

test("the diff names the change in the words a change list uses", () => {
  const before = def(), after = def();
  assert.deepEqual(recruitmentDiff(before, after), []);
  applyRecruitmentAction(after, coerce({ audience: { demographics: { countries: ["US"], ageMin: 25, ageMax: 45 } } }) as never);
  assert.deepEqual(recruitmentDiff(before, after), ["Define the audience (US; aged 25–45)"]);
  const cleared = def();
  assert.deepEqual(recruitmentDiff(after, cleared), ["Clear the study's audience"]);
  assert.equal(describeRecruitmentAction({ op: "clear_audience" }), "Clear the study's audience");
});

test("the audience reads as facts in order, and an empty one says so", () => {
  assert.equal(audienceWords(undefined), "none");
  const r = coerce({ audience: {
    demographics: { countries: ["US"], ageMin: 25, ageMax: 45, genders: ["female"] },
    advanced: { industries: ["Automotive"], productOwnership: ["Car", "Van", "Truck", "Bus"] },
    screeners: [{ id: "s1", text: "Bought a car in the last year?", qualifyingAnswers: ["Yes"] }],
  } }) as Extract<ReturnType<typeof coerce>, { op: "define_audience" }>;
  assert.equal(
    audienceWords(r.audience),
    "US; aged 25–45; female; industry: Automotive; owns: Car, Van, Truck…; 1 screener",
  );
});
