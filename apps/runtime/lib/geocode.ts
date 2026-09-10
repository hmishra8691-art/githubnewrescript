import "server-only";

/**
 * GEOCODING — address text → candidate places, for the `geo` question's
 * address renderer.
 *
 * ## Configuration (server env, never in the browser)
 *
 *   GEOCODE_API_URL   a Nominatim-compatible search endpoint, e.g.
 *                     https://nominatim.openstreetmap.org/search — or the
 *                     literal `fake:` for the deterministic in-process provider
 *   GEOCODE_API_KEY   optional; sent as `key=` (commercial Nominatim hosts)
 *   GEOCODE_EMAIL     optional; sent as `email=` — the public OSM Nominatim
 *                     asks for it, and its usage policy (1 request/second,
 *                     attribution, no bulk) means a study fielded at scale
 *                     should point GEOCODE_API_URL at a commercial host
 *
 * Unset means geocoding is OFF: `/api/geocode` answers 501 and the address
 * question keeps the typed text — the survey still asks for an address, the
 * pin is simply not placed.
 *
 * ## Why Nominatim-compatible and nothing else
 *
 * The public OSM instance, every self-hosted Nominatim, and the commercial
 * hosts (LocationIQ, Geoapify's Nominatim endpoint, OpenCage's compatibility
 * layer) accept the same `?q=&format=jsonv2&addressdetails=1` request and
 * return the same shape. One client covers them; Google/Mapbox are a
 * decision for when a customer's contract names a vendor.
 */

export interface GeocodeHit { formatted: string; lat: number; lng: number; city?: string; region?: string; country?: string; postal?: string }

const TIMEOUT_MS = 6_000;

export function geocodeConfigured(): boolean { return !!(process.env.GEOCODE_API_URL ?? "").trim(); }
export function geocodeProviderName(): "fake" | "nominatim" | null {
  const u = (process.env.GEOCODE_API_URL ?? "").trim();
  return !u ? null : u === "fake:" ? "fake" : "nominatim";
}

export async function geocode(q: string, limit = 5): Promise<GeocodeHit[]> {
  const query = q.trim().slice(0, 200);
  if (!query) return [];
  if (geocodeProviderName() === "fake") return fakeGeocode(query);
  const base = (process.env.GEOCODE_API_URL ?? "").trim();
  const url = new URL(base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", String(limit));
  const key = (process.env.GEOCODE_API_KEY ?? "").trim();
  if (key) url.searchParams.set("key", key);
  const email = (process.env.GEOCODE_EMAIL ?? "").trim();
  if (email) url.searchParams.set("email", email);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { "user-agent": "Rescript-Survey/1.0 (geocoding for a respondent's address question)", accept: "application/json" } });
    if (!r.ok) { console.warn("[rescript:geocode] provider error", JSON.stringify({ status: r.status })); return []; }
    const rows = await r.json().catch(() => []) as any[];
    return (Array.isArray(rows) ? rows : []).map(nominatimHit).filter((h): h is GeocodeHit => !!h);
  } catch (e) {
    console.warn("[rescript:geocode] provider unreachable", JSON.stringify({ error: (e as Error).name }));
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function nominatimHit(row: any): GeocodeHit | null {
  const lat = Number(row?.lat), lng = Number(row?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const a = row?.address ?? {};
  return {
    formatted: String(row?.display_name ?? "").slice(0, 300),
    lat, lng,
    city: a.city ?? a.town ?? a.village ?? a.municipality ?? undefined,
    region: a.state ?? a.region ?? a.county ?? undefined,
    country: a.country ?? undefined,
    postal: a.postcode ?? undefined,
  };
}

/**
 * THE FAKE GEOCODER — a handful of well-known places matched by substring,
 * so the browser suite can prove search → choose → pin → export without a
 * network, and a developer can see the address question work locally.
 * Selected only by GEOCODE_API_URL=fake:, never a silent fallback.
 */
const FAKE_PLACES: GeocodeHit[] = [
  { formatted: "10 Downing Street, Westminster, London SW1A 2AA, United Kingdom", lat: 51.503396, lng: -0.127640, city: "London", region: "England", country: "United Kingdom", postal: "SW1A 2AA" },
  { formatted: "Downing Street, Cambridge CB2 3EN, United Kingdom", lat: 52.203054, lng: 0.121394, city: "Cambridge", region: "England", country: "United Kingdom", postal: "CB2 3EN" },
  { formatted: "Times Square, Manhattan, New York, NY 10036, United States", lat: 40.758, lng: -73.9855, city: "New York", region: "New York", country: "United States", postal: "10036" },
  { formatted: "Connaught Place, New Delhi, Delhi 110001, India", lat: 28.6315, lng: 77.2167, city: "New Delhi", region: "Delhi", country: "India", postal: "110001" },
  { formatted: "Marine Drive, Mumbai, Maharashtra 400020, India", lat: 18.9432, lng: 72.8236, city: "Mumbai", region: "Maharashtra", country: "India", postal: "400020" },
  { formatted: "Champs-Élysées, 75008 Paris, France", lat: 48.8698, lng: 2.3078, city: "Paris", region: "Île-de-France", country: "France", postal: "75008" },
];
export function fakeGeocode(q: string): GeocodeHit[] {
  const t = q.toLowerCase();
  return FAKE_PLACES.filter((p) => p.formatted.toLowerCase().includes(t) || t.split(/\s+/).every((w) => w.length > 2 && p.formatted.toLowerCase().includes(w)));
}
