import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  translationInventory, maskText, unmaskTranslation, planTranslationBatches, segmentsOf, checkTranslationBatch, translationCoverage, pendingTranslationKeys,
  translationTaskActions, surveyStructureHash, pseudoTranslate, validateTranslatedUnit, languageFromName, coerceSurveyActions, applySurveyActions, localizeDefinition,
  translatableElements, setSourceText, type TranslationUnit,
} from "./index.js";

/*
 * TRANSLATION AS A TASK (2026-10-25) — the deterministic half: the inventory and its masking, adaptive batches with
 * translation memory, per-batch validation, completeness, resume and per-key invalidation, and the structure hash.
 */

const opts = (...ls: string[]) => ls.map((l, i) => ({ code: i + 1, label: l }));

/** every kind of respondent-facing text the survey can have */
function richSurvey() {
  const def = SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "Mobility study 2026", description: "About how you travel", version: "1.0" },
    embeddedData: [{ name: "brand", source: "url" }],
    questions: [
      { id: "q0", code: "CONSENT", variableName: "CONSENT", type: "single_select", text: "<p>Please read our <a href=\"https://example.org/privacy?x=1&amp;y=2\">privacy notice</a> before you continue.</p>", options: opts("I agree", "I do not agree") },
      { id: "q1", code: "Q1", variableName: "MODE", type: "single_select", text: "How do you usually travel to {{brand}}?", instruction: "Select one", options: [...opts("Car", "Bus", "Train"), { code: 97, label: "Other", flags: ["other_specify"] }], validation: [{ kind: "required", message: "Please choose how you travel." }] },
      { id: "q2", code: "Q2", variableName: "SAT", type: "matrix_single", text: "How satisfied are you with each? See Q1.", rows: [{ code: "r1", label: "Price" }, { code: "r2", label: "Comfort" }], options: opts("Very dissatisfied", "Dissatisfied", "Satisfied", "Very satisfied") },
      { id: "q3", code: "Q3", variableName: "ALLOC", type: "allocation", text: "Split 100 points across these. Your total so far: ${total}", rows: [{ code: "a", label: "Price" }, { code: "b", label: "Speed" }], settings: { affixText: "points" } },
      { id: "q4", code: "Q4", variableName: "NPS", type: "nps", text: "How likely are you to recommend us?", settings: { npsLeftLabel: "Not at all likely", npsRightLabel: "Extremely likely", scalePointLabels: { "5": "Neutral" } } },
      { id: "q5", code: "Q5", variableName: "AGE", type: "numeric", text: "What is your age?", settings: { placeholder: "e.g. 34" } },
      { id: "q6", code: "Q6", variableName: "WHY", type: "long_text", text: "Why? <script>window.x = 'do not translate';</script>", probe: { prompt: "You said {answer} — tell us more." } },
      { id: "q7", code: "Q7", variableName: "H", type: "hidden", text: "hidden text" },
    ],
    flow: [
      { type: "block", id: "b1", title: "Screening", children: [{ type: "page", id: "p1", questionIds: ["q0", "q1"] }] },
      { type: "block", id: "b2", title: "Experience", children: [{ type: "page", id: "p2", questionIds: ["q2", "q3", "q4", "q5", "q6"] }] },
      { type: "end", id: "e1", status: "screened", message: "Sorry, you do not qualify." },
      { type: "end", id: "e2", status: "complete", message: "Thank you for your time!" },
    ],
    quotas: [],
    deployment: { clientSlug: "c", studySlug: "s", languages: ["en"] },
  });
  const withPopup = apply(def, [{ op: "create_behavior", label: "Q1 popup", target: "Q1", on: "select_option", options: ["1"], effects: [{ do: "show_popup", title: "Thank you", text: "Thanks — drive safely.", placement: "center" }] }]);
  const b = withPopup.ux!.behaviors[0]!;
  b.id = "bh1";
  return withPopup;
}

