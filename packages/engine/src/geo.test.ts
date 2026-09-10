import { test } from "node:test";
import assert from "node:assert/strict";
import { SurveyDefinition } from "@rescript/schema";
import {
  geoAnswered, geoProblems, geoText, coordinatesOf, distanceKm, lngToTileX, latToTileY, tileXToLng, tileYToLat,
  buildVariableDictionary, flattenVariables, createResponseState, setAnswer, validatePage, resolvePiping, runCalculations,
  evaluateExpression, validateExpression, registerBuiltinQuestionTypes,
} from "./index.js";
import { questionTypeRegistry } from "@rescript/schema";

/**
 * THE GEO RESPONSE MODEL — the pure half.
 *
 * One stored shape for three renderers; what "answered" means per mode; the
 * export columns declared up front and filled by flatten; piping; the
 * distance function; and the slippy-map arithmetic the renderer relies on.
 */

const def = (mode: "pin" | "address" | "radius", settings: Record<string, unknown> = {}, required = true) => SurveyDefinition.parse({
  meta: { id: "g", code: "G", title: "Geo", version: "1.0" },
  questions: [
    { id: "home", code: "Q1", variableName: "HOME", type: "geo", text: "Where do you live?", required, settings: { geoMode: mode, ...settings } },
    { id: "work", code: "Q2", variableName: "WORK", type: "geo", text: "Where do you work?", settings: { geoMode: "pin" } },
    { id: "dist", code: "Q3", variableName: "COMMUTE_KM", type: "calculated", text: "", settings: { expression: "distance_km(HOME, WORK)" } },
    { id: "q4", code: "Q4", variableName: "Q4", type: "open_text", text: "You said you live at {{Q1}} ({{Q1.lat}}, {{Q1.lng}}); city {{Q1.city}}; within {{Q1.radius}}." },
  ],
  flow: [{ type: "page", id: "p1", questionIds: ["home", "work"] }, { type: "page", id: "p2", questionIds: ["q4"] }, { type: "end", id: "e1", status: "complete" }],
});
const LONDON = { lat: 51.5007, lng: -0.1246 };
const PARIS = { lat: 48.8566, lng: 2.3522 };

test("geo is a built-in type: registered, categorised, labelled", () => {
  registerBuiltinQuestionTypes();
  const plugin = questionTypeRegistry.get("geo");
  assert.ok(plugin, "registered");
  assert.match(plugin!.label, /Location/);
});

test("ANSWERED depends on the mode: pin and radius need coordinates, an address needs at least its text", () => {
  const pin = def("pin").questions[0], addr = def("address").questions[0], rad = def("radius").questions[0];
  assert.equal(geoAnswered(pin, undefined), false);
  assert.equal(geoAnswered(pin, {}), false);
  assert.equal(geoAnswered(pin, { source: "pin" }), false, "a source without coordinates is not a place");
  assert.equal(geoAnswered(pin, LONDON), true);
  assert.equal(geoAnswered(addr, { address: { formatted: "10 Downing St" }, source: "typed" }), true, "typed address, no geocoder → still an answer");
  assert.equal(geoAnswered(addr, { address: { formatted: "   " } }), false);
  assert.equal(geoAnswered(rad, LONDON), true, "answered — the radius bound is a separate problem, below");
});

test("PROBLEMS: radius bounds and coordinate sanity, in words", () => {
  const rad = def("radius", { radiusMinM: 500, radiusMaxM: 50000 }).questions[0];
  assert.deepEqual(geoProblems(rad, { ...LONDON }), ["Please set the distance."]);
  assert.deepEqual(geoProblems(rad, { ...LONDON, radiusM: 100 }), ["The distance must be at least 500 m."]);
  assert.deepEqual(geoProblems(rad, { ...LONDON, radiusM: 80000 }), ["The distance must be at most 50 km."]);
  assert.deepEqual(geoProblems(rad, { ...LONDON, radiusM: 5000 }), []);
  assert.deepEqual(geoProblems(def("pin").questions[0], { lat: 95, lng: 0 }), ["Latitude is out of range."]);
});

test("validatePage: required geo with an empty object fails once, in the mode's own words; complete passes", () => {
  const d = def("pin");
  const state = createResponseState(d, { seed: 1 });
  const ctx = { def: d, state, loop: null };
  state.answers.home = { source: "pin" };
  const errs = validatePage(d, [d.questions[0]], ctx).map((e) => e.message);
  assert.deepEqual(errs, ["Please place the pin on the map."], "not answered → the geo message, and NOT also the generic one");
  state.answers.home = {};
  assert.deepEqual(validatePage(d, [d.questions[0]], ctx).map((e) => e.message), ["This question is required."], "an empty object is simply empty");
  state.answers.home = { ...LONDON, source: "pin" };
  assert.deepEqual(validatePage(d, [d.questions[0]], ctx), []);

  const a = def("address");
  const s2 = createResponseState(a, { seed: 1 });
  s2.answers.home = { source: "typed" };
  assert.deepEqual(validatePage(a, [a.questions[0]], { def: a, state: s2, loop: null }).map((e) => e.message), ["Please enter or choose an address."]);
});

