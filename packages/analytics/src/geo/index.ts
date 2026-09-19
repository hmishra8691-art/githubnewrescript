import { WORLD_COUNTRIES, US_STATES, type GeoRow } from "./regions.js";

/**
 * GEOGRAPHY (§39) — turning the labels a survey actually produces ("Germany",
 * "DEU", "de", "Bayern"… no: "CA", "California") into shapes on a map.
 *
 * The chart library draws in plain SVG with no charting dependency; maps are
 * held to the same rule, so the outlines are baked into `regions.ts` by
 * `scripts/gen-geo.mjs` at authoring time and nothing geographic is installed
 * at runtime. This module is the whole geographic surface: resolve a label to
 * a region, fit a projection to a set of regions, and emit a path.
 *
 * The design bias throughout is that a map must never quietly lie. A label
 * that cannot be resolved is REPORTED (`unmatched`), never dropped in
 * silence — an empty space on a choropleth reads as "no respondents there",
 * which is a very different claim from "this label didn't match a country".
 */

export type RegionScope = "world" | "us";

export interface Region {
  code: string;
  name: string;
  /** ISO alpha-3, "" for US states */
  a3: string;
  /** label/pin anchor, in degrees */
  lon: number;
  lat: number;
  /** outer rings, each a flat [lon, lat, lon, lat, …] */
  rings: number[][];
}

/* Rings are parsed lazily: a dashboard with no map on it should not pay to
 * decode twelve thousand coordinates at import time. */
const cache = new Map<RegionScope, Region[]>();

function parse(rows: GeoRow[]): Region[] {
  return rows.map(([code, name, a3, lon, lat, rings]) => ({
    code, name, a3, lon, lat,
    rings: rings ? rings.split("|").map((r) => r.split(",").map(Number)) : [],
  }));
}

export function regionsFor(scope: RegionScope): Region[] {
  let out = cache.get(scope);
  if (!out) { out = parse(scope === "us" ? US_STATES : WORLD_COUNTRIES); cache.set(scope, out); }
  return out;
}

/* ------------------------------------------------------------ resolution */

