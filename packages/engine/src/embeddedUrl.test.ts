import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import { coerceEmbedded, checkUrlValue, applyEmbeddedField, EMBEDDED_TYPES } from "./embedded.js";
import { resolveUrlTemplate, validateRedirectUrl, leadingUrlField } from "./redirect.js";
import { resolvePiping } from "./piping.js";
import { createResponseState } from "./state.js";
import { lintStructure } from "./lintLogic.js";

/*
 * EMBEDDED DATA — A URL IS A URL (October 2026 review).
 *
 * `redirect_url`, type URL, value `https://example.com/survey?id=123` keeps
 * name / type / value as written, through the Studio, save and reload, the
 * runtime, piping and redirects; untyped fields behave exactly as before.
 */
const URLS = [
  "https://example.com/test?id=123",
  "https://example.com/survey?id=123&src=panel&lang=en",
  "https://example.com/page#section-2",
  "https://example.com/a%20b/c?q=caf%C3%A9&x=%26",
  "http://example.com:8080/path/to/x?y=1",
  "https://example.com/r?next=https%3A%2F%2Fother.org%2Fdone%3Fa%3D1",
  "https://sub.example.co.uk/?a=1&a=2#frag?not=query",
  /* forms a URL parser would rewrite — kept as typed */
  "https://example.com",
  "HTTPS://Example.COM/Path?Q=1",
  "https://example.com/café?x=é",
];

test("coerceEmbedded(url) — every legitimate form kept byte for byte", () => {
  assert.ok(EMBEDDED_TYPES.some((t) => t.value === "url"), "URL is offered as a type");
  for (const u of URLS) assert.deepEqual(coerceEmbedded("url", u), { value: u }, u);
  assert.deepEqual(coerceEmbedded("url", ""), { value: null }, "empty is no value, no error");
  assert.deepEqual(coerceEmbedded("string", URLS[1]), { value: URLS[1] }, "as text it is unchanged too");
  assert.deepEqual(coerceEmbedded(undefined, URLS[1]), { value: URLS[1] }, "an untyped field: no conversion at all");
});