test("THE DICTIONARY declares the columns per mode, up front; flatten fills them", () => {
  const names = (m: "pin" | "address" | "radius") => buildVariableDictionary(def(m)).filter((v) => v.questionId === "home").map((v) => v.name);
  assert.deepEqual(names("pin"), ["HOME", "HOME_LAT", "HOME_LNG", "HOME_ACCURACY_M", "HOME_SOURCE"]);
  assert.deepEqual(names("radius"), ["HOME", "HOME_LAT", "HOME_LNG", "HOME_ACCURACY_M", "HOME_RADIUS_M", "HOME_SOURCE"]);
  assert.deepEqual(names("address"), ["HOME", "HOME_LAT", "HOME_LNG", "HOME_ACCURACY_M", "HOME_CITY", "HOME_REGION", "HOME_COUNTRY", "HOME_POSTAL", "HOME_SOURCE"]);

  const d = def("address");
  const state = createResponseState(d, { seed: 1 });
  setAnswer(d, state, "home", { ...LONDON, accuracy: 12.4, address: { formatted: "Westminster, London SW1A 0AA", city: "London", country: "United Kingdom", postal: "SW1A 0AA" }, source: "search" });
  setAnswer(d, state, "work", { lat: 51.5155, lng: -0.0922, source: "pin" });
  const flat = flattenVariables(d, state);
  assert.equal(flat.HOME, "Westminster, London SW1A 0AA", "the one-column form is the address when there is one");
  assert.equal(flat.HOME_LAT, 51.5007);
  assert.equal(flat.HOME_LNG, -0.1246);
  assert.equal(flat.HOME_ACCURACY_M, 12);
  assert.equal(flat.HOME_CITY, "London");
  assert.equal(flat.HOME_POSTAL, "SW1A 0AA");
  assert.equal(flat.HOME_SOURCE, "search");
  assert.equal(flat.WORK, "51.5155,-0.0922", "…and \"lat,lng\" when there is not");
  assert.equal("WORK_CITY" in flat, false, "no address parts for a pin");
});

test("distance_km: haversine over two geo answers, through the ordinary calculated question", () => {
  assert.equal(Math.round(distanceKm(LONDON, PARIS)), 343, "Westminster–Paris centre ≈ 343 km");
  assert.equal(distanceKm(LONDON, LONDON), 0);
  assert.deepEqual(coordinatesOf("51.5007,-0.1246"), LONDON, "the flattened text form");
  assert.deepEqual(coordinatesOf([48.8566, 2.3522]), PARIS);
  assert.equal(coordinatesOf("hello"), null);
  assert.equal(coordinatesOf("95,0"), null, "out of range is not a coordinate");
  assert.equal(validateExpression("distance_km(HOME, WORK)"), null, "known to the grammar");
  assert.equal(evaluateExpression('distance_km("51.5007,-0.1246", "48.8566,2.3522")', { resolver: () => undefined }), 342.807);

  const d = def("pin");
  const state = createResponseState(d, { seed: 1 });
  setAnswer(d, state, "home", { ...LONDON, source: "pin" });
  setAnswer(d, state, "work", { ...PARIS, source: "pin" });
  runCalculations(d, state, "on_page_submit");
  assert.equal(state.answers.dist, 342.807, "COMMUTE_KM is an ordinary calculated variable");
  setAnswer(d, state, "work", { source: "pin" });
  runCalculations(d, state, "on_page_submit");
  assert.equal(state.answers.dist, null, "one side missing → null, not NaN");
});

test("PIPING: {{Q1}} is the address or lat,lng; .lat .lng .city .radius read the parts", () => {
  const d = def("radius");
  const state = createResponseState(d, { seed: 1 });
  const ctx = { def: d, state, loop: null };
  setAnswer(d, state, "home", { ...LONDON, radiusM: 2500, source: "pin" });
  assert.equal(resolvePiping(d.questions[3].text, ctx), "You said you live at 51.5007,-0.1246 (51.5007, -0.1246); city ; within 2.5 km.");
  setAnswer(d, state, "home", { ...LONDON, radiusM: 800, address: { formatted: "Westminster, London", city: "London" }, source: "search" });
  assert.equal(resolvePiping(d.questions[3].text, ctx), "You said you live at Westminster, London (51.5007, -0.1246); city London; within 800 m.");
  assert.equal(geoText({}), "");
});

test("slippy-map arithmetic round-trips, and (0,0) is the centre tile", () => {
  for (const z of [1, 4, 10, 16]) {
    assert.ok(Math.abs(tileXToLng(lngToTileX(LONDON.lng, z), z) - LONDON.lng) < 1e-9);
    assert.ok(Math.abs(tileYToLat(latToTileY(LONDON.lat, z), z) - LONDON.lat) < 1e-9);
  }
  assert.equal(lngToTileX(0, 1), 1);
  assert.equal(latToTileY(0, 1), 1);
  assert.ok(Math.abs(tileYToLat(0, 1) - 85.0511) < 0.001, "the top of Web Mercator");
});