/** a large survey: n questions of mixed types, with shared option wordings (translation memory) */
export function bigSurvey(n: number) {
  const questions: unknown[] = [];
  const pages: unknown[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `q${i}`, code = `Q${i}`;
    const k = i % 4;
    if (k === 0) questions.push({ id, code, variableName: `V${i}`, type: "matrix_single", text: `How much do you agree with statement set ${i}?`, rows: [{ code: "r1", label: `Statement ${i} alpha` }, { code: "r2", label: `Statement ${i} beta` }], options: opts("Disagree", "Neutral", "Agree") });
    else if (k === 1) questions.push({ id, code, variableName: `V${i}`, type: "single_select", text: `Question number ${i}: which option fits {{brand}} best?`, instruction: "Select one answer", options: opts("Yes", "No", "Not sure") });
    else if (k === 2) questions.push({ id, code, variableName: `V${i}`, type: "multi_select", text: `Which of these did you use in topic ${i}?`, options: [...opts(`Item ${i} one`, `Item ${i} two`), { code: 99, label: "None of these", flags: ["exclusive"] }] });
    else questions.push({ id, code, variableName: `V${i}`, type: "long_text", text: `Please describe your experience with area ${i} in a few words.` });
    pages.push({ type: "page", id: `p${i}`, questionIds: [id] });
  }
  return SurveyDefinition.parse({
    meta: { id: "big", code: "BIG", title: "Large tracker", version: "1.0" },
    embeddedData: [{ name: "brand", source: "url" }],
    questions,
    flow: [{ type: "block", id: "b1", title: "Main", children: pages }, { type: "end", id: "e", status: "complete", message: "Thank you!" }],
    deployment: { clientSlug: "c", studySlug: "big", languages: ["en"] },
  });
}

const apply = (def: SurveyDefinition, raw: unknown[]) => {
  const c = coerceSurveyActions(raw);
  assert.deepEqual(c.rejected, [], JSON.stringify(c.rejected));
  const r = applySurveyActions(def, c.actions, { now: "2026-10-25T00:00:00Z" });
  assert.deepEqual(r.errors, [], r.errors.join("; "));
  return r.def;
};

test("inventory: every respondent-facing string across question types — grids, constant sum, NPS anchors and point labels, validation, probe, popup + Close, end screens, block titles — and never a hidden variable", () => {
  const def = richSurvey();
  const inv = translationInventory(def);
  const keys = new Set(inv.units.map((u) => u.key));
  for (const k of [
    "meta:title", "meta:description", "q:q0:text", "q:q0:opt:1", "q:q1:text", "q:q1:instruction", "q:q1:opt:97", "q:q1:validation:0", "q:q2:row:r1", "q:q2:opt:4",
    "q:q3:text", "q:q3:row:a", "q:q3:affix", "q:q4:scale:npsLeftLabel", "q:q4:scale:npsRightLabel", "q:q4:scalept:5", "q:q5:placeholder", "q:q6:probe",
    "flow:b1:title", "flow:e1:message", "flow:e2:message", "ux:bh1:0:title", "ux:bh1:0:text", "ui:popup_close", "ui:other_specify", "ui:required", "ui:sum_target",
  ]) assert.ok(keys.has(k), `inventory has ${k}`);
  assert.ok(![...keys].some((k) => k.startsWith("q:q7:")), "a hidden variable is not respondent-facing");
  assert.ok(inv.protectedTokens >= 8, `protected tokens counted (${inv.protectedTokens})`);
  // a question scope: its elements only, no survey-level strings
  const small = translationInventory(def, { questionIds: ["q1"] });
  assert.ok(small.units.every((u) => u.questionId === "q1"));
  assert.equal(small.units.length, 7, small.units.map((u) => u.key).join(","));
  // replace mode leaves the interface strings out
  assert.ok(!translationInventory(def, { excludeUi: true }).units.some((u) => u.kind === "ui"));
});

