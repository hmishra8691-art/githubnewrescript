import type { GeoAnswer, Question } from "@rescript/schema";

/**
 * THE GEO RESPONSE MODEL — pure helpers shared by validation, variables,
 * flatten, piping, the calc engine and the renderers.
 *
 * A `geo` answer is `{ lat, lng, accuracy?, radiusM?, address?, source? }`
 * (schema GeoAnswer). Three renderers produce it — pin, address search,
 * radius — selected by `settings.geoMode`; one model is stored, exported and
 * reasoned about. What "answered" means depends on the mode: a pin or a
 * radius needs coordinates; an address needs at least the text, since a
 * survey with no geocoding provider must still be able to ask for one.
 */

export type GeoMode = "pin" | "address" | "radius";

export function geoModeOf(q: Question): GeoMode {
  const m = q.settings.geoMode;
  return m === "address" || m === "radius" ? m : "pin";
}

export function isGeoAnswer(v: unknown): v is GeoAnswer {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function hasCoordinates(v: unknown): v is GeoAnswer & { lat: number; lng: number } {
  return isGeoAnswer(v) && typeof v.lat === "number" && typeof v.lng === "number" && Number.isFinite(v.lat) && Number.isFinite(v.lng);
}

/** Is this a complete answer for the question's mode? */
export function geoAnswered(q: Question, v: unknown): boolean {
  if (!isGeoAnswer(v)) return false;
  const mode = geoModeOf(q);
  if (mode === "address") return hasCoordinates(v) || !!v.address?.formatted?.trim();
  return hasCoordinates(v);
}

/** Problems with a geo answer beyond "is it there" — radius bounds, coordinate sanity. */
export function geoProblems(q: Question, v: unknown): string[] {
  const out: string[] = [];
  if (!isGeoAnswer(v)) return out;
  if (v.lat != null && (v.lat < -90 || v.lat > 90)) out.push("Latitude is out of range.");
  if (v.lng != null && (v.lng < -180 || v.lng > 180)) out.push("Longitude is out of range.");
  if (geoModeOf(q) === "radius" && hasCoordinates(v)) {
    const r = v.radiusM;
    if (r == null || !Number.isFinite(r)) out.push("Please set the distance.");
    else {
      if (q.settings.radiusMinM != null && r < q.settings.radiusMinM) out.push(`The distance must be at least ${formatMetres(q.settings.radiusMinM)}.`);
      if (q.settings.radiusMaxM != null && r > q.settings.radiusMaxM) out.push(`The distance must be at most ${formatMetres(q.settings.radiusMaxM)}.`);
    }
  }
  return out;
}

/** "lat,lng" to 6 decimals — the one-column textual form (VAR itself, and what piping shows without an address). */
export function geoText(v: unknown): string {
  if (!isGeoAnswer(v)) return "";
  if (v.address?.formatted?.trim()) return v.address.formatted.trim();
  if (hasCoordinates(v)) return `${round6(v.lat)},${round6(v.lng)}`;
  return "";
}

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function formatMetres(m: number): string {
  if (m >= 1000) { const km = Math.round((m / 1000) * 10) / 10; return `${km} km`; }
  return `${Math.round(m)} m`;
}

/**
 * Accept a coordinate pair in any of the forms it reaches the calc engine in:
 * a GeoAnswer object, a "lat,lng" string (the flattened VAR), or [lat, lng].
 */
export function coordinatesOf(v: unknown): { lat: number; lng: number } | null {
  if (hasCoordinates(v)) return { lat: v.lat, lng: v.lng };
  if (Array.isArray(v) && v.length === 2 && v.every((x) => Number.isFinite(Number(x)))) return { lat: Number(v[0]), lng: Number(v[1]) };
  if (typeof v === "string") {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(v);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }
  }
  return null;
}

/** Great-circle distance in kilometres (haversine, mean Earth radius 6371.0088 km). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371.0088;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Slippy-map arithmetic (Web Mercator, 256-px tiles) — shared by the map
 * renderer and its test so both agree on what a click means.
 */
export function lngToTileX(lng: number, z: number): number { return ((lng + 180) / 360) * 2 ** z; }
export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
export function tileXToLng(x: number, z: number): number { return (x / 2 ** z) * 360 - 180; }
export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
