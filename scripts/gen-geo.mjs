/**
 * Generates packages/analytics/src/geo/regions.ts — compact world-country and
 * US-state outlines baked into plain TypeScript, so the chart library keeps its
 * "plain SVG, no chart/geo dependency at runtime" property. Run by hand when the
 * boundary data needs refreshing; the output is committed.
 *
 * Sources: world-atlas (Natural Earth 110m), us-atlas (Census 10m), both public
 * domain / ISC, via topojson-client + topojson-simplify at generation time only.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const tc = require("topojson-client");
const ts = require("topojson-simplify");
const iso = require("i18n-iso-countries");

const P = 1; // decimal places — ~11 km at the equator, plenty for a dashboard map

function simplifyTopo(topo, objectName, weight) {
  const pre = ts.presimplify(topo);
  const min = ts.quantile(pre, weight);
  return ts.simplify(pre, min);
}

/** round, drop consecutive duplicates, and drop rings that collapse */
function encodeRings(geom, minRingPoints = 4) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  const out = [];
  for (const poly of polys) {
    // outer ring only: holes are invisible at this scale and double the data
    const ring = poly[0];
    const pts = [];
    let px = null, py = null;
    for (const [lon, lat] of ring) {
      const x = Number(lon.toFixed(P)), y = Number(lat.toFixed(P));
      if (x === px && y === py) continue;
      pts.push(x, y); px = x; py = y;
    }
    if (pts.length / 2 >= minRingPoints) out.push(pts.join(","));
  }
  return out.join("|");
}

/** area of the largest ring's bbox, used to drop specks and to place the label */
function bboxCentroid(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  let best = null, bestArea = -1;
  for (const poly of polys) {
    const ring = poly[0];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ring) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    const area = (maxX - minX) * (maxY - minY);
    if (area > bestArea) { bestArea = area; best = [(minX + maxX) / 2, (minY + maxY) / 2]; }
  }
  return best ? [Number(best[0].toFixed(P)), Number(best[1].toFixed(P))] : [0, 0];
}

function countPoints(encoded) {
  if (!encoded) return 0;
  return encoded.split("|").reduce((n, r) => n + r.split(",").length / 2, 0);
}

/*
 * Simplification is lossy, and for a SMALL country it is lossy enough to erase
 * it (Cyprus, Qatar, Jamaica and seven others vanished at the first threshold
 * tried). A country silently missing from a map is a reporting error, not a
 * cosmetic one — the researcher would read an empty space as "no respondents
 * there". So every feature is encoded from the simplified geometry only if it
 * SURVIVES; otherwise it falls back to the raw outline, which costs a few
 * hundred bytes and keeps the map complete.
 */
function encodeWithFallback(simplified, raw, name, dropped) {
  const geom = simplified?.geometry;
  if (geom) {
    const enc = encodeRings(geom);
    if (enc) return enc;
  }
  const rawGeom = raw?.geometry;
  if (rawGeom) {
    const enc = encodeRings(rawGeom);
    if (enc) return enc;
  }
  dropped.push(name);
  return "";
}

/* ------------------------------------------------------------ countries */
const worldRaw = require("world-atlas/countries-110m.json");
const world = simplifyTopo(worldRaw, "countries", 0.3);
const countries = tc.feature(world, world.objects.countries).features;
const countriesRaw = tc.feature(worldRaw, worldRaw.objects.countries).features;
const rawById = new Map(countriesRaw.map((f) => [String(f.id), f]));

