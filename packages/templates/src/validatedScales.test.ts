import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { createResponseState, start, advance } from "@rescript/engine";
import { VALIDATED_SCALES, scaleById, scoreScale, bandOf, scaleBlock, citationText } from "./validatedScales.js";

test("every scale has a citation, a licence statement, its items, options and a scoring with a range (audit P2-10 gate)", () => {
  assert.ok(VALIDATED_SCALES.length >= 8);
  const ids = new Set<string>();
  for (const s of VALIDATED_SCALES) {
    assert.ok(!ids.has(s.id), `unique id ${s.id}`); ids.add(s.id);
    assert.ok(s.citation.authors && s.citation.year > 1900 && s.citation.title && s.citation.source, `${s.id} cites its source`);
    assert.ok(s.licence.length > 10, `${s.id} states its licence`);
    assert.ok(s.items.length >= 2 && s.options.length >= 2 && s.scores.length >= 1, s.id);
    assert.equal(new Set(s.items.map((i) => i.code)).size, s.items.length, `${s.id}: item codes unique`);
    for (const sc of s.scores) {
      for (const c of sc.items) assert.ok(s.items.some((i) => i.code === c), `${s.id}.${sc.id} scores an item it has (${c})`);
      /* the scoring reaches exactly its published range at the two extremes */
      const lo = Math.min(...s.options.map((o) => o.code)), hi = Math.max(...s.options.map((o) => o.code));
      const at = (v: (rev: boolean) => number) => scoreScale(s, Object.fromEntries(s.items.map((i) => [i.code, v(!!i.reverse)])), sc.id)!;
      const a = at((rev) => (rev ? hi : lo)), b = at((rev) => (rev ? lo : hi));
      assert.deepEqual([Math.min(a, b), Math.max(a, b)].map((x) => Math.round(x * 1000) / 1000), sc.range, `${s.id}.${sc.id} spans ${sc.range}`);
    }
    assert.match(citationText(s.citation), new RegExp(String(s.citation.year)));
  }
});

test("published worked values: SUS all neutral = 50, GAD-7 bands, WHO-5 × 4, PSS-10 reverse items, TIPI subscale means", () => {
  const sus = scaleById("sus")!;
  assert.equal(scoreScale(sus, Object.fromEntries(sus.items.map((i) => [i.code, 3]))), 50);
  assert.equal(scoreScale(sus, Object.fromEntries(sus.items.map((i) => [i.code, i.reverse ? 1 : 5]))), 100);
  const gad = scaleById("gad7")!;
  const g = (vals: number[]) => scoreScale(gad, Object.fromEntries(vals.map((v, i) => [String(i + 1), v])));
  assert.equal(g([1, 1, 1, 1, 1, 0, 0]), 5);
  assert.equal(bandOf(gad, 4), "Minimal"); assert.equal(bandOf(gad, 5), "Mild"); assert.equal(bandOf(gad, 10), "Moderate"); assert.equal(bandOf(gad, 15), "Severe");
  const who = scaleById("who5")!;
  assert.equal(scoreScale(who, { 1: 3, 2: 3, 3: 2, 4: 2, 5: 3 }), 52);
  const pss = scaleById("pss10")!;
  /* "Never" everywhere: the four positive items reverse to 4 each */
  assert.equal(scoreScale(pss, Object.fromEntries(pss.items.map((i) => [i.code, 0]))), 16);
  const tipi = scaleById("tipi")!;
  assert.equal(scoreScale(tipi, { 1: 6, 6: 2, 2: 1, 7: 7, 3: 5, 8: 3, 4: 2, 9: 6, 5: 7, 10: 1 }, "E"), 6);
  assert.equal(scoreScale(tipi, { 1: 6 }, "E"), null, "an unanswered item: no score");
});

test("the survey block's calculations give the same score as scoreScale, in the real engine", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const s of VALIDATED_SCALES) {
    const b = scaleBlock(s);
    const def = SurveyDefinition.parse({
      meta: { id: s.id, code: s.id, title: s.name, version: "1", schemaVersion: 1, status: "draft" },
      questions: [b.question], flow: [b.page, { type: "end", id: "e", status: "complete" }], calculations: b.calculations,
    });
    for (let k = 0; k < 5; k++) {
      const answers: Record<string, number> = {};
      for (const it of s.items) answers[it.code] = s.options[Math.floor(rnd() * s.options.length)].code;
      const st = createResponseState(def); start(def, st);
      st.answers[b.question.id] = answers;
      advance(def, st, {});
      for (const sc of s.scores) {
        const got = (st as unknown as { calculated: Record<string, number> }).calculated[`${b.question.variableName}_${sc.id}`];
        const want = scoreScale(s, answers, sc.id)!;
        assert.ok(Math.abs(got - want) < 1e-5, `${s.id}.${sc.id}: engine ${got}, scoring ${want}, answers ${JSON.stringify(answers)}`);
      }
    }
    assert.ok(b.question.required && b.question.rows.length === s.items.length);
    assert.match(b.question.notes, new RegExp(s.citation.authors.split(",")[0]));
  }
});