test("masking: pipes, ${vars}, {params}, codes, HTML tags + attributes, entities, inline script, URLs and do-not-translate terms become sentinels — and come back byte-identical", () => {
  const src = "<p>Read <a href=\"https://example.org/p?a=1&amp;b=2\">this</a> about {{brand}} and ${total} — see Q1.R2, visit www.miures.com or mail help@miures.com. <script>var s = 'x';</script>{n} Miures</p>";
  const m = maskText(src, { keep: ["Miures"] });
  for (const t of ["{{brand}}", "${total}", "Q1.R2", "{n}", "Miures", "<script>var s = 'x';</script>", "&amp;", "www.miures.com", "help@miures.com"]) assert.ok(m.tokens.some((x) => x.includes(t)), `masked ${t}`);
  assert.ok(!/[{}<>$]/.test(m.masked.replace(/\{\d+\}/g, "")), `nothing protected left visible: ${m.masked}`);
  assert.ok(!/Miures|miures/.test(m.masked));
  // round-trip, with the sentinels moved around (word order changes in translation) — every token back, unchanged
  const ids = [...m.masked.matchAll(/\{(\d+)\}/g)].map((x) => x[0]);
  const translated = `${ids.reverse().join(" ")} ترجمہ`;
  const un = unmaskTranslation(translated, m.tokens);
  assert.ok(un.ok);
  for (const t of m.tokens) assert.ok(un.text.includes(t), `token back byte-identical: ${t}`);
  // a lost, a doubled and an invented sentinel are all caught
  assert.deepEqual(unmaskTranslation(translated.replace(ids[0], ""), m.tokens).missing.length, 1);
  assert.equal(unmaskTranslation(`${translated} ${ids[1]}`, m.tokens).duplicated.length, 1);
  assert.equal(unmaskTranslation(`${translated} {99}`, m.tokens).unknown.length, 1);
  // a string with nothing to translate is copy-through
  const inv = translationInventory(SurveyDefinition.parse({ meta: { id: "x", code: "X", title: "T", version: "1" }, questions: [{ id: "q", code: "Q", variableName: "Q", type: "single_select", text: "Age?", options: opts("18-24", "{{brand}}", "25+") }], flow: [{ type: "page", id: "p", questionIds: ["q"] }] }));
  assert.equal(inv.units.find((u) => u.key === "q:q:opt:1")!.copyThrough, true);
  assert.equal(inv.units.find((u) => u.key === "q:q:opt:2")!.copyThrough, true);
  assert.equal(inv.units.find((u) => u.key === "q:q:text")!.copyThrough, false);
});

test("batches: adaptive by count and characters, a question's elements together, identical strings translated once (translation memory)", () => {
  const def = bigSurvey(120);
  const inv = translationInventory(def);
  const segs = segmentsOf(inv.units);
  const translatable = inv.units.filter((u) => !u.copyThrough);
  assert.ok(segs.length < translatable.length, `memory: ${translatable.length} strings, ${segs.length} unique`);
  // "Select one answer" appears 30 times and is one segment
  assert.equal(segs.find((s) => s.masked === "Select one answer")!.keys.length, 30);
  const batches = planTranslationBatches(inv.units);
  assert.ok(batches.length >= 3, `${batches.length} batches`);
  for (const b of batches) assert.ok(b.segments <= 180 && b.chars <= 9000, JSON.stringify({ s: b.segments, c: b.chars }));
  // every translatable key in exactly one batch
  const all = batches.flatMap((b) => b.keys);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(new Set(all), new Set(translatable.map((u) => u.key)));
  // a question's elements are in one batch
  for (const q of def.questions) {
    const owners = new Set(batches.filter((b) => b.keys.some((k) => k.startsWith(`q:${q.id}:`) && !segs.find((s) => s.keys.includes(k))!.keys.some((x) => !x.startsWith(`q:${q.id}:`)))).map((b) => b.index));
    assert.ok(owners.size <= 1, `${q.code} split across ${[...owners]}`);
  }
  // a shared wording is translated AND written by one batch: its 30 keys are all in the batch of its first occurrence
  const shared = segs.find((s) => s.masked === "Select one answer")!;
  assert.equal(batches.filter((b) => shared.keys.some((k) => b.keys.includes(k))).length, 1);
  assert.ok(batches[0].keys.includes(shared.keys[29]));
  // deterministic
  assert.deepEqual(planTranslationBatches(inv.units), batches);
  // smaller caps → more, smaller batches
  assert.ok(planTranslationBatches(inv.units, { maxItems: 40, maxChars: 2000, minItems: 10 }).length > batches.length);
});