const countryRows = [];
let dropped = [];
let fellBack = [];
for (const f of countries) {
  const numeric = String(f.id).padStart(3, "0");
  const name = f.properties.name;
  /*
   * Three Natural Earth features have no ISO numeric id (they are disputed or
   * partially recognised): Kosovo, Northern Cyprus and Somaliland. They still
   * belong on a map — respondents live there — so they get the user-assigned
   * codes that are conventional for exactly this case rather than being
   * dropped or, worse, keyed by the string "undefined".
   */
  const UNASSIGNED = { Kosovo: ["XK", "XKX"], "N. Cyprus": ["XN", "XNC"], Somaliland: ["XS", "XSL"] };
  const a2 = iso.numericToAlpha2(numeric) ?? UNASSIGNED[name]?.[0];
  const a3 = iso.numericToAlpha3(numeric) ?? UNASSIGNED[name]?.[1];
  if (!a2) { dropped.push(`no-code:${name}`); continue; }
  const raw = rawById.get(String(f.id));
  const before = dropped.length;
  const simpleEnc = f.geometry ? encodeRings(f.geometry) : "";
  const rings = encodeWithFallback(f, raw, name, dropped);
  if (!rings) continue;
  if (!simpleEnc) fellBack.push(name);
  const [lon, lat] = bboxCentroid(f.geometry ?? raw.geometry);
  void before;
  countryRows.push({ code: a2, a3: a3 ?? "", name, lon, lat, rings });
}

/* ------------------------------------------------------------ US states */
const usRaw = require("us-atlas/states-10m.json");
const us = simplifyTopo(usRaw, "states", 0.75);
const states = tc.feature(us, us.objects.states).features;
const statesRaw = tc.feature(usRaw, usRaw.objects.states).features;
const rawStateById = new Map(statesRaw.map((f) => [String(f.id), f]));

const USPS = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT",
  Delaware: "DE", "District of Columbia": "DC", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL",
  Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
  Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT",
  Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
  "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA",
  "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT",
  Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
  "Puerto Rico": "PR", "United States Virgin Islands": "VI", Guam: "GU", "American Samoa": "AS",
  "Commonwealth of the Northern Mariana Islands": "MP",
};

const stateRows = [];
for (const f of states) {
  const name = f.properties.name;
  const code = USPS[name];
  if (!code) { dropped.push(`US:${name}`); continue; }
  const raw = rawStateById.get(String(f.id));
  const simpleEnc = f.geometry ? encodeRings(f.geometry) : "";
  const rings = encodeWithFallback(f, raw, `US:${name}`, dropped);
  if (!rings) continue;
  if (!simpleEnc) fellBack.push(`US:${name}`);
  const [lon, lat] = bboxCentroid(f.geometry ?? raw.geometry);
  stateRows.push({ code, a3: "", name, lon, lat, rings });
}

/* ------------------------------------------------------------ emit */
const fmt = (rows) => rows
  .sort((a, b) => a.code.localeCompare(b.code))
  .map((r) => `  ["${r.code}", ${JSON.stringify(r.name)}, "${r.a3}", ${r.lon}, ${r.lat}, "${r.rings}"],`)
  .join("\n");

const header = `/* GENERATED FILE — do not edit by hand.
 *
 * Built by scripts/gen-geo.mjs from world-atlas (Natural Earth 110m) and
 * us-atlas (US Census 10m), simplified and quantized to ~0.1° (about 11 km),
 * outer rings only. Both sources are public domain; the generator runs at
 * authoring time so the chart library keeps no geo dependency at runtime,
 * exactly as it keeps no charting dependency.
 *
 * Columns: [code, name, alpha3, centroidLon, centroidLat, rings]
 * "rings" is pipe-separated rings of comma-separated "lon,lat,lon,lat…".
 */

export type GeoRow = [code: string, name: string, a3: string, lon: number, lat: number, rings: string];

export const WORLD_COUNTRIES: GeoRow[] = [
${fmt(countryRows)}
];

export const US_STATES: GeoRow[] = [
${fmt(stateRows)}
];
`;

mkdirSync("out", { recursive: true });
writeFileSync("out/regions.ts", header);

const cPts = countryRows.reduce((n, r) => n + countPoints(r.rings), 0);
const sPts = stateRows.reduce((n, r) => n + countPoints(r.rings), 0);
console.log(`countries: ${countryRows.length} (${cPts} points)`);
console.log(`us states: ${stateRows.length} (${sPts} points)`);
console.log(`dropped:   ${dropped.length ? dropped.join(", ") : "none"}`);
console.log(`fellback:  ${fellBack.length ? fellBack.join(", ") : "none"}`);
console.log(`size:      ${(Buffer.byteLength(header) / 1024).toFixed(1)} KB`);