test("checkUrlValue — malformed refused with a reason; nothing legitimate over-restricted", () => {
  for (const u of URLS) assert.equal(checkUrlValue(u), null, u);
  assert.match(String(checkUrlValue("example.com/x")), /must start with http:\/\/ or https:\/\//);
  assert.match(String(checkUrlValue("javascript:alert(1)")), /must start with http/);
  assert.match(String(checkUrlValue("ftp://example.com")), /must start with http/);
  assert.match(String(checkUrlValue("https://exa mple.com")), /spaces/);
  assert.match(String(checkUrlValue("https://")), /not a valid URL|no domain/);
  assert.match(String(checkUrlValue("https://nodot")), /no domain/);
  assert.equal(checkUrlValue("http://localhost:3000/x"), null, "a local test address is legitimate");
  const bad = coerceEmbedded("url", "not a url");
  assert.equal(bad.value, null);
  assert.match(String(bad.error), /not a URL/);
});

function surveyWith(field: Record<string, unknown>, redirect?: string) {
  return SurveyDefinition.parse({
    meta: { id: "s", code: "S", title: "T" },
    questions: [{ id: "q1", code: "Q1", variableName: "Q1", type: "single_line", text: 'Go <a href="{{ed.redirect_url}}">here</a>: {{ed.redirect_url}}' }],
    flow: [
      { type: "embedded_data", id: "ed", fields: [{ name: "redirect_url", ...field }] },
      { type: "page", id: "p", questionIds: ["q1"] },
      ...(redirect ? [{ type: "redirect", id: "r", url: redirect }] : []),
      { type: "end", id: "e", status: "complete" },
    ],
  });
}

test("the data model keeps name / type / value; JSON round-trip and reload change nothing", () => {
  const def = surveyWith({ source: "static", dataType: "url", value: URLS[1] });
  const again = SurveyDefinition.parse(JSON.parse(JSON.stringify(def)));
  const f = (again.flow[0] as { fields: Record<string, unknown>[] }).fields[0];
  assert.deepEqual({ name: f.name, type: f.dataType, value: f.value }, { name: "redirect_url", type: "url", value: URLS[1] });
});

test("runtime: a fixed URL value, a URL captured from the link, a default — stored as written; piping escapes for HTML only", () => {
  for (const u of URLS) {
    const def = surveyWith({ source: "static", dataType: "url", value: u });
    const state = createResponseState(def);
    assert.deepEqual(applyEmbeddedField(def, state, (def.flow[0] as any).fields[0]), { value: u, error: undefined });
    assert.equal(state.embedded.redirect_url, u);
    const piped = resolvePiping("{{ed.redirect_url}}", { def, state });
    assert.equal(piped.replace(/&amp;/g, "&"), u, "piped into text it is the same address (& escaped for HTML, which the browser reads back)");
  }
  const fromLink = surveyWith({ source: "url", dataType: "url" });
  const st = createResponseState(fromLink, { embedded: { redirect_url: URLS[5] } });
  applyEmbeddedField(fromLink, st, (fromLink.flow[0] as any).fields[0]);
  assert.equal(st.embedded.redirect_url, URLS[5], "a URL arriving as a parameter keeps its own encoded query");
  const withDefault = surveyWith({ source: "url", dataType: "url", defaultValue: URLS[2] });
  const sd = createResponseState(withDefault);
  applyEmbeddedField(withDefault, sd, (withDefault.flow[0] as any).fields[0]);
  assert.equal(sd.embedded.redirect_url, URLS[2], "the default, when nothing arrives");
  const invalid = surveyWith({ source: "url", dataType: "url" });
  const si = createResponseState(invalid, { embedded: { redirect_url: "example.com" } });
  const r = applyEmbeddedField(invalid, si, (invalid.flow[0] as any).fields[0]);
  assert.equal(r.value, null);
  assert.match(String(r.error), /must start with http/, "an unusable address is no value, with the reason");
});

test("redirect: a URL field that starts the template IS the address; elsewhere it is an encoded parameter; text fields as before", () => {
  const def = surveyWith({ source: "static", dataType: "url", value: URLS[1] }, "{{ed.redirect_url}}");
  const state = createResponseState(def);
  applyEmbeddedField(def, state, (def.flow[0] as any).fields[0]);
  assert.equal(leadingUrlField(def, "{{ed.redirect_url}}"), "redirect_url");
  assert.equal(resolveUrlTemplate("{{ed.redirect_url}}", { def, state }), URLS[1], "sent to exactly the address, ? & = intact");
  assert.equal(resolveUrlTemplate("{{ed.redirect_url}}&rid=7", { def, state }), `${URLS[1]}&rid=7`);
  assert.equal(resolveUrlTemplate("https://panel.com/done?return={{ed.redirect_url}}", { def, state }),
    `https://panel.com/done?return=${encodeURIComponent(URLS[1])}`, "as a parameter it is encoded, so it arrives whole");
  const asText = surveyWith({ source: "static", dataType: "string", value: URLS[1] }, "{{ed.redirect_url}}");
  const s2 = createResponseState(asText);
  applyEmbeddedField(asText, s2, (asText.flow[0] as any).fields[0]);
  assert.equal(resolveUrlTemplate("{{ed.redirect_url}}", { def: asText, state: s2 }), encodeURIComponent(URLS[1]), "the type decides, never the value's look");
  assert.equal(validateRedirectUrl("{{ed.redirect_url}}", def).ok, true, "a URL field may supply the whole address");
  assert.equal(validateRedirectUrl("{{ed.redirect_url}}", asText).ok, false, "a text field may not");
  assert.equal(validateRedirectUrl("{{ed.redirect_url}}").ok, false, "without the survey, as before");
});

test("lint: a fixed URL value or default that is not a URL blocks release; a good one is clean", () => {
  const bad = lintStructure(surveyWith({ source: "static", dataType: "url", value: "example.com/x" }));
  assert.ok(bad.some((i) => i.level === "error" && /redirect_url.*fixed value is not a URL/.test(i.message)), bad.map((i) => i.message).join("\n"));
  const badDefault = lintStructure(surveyWith({ source: "url", dataType: "url", defaultValue: "www.example.com" }));
  assert.ok(badDefault.some((i) => i.level === "error" && /default value is not a URL/.test(i.message)));
  const good = lintStructure(surveyWith({ source: "static", dataType: "url", value: URLS[0] }));
  assert.ok(!good.some((i) => /redirect_url/.test(i.message)), good.map((i) => i.message).join("\n"));
  const untyped = lintStructure(surveyWith({ source: "static", value: "example.com/x" }));
  assert.ok(!untyped.some((i) => /redirect_url/.test(i.message)), "an untyped field is not judged");
});