/** translate a batch the way the fake provider does: pseudo-Urdu over the masked text */
function translateBatch(units: TranslationUnit[], keys: string[], lang = "ur", tamper?: (seg: string, out: string) => string | undefined) {
  const set = new Set(keys);
  const segs = segmentsOf(units.filter((u) => set.has(u.key)));
  const returned: Record<string, string | undefined> = {};
  for (const s of segs) { const out = pseudoTranslate(s.masked, lang); returned[s.id] = tamper ? tamper(s.masked, out) : out; }
  return { segs, returned };
}

test("validation catches missing, corrupted (lost / doubled sentinel, changed placeholder), untranslated (identical), wrong script and duplicated answers — and accepts the rest", () => {
  const def = richSurvey();
  const inv = translationInventory(def);
  const keys = inv.units.filter((u) => u.questionId === "q1" || u.questionId === "q2").map((u) => u.key);
  const { segs, returned } = translateBatch(inv.units, keys, "ur", (src, out) => {
    if (src === "Select one") return undefined;                              // missing
    if (src.startsWith("How do you usually")) return out.replace(/\{0\}/, "");  // lost the {{brand}} sentinel
    if (src === "Car") return "Car";                                         // identical → untranslated? "Car" is brand-like (capitalised, short) → kept for review
    if (src === "Please choose how you travel.") return "Please choose how you travel."; // identical sentence → untranslated
    if (src === "Bus") return "Autobus";                                     // Latin letters in Urdu → wrong script
    if (src === "Dissatisfied") return pseudoTranslate("Satisfied", "ur");     // duplicate of another option
    return out;
  });
  const r = checkTranslationBatch(inv.units, segs, returned, "ur");
  const kinds = Object.fromEntries(r.issues.map((i) => [i.key, i.kind]));
  assert.equal(kinds["q:q1:instruction"], "missing");
  assert.equal(kinds["q:q1:text"], "corrupted");
  assert.equal(kinds["q:q1:validation:0"], "untranslated");
  assert.equal(kinds["q:q1:opt:2"], "wrong_script");
  assert.equal(kinds["q:q2:opt:2"], "duplicate");
  assert.equal(kinds["q:q2:opt:3"], "duplicate");
  assert.ok(r.accepted["q:q1:opt:1"] === "Car" && r.review.some((x) => x.key === "q:q1:opt:1"), "a brand-like identical word is kept and listed for review");
  assert.ok(r.accepted["q:q2:row:r1"] && /\p{Script=Arabic}/u.test(r.accepted["q:q2:row:r1"]));
  // the Q2 text's code Q1 came back as is
  assert.ok(r.accepted["q:q2:text"].includes("Q1"));
  // a translation that changes a protected part directly (not through sentinels)
  const u = inv.units.find((x) => x.key === "q:q1:text")!;
  assert.equal(validateTranslatedUnit(u, "کیسے {{brand2}}", "ur")?.kind, "corrupted");
  assert.equal(validateTranslatedUnit(u, "", "ur")?.kind, "empty");
});

