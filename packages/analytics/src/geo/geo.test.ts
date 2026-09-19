import test from "node:test";
import assert from "node:assert/strict";
import { fitProjection, normalizeLabel, regionPath, regionsFor, resolveRegion, resolveRegions, worldViewRegions } from "./index.js";

test("every country and US state carries a code, a name and at least one ring", () => {
  for (const scope of ["world", "us"] as const) {
    const regions = regionsFor(scope);
    assert.ok(regions.length > 50, `${scope} should have a real number of regions`);
    for (const r of regions) {
      assert.match(r.code, /^[A-Z]{2}$/, `${r.name} should have a two-letter code, got "${r.code}"`);
      assert.ok(r.name.length > 0);
      assert.ok(r.rings.length > 0, `${r.name} should have an outline`);
      for (const ring of r.rings) {
        assert.ok(ring.length >= 8 && ring.length % 2 === 0, `${r.name}: a ring is a flat lon/lat list`);
        assert.ok(ring.every((n) => Number.isFinite(n)), `${r.name}: every coordinate is a number`);
      }
      assert.ok(r.lon >= -180 && r.lon <= 180 && r.lat >= -90 && r.lat <= 90, `${r.name}: centroid is on Earth`);
    }
  }
});

test("no country is missing from the map because simplification erased it", () => {
  // the ten that collapsed at the first simplification threshold tried, and
  // which the generator now falls back to raw outlines for
  for (const code of ["CY", "QA", "JM", "BS", "PR", "PS", "VU", "SB", "TT", "XN"]) {
    const r = regionsFor("world").find((x) => x.code === code);
    assert.ok(r, `${code} should be on the map`);
    assert.ok(r!.rings.length > 0 && r!.rings[0].length >= 8, `${code} should have a usable outline`);
  }
});

test("a label resolves however the questionnaire happened to write it", () => {
  const cases: [string, string][] = [
    ["Germany", "DE"], ["DE", "DE"], ["DEU", "DE"], ["germany", "DE"],
    ["United States", "US"], ["USA", "US"], ["U.S.A.", "US"], ["United States of America", "US"], ["us", "US"],
    ["UK", "GB"], ["United Kingdom", "GB"], ["Great Britain", "GB"],
    ["Côte d'Ivoire", "CI"], ["Cote d Ivoire", "CI"], ["Ivory Coast", "CI"],
    ["South Korea", "KR"], ["Republic of Korea", "KR"], ["KOR", "KR"],
    ["Czech Republic", "CZ"], ["Czechia", "CZ"],
    ["Bosnia and Herzegovina", "BA"], ["Bosnia and Herz.", "BA"],
    ["Democratic Republic of the Congo", "CD"], ["DR Congo", "CD"], ["Congo", "CG"],
    ["Swaziland", "SZ"], ["Burma", "MM"], ["North Macedonia", "MK"], ["Turkey", "TR"], ["Türkiye", "TR"],
  ];
  for (const [label, code] of cases) {
    const r = resolveRegion(label, "world");
    assert.equal(r?.code, code, `"${label}" should resolve to ${code}, got ${r?.code ?? "nothing"}`);
  }
});

test("US states resolve by name and by postal code", () => {
  assert.equal(resolveRegion("California", "us")?.code, "CA");
  assert.equal(resolveRegion("CA", "us")?.code, "CA");
  assert.equal(resolveRegion("new york", "us")?.code, "NY");
  assert.equal(resolveRegion("District of Columbia", "us")?.code, "DC");
  assert.equal(resolveRegion("Puerto Rico", "us")?.code, "PR");
});

test("the scope is chosen by whichever explains more of the labels", () => {
  const states = resolveRegions(["California", "Texas", "New York", "Florida"]);
  assert.equal(states.scope, "us");
  assert.equal(states.matched.length, 4);

  const countries = resolveRegions(["Germany", "France", "Spain", "Italy"]);
  assert.equal(countries.scope, "world");
  assert.equal(countries.matched.length, 4);
});

