/**
 * THE GEO RESPONSE MODEL — the whole path, end to end.
 *
 *   Studio: pick a location type from the picker; configure the mode
 *       ↓
 *   Runtime: click the map → a pin; drag; zoom; "use my location"
 *       ↓
 *   radius mode: the slider; address mode: search → choose → pin
 *       ↓
 *   one stored shape, whichever renderer produced it
 *       ↓
 *   distance_km() between two answers as an ordinary calculated variable
 *       ↓
 *   the flattened columns the dictionary declared
 *
 * Runs against the FAKE geocoder (`GEOCODE_API_URL=fake:` on the runtime).
 * Tiles come from OpenStreetMap; in this sandbox they may not load, which is
 * fine — the map's arithmetic is what is under test, not the pictures.
 */
import { openHarness, assert } from "./lib/variantHarness.mjs";
import { openPreview } from "./lib/preview.mjs";

const RUNTIME = process.env.RUNTIME_URL ?? "http://localhost:3001";
const h = await openHarness();

{
  const r = await fetch(`${RUNTIME}/api/geocode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: "preview", definition: {} }) });
  assert.equal(r.status, 400, `runtime must be started with GEOCODE_API_URL=fake: — got ${r.status}`);
}

console.log("\nSTUDIO — the location family offers three types over one response model");
const pin = await h.createFromPicker("location", "location.pin");
assert.equal(pin.type, "geo");
assert.equal(pin.settings.geoMode, "pin");
const addr = await h.createFromPicker("location", "location.address");
assert.equal(addr.type, "geo");
assert.equal(addr.settings.geoMode, "address");
const rad = await h.createFromPicker("location", "location.radius");
assert.equal(rad.type, "geo");
assert.equal(rad.settings.geoMode, "radius");
assert.equal(rad.settings.radiusMaxM, 50000);
console.log("  ok   pin / address / radius created; all three are type geo, told apart by settings.geoMode");

console.log("\nSTUDIO — the Location / map section edits the mode and the framing");
await h.goTab("Questions");
await h.page.click(`[data-qid="${pin.id}"]`);
await h.page.waitForSelector('[data-testid="geo-mode"]');
await h.page.fill('[data-testid="geo-center-lat"]', "51.5");
await h.page.fill('[data-testid="geo-center-lng"]', "-0.12");
await h.page.fill('[data-testid="geo-zoom"]', "10");
await h.page.waitForTimeout(300);
let def = await h.readDef();
let q = def.questions.find((x) => x.id === pin.id);
assert.deepEqual(q.settings.mapCenter, { lat: 51.5, lng: -0.12 });
assert.equal(q.settings.mapZoom, 10);
console.log("  ok   centre and zoom stored on settings");

/* one definition with all three, plus a distance calculation and a piped question */
const survey = {
  meta: { id: "sandbox", code: "GEO", title: "Geo", version: "1.0" },
  questions: [
    { id: "home", code: "Q1", variableName: "HOME", type: "geo", variant: "location.pin", text: "Where do you live?", required: true,
      settings: { geoMode: "pin", mapCenter: { lat: 51.5, lng: -0.12 }, mapZoom: 10, allowGeolocation: true } },
    { id: "work", code: "Q2", variableName: "WORK", type: "geo", variant: "location.radius", text: "Where do you work, and how far would you travel?",
      settings: { geoMode: "radius", mapCenter: { lat: 51.5, lng: -0.12 }, mapZoom: 10, radiusMinM: 500, radiusMaxM: 50000, radiusDefaultM: 5000 } },
    { id: "shop", code: "Q3", variableName: "SHOP", type: "geo", variant: "location.address", text: "Which store do you use most?", settings: { geoMode: "address" } },
    { id: "dist", code: "DIST", variableName: "COMMUTE_KM", type: "calculated", text: "", settings: { expression: "distance_km(HOME, WORK)" } },
    { id: "q5", code: "Q5", variableName: "Q5", type: "single_select", text: "You live at {{Q1}} and would travel {{Q2.radius}} from {{Q2}}; your store is in {{Q3.city}}.", options: [{ code: 1, label: "Right" }, { code: 2, label: "Wrong" }] },
  ],
  flow: [
    { type: "page", id: "p1", questionIds: ["home", "work", "shop"] },
    { type: "page", id: "p2", questionIds: ["q5"] },
    { type: "end", id: "e1", status: "complete" },
  ],
};
await h.loadDef(survey);
def = await h.readDef();

console.log("\nRUNTIME — pin: click places it, drag moves it, zoom keeps it, clear removes it");
let pv = await openPreview(h.browser, RUNTIME, { definition: def }, { selector: '[data-qid="home"]' });
const map = '[data-qid="home"] [data-testid="rs-map"]';
assert.equal(await pv.getAttribute(map, "data-zoom"), "10");
assert.match(await pv.getAttribute(map, "data-center"), /^51\.5,-0\.12$/, "framed from the settings");
assert.match(await pv.textContent('[data-qid="home"] [data-testid="rs-geo-readout"]'), /No location yet/);
let box = await (await pv.$(map)).boundingBox();
// click the exact centre → the pin lands on the map centre
await pv.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await pv.waitForSelector('[data-qid="home"] [data-testid="rs-map-pin"]');
let v = await h.answerOf(pv, "home");
assert.ok(Math.abs(v.lat - 51.5) < 0.002 && Math.abs(v.lng - -0.12) < 0.002, `centre click → centre coordinates, got ${JSON.stringify(v)}`);
assert.equal(v.source, "pin");
// click 128 px east → about a quarter of a tile: longitude grows by 360/2^10/2 ≈ 0.176°
await pv.mouse.click(box.x + box.width / 2 + 128, box.y + box.height / 2);
await pv.waitForTimeout(150);
v = await h.answerOf(pv, "home");
assert.ok(Math.abs(v.lng - (-0.12 + 0.17578)) < 0.003, `128 px east at z10 = +0.1758° lng, got ${v.lng}`);
assert.ok(Math.abs(v.lat - 51.5) < 0.002, "latitude unchanged");
// drag the pin 64 px west
let pinBox = await (await pv.$('[data-qid="home"] [data-testid="rs-map-pin"]')).boundingBox();
await pv.mouse.move(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height - 2);
await pv.mouse.down();
await pv.mouse.move(pinBox.x + pinBox.width / 2 - 32, pinBox.y + pinBox.height - 2, { steps: 4 });
await pv.mouse.move(pinBox.x + pinBox.width / 2 - 64, pinBox.y + pinBox.height - 2, { steps: 4 });
await pv.mouse.up();
await pv.waitForTimeout(150);
const dragged = await h.answerOf(pv, "home");
assert.ok(dragged.lng < v.lng - 0.05, `dragging the pin west moved it west (${v.lng} → ${dragged.lng})`);
// zoom in twice: the answer does not change, the map does
await pv.click('[data-qid="home"] [data-testid="rs-map-zoom-in"]');
await pv.click('[data-qid="home"] [data-testid="rs-map-zoom-in"]');
assert.equal(await pv.getAttribute(map, "data-zoom"), "12");
assert.deepEqual(await h.answerOf(pv, "home"), dragged, "zooming is a view change, not an answer change");
// pan the map (drag empty space): the pin's coordinates still do not change
box = await (await pv.$(map)).boundingBox();
await pv.mouse.move(box.x + 40, box.y + 40);
await pv.mouse.down();
await pv.mouse.move(box.x + 140, box.y + 90, { steps: 5 });
await pv.mouse.up();
await pv.waitForTimeout(100);
assert.deepEqual(await h.answerOf(pv, "home"), dragged, "panning is a view change too");
assert.notEqual(await pv.getAttribute(map, "data-center"), "51.5,-0.12", "…and the view did move");
// clear
await pv.click('[data-qid="home"] [data-testid="rs-geo-clear"]');
await pv.waitForTimeout(100);
assert.equal((await h.answerOf(pv, "home")).lat, undefined);
assert.ok(!(await pv.$('[data-qid="home"] [data-testid="rs-map-pin"]')), "pin gone");
console.log("  ok   click / drag / zoom / pan / clear behave, and only the first two change the answer");

console.log("\nRUNTIME — required pin: Next without one is refused in the mode's words");
await h.next(pv);
await pv.waitForTimeout(200);
assert.match(await pv.evaluate(() => document.body.innerText), /Please place the pin on the map|This question is required/);
assert.ok(await pv.$('[data-qid="home"]'), "still on page 1");
console.log("  ok   refused");

console.log("\nRUNTIME — \"use my location\": device geolocation becomes the pin, with its accuracy");
await pv.close();
pv = await h.browser.newPage({ viewport: { width: 1000, height: 1000 } });
await pv.addInitScript(() => {
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: { getCurrentPosition: (ok) => setTimeout(() => ok({ coords: { latitude: 48.8566, longitude: 2.3522, accuracy: 23.7 } }), 30) },
  });
});
await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
const { sendPreview } = await import("./lib/preview.mjs");
await sendPreview(pv, { definition: def }, { selector: '[data-qid="home"]' });
await pv.click('[data-qid="home"] [data-testid="rs-geo-locate"]');
await pv.waitForSelector('[data-qid="home"] [data-testid="rs-map-pin"]');
v = await h.answerOf(pv, "home");
assert.deepEqual(v, { lat: 48.8566, lng: 2.3522, source: "device", accuracy: 24 });
assert.match(await pv.textContent('[data-qid="home"] [data-testid="rs-geo-readout"]'), /± 24 m/);
assert.ok(Number(await pv.getAttribute(map, "data-zoom")) >= 14, "the map zooms in on the located point");
console.log("  ok   device location → { lat, lng, source: device, accuracy }");

console.log("\nRUNTIME — geolocation declined: says so, and the pin can still be placed by hand");
await pv.close();
pv = await h.browser.newPage({ viewport: { width: 1000, height: 1000 } });
await pv.addInitScript(() => {
  Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (_ok, err) => setTimeout(() => err({ code: 1 }), 10) } });
});
await pv.goto(`${RUNTIME}/preview`, { waitUntil: "networkidle" });
await sendPreview(pv, { definition: def }, { selector: '[data-qid="home"]' });
await pv.click('[data-qid="home"] [data-testid="rs-geo-locate"]');
await pv.waitForSelector('[data-qid="home"] [data-testid="rs-geo-locate-note"]');
assert.match(await pv.textContent('[data-qid="home"] [data-testid="rs-geo-locate-note"]'), /declined/);
box = await (await pv.$(map)).boundingBox();
await pv.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await pv.waitForSelector('[data-qid="home"] [data-testid="rs-map-pin"]');
console.log("  ok   declined → note; hand placement works");

console.log("\nRUNTIME — radius: the pin gets the default radius; the slider changes it; bounds are enforced");
const rmap = '[data-qid="work"] [data-testid="rs-map"]';
assert.ok(await pv.$eval('[data-qid="work"] [data-testid="rs-geo-radius"]', (e) => e.disabled), "no pin yet → no radius to set");
await (await pv.$(rmap)).scrollIntoViewIfNeeded();
box = await (await pv.$(rmap)).boundingBox();
// 100 px east of the centre at z10 ≈ 0.137° of longitude ≈ 9.5 km at this latitude — so the commute below is not zero
await pv.mouse.click(box.x + box.width / 2 + 100, box.y + box.height / 2);
await pv.waitForSelector('[data-qid="work"] [data-testid="rs-map-pin"]');
v = await h.answerOf(pv, "work");
assert.equal(v.radiusM, 5000, "the configured default radius");
assert.match(await pv.textContent('[data-qid="work"] [data-testid="rs-geo-radius-label"]'), /^5 km$/);
assert.ok(await pv.$('[data-qid="work"] .rs-map-radius'), "the circle is drawn");
// slide to the top → max
await pv.focus('[data-qid="work"] [data-testid="rs-geo-radius"]');
await pv.keyboard.press("End");
await pv.waitForTimeout(100);
assert.equal((await h.answerOf(pv, "work")).radiusM, 50000);
assert.match(await pv.textContent('[data-qid="work"] [data-testid="rs-geo-radius-label"]'), /^50 km$/);
await pv.keyboard.press("Home");
await pv.waitForTimeout(100);
assert.equal((await h.answerOf(pv, "work")).radiusM, 500, "bottom of the slider is the minimum");
console.log("  ok   radius 5 km default → 50 km → 500 m through the log slider");

console.log("\nRUNTIME — address: typed text is the answer; search → matches → choose → pin + parts");
await pv.fill('[data-qid="shop"] [data-testid="rs-geo-address"]', "Nowhere Lane 99");
await pv.waitForTimeout(100);
v = await h.answerOf(pv, "shop");
assert.deepEqual(v, { address: { formatted: "Nowhere Lane 99" }, source: "typed" }, "typed, un-geocoded — still an answer");
await pv.click('[data-qid="shop"] [data-testid="rs-geo-search"]');
await pv.waitForSelector('[data-qid="shop"] [data-testid="rs-geo-status"]');
assert.match(await pv.textContent('[data-qid="shop"] [data-testid="rs-geo-status"]'), /No match found/);
await pv.fill('[data-qid="shop"] [data-testid="rs-geo-address"]', "Downing Street");
await pv.press('[data-qid="shop"] [data-testid="rs-geo-address"]', "Enter");
await pv.waitForSelector('[data-qid="shop"] [data-testid="rs-geo-hits"]');
const hits = await pv.$$eval('[data-qid="shop"] [data-testid="rs-geo-hit"]', (els) => els.map((e) => e.textContent));
assert.equal(hits.length, 2, "London and Cambridge");
await pv.click('[data-qid="shop"] [data-testid="rs-geo-hit"] >> nth=0');
await pv.waitForSelector('[data-qid="shop"] [data-testid="rs-map-pin"]');
v = await h.answerOf(pv, "shop");
assert.equal(v.source, "search");
assert.equal(v.address.city, "London");
assert.equal(v.address.postal, "SW1A 2AA");
assert.ok(Math.abs(v.lat - 51.503396) < 1e-6 && Math.abs(v.lng - -0.12764) < 1e-6);
assert.equal(await pv.inputValue('[data-qid="shop"] [data-testid="rs-geo-address"]'), hits[0]);
// editing the text again drops the coordinates: the text no longer describes them
await pv.fill('[data-qid="shop"] [data-testid="rs-geo-address"]', "Downing Street, Cambridge");
await pv.waitForTimeout(100);
v = await h.answerOf(pv, "shop");
assert.equal(v.lat, undefined, "coordinates dropped when the text changed");
assert.equal(v.source, "typed");
await pv.press('[data-qid="shop"] [data-testid="rs-geo-address"]', "Enter");
await pv.waitForSelector('[data-qid="shop"] [data-testid="rs-geo-hits"]');
await pv.click('[data-qid="shop"] [data-testid="rs-geo-hit"] >> nth=0');
await pv.waitForTimeout(100);
assert.equal((await h.answerOf(pv, "shop")).address.city, "Cambridge");
console.log("  ok   typed → no match → match → chosen → re-typed drops coords → re-chosen");

console.log("\nRUNTIME — one shape, many consumers: distance_km, piping on the next page, flattened columns");
// put HOME back on a known point (device location London) — set it precisely through a click at centre after recentering
await pv.click('[data-qid="home"] [data-testid="rs-geo-clear"]');
await pv.waitForTimeout(150);
await (await pv.$(map)).scrollIntoViewIfNeeded();
box = await (await pv.$(map)).boundingBox();
await pv.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await pv.waitForSelector('[data-qid="home"] [data-testid="rs-map-pin"]');
const home = await h.answerOf(pv, "home"), work = await h.answerOf(pv, "work");
await h.next(pv);
await pv.waitForSelector('[data-qid="q5"]');
const dist = await h.answerOf(pv, "dist");
assert.ok(typeof dist === "number" && dist > 8 && dist < 11, `home at the centre, work 100 px east at z10 → ≈ 9.5 km, got ${dist}`);
const text = await pv.textContent('[data-qid="q5"]');
assert.match(text, new RegExp(`You live at ${home.lat},${home.lng}`), "{{Q1}} is lat,lng when there is no address");
assert.match(text, /would travel 500 m from/, "{{Q2.radius}}");
assert.match(text, /your store is in Cambridge/, "{{Q3.city}}");
const flat = await pv.evaluate(() => {
  const st = window.__rescriptState;
  return st ? { keys: Object.keys(st.answers) } : null;
});
assert.ok(flat.keys.includes("home") && flat.keys.includes("work") && flat.keys.includes("shop"));
console.log(`  ok   COMMUTE_KM = ${dist}; piping shows lat,lng / 500 m / Cambridge`);
await pv.close();

await h.close();
console.log("\nALL GEO CHECKS PASSED");