test("resume: an interrupted run keeps every completed batch; only the missing keys are translated again — and a source edit invalidates exactly that key", () => {
  let def = bigSurvey(120);
  const inv = translationInventory(def);
  const batches = planTranslationBatches(inv.units);
  def = apply(def, [{ op: "add_language", code: "ur" }]);
  // copy-through first (no model)
  const copy = Object.fromEntries(inv.units.filter((u) => u.copyThrough).map((u) => [u.key, u.source]));
  if (Object.keys(copy).length) def = apply(def, translationTaskActions("ur", copy));
  const k = 2; // the run is killed while batch k is in flight
  const calls: number[] = [];
  const runBatch = (d: SurveyDefinition, b: (typeof batches)[number]) => {
    const pending = new Set(pendingTranslationKeys(d, "ur", inv.units.filter((u) => b.keys.includes(u.key))));
    if (!pending.size) return d;              // already done: no call
    calls.push(b.index);
    const { segs, returned } = translateBatch(inv.units, [...pending]);
    const r = checkTranslationBatch(inv.units, segs, returned, "ur");
    assert.deepEqual(r.issues, []);
    return apply(d, translationTaskActions("ur", r.accepted));
  };
  for (const b of batches) { if (b.index === k) break; def = runBatch(def, b); }
  const before = translationCoverage(def, "ur", inv.units);
  assert.ok(!before.complete && before.percent > 0 && before.percent < 100, `partial ${before.percent}%`);
  // resume from the persisted survey: every batch is run again, but the completed ones cost nothing
  const firstRun = calls.length;
  for (const b of batches) def = runBatch(def, b);
  assert.deepEqual(calls.slice(firstRun), batches.filter((b) => b.index >= k).map((b) => b.index), "only batch k onwards was translated again");
  const after = translationCoverage(def, "ur", inv.units);
  assert.equal(after.complete, true, JSON.stringify({ m: after.missing.slice(0, 5), i: after.invalid.slice(0, 3) }));
  assert.equal(after.percent, 100);
  assert.equal(after.rtl, true);
  // a source edit after translation: exactly that key is stale and pending
  def = apply(def, [{ op: "update_question", target: "Q5", text: "A changed wording for question five, which {{brand}} asked?" }]);
  const inv2 = translationInventory(def);
  assert.deepEqual(pendingTranslationKeys(def, "ur", inv2.units), ["q:q5:text"]);
  const cov = translationCoverage(def, "ur", inv2.units);
  assert.deepEqual(cov.stale, ["q:q5:text"]);
  assert.equal(cov.complete, false);
});

test("structure is untouched: logic, piping, scripts, ids and codes hash the same before and after a full Urdu version; the localized survey is in Urdu", () => {
  let def = richSurvey();
  const h0 = surveyStructureHash(def);
  const inv = translationInventory(def);
  def = apply(def, [{ op: "add_language", code: "ur" }]);
  const { segs, returned } = translateBatch(inv.units, inv.units.map((u) => u.key));
  const r = checkTranslationBatch(inv.units, segs, returned, "ur");
  const all = { ...r.accepted, ...Object.fromEntries(inv.units.filter((u) => u.copyThrough).map((u) => [u.key, u.source])) };
  def = apply(def, translationTaskActions("ur", all));
  assert.equal(surveyStructureHash(def), h0);
  const cov = translationCoverage(def, "ur", inv.units);
  assert.deepEqual(r.issues, []);
  assert.equal(cov.complete, true, JSON.stringify({ i: cov.invalid, m: cov.missing, s: cov.stale }));
  const ur = localizeDefinition(def, "ur");
  assert.ok(/\p{Script=Arabic}/u.test(ur.questions[1].text));
  assert.ok(ur.questions[1].text.includes("{{brand}}"));
  assert.ok(ur.questions[6].text.includes("<script>window.x = 'do not translate';</script>"), "the inline script is byte-identical");
  assert.ok(ur.questions[0].text.includes("href=\"https://example.org/privacy?x=1&amp;y=2\""), "the link and its attribute are byte-identical");
  assert.equal((ur.questions[4].settings as { scalePointLabels?: Record<string, string> }).scalePointLabels?.["5"], all["q:q4:scalept:5"]);
  // a wording change shows in the hash; a translation does not
  const changed = structuredClone(def); changed.questions[1].options![0].code = 11;
  assert.notEqual(surveyStructureHash(changed), h0);
});

