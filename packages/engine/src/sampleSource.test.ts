import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSurvey } from "@rescript/schema";
import {
  resolveSampleSource, sampleSourceLink,
  SOURCE_MAX_LENGTH, RESPONDENT_ID_MAX_LENGTH,
} from "./sampleSource.js";

function survey(sample?: { sourceParam?: string; respondentParam?: string }) {
  return parseSurvey({
    meta: { id: "S", title: "Study" },
    deployment: { clientSlug: "acme", studySlug: "study-001", ...(sample ? { sample } : {}) },
  });
}

test("the conventional parameter names work with no configuration at all", () => {
  const def = survey();
  assert.equal(resolveSampleSource(def, { src: "cint" }).source, "cint");
  assert.equal(resolveSampleSource(def, { source: "dynata" }).source, "dynata");
  assert.equal(resolveSampleSource(def, { panel: "toluna" }).source, "toluna");
  assert.equal(resolveSampleSource(def, { utm_source: "linkedin" }).source, "linkedin");
  assert.equal(resolveSampleSource(def, { pid: "abc-123" }).respondent, "abc-123");
  assert.equal(resolveSampleSource(def, { rid: "r9" }).respondent, "r9");
});

test("a link with no source at all records nothing rather than something invented", () => {
  const got = resolveSampleSource(survey(), { lang: "en", utm_campaign: "spring" });
  assert.equal(got.source, null);
  assert.equal(got.respondent, null);
});

test("the survey's configured parameter wins over the conventions", () => {
  const def = survey({ sourceParam: "vendor", respondentParam: "vid" });
  const got = resolveSampleSource(def, { vendor: "prodege", src: "cint", vid: "v1", pid: "p1" });
  assert.equal(got.source, "prodege");
  assert.equal(got.respondent, "v1");
  assert.equal(got.sourceParam, "vendor");
});

test("a configured parameter that the link does not carry falls back, so links already in the field keep working", () => {
  const def = survey({ sourceParam: "vendor" });
  assert.equal(resolveSampleSource(def, { src: "cint" }).source, "cint");
});

test("the same supplier written two ways stays one supplier", () => {
  const def = survey();
  // "Cint UK" arrives as %20 from one platform and + from another
  assert.equal(resolveSampleSource(def, { src: "Cint UK" }).source, "Cint UK");
  assert.equal(resolveSampleSource(def, { src: "Cint  UK" }).source, "Cint UK");
  assert.equal(resolveSampleSource(def, { src: "  Cint UK  " }).source, "Cint UK");
});

test("case is preserved — the database join is what makes Cint and cint one source", () => {
  assert.equal(resolveSampleSource(survey(), { src: "Cint" }).source, "Cint");
});

test("an empty or whitespace parameter is an absent one, not a source called nothing", () => {
  assert.equal(resolveSampleSource(survey(), { src: "" }).source, null);
  assert.equal(resolveSampleSource(survey(), { src: "   " }).source, null);
});

test("a repeated parameter takes the first value", () => {
  assert.equal(resolveSampleSource(survey(), { src: ["cint", "dynata"] }).source, "cint");
});

test("an absurdly long value is capped rather than refused — the interview matters more", () => {
  const long = "x".repeat(500);
  const got = resolveSampleSource(survey(), { src: long, pid: long });
  assert.equal(got.source?.length, SOURCE_MAX_LENGTH);
  assert.equal(got.respondent?.length, RESPONDENT_ID_MAX_LENGTH);
});

test("no parameters at all is not an error", () => {
  assert.deepEqual(resolveSampleSource(survey(), null), { source: null, respondent: null });
  assert.deepEqual(resolveSampleSource(survey(), undefined), { source: null, respondent: null });
});

test("no definition still captures — the conventions do not depend on configuration", () => {
  /*
   * A missing definition means "nothing was configured", not "capture
   * nothing". Reading it the other way round would mean any code path that
   * reached here without a parsed survey silently lost every source.
   */
  assert.equal(resolveSampleSource(null, { src: "cint" }).source, "cint");
});

test("a supplier link carries the source and leaves their macro literal", () => {
  const link = sampleSourceLink("https://survey.example.com/s/acme/study-001", "cint", {
    respondentPlaceholder: "[%pid%]",
  });
  assert.match(link, /[?&]src=cint/);
  // encoded, no panel platform substitutes it
  assert.ok(!link.includes("%5B%25pid%25%5D"), `macro was encoded: ${link}`);
  assert.ok(link.includes("pid=[%pid%]"), link);
});

test("a link that already has a query string keeps it", () => {
  const link = sampleSourceLink("https://survey.example.com/s/acme/study-001?lang=fr", "dynata");
  assert.match(link, /lang=fr/);
  assert.match(link, /src=dynata/);
});

test("the configured parameter names are used in the link the supplier is given", () => {
  const link = sampleSourceLink("https://x.test/s/a/b", "prodege", {
    sourceParam: "vendor", respondentParam: "vid", respondentPlaceholder: "{{RID}}",
  });
  assert.match(link, /vendor=prodege/);
  assert.ok(link.includes("vid={{RID}}"), link);
});
