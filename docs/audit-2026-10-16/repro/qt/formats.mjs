import { SurveyDefinition } from "/home/claude/rescript/packages/schema/dist/index.js";
import { validateQuestion, createResponseState, validateFieldValue, checkPhone, checkPostal, checkUrl, blockingErrors, PHONE_FORMATS, POSTAL_FORMATS } from "/home/claude/rescript/packages/engine/dist/index.js";

const def = SurveyDefinition.parse({ meta: { id: "s", code: "S", title: "Audit" }, questions: [
  { id: "q_e", code: "Q1", variableName: "EMAIL", type: "open_text", variant: "text.email", text: "Email", validation: [{ kind: "email" }] },
  { id: "q_p", code: "Q2", variableName: "PHONE", type: "open_text", variant: "text.phone", text: "Phone", validation: [{ kind: "phone" }] },
  { id: "q_z", code: "Q3", variableName: "ZIP", type: "open_text", variant: "text.zip", text: "Zip", validation: [{ kind: "zip" }] },
], flow: [{ type: "end", id: "e_ok", status: "complete" }], deployment: { clientSlug: "c", studySlug: "s" } });
const state = createResponseState(def, "sess", 1);
const ctx = { def, state };
const q = (id) => def.questions.find((x) => x.id === id);

console.log("== EMAIL: scalar rule (validate.ts) vs field type (fields.ts)");
const emails = ["a@b.co", "first.last+tag@sub.example.museum", "x@y", "no-at", "a@b", "a..b@c.com", "ü@example.com", "a@b.c", "user@localhost", "a @b.com", "a@b..com", "a@-b.com"];
for (const e of emails) {
  const scalar = blockingErrors(validateQuestion(def, q("q_e"), e, ctx)).length ? "REJECT" : "ACCEPT";
  const field = validateFieldValue("email", e) ? "REJECT" : "ACCEPT";
  console.log(JSON.stringify(e).padEnd(38), "scalar=", scalar.padEnd(7), "field=", field.padEnd(7), scalar !== field ? "<-- DISAGREE" : "");
}

console.log("\n== POSTAL (checkPostal) — loose (no country) and country-aware");
const postals = [["US", "90210"], ["US", "90210-1234"], ["US", "9021"], ["GB", "SW1A 1AA"], ["GB", "sw1a1aa"], ["GB", "SW1A 1A"], ["CA", "K1A 0B1"], ["CA", "K1A0B1"], ["CA", "90210"], ["DE", "10115"], ["DE", "1011"], ["IN", "110001"], ["IN", "010001"], ["FR", "75008"], ["AU", "3000"], ["JP", "100-0001"], ["BR", "01310-100"], ["NL", "1012 AB"]];
for (const [c, v] of postals) {
  const strict = checkPostal(v, c); const loose = checkPostal(v);
  console.log(c, JSON.stringify(v).padEnd(14), "country=", (strict ? "REJECT" : "ACCEPT").padEnd(7), "loose=", loose ? "REJECT" : "ACCEPT", strict ? " :: " + strict : "");
}
console.log("POSTAL_FORMATS countries:", POSTAL_FORMATS.map((f) => f.code).join(","));

console.log("\n== PHONE (checkPhone)");
const phones = [["US", "(415) 555-0132"], ["US", "+1 415 555 0132"], ["US", "415-555-013"], ["US", "123-456-7890"], ["GB", "+44 7700 900123"], ["GB", "07700 900123"], ["IN", "+91 98765 43210"], ["IN", "12345 67890"], ["DE", "+49 151 23456789"], ["CA", "604 555 0132"], [undefined, "+1 (555) 123-4567"], [undefined, "12345"], [undefined, "abc"], [undefined, "1234567"], ["JP", "+81 3 1234 5678"]];
for (const [c, v] of phones) {
  const r = checkPhone(v, c);
  console.log(String(c).padEnd(9), JSON.stringify(v).padEnd(22), r ? "REJECT :: " + r : "ACCEPT");
}
console.log("PHONE_FORMATS countries:", PHONE_FORMATS.map((f) => f.code).join(","));

console.log("\n== URL (checkUrl)");
for (const u of ["example.com", "https://example.com/path?q=1", "http://localhost", "ftp://x.com", "not a url", "x", "https://xn--bcher-kva.example", "mailto:a@b.com"]) {
  const r = checkUrl(u); console.log(JSON.stringify(u).padEnd(34), r ? "REJECT :: " + r : "ACCEPT");
}
