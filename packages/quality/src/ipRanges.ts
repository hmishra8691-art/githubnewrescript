/**
 * F2 — NETWORK SIGNALS, THE FREE LAYER (2026-11-23).
 *
 * Address ranges that are not consumer connections, from lists their owners publish:
 *
 *   datacenter   cloud and hosting networks (AWS, Google Cloud, Oracle Cloud, DigitalOcean, Linode/Akamai,
 *                Cloudflare). A survey answered from one is a script, a remote desktop or a proxy — rarely a person
 *                at home.
 *   tor          Tor exit relays (the Tor Project's bulk exit list).
 *
 * Commercial VPNs and residential proxies are NOT in any free list; the `vpn` / `proxy` kinds exist so a licensed
 * feed (decision 2026-11-23: build this layer, license an offline anonymous-IP database for the rest) lands in the
 * same table and the same lookup. `operatorFeed` reads a plain `cidr,kind` CSV for that.
 *
 * Everything here is pure: the fetching, storing and lookup live in the Studio's cron job and in Postgres
 * (migration 0117, `cidr >>= inet` on a GiST index). Nothing about a respondent is sent anywhere — the lists come
 * to us.
 */

export type IpRangeKind = "datacenter" | "tor" | "vpn" | "proxy";
export interface IpRangeSource {
  id: string;
  kind: IpRangeKind;
  /** who publishes it */
  provider: string;
  /** one or more URLs, each parsed by `parse` and merged */
  urls: string[];
  format: "aws" | "gcp" | "oracle" | "csv_first" | "lines";
  /** a sanity floor: fewer ranges than this means the download was truncated or the format changed — keep the old rows */
  minRanges: number;
}

export const FREE_IP_SOURCES: IpRangeSource[] = [
  { id: "aws", kind: "datacenter", provider: "Amazon Web Services", urls: ["https://ip-ranges.amazonaws.com/ip-ranges.json"], format: "aws", minRanges: 1000 },
  { id: "gcp", kind: "datacenter", provider: "Google Cloud", urls: ["https://www.gstatic.com/ipranges/cloud.json"], format: "gcp", minRanges: 200 },
  { id: "oracle", kind: "datacenter", provider: "Oracle Cloud", urls: ["https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json"], format: "oracle", minRanges: 100 },
  { id: "digitalocean", kind: "datacenter", provider: "DigitalOcean", urls: ["https://digitalocean.com/geo/google.csv"], format: "csv_first", minRanges: 100 },
  { id: "linode", kind: "datacenter", provider: "Linode (Akamai)", urls: ["https://geoip.linode.com/"], format: "csv_first", minRanges: 50 },
  { id: "cloudflare", kind: "datacenter", provider: "Cloudflare", urls: ["https://www.cloudflare.com/ips-v4", "https://www.cloudflare.com/ips-v6"], format: "lines", minRanges: 10 },
  { id: "tor", kind: "tor", provider: "Tor Project (exit relays)", urls: ["https://check.torproject.org/torbulkexitlist"], format: "lines", minRanges: 200 },
];

