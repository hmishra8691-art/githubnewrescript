import { test } from "node:test";
import assert from "node:assert/strict";
import { speechInputFor, questionOffersSpeechInput, speechServerOn, speechInputLang } from "./index.js";

/* #16: dictation in grid text cells, the server-dictation switch, the respondent's language */

const q = (type: string, extra: Record<string, unknown> = {}) => ({ type, settings: {}, options: [], rows: [], validation: [], ...extra }) as never;

test("grid cells: matrix_text and text / long-text columns of a custom table take dictation; formatted and other columns do not", () => {
  assert.equal(speechInputFor(null, q("matrix_text"), { kind: "cell", columnType: "text" }), true);
  assert.equal(speechInputFor(null, q("matrix_text", { validation: [{ kind: "email" }] }), { kind: "cell", columnType: "text" }), false, "a matrix of e-mail cells is formatted");
  assert.equal(speechInputFor(null, q("custom_table"), { kind: "cell", columnType: "longtext" }), true);
  assert.equal(speechInputFor(null, q("custom_table"), { kind: "cell", columnType: "numeric" }), false);
  assert.equal(speechInputFor(null, q("custom_table"), { kind: "cell", columnType: "text", validation: [{ kind: "zip" }] }), false);
  assert.equal(speechInputFor(null, q("matrix_numeric"), { kind: "cell", columnType: "text" }), false, "only grid types with text cells");
  assert.equal(speechInputFor({ deployment: { speechInput: false } }, q("matrix_text"), { kind: "cell" }), false, "the survey switch still wins");
  assert.equal(questionOffersSpeechInput(q("matrix_text")), true);
  assert.equal(questionOffersSpeechInput(q("custom_table", { columns: [{ responseType: "numeric" }, { responseType: "text", validation: [] }] })), true);
  assert.equal(questionOffersSpeechInput(q("custom_table", { columns: [{ responseType: "numeric" }] })), false);
});

test("server dictation is on unless the survey turns it (or dictation) off", () => {
  assert.equal(speechServerOn(null), true);
  assert.equal(speechServerOn({ deployment: { speechServer: false } } as never), false);
  assert.equal(speechServerOn({ deployment: { speechInput: false } }), false);
});

test("the recogniser hears the respondent's language before the survey's default", () => {
  const def = { deployment: { languages: ["en", "hi"] } } as never;
  assert.equal(speechInputLang(def, { settings: {} } as never, "fr-FR", "hi"), "hi");
  assert.equal(speechInputLang(def, { settings: { speechLang: "en-IN" } } as never, "fr-FR", "hi"), "en-IN", "the question's own setting still wins");
  assert.equal(speechInputLang(def, { settings: {} } as never, "fr-FR"), "en");
});
