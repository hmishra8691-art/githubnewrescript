import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewBackTranslation, reconcileBackTranslation, type BackItem } from "./backTranslation.js";

/*
 * THE PLANTED-SHIFT CORPUS (audit P2-09 gate: "planted meaning shifts flagged"). Spanish translations of survey
 * strings with their English back-translations. The faithful ones have ordinary rewording ("buy" for "purchase",
 * word order); the planted ones each change the meaning in one way a reviewer must catch.
 */
const FAITHFUL: BackItem[] = [
  { key: "q1", source: "How satisfied are you with our customer service?", translation: "¿Qué tan satisfecho está con nuestro servicio al cliente?", back: "How satisfied are you with our customer service?" },
  { key: "q2", source: "In the past 12 months, how many times have you purchased online?", translation: "En los últimos 12 meses, ¿cuántas veces ha comprado en línea?", back: "In the last 12 months, how many times have you bought online?" },
  { key: "q3", source: "Please do not include purchases made for work.", translation: "Por favor, no incluya las compras hechas para el trabajo.", back: "Please do not include purchases made for work." },
  { key: "q4", source: "Strongly agree", translation: "Totalmente de acuerdo", back: "Completely agree" },
  { key: "q5", source: "Which of these brands, if any, have you heard of?", translation: "¿De cuáles de estas marcas, si alguna, ha oído hablar?", back: "Which of these brands, if any, have you heard about?" },
  { key: "q6", source: "You said you shop at {{Q3}}. Why do you prefer it?", translation: "Usted dijo que compra en {{Q3}}. ¿Por qué lo prefiere?", back: "You said you shop at {{Q3}}. Why do you prefer it?" },
  { key: "q7", source: "Very unlikely", translation: "Muy poco probable", back: "Very unlikely" },
  { key: "q8", source: "Are you 18 years of age or older?", translation: "¿Tiene 18 años o más?", back: "Are you 18 years old or older?" },
];

const PLANTED: (BackItem & { expect: string })[] = [
  { key: "p_number", expect: "number", source: "Are you 18 years of age or older?", translation: "¿Tiene 16 años o más?", back: "Are you 16 years old or older?" },
  { key: "p_negation", expect: "negation", source: "Please do not include purchases made for work.", translation: "Por favor, incluya las compras hechas para el trabajo.", back: "Please include purchases made for work." },
  { key: "p_polarity", expect: "polarity", source: "Strongly disagree", translation: "Totalmente de acuerdo", back: "Completely agree" },
  { key: "p_satisfied", expect: "polarity", source: "How dissatisfied were you with the delivery?", translation: "¿Qué tan satisfecho quedó con la entrega?", back: "How satisfied were you with the delivery?" },
  { key: "p_placeholder", expect: "placeholder", source: "You said you shop at {{Q3}}. Why do you prefer it?", translation: "Usted dijo que compra en esa tienda. ¿Por qué la prefiere?", back: "You said you shop at that store. Why do you prefer it?" },
  { key: "p_untranslated", expect: "untranslated", source: "Which of these brands have you heard of?", translation: "Which of these brands have you heard of?", back: "Which of these brands have you heard of?" },
  { key: "p_drift", expect: "drift", source: "How easy was it to find the product you were looking for on our website?", translation: "¿Le gustó nuestro sitio?", back: "Did you like our site?" },
  { key: "p_intensity", expect: "intensity", source: "Very likely", translation: "Probable", back: "Likely" },
  { key: "p_period", expect: "number", source: "In the past 12 months, how many times have you purchased online?", translation: "En los últimos 2 meses, ¿cuántas veces ha comprado en línea?", back: "In the last 2 months, how many times have you bought online?" },
  { key: "p_likely", expect: "polarity", source: "How likely are you to recommend us?", translation: "¿Qué tan improbable es que nos recomiende?", back: "How unlikely is it that you would recommend us?" },
];

test("every planted meaning shift is flagged, with the kind it was planted as; faithful rewording is not", () => {
  const r = reviewBackTranslation([...FAITHFUL, ...PLANTED], { language: "es", now: "2026-11-18T00:00:00Z" });
  for (const p of PLANTED) {
    const it = r.items.find((x) => x.key === p.key)!;
    assert.notEqual(it.status, "ok", `${p.key} must be flagged`);
    assert.ok(it.issues.some((i) => i.kind === p.expect), `${p.key}: expected ${p.expect}, got ${JSON.stringify(it.issues)}`);
  }
  for (const f of FAITHFUL) {
    const it = r.items.find((x) => x.key === f.key)!;
    assert.equal(it.status, "ok", `${f.key} is faithful: ${JSON.stringify(it.issues)}`);
  }
  assert.equal(r.counts.ok, FAITHFUL.length);
  /* the language score: ok strings, review counting half */
  const expected = Math.round(((r.counts.ok + r.counts.review * 0.5) / r.items.length) * 100);
  assert.equal(r.score, expected);
  assert.ok(r.score < 60, `a language with ten bad strings in eighteen scores low (${r.score})`);
  assert.equal(reviewBackTranslation(FAITHFUL, { language: "es" }).score, 100);
});

test("glossary: an agreed wording not used is flagged; a term the glossary keeps as it is is not 'untranslated'", () => {
  const g = [{ source: "customer service", target: "atención al cliente" }, { source: "Netflix", target: "Netflix" }];
  const r = reviewBackTranslation([
    { key: "a", source: "How satisfied are you with our customer service?", translation: "¿Qué tan satisfecho está con nuestro servicio al cliente?", back: "How satisfied are you with our customer service?" },
    { key: "b", source: "Netflix", translation: "Netflix", back: "Netflix" },
  ], { language: "es", glossary: g });
  assert.ok(r.items[0].issues.some((i) => i.kind === "glossary"));
  assert.equal(r.items[1].status, "ok");
});

test("reconciliation: every flagged string is decided; keeping a shift needs a reason; a revision may not break a placeholder", () => {
  const src = { p_negation: PLANTED[1].source, p_placeholder: PLANTED[4].source };
  const r = reviewBackTranslation([PLANTED[1], PLANTED[4], FAITHFUL[0]], { language: "es" });
  const tr = { p_negation: PLANTED[1].translation, p_placeholder: PLANTED[4].translation, q1: FAITHFUL[0].translation };
  const first = reconcileBackTranslation(r, tr, [
    { key: "p_negation", action: "keep", reason: "" },
    { key: "p_placeholder", action: "revise", text: "Usted dijo que compra en esa tienda. ¿Por qué?" },
  ], "ana@example.test", "2026-11-18T00:00:00Z", src);
  assert.deepEqual(first.open.sort(), ["p_negation", "p_placeholder"]);
  assert.equal(first.refused.length, 2);
  const done = reconcileBackTranslation(r, tr, [
    { key: "p_negation", action: "revise", text: "Por favor, no incluya las compras hechas para el trabajo.", reason: "the negation was lost" },
    { key: "p_placeholder", action: "revise", text: "Usted dijo que compra en {{Q3}}. ¿Por qué lo prefiere?" },
  ], "ana@example.test", "2026-11-18T00:00:00Z", src);
  assert.deepEqual(done.open, []);
  assert.equal(done.translations.p_negation, "Por favor, no incluya las compras hechas para el trabajo.");
  assert.equal(done.translations.q1, FAITHFUL[0].translation, "ok strings untouched");
  assert.deepEqual(done.record.map((x) => [x.key, x.action, x.by]), [["p_negation", "revise", "ana@example.test"], ["p_placeholder", "revise", "ana@example.test"]]);
});