/* ------------------------------------------------------------------ addresses */

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** an IPv6 address in any valid textual form → 8 sixteen-bit groups, or null */
function v6Groups(input: string): number[] | null {
  let s = input;
  if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(":") || s.split("::").length > 2) return null;
  /* an embedded IPv4 tail (::ffff:192.0.2.1) becomes two hex groups */
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    if (!V4.test(m[2])) return null;
    const b = m[2].split(".").map(Number);
    s = `${m[1]}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((h) => (/^[0-9a-fA-F]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  let groups: number[];
  if (s.includes("::")) {
    const [a, b] = s.split("::");
    const ga = parse(a), gb = parse(b);
    const fill = 8 - ga.length - gb.length;
    if (fill < 1) return null;
    groups = [...ga, ...Array(fill).fill(0), ...gb];
  } else groups = parse(s);
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

export function isIp(s: string): boolean { return V4.test(s) || v6Groups(s) !== null; }

/** a CIDR block (or a bare address, taken as /32 or /128) → its canonical text, or null when it is not one */
export function normaliseCidr(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const [addr, bits, extra] = s.split("/");
  if (extra !== undefined) return null;
  if (V4.test(addr)) {
    const n = bits === undefined ? 32 : Number(bits);
    if (!Number.isInteger(n) || n < 8 || n > 32 || (bits !== undefined && !/^\d{1,2}$/.test(bits))) return null;
    return `${addr}/${n}`;
  }
  const g = v6Groups(addr);
  if (!g) return null;
  const n = bits === undefined ? 128 : Number(bits);
  if (!Number.isInteger(n) || n < 16 || n > 128 || (bits !== undefined && !/^\d{1,3}$/.test(bits))) return null;
  return `${addr.toLowerCase()}/${n}`;
}

/** whether an address falls inside a block (for tests and in-memory checks; Postgres does this in production) */
export function cidrContains(cidr: string, ip: string): boolean {
  const [addr, bitsS] = cidr.split("/");
  const bits = Number(bitsS);
  if (V4.test(addr) && V4.test(ip)) {
    const toN = (x: string) => x.split(".").reduce((a, o) => a * 256 + Number(o), 0);
    const unit = 2 ** (32 - bits);
    return Math.floor(toN(addr) / unit) === Math.floor(toN(ip) / unit);
  }
  const ga = v6Groups(addr), gb = v6Groups(ip);
  if (!ga || !gb) return false;
  let left = bits;
  for (let i = 0; i < 8 && left > 0; i++) {
    const take = Math.min(16, left);
    const shift = 16 - take;
    if (ga[i] >> shift !== gb[i] >> shift) return false;
    left -= take;
  }
  return true;
}

/* ------------------------------------------------------------------ the formats */

/** the ranges in one downloaded document, by format; anything that is not a valid block is skipped and counted */
export function parseIpRanges(format: IpRangeSource["format"], body: string): { cidrs: string[]; skipped: number } {
  const raw: string[] = [];
  if (format === "aws" || format === "gcp" || format === "oracle") {
    let j: any;
    try { j = JSON.parse(body); } catch { return { cidrs: [], skipped: 0 }; }
    if (format === "aws") {
      for (const p of j?.prefixes ?? []) raw.push(String(p?.ip_prefix ?? ""));
      for (const p of j?.ipv6_prefixes ?? []) raw.push(String(p?.ipv6_prefix ?? ""));
    } else if (format === "gcp") {
      for (const p of j?.prefixes ?? []) raw.push(String(p?.ipv4Prefix ?? p?.ipv6Prefix ?? ""));
    } else {
      for (const r of j?.regions ?? []) for (const c of r?.cidrs ?? []) raw.push(String(c?.cidr ?? ""));
    }
  } else {
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      raw.push(format === "csv_first" ? t.split(",")[0] : t.split(/\s+/)[0]);
    }
  }
  const out = new Set<string>();
  let skipped = 0;
  for (const r of raw) { const c = normaliseCidr(r); if (c) out.add(c); else skipped++; }
  return { cidrs: [...out], skipped };
}

/** a licensed or operator-supplied feed as plain CSV: `cidr,kind` per line (kind: datacenter, tor, vpn, proxy) */
export function operatorFeed(body: string): { byKind: Record<IpRangeKind, string[]>; skipped: number } {
  const byKind: Record<IpRangeKind, string[]> = { datacenter: [], tor: [], vpn: [], proxy: [] };
  let skipped = 0;
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || /^cidr\s*,/i.test(t)) continue;
    const [c, k] = t.split(",").map((x) => x.trim());
    const cidr = normaliseCidr(c ?? "");
    const kind = (k ?? "").toLowerCase() as IpRangeKind;
    if (!cidr || !(kind in byKind)) { skipped++; continue; }
    byKind[kind].push(cidr);
  }
  return { byKind, skipped };
}
