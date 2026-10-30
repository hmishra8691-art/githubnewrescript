import { test } from "node:test";
import assert from "node:assert/strict";
import type { SurveyDefinition } from "@rescript/schema";
import { SANDBOX_API, SANDBOX_EVENTS, LOGIC_HELPER_DOCS } from "@rescript/engine";
import { codeCompletions, pageHooks } from "./completions.ts";

/* S3a item 2: completion from the platform's registry and the current definition — pure, given a cursor */

const def = {
  questions: [
    { id: "q_age", code: "AGE", type: "numeric", text: "<p>How old are you?</p>" },
    { id: "q_brand", code: "Q2", type: "single_choice", text: "Which brand do you prefer?", options: [{ code: "1", label: "Coke" }, { code: "2", label: "<b>Pepsi</b>" }] },
  ],
  calculations: [{ id: "c1", targetVariable: "TOTAL", label: "Total spend", expression: "Q1 + Q2" }],
  embeddedData: [{ name: "src", source: "url" }],
} as unknown as SurveyDefinition;

/** the completion at the "|" in the text */
const at = (kind: Parameters<typeof codeCompletions>[0], text: string, explicit = false) => {
  const pos = text.indexOf("|");
  const doc = text.replace("|", "");
  const r = codeCompletions(kind, def, doc, pos, explicit);
  return r && { ...r, labels: r.options.map((o) => o.label), typed: doc.slice(r.from, pos) };
};

test("rs. offers every rs method of the registry, with its signature and effect", () => {
  const r = at("ux", 'rs.ad|')!;
  assert.deepEqual(r.labels.sort(), Object.keys(SANDBOX_API).sort());
  assert.equal(r.typed, "ad");
  const add = r.options.find((o) => o.label === "addClass")!;
  assert.equal(add.detail, "rs.addClass(target, className)");
  assert.equal(add.info, SANDBOX_API.addClass.effect);
  assert.match(r.options.find((o) => o.label === "setAnswer")!.info!, /write request/);
});

test("rs.listen: events first, then self or a question code", () => {
  const ev = at("ux", 'rs.listen("se|')!;
  assert.deepEqual(ev.labels.sort(), Object.keys(SANDBOX_EVENTS).sort());
  assert.equal(ev.typed, "se");
  assert.equal(ev.inString, true);
  const tgt = at("ux", 'rs.listen("select", "|')!;
  assert.deepEqual(tgt.labels, ["self", "AGE", "Q2"]);
  assert.equal(at("ux", "rs.animate(\"self\", 'p|")!.labels.includes("pop"), true);
});

test("a question reference inside rs.getAnswer(\"…\") offers the codes with their text", () => {
  const r = at("ux", 'const a = rs.getAnswer("Q|');
  assert.ok(r);
  assert.deepEqual(r.labels, ["AGE", "Q2"]);
  assert.equal(r.options[0]!.info, "How old are you?");
  assert.equal(r.typed, "Q");
  assert.deepEqual(at("ux", "rs.getCalc('|")!.labels, ["TOTAL"]);
  assert.deepEqual(at("ux", 'rs.getEmbedded("|')!.labels, ["src"]);
});

test("a comparison with an answer offers that question's option codes", () => {
  const r = at("ux", 'if (rs.getAnswer("Q2") === "|')!;
  assert.deepEqual(r.labels, ["1", "2"]);
  assert.equal(r.options[1]!.info, "Pepsi");
  assert.deepEqual(at("logic", "if (get('Q2') == '|")!.labels, ["1", "2"]);
});

test("logic scripts: the ctx helpers of the registry, and get(\"…\") offers questions and calculations", () => {
  const r = at("logic", "const t = getC|")!;
  assert.deepEqual(r.labels.sort(), Object.keys(LOGIC_HELPER_DOCS).sort());
  assert.equal(r.typed, "getC");
  assert.equal(r.options.find((o) => o.label === "setCalc")!.detail, "setCalc(name, value)");
  assert.deepEqual(at("logic", 'get("|')!.labels, ["AGE", "Q2", "TOTAL"]);
  assert.deepEqual(at("logic", 'setCalc("|')!.labels, ["TOTAL"]);
  assert.equal(at("logic", 'map.get("|'), null, "a method of something else is not a survey reference");
  assert.equal(at("logic", 'rs.|'), null, "no rs api in a logic script");
});

test("components: el and api, then api.getValue / setValue / onChange", () => {
  assert.deepEqual(at("component", "a|")!.labels, ["el", "api"]);
  assert.deepEqual(at("component", "api.|")!.labels.sort(), ["getValue", "onChange", "question", "setValue"]);
  assert.equal(at("component", "rs.|"), null);
});

test("page hooks in a selector: Next, Back, option, each question's card", () => {
  const r = at("ux", 'document.querySelector("|')!;
  for (const h of ['[data-testid="rs-next"]', '[data-testid="rs-back"]', '[data-rs-el="option"]', '[data-qid="q_age"]', '[data-qid="q_brand"]']) assert.ok(r.labels.includes(h), h);
  assert.ok(!r.labels.some((l) => l.includes("<")), "no placeholder hooks");
  assert.deepEqual(at("ux", "document.querySelector('[data-qid=\"|")!.labels, ["q_age", "q_brand"]);
  assert.equal(pageHooks(undefined).length >= 4, true);
});

test("nothing inside a closed string, a comment-free member of something else, or CSS / HTML", () => {
  assert.equal(at("ux", 'rs.getAnswer("Q2") |'), null);
  assert.equal(at("ux", "foo.ba|"), null);
  assert.equal(at("css", ".a { co|"), null);
  assert.equal(at("html", "<di|"), null);
  assert.equal(at("ux", 'rs.log("hello |'), null, "a message is free text");
});