test("replace the wording: replace_wording rewrites the source text by element key (codes, logic untouched), refuses a lost pipe, and can make the language the source", () => {
  let def = richSurvey();
  const h0 = surveyStructureHash(def);
  const inv = translationInventory(def, { excludeUi: true });
  const { segs, returned } = translateBatch(inv.units, inv.units.map((u) => u.key));
  const r = checkTranslationBatch(inv.units, segs, returned, "ur");
  def = apply(def, [...translationTaskActions("ur", r.accepted, "replace"), { op: "replace_wording", language: "ur", sourceLanguage: true, entries: [] }]);
  assert.equal(surveyStructureHash(def), h0, "only words changed");
  assert.ok(/\p{Script=Arabic}/u.test(def.questions[1].text) && def.questions[1].text.includes("{{brand}}"));
  assert.ok(/\p{Script=Arabic}/u.test(def.questions[2].rows![0].label));
  assert.equal(def.questions[1].options![3].code, 97);
  assert.equal(def.localization?.sourceLanguage, "ur");
  // a lost pipe is refused, the rest written
  const c = coerceSurveyActions([{ op: "replace_wording", language: "ur", entries: [{ target: "q:q1:text", text: "بغیر پائپ" }, { target: "q:q5:text", text: "عمر؟" }] }]);
  const out = applySurveyActions(def, c.actions, { now: "2026-10-25T00:00:00Z" });
  assert.equal(out.def.questions[5].text, "عمر؟");
  assert.ok(out.def.questions[1].text.includes("{{brand}}"));
  assert.ok(out.warnings.some((w) => /Not replaced/.test(w)), JSON.stringify(out.warnings));
});

test("setSourceText is the inverse of the element addressing, for every element of the inventory", () => {
  const def = richSurvey();
  for (const el of translatableElements(def)) {
    if (el.kind === "ui") { assert.equal(setSourceText(def, el.key, "x"), false); continue; }
    assert.equal(setSourceText(def, el.key, `NEW ${el.key}`), true, el.key);
  }
  const after = new Map(translatableElements(def).map((e) => [e.key, e.source]));
  for (const [k, v] of after) if (!k.startsWith("ui:")) assert.equal(v, `NEW ${k}`, k);
});

test("languages by name in any script", () => {
  assert.equal(languageFromName("Urdu"), "ur");
  assert.equal(languageFromName("اردو"), "ur");
  assert.equal(languageFromName("उर्दू"), "ur");
  assert.equal(languageFromName("Deutsch"), "de");
  assert.equal(languageFromName("klingon"), null);
});

test("a translation made from words the element no longer has is stored OUTDATED (never stamped current), and a replacement of changed wording is refused", () => {
  let def = richSurvey();
  const inv = translationInventory(def);
  const u = inv.units.find((x) => x.key === "q:q5:text")!;
  def = apply(def, [{ op: "add_language", code: "ur" }, { op: "update_question", target: "Q5", text: "How old are you today?" }]);
  def = apply(def, translationTaskActions("ur", { "q:q5:text": pseudoTranslate(u.masked, "ur") }, "version", { "q:q5:text": u.sourceHash }));
  assert.equal(def.localization!.translations.ur["q:q5:text"].status, "outdated");
  assert.deepEqual(pendingTranslationKeys(def, "ur", translationInventory(def).units.filter((x) => x.key === "q:q5:text")), ["q:q5:text"]);
  const c = coerceSurveyActions(translationTaskActions("ur", { "q:q5:text": "عمر؟" }, "replace", { "q:q5:text": u.sourceHash }));
  const out = applySurveyActions(def, c.actions, { now: "2026-10-25T00:00:00Z" });
  assert.equal(out.def.questions[5].text, "How old are you today?");
});