/** lowercase, strip accents and punctuation, collapse spaces — so "Côte d'Ivoire" and "cote divoire" meet. */
export function normalizeLabel(s: string): string {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’`_]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/*
 * The source data uses Natural Earth's abbreviated names ("Dem. Rep. Congo",
 * "Bosnia and Herz.", "S. Sudan"), which is not what a questionnaire writes
 * down. These aliases close the gap between the two, plus the everyday names
 * and the ones that changed ("Swaziland" → eSwatini, "Macedonia" → North
 * Macedonia, "Burma" → Myanmar). Keys are normalized by `normalizeLabel`.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  "usa": "US", "us": "US", "u s a": "US", "united states": "US", "united states of america": "US", "america": "US",
  "uk": "GB", "united kingdom": "GB", "great britain": "GB", "britain": "GB", "england": "GB",
  "united kingdom of great britain and northern ireland": "GB",
  "south korea": "KR", "korea south": "KR", "republic of korea": "KR", "korea rep": "KR", "korea": "KR",
  "north korea": "KP", "korea north": "KP", "dprk": "KP",
  "russia": "RU", "russian federation": "RU",
  "czech republic": "CZ", "czechia": "CZ",
  "vietnam": "VN", "viet nam": "VN",
  "ivory coast": "CI", "cote divoire": "CI", "cote d ivoire": "CI",
  "uae": "AE", "united arab emirates": "AE",
  "democratic republic of the congo": "CD", "dr congo": "CD", "drc": "CD", "congo kinshasa": "CD",
  "dem rep congo": "CD", "congo democratic republic": "CD",
  "republic of the congo": "CG", "congo brazzaville": "CG", "congo": "CG",
  "bosnia": "BA", "bosnia and herzegovina": "BA", "bosnia and herz": "BA",
  "macedonia": "MK", "north macedonia": "MK", "fyrom": "MK",
  "swaziland": "SZ", "eswatini": "SZ",
  "burma": "MM", "myanmar": "MM",
  "laos": "LA", "lao pdr": "LA",
  "syria": "SY", "syrian arab republic": "SY",
  "western sahara": "EH", "w sahara": "EH",
  "dominican republic": "DO", "dominican rep": "DO",
  "central african republic": "CF", "central african rep": "CF",
  "south sudan": "SS", "s sudan": "SS",
  "equatorial guinea": "GQ", "eq guinea": "GQ",
  "solomon islands": "SB", "solomon is": "SB",
  "timor leste": "TL", "east timor": "TL",
  "cape verde": "CV", "cabo verde": "CV",
  "netherlands": "NL", "holland": "NL", "the netherlands": "NL",
  "turkey": "TR", "turkiye": "TR",
  "tanzania": "TZ", "united republic of tanzania": "TZ",
  "bolivia": "BO", "venezuela": "VE", "iran": "IR", "moldova": "MD", "brunei": "BN", "taiwan": "TW",
  "hong kong": "HK", "macau": "MO", "palestine": "PS", "kosovo": "XK",
  "falkland islands": "FK", "falkland is": "FK",
  "trinidad": "TT", "trinidad and tobago": "TT",
  "antigua": "AG", "st lucia": "LC", "saint lucia": "LC",
  "new zealand": "NZ", "papua new guinea": "PG", "sri lanka": "LK",
  "saudi arabia": "SA", "south africa": "ZA", "north cyprus": "XN", "northern cyprus": "XN",
  "somaliland": "XS", "the gambia": "GM", "gambia": "GM", "bahamas": "BS", "the bahamas": "BS",
  "philippines": "PH", "the philippines": "PH",
};

/** Built once per scope: every code, alpha-3 and name, normalized, pointing at its region. */
const indexes = new Map<RegionScope, Map<string, Region>>();
function indexFor(scope: RegionScope): Map<string, Region> {
  let idx = indexes.get(scope);
  if (idx) return idx;
  idx = new Map();
  for (const r of regionsFor(scope)) {
    idx.set(normalizeLabel(r.code), r);
    if (r.a3) idx.set(normalizeLabel(r.a3), r);
    idx.set(normalizeLabel(r.name), r);
  }
  if (scope === "world") {
    for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
      const r = regionsFor("world").find((x) => x.code === code);
      // an alias only ever ADDS a way to reach a region; it never shadows a real name
      if (r && !idx.has(alias)) idx.set(alias, r);
    }
  }
  indexes.set(scope, idx);
  return idx;
}

export function resolveRegion(label: string, scope: RegionScope): Region | undefined {
  if (!label) return undefined;
  return indexFor(scope).get(normalizeLabel(label));
}

export interface ResolvedRegions {
  scope: RegionScope;
  /** one entry per label that resolved, in the order the labels came in */
  matched: { label: string; region: Region; index: number }[];
  /** labels that matched nothing — surfaced to the reader, never swallowed */
  unmatched: string[];
}

/**
 * Resolve a whole set of category labels, choosing the scope that explains
 * more of them. A crosstab banner of US states and one of countries look
 * identical to the caller ("categories"), so the data decides, not a setting
 * the author has to remember to flip.
 */
export function resolveRegions(labels: string[], forced?: RegionScope): ResolvedRegions {
  const tryScope = (scope: RegionScope): ResolvedRegions => {
    const matched: ResolvedRegions["matched"] = [];
    const unmatched: string[] = [];
    labels.forEach((label, index) => {
      const region = resolveRegion(label, scope);
      if (region) matched.push({ label, region, index });
      else unmatched.push(label);
    });
    return { scope, matched, unmatched };
  };
  if (forced) return tryScope(forced);
  const world = tryScope("world");
  const us = tryScope("us");
  return us.matched.length > world.matched.length ? us : world;
}

/* ------------------------------------------------------------ projection */

export interface Projection {
  x(lon: number, lat: number): number;
  y(lon: number, lat: number): number;
  /** the geographic window this projection shows */
  bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number };
}

/**
 * Fit an equirectangular projection to a set of regions.
 *
 * Only each region's LARGEST ring takes part in the fit. France's outline
 * includes French Guiana and Spain's includes the Canaries, so fitting to
 * every ring makes "a map of western Europe" a map of the Atlantic with
 * Europe in one corner — which is exactly what the first attempt drew. The
 * smaller rings are still DRAWN (Sicily, the Balearics, Hawaii); they just do
 * not get a vote on where the camera points.
 */
export function fitProjection(regions: Region[], width: number, height: number, padFrac = 0.06): Projection {
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const r of regions) {
    let largest: number[] | null = null;
    for (const ring of r.rings) if (!largest || ring.length > largest.length) largest = ring;
    const ring = largest ?? [r.lon, r.lat];
    for (let i = 0; i < ring.length; i += 2) {
      if (ring[i] < minLon) minLon = ring[i];
      if (ring[i] > maxLon) maxLon = ring[i];
      if (ring[i + 1] < minLat) minLat = ring[i + 1];
      if (ring[i + 1] > maxLat) maxLat = ring[i + 1];
    }
  }
  if (!Number.isFinite(minLon)) { minLon = -180; maxLon = 180; minLat = -58; maxLat = 84; }
  // a single region would otherwise fit to a zero-size window
  if (maxLon - minLon < 1) { minLon -= 4; maxLon += 4; }
  if (maxLat - minLat < 1) { minLat -= 3; maxLat += 3; }
  const padX = (maxLon - minLon) * padFrac, padY = (maxLat - minLat) * padFrac;
  minLon -= padX; maxLon += padX; minLat -= padY; maxLat += padY;
  const s = Math.min(width / (maxLon - minLon), height / (maxLat - minLat));
  const ox = (width - (maxLon - minLon) * s) / 2;
  const oy = (height - (maxLat - minLat) * s) / 2;
  return {
    x: (lon) => ox + (lon - minLon) * s,
    y: (_lon, lat) => oy + (maxLat - lat) * s,
    bounds: { minLon, minLat, maxLon, maxLat },
  } as Projection;
}

/** The default world window: Antarctica is dropped from the FIT so it does not eat a third of the frame. */
export function worldViewRegions(scope: RegionScope): Region[] {
  const all = regionsFor(scope);
  return scope === "world" ? all.filter((r) => r.code !== "AQ" && r.lat > -58) : all;
}

/** An SVG path for one region: every ring, projected. */
export function regionPath(region: Region, p: Projection): string {
  let d = "";
  for (const ring of region.rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const x = p.x(ring[i], ring[i + 1]), y = p.y(ring[i], ring[i + 1]);
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
    }
    d += "Z";
  }
  return d;
}

export { WORLD_COUNTRIES, US_STATES };
