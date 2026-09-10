"use client";
import React from "react";
import type { GeoAnswer } from "@rescript/schema";
import {
  geoModeOf, hasCoordinates, isGeoAnswer, formatMetres, round6,
  lngToTileX, latToTileY, tileXToLng, tileYToLat,
} from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";

/**
 * LOCATION FAMILY — three renderers over the ONE `geo` response model.
 *
 *   geopin      click / drag a pin; optional "use my location"
 *   georadius   the pin plus a distance control, drawn as a circle
 *   geoaddress  type an address → geocoded matches → pin; or keep the text
 *
 * All three store a GeoAnswer (`{ lat, lng, accuracy?, radiusM?, address?,
 * source? }`), so validation, export, piping, quality and `distance_km()`
 * see one shape and never ask which renderer produced it.
 *
 * ## The map has no dependency
 *
 * It is a slippy map drawn from raster tiles: a grid of 256-px `<img>`
 * tiles positioned by Web Mercator arithmetic (engine geo.ts), panned by
 * pointer drag, zoomed by buttons or wheel. Roughly a hundred lines, no
 * Leaflet, no CSS import, no marker-icon path problems, and it renders in
 * headless Chromium without a network (the tiles simply do not load; the
 * arithmetic still does). The tile URL is `settings.mapTiles` or the
 * OpenStreetMap default — whose usage policy asks for a real User-Agent and
 * modest volumes: a study fielded at scale should point `mapTiles` at a
 * commercial tile provider. That is a configuration, not a code change.
 *
 * ## Geocoding goes through the runtime
 *
 * The address renderer calls `/api/geocode`, which holds the provider and
 * any key. In preview it works only against the fake provider (same gate as
 * the AI routes); a live interview authenticates by session. When no
 * provider is configured the field still stores the typed address — a survey
 * must be able to ask for an address without a geocoder.
 */

const TILE = 256;
const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

type Center = { lat: number; lng: number };

function tileUrl(tpl: string, z: number, x: number, y: number): string {
  const n = 2 ** z;
  const wx = ((x % n) + n) % n; // wrap longitude
  return tpl.replace("{z}", String(z)).replace("{x}", String(wx)).replace("{y}", String(y));
}

/* ------------------------------------------------------------- the map */

interface MapProps {
  center: Center;
  zoom: number;
  onView(center: Center, zoom: number): void;
  onClick?(pt: Center): void;
  pin?: Center | null;
  onPinDrag?(pt: Center): void;
  radiusM?: number | null;
  tiles?: string;
  height?: number;
  readOnly?: boolean;
  qid: string;
}

/** Pixel offset of a point from the map centre at this zoom. */
function project(pt: Center, center: Center, zoom: number): { dx: number; dy: number } {
  return {
    dx: (lngToTileX(pt.lng, zoom) - lngToTileX(center.lng, zoom)) * TILE,
    dy: (latToTileY(pt.lat, zoom) - latToTileY(center.lat, zoom)) * TILE,
  };
}
function unproject(dx: number, dy: number, center: Center, zoom: number): Center {
  return {
    lat: tileYToLat(latToTileY(center.lat, zoom) + dy / TILE, zoom),
    lng: tileXToLng(lngToTileX(center.lng, zoom) + dx / TILE, zoom),
  };
}
/** metres per pixel at this latitude and zoom (Web Mercator) */
function metresPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

