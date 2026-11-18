import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { normalizeAsParsed, normalizeOptionFlags, SurveyDefinition } from "./index.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

test("every parse-time migration in the schema is one normalizeAsParsed knows about", () => {
  /* the draft save's dropped-field check (Error.xlsx item 2) compares against normalizeAsParsed: a NEW transform or
     preprocess that it does not repeat turns every save that touches it into a false "Save failed". Add the
     migration to normalizeAsParsed (questionContent.ts), then add it here. */
  const known = new Map([["question.ts", 2]]);
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
    const src = readFileSync(join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const n = (src.match(/\.transform\(|z\.preprocess\(|\.catch\(|z\.coerce\./g) ?? []).length;
    assert.equal(n, known.get(f) ?? 0, `${f}: ${n} parse-time migration(s); normalizeAsParsed covers ${known.get(f) ?? 0}`);
  }
});

test("normalizeAsParsed applies the flag retirement exactly as the schema does", () => {
  for (const flags of [["none_of_above"], ["dont_know", "exclusive"], ["refused", "other_specify", "none_of_above"], ["anchor_top"], []]) {
    assert.deepEqual(normalizeAsParsed({ flags }).flags, normalizeOptionFlags(flags));
  }
});