test("a label that matches nothing is reported, never silently dropped", () => {
  const out = resolveRegions(["Germany", "Narnia", "France", "Benelux"], "world");
  assert.equal(out.matched.length, 2);
  assert.deepEqual(out.unmatched, ["Narnia", "Benelux"]);
  // the matched entries keep the index of the category they came from, so the
  // caller can still line a region up with its value
  assert.deepEqual(out.matched.map((m) => m.index), [0, 2]);
});

test("an alias never shadows a country's real name", () => {
  // "Georgia" is a country AND a US state; within the world scope the country wins
  assert.equal(resolveRegion("Georgia", "world")?.name, "Georgia");
  assert.equal(resolveRegion("Georgia", "us")?.code, "GA");
  // "Congo" is an alias for CG, but "Dem. Rep. Congo" is CD's own name
  assert.equal(resolveRegion("Dem. Rep. Congo", "world")?.code, "CD");
});

test("normalizeLabel folds accents, punctuation and case together", () => {
  assert.equal(normalizeLabel("Côte d'Ivoire"), "cote divoire");
  assert.equal(normalizeLabel("  U.S.A.  "), "usa");
  assert.equal(normalizeLabel("Bosnia and Herz."), "bosnia and herz");
});

test("the projection fits the regions it is given, inside the box it is given", () => {
  const europe = ["DE", "FR", "ES", "IT", "GB", "SE", "PL"].map((c) => regionsFor("world").find((r) => r.code === c)!);
  const p = fitProjection(europe, 400, 300);
  for (const r of europe) {
    const x = p.x(r.lon, r.lat), y = p.y(r.lon, r.lat);
    assert.ok(x >= 0 && x <= 400, `${r.name} x=${x} should be inside the box`);
    assert.ok(y >= 0 && y <= 300, `${r.name} y=${y} should be inside the box`);
  }
  // north is up: Sweden must sit above Spain
  const se = europe.find((r) => r.code === "SE")!, es = europe.find((r) => r.code === "ES")!;
  assert.ok(p.y(se.lon, se.lat) < p.y(es.lon, es.lat), "Sweden should be drawn above Spain");
  // east is right: Poland must sit right of Spain
  const pl = europe.find((r) => r.code === "PL")!;
  assert.ok(p.x(pl.lon, pl.lat) > p.x(es.lon, es.lat), "Poland should be drawn right of Spain");
});

test("an overseas territory does not drag the view across an ocean", () => {
  /*
   * France's outline includes French Guiana, Spain's the Canaries. Fitting to
   * every ring put Europe in one corner of an Atlantic map — this is the
   * regression that check guards.
   */
  const western = ["FR", "ES", "DE", "IT"].map((c) => regionsFor("world").find((r) => r.code === c)!);
  const p = fitProjection(western, 400, 300);
  assert.ok(p.bounds.minLon > -20, `the window should start near Iberia, not South America (got ${p.bounds.minLon})`);
  assert.ok(p.bounds.minLat > 25, `the window should start in the Mediterranean, not the tropics (got ${p.bounds.minLat})`);
});

test("a single region still gets a sane window", () => {
  const de = regionsFor("world").find((r) => r.code === "DE")!;
  const p = fitProjection([de], 300, 200);
  assert.ok(p.bounds.maxLon > p.bounds.minLon && p.bounds.maxLat > p.bounds.minLat);
  const x = p.x(de.lon, de.lat), y = p.y(de.lon, de.lat);
  assert.ok(x > 0 && x < 300 && y > 0 && y < 200);
});

test("the default world view leaves Antarctica out of the fit", () => {
  const view = worldViewRegions("world");
  assert.ok(!view.some((r) => r.code === "AQ"), "Antarctica should not drive the world window");
  assert.ok(view.length > 150, "everything else is still there");
  assert.equal(worldViewRegions("us").length, regionsFor("us").length);
});

test("regionPath emits a closed SVG path per ring", () => {
  const de = regionsFor("world").find((r) => r.code === "DE")!;
  const p = fitProjection([de], 300, 200);
  const d = regionPath(de, p);
  assert.match(d, /^M[\d.\- ]/, "starts with a move");
  assert.equal((d.match(/Z/g) ?? []).length, de.rings.length, "one closed subpath per ring");
  assert.ok(!/NaN|Infinity/.test(d), "no coordinate should come out as NaN");
});