function SlippyMap(m: MapProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [size, setSize] = React.useState({ w: 600, h: m.height ?? 320 });
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth || 600, h: m.height ?? 320 });
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [m.height]);

  const drag = React.useRef<{ x: number; y: number; moved: boolean; pin: boolean } | null>(null);
  const zoom = Math.max(1, Math.min(19, Math.round(m.zoom)));

  // the tiles covering the viewport
  const cx = lngToTileX(m.center.lng, zoom), cy = latToTileY(m.center.lat, zoom);
  const tiles: { x: number; y: number; left: number; top: number }[] = [];
  const x0 = Math.floor(cx - size.w / 2 / TILE), x1 = Math.floor(cx + size.w / 2 / TILE);
  const y0 = Math.floor(cy - size.h / 2 / TILE), y1 = Math.floor(cy + size.h / 2 / TILE);
  const n = 2 ** zoom;
  for (let x = x0; x <= x1; x++) for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) {
    tiles.push({ x, y, left: size.w / 2 + (x - cx) * TILE, top: size.h / 2 + (y - cy) * TILE });
  }

  const toPoint = (e: React.PointerEvent | React.MouseEvent | React.WheelEvent): Center => {
    const rect = (ref.current as HTMLDivElement).getBoundingClientRect();
    return unproject(e.clientX - rect.left - size.w / 2, e.clientY - rect.top - size.h / 2, m.center, zoom);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // the zoom buttons are controls, not map: capturing the pointer here would swallow their click
    if ((e.target as HTMLElement).closest(".rs-map-zoom")) return;
    const onPin = (e.target as HTMLElement).closest("[data-map-pin]") != null;
    drag.current = { x: e.clientX, y: e.clientY, moved: false, pin: onPin && !m.readOnly };
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    if (d.pin) {
      m.onPinDrag?.(toPoint(e));
    } else {
      d.x = e.clientX; d.y = e.clientY;
      m.onView(unproject(-dx, -dy, m.center, zoom), zoom);
    }
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved && !d.pin && !m.readOnly) m.onClick?.(toPoint(e));
  };
  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.deltaY) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    const nz = Math.max(1, Math.min(19, zoom + dir));
    if (nz === zoom) return;
    // zoom about the cursor: keep the point under the cursor fixed
    const at = toPoint(e);
    const rect = (ref.current as HTMLDivElement).getBoundingClientRect();
    const px = e.clientX - rect.left - size.w / 2, py = e.clientY - rect.top - size.h / 2;
    const newCenter = unproject(-px, -py, at, nz);
    m.onView(newCenter, nz);
  };
  const zoomBy = (d: number) => m.onView(m.center, Math.max(1, Math.min(19, zoom + d)));

  const pinPx = m.pin ? project(m.pin, m.center, zoom) : null;
  const radiusPx = m.pin && m.radiusM ? m.radiusM / metresPerPixel(m.pin.lat, zoom) : 0;

  return (
    <div className={`rs-map${m.readOnly ? " readonly" : ""}`} ref={ref} style={{ height: size.h }}
      data-testid="rs-map" data-qid-map={m.qid} data-zoom={zoom} data-center={`${round6(m.center.lat)},${round6(m.center.lng)}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null; }}
      onWheel={onWheel} role="application" aria-label="Map">
      <div className="rs-map-tiles" aria-hidden="true">
        {tiles.map((t) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={`${zoom}/${t.x}/${t.y}`} className="rs-map-tile" alt="" draggable={false}
            src={tileUrl(m.tiles || OSM, zoom, t.x, t.y)} style={{ left: t.left, top: t.top }} loading="lazy" />
        ))}
      </div>
      {pinPx && radiusPx > 0 && (
        <div className="rs-map-radius" aria-hidden="true"
          style={{ left: size.w / 2 + pinPx.dx - radiusPx, top: size.h / 2 + pinPx.dy - radiusPx, width: radiusPx * 2, height: radiusPx * 2 }} />
      )}
      {pinPx && (
        <div className="rs-map-pin" data-map-pin data-testid="rs-map-pin" title={m.readOnly ? "" : "Drag to move"}
          style={{ left: size.w / 2 + pinPx.dx, top: size.h / 2 + pinPx.dy }} />
      )}
      <div className="rs-map-zoom">
        <button type="button" aria-label="Zoom in" data-testid="rs-map-zoom-in" onClick={() => zoomBy(1)}>+</button>
        <button type="button" aria-label="Zoom out" data-testid="rs-map-zoom-out" onClick={() => zoomBy(-1)}>−</button>
      </div>
      <div className="rs-map-attrib">{m.tiles ? "" : "© OpenStreetMap contributors"}</div>
    </div>
  );
}

/* ----------------------------------------------------------- the answer */

function useGeo(p: QRProps) {
  const value: GeoAnswer = isGeoAnswer(p.value) ? p.value : {};
  const mode = geoModeOf(p.q);
  const s = p.q.settings;
  const initial: Center = hasCoordinates(value) ? { lat: value.lat, lng: value.lng } : s.mapCenter ?? { lat: 20, lng: 0 };
  const [center, setCenter] = React.useState<Center>(initial);
  const [zoom, setZoom] = React.useState<number>(s.mapZoom ?? (hasCoordinates(value) ? 12 : 2));
  const [locating, setLocating] = React.useState<null | "busy" | "denied" | "unavailable">(null);
  const set = (patch: Partial<GeoAnswer>) => p.onChange({ ...value, ...patch });
  const place = (pt: Center, source: GeoAnswer["source"], extra: Partial<GeoAnswer> = {}) => {
    const next: GeoAnswer = { ...value, lat: round6(pt.lat), lng: round6(pt.lng), source, ...extra };
    if (source !== "device") delete next.accuracy;
    if (mode === "radius" && next.radiusM == null) next.radiusM = s.radiusDefaultM ?? s.radiusMinM ?? 1000;
    p.onChange(next);
  };
  const locate = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) { setLocating("unavailable"); return; }
    setLocating("busy");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        place(pt, "device", { accuracy: Math.round(pos.coords.accuracy) });
        setCenter(pt); setZoom((z) => Math.max(z, 14));
        setLocating(null);
      },
      (err) => setLocating(err.code === 1 ? "denied" : "unavailable"),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  };
  return { value, mode, s, center, setCenter, zoom, setZoom, set, place, locate, locating };
}

function LocateButton({ g }: { g: ReturnType<typeof useGeo> }) {
  if (!g.s.allowGeolocation) return null;
  return (
    <span className="rs-geo-locate">
      <button type="button" className="rs-btn-mini" data-testid="rs-geo-locate" onClick={g.locate} disabled={g.locating === "busy"}>
        {g.locating === "busy" ? "Locating…" : "📍 Use my location"}
      </button>
      {g.locating === "denied" && <span className="rs-geo-note" data-testid="rs-geo-locate-note">Location access was declined — place the pin by hand.</span>}
      {g.locating === "unavailable" && <span className="rs-geo-note" data-testid="rs-geo-locate-note">Location is not available on this device — place the pin by hand.</span>}
    </span>
  );
}

function Readout({ g }: { g: ReturnType<typeof useGeo> }) {
  const v = g.value;
  if (!hasCoordinates(v)) return <div className="rs-geo-readout" data-testid="rs-geo-readout">No location yet.</div>;
  return (
    <div className="rs-geo-readout" data-testid="rs-geo-readout">
      {v.address?.formatted ? <span className="rs-geo-addr">{v.address.formatted}</span> : null}
      <span className="rs-geo-coords">{round6(v.lat)}, {round6(v.lng)}</span>
      {typeof v.accuracy === "number" && <span className="rs-geo-note">± {formatMetres(v.accuracy)}</span>}
      {g.mode === "radius" && typeof v.radiusM === "number" && <span className="rs-geo-note">within {formatMetres(v.radiusM)}</span>}
      {!g.s.readOnly && (
        <button type="button" className="rs-hotspot-clear" data-testid="rs-geo-clear" onClick={() => g.set({ lat: undefined, lng: undefined, accuracy: undefined, radiusM: undefined, address: undefined, source: undefined })}>clear</button>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- pin */

export function GeoPin(p: QRProps) {
  const g = useGeo(p);
  const pin = hasCoordinates(g.value) ? { lat: g.value.lat, lng: g.value.lng } : null;
  return (
    <div className="rs-geo" data-testid="rs-geo" data-geo-mode={g.mode}>
      <SlippyMap qid={p.q.id} center={g.center} zoom={g.zoom} tiles={g.s.mapTiles} readOnly={g.s.readOnly}
        onView={(c, z) => { g.setCenter(c); g.setZoom(z); }}
        onClick={(pt) => g.place(pt, "pin")}
        pin={pin} onPinDrag={(pt) => g.place(pt, "pin")} />
      <div className="rs-geo-bar">
        <LocateButton g={g} />
        <Readout g={g} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- radius */

export function GeoRadius(p: QRProps) {
  const g = useGeo(p);
  const pin = hasCoordinates(g.value) ? { lat: g.value.lat, lng: g.value.lng } : null;
  const min = g.s.radiusMinM ?? 100, max = g.s.radiusMaxM ?? 100_000;
  const r = g.value.radiusM ?? g.s.radiusDefaultM ?? Math.min(max, Math.max(min, 5000));
  // a log slider: 100 m and 100 km both need room
  const toSlider = (m: number) => Math.round(((Math.log(m) - Math.log(min)) / (Math.log(max) - Math.log(min))) * 1000);
  const fromSlider = (t: number) => Math.round(Math.exp(Math.log(min) + (t / 1000) * (Math.log(max) - Math.log(min))));
  return (
    <div className="rs-geo" data-testid="rs-geo" data-geo-mode="radius">
      <SlippyMap qid={p.q.id} center={g.center} zoom={g.zoom} tiles={g.s.mapTiles} readOnly={g.s.readOnly}
        onView={(c, z) => { g.setCenter(c); g.setZoom(z); }}
        onClick={(pt) => g.place(pt, "pin")}
        pin={pin} onPinDrag={(pt) => g.place(pt, "pin")} radiusM={pin ? r : null} />
      <div className="rs-geo-bar">
        <label className="rs-geo-radius">
          <span>Distance: <strong data-testid="rs-geo-radius-label">{formatMetres(r)}</strong></span>
          <input type="range" min={0} max={1000} step={1} value={toSlider(Math.min(max, Math.max(min, r)))}
            data-testid="rs-geo-radius" disabled={g.s.readOnly || !pin}
            aria-label="Distance" aria-valuetext={formatMetres(r)}
            onChange={(e) => g.set({ radiusM: fromSlider(Number(e.target.value)) })} />
        </label>
        <LocateButton g={g} />
        <Readout g={g} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- address */

interface GeocodeHit { formatted: string; lat: number; lng: number; city?: string; region?: string; country?: string; postal?: string }

/** The session id for a live interview — the same test upload.tsx uses; preview and test get none. */
function liveSessionId(p: QRProps): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location.pathname.startsWith("/s/") ? p.state.sessionId : undefined;
}

export function GeoAddress(p: QRProps) {
  const g = useGeo(p);
  const [query, setQuery] = React.useState<string>(g.value.address?.formatted ?? "");
  const [hits, setHits] = React.useState<GeocodeHit[] | null>(null);
  const [status, setStatus] = React.useState<"idle" | "busy" | "none" | "off" | "error">("idle");
  const pin = hasCoordinates(g.value) ? { lat: g.value.lat, lng: g.value.lng } : null;

  // the typed text IS the answer, geocoded or not — a survey without a provider still gets the address
  const typed = (text: string) => {
    setQuery(text);
    setHits(null);
    const next: GeoAnswer = { ...g.value, address: { ...(g.value.address ?? { formatted: "" }), formatted: text }, source: "typed" };
    // a changed text no longer describes the old coordinates
    delete next.lat; delete next.lng; delete next.accuracy;
    p.onChange(text.trim() ? next : {});
  };

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setStatus("busy");
    try {
      const sid = liveSessionId(p);
      const r = await fetch("/api/geocode", {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ sessionId: sid ?? "preview", definition: sid ? undefined : p.def, q, questionId: p.q.id }),
      });
      if (r.status === 501 || r.status === 403) { setStatus("off"); setHits(null); return; }
      if (!r.ok) { setStatus("error"); return; }
      const j = await r.json().catch(() => ({})) as { hits?: GeocodeHit[] };
      const list = Array.isArray(j.hits) ? j.hits : [];
      setHits(list);
      setStatus(list.length ? "idle" : "none");
    } catch {
      setStatus("error");
    }
  };

  const choose = (h: GeocodeHit) => {
    setQuery(h.formatted);
    setHits(null);
    setStatus("idle");
    const address = { formatted: h.formatted, city: h.city, region: h.region, country: h.country, postal: h.postal };
    p.onChange({ ...g.value, lat: round6(h.lat), lng: round6(h.lng), address, source: "search" } as GeoAnswer);
    g.setCenter({ lat: h.lat, lng: h.lng });
    g.setZoom((z) => Math.max(z, 14));
  };

  return (
    <div className="rs-geo" data-testid="rs-geo" data-geo-mode="address">
      <div className="rs-geo-search">
        <input className="rs-input" type="text" value={query} placeholder={p.q.settings.placeholder ?? "Street, city, postal code…"}
          data-testid="rs-geo-address" disabled={g.s.readOnly} autoComplete="street-address"
          onChange={(e) => typed(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void search(); } }} />
        <button type="button" className="rs-btn-mini" data-testid="rs-geo-search" onClick={() => void search()} disabled={g.s.readOnly || status === "busy" || !query.trim()}>
          {status === "busy" ? "Searching…" : "Search"}
        </button>
      </div>
      {hits && hits.length > 0 && (
        <ul className="rs-geo-hits" role="listbox" data-testid="rs-geo-hits">
          {hits.map((h, i) => (
            <li key={i} role="option" aria-selected={false}>
              <button type="button" data-testid="rs-geo-hit" onClick={() => choose(h)}>{h.formatted}</button>
            </li>
          ))}
        </ul>
      )}
      {status === "none" && <div className="rs-geo-note" data-testid="rs-geo-status">No match found — your typed address will be kept as written.</div>}
      {status === "off" && <div className="rs-geo-note" data-testid="rs-geo-status">Address lookup is not available here — your typed address will be kept as written.</div>}
      {status === "error" && <div className="rs-geo-note" data-testid="rs-geo-status">Address lookup failed — your typed address will be kept as written.</div>}
      {pin && (
        <SlippyMap qid={p.q.id} center={g.center} zoom={g.zoom} tiles={g.s.mapTiles} readOnly height={220}
          onView={(c, z) => { g.setCenter(c); g.setZoom(z); }} pin={pin} />
      )}
      {pin && <Readout g={g} />}
    </div>
  );
}

registerVariantRenderer("geopin", GeoPin);
registerVariantRenderer("georadius", GeoRadius);
registerVariantRenderer("geoaddress", GeoAddress);
/** a `geo` question with no variant stored: pick the renderer from the mode */
registerVariantRenderer("base:geo", function GeoBase(p: QRProps) {
  const mode = geoModeOf(p.q);
  return mode === "address" ? <GeoAddress {...p} /> : mode === "radius" ? <GeoRadius {...p} /> : <GeoPin {...p} />;
});
