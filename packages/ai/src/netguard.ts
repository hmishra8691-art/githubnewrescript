import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

/**
 * THE ENDPOINT GUARD — for every address a USER can name.
 *
 * A researcher who connects their own AI provider names a URL, and the Studio
 * server then sends requests to it carrying the researcher's key and the
 * project's text. Left unchecked that is a server-side request forgery
 * primitive: `https://169.254.169.254/…` (the cloud's metadata service),
 * `https://localhost:5432`, a name whose DNS answers with a private address,
 * a public URL that redirects to one. Three layers, each of which holds if
 * the others fail:
 *
 *   1. `validateEndpoint` — the URL's SHAPE: https, no credentials, no query
 *      or fragment, a public-looking name or address, an allowed port.
 *   2. `isPrivateAddress` — an ADDRESS is never reachable if it is loopback,
 *      private, link-local, CGNAT, multicast, reserved, documentation,
 *      unique-local, 6to4/Teredo/NAT64 or an IPv4-mapped IPv6 of any of
 *      those (parsed to bytes, so `::ffff:7f00:1`, `0x7f.1`, `2130706433`
 *      and `[::1]` are all seen for what they are).
 *   3. `guardedFetch` — the CONNECTION: the name is resolved once, every
 *      answer is checked, and the socket connects to exactly the address
 *      that was checked (a `lookup` override on `https.request`) — no second
 *      lookup for a rebinding attacker to answer differently. Redirects are
 *      NOT followed; the response is size- and time-capped.
 *
 * `allowPrivate` exists for the one legitimate case — an operator who runs a
 * model on their own network and says so in the SERVER's environment
 * (`AI_BYOK_ALLOW_PRIVATE_ENDPOINTS=1`). It is never a request parameter.
 */

/* ----------------------------------------------------------------- addresses */

type Bytes = number[];

function parseV4(s: string): Bytes | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  const b = s.split(".").map(Number);
  return b.every((n) => n >= 0 && n <= 255) ? b : null;
}

/** an IPv6 literal (any notation Node accepts, an embedded dotted quad included) as 16 bytes */
function parseV6(input: string): Bytes | null {
  let s = input.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (net.isIP(s) !== 6) return null;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const v4 = parseV4(dotted[1]);
    if (!v4) return null;
    s = s.slice(0, s.length - dotted[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail ? tail.split(":") : [];
  const missing = 8 - h.length - t.length;
  if (s.includes("::") ? missing < 0 : missing !== 0) return null;
  const groups = [...h, ...Array(s.includes("::") ? missing : 0).fill("0"), ...t];
  if (groups.length !== 8) return null;
  const out: Bytes = [];
  for (const g of groups) {
    const n = parseInt(g || "0", 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffff) return null;
    out.push(n >> 8, n & 0xff);
  }
  return out;
}

const within = (b: Bytes, base: Bytes, bits: number): boolean => {
  for (let i = 0; i < bits; i += 8) {
    const keep = Math.min(8, bits - i);
    const mask = (0xff << (8 - keep)) & 0xff;
    if ((b[i / 8] & mask) !== (base[i / 8] & mask)) return false;
  }
  return true;
};

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const V6_BLOCKS: [string, number][] = [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
];
const V4_PARSED = V4_BLOCKS.map(([a, n]) => [parseV4(a)!, n] as const);
const V6_PARSED = V6_BLOCKS.map(([a, n]) => [parseV6(a)!, n] as const);

/** true for any address a user-named endpoint must never reach — and for anything that is not an address at all */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return V4_PARSED.some(([base, bits]) => within(v4, base, bits));
  const v6 = parseV6(ip);
  if (!v6) return true;
  /* ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible) are their IPv4 address */
  if (v6.slice(0, 10).every((x) => x === 0) && v6[10] === 0xff && v6[11] === 0xff) return V4_PARSED.some(([base, bits]) => within(v6.slice(12), base, bits));
  return V6_PARSED.some(([base, bits]) => within(v6, base, bits));
}

/* ----------------------------------------------------------------- the URL */

export interface EndpointOptions {
  /** the operator's own network: http and private addresses allowed. Server environment only — never a request parameter. */
  allowPrivate?: boolean;
  /** ports besides 443 (default: 443 and 8443) */
  ports?: number[];
}
export type EndpointCheck = { ok: true; url: URL; base: string } | { ok: false; code: "invalid_url" | "insecure" | "credentials" | "query" | "private_host" | "private_address" | "port" | "too_long"; message: string };

const BAD_HOST = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|in-addr\.arpa|ip6\.arpa)$/i;
const refuse = (code: Extract<EndpointCheck, { ok: false }>["code"], message: string): EndpointCheck => ({ ok: false, code, message });

/** The shape of a user-supplied API base URL. Pure, and runs again at request time inside `guardedFetch`. */
export function validateEndpoint(raw: string, opts: EndpointOptions = {}): EndpointCheck {
  const text = String(raw ?? "").trim();
  if (!text) return refuse("invalid_url", "Enter the provider's API address.");
  if (text.length > 300) return refuse("too_long", "That address is too long.");
  let url: URL;
  try { url = new URL(text); } catch { return refuse("invalid_url", "That is not a valid web address."); }
  if (url.protocol !== "https:" && !(opts.allowPrivate && url.protocol === "http:")) return refuse("insecure", "The address must start with https:// — keys are never sent over an unencrypted connection.");
  if (url.username || url.password) return refuse("credentials", "Put the key in the API key field, not in the address.");
  if (url.search || url.hash) return refuse("query", "The address must not contain a query string or fragment.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return refuse("invalid_url", "That address has no host name.");
  const literal = net.isIP(host) !== 0;
  if (!opts.allowPrivate) {
    if (literal) { if (isPrivateAddress(host)) return refuse("private_address", "That address points at a private or internal network, which cannot be used."); }
    else if (!host.includes(".") || BAD_HOST.test(host)) return refuse("private_host", "That host name looks internal, which cannot be used. Use the provider's public address.");
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const allowed = new Set([443, 8443, ...(opts.ports ?? [])]);
  if (!opts.allowPrivate && !allowed.has(port)) return refuse("port", `Port ${port} is not allowed. Providers are reached on port 443.`);
  const base = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  return { ok: true, url, base };
}

/* ----------------------------------------------------------- the connection */

export interface GuardedFetchOptions extends EndpointOptions {
  /** most response bytes read (default 32 MB — a speech clip is the biggest legitimate answer) */
  maxResponseBytes?: number;
  /** a test seam: the resolver (default `dns.lookup`, all answers) */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
}

const defaultResolve = (host: string) => dns.promises.lookup(host, { all: true, verbatim: true });

/** the multipart/stream bodies callers hand to `fetch`, as bytes with their content type */
async function bodyOf(init: RequestInit): Promise<{ bytes: Buffer | null; contentType?: string }> {
  const b = init.body as unknown;
  if (b == null) return { bytes: null };
  if (typeof b === "string") return { bytes: Buffer.from(b, "utf8") };
  if (b instanceof Uint8Array) return { bytes: Buffer.from(b) };
  if (b instanceof ArrayBuffer) return { bytes: Buffer.from(b) };
  /* FormData, Blob, URLSearchParams: let the platform encode them (this also picks the multipart boundary) */
  const probe = new Request("https://encode.invalid/", { method: "POST", body: b as BodyInit });
  return { bytes: Buffer.from(await probe.arrayBuffer()), contentType: probe.headers.get("content-type") ?? undefined };
}

/**
 * `fetch` for an address a user chose. Same inputs and a `Response` out, but:
 * the URL is validated, the name resolved ONCE with every answer checked,
 * the socket connects to a checked address, redirects are refused, and the
 * answer is capped in size and time.
 */
export async function guardedFetch(input: string | URL, init: RequestInit = {}, opts: GuardedFetchOptions = {}): Promise<Response> {
  const text = String(input);
  const check = validateEndpoint(text.replace(/\?[^#]*$/, "").replace(/#.*$/, ""), { ...opts, ports: opts.ports });
  if (!check.ok) throw Object.assign(new Error(check.message), { name: "EndpointRefused", code: check.code });
  const url = new URL(text);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const resolve = opts.resolve ?? defaultResolve;
  let addresses: { address: string; family: number }[];
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIP(host) }];
  else {
    try { addresses = await resolve(host); } catch { throw Object.assign(new Error("The provider's address could not be found."), { name: "EndpointRefused", code: "unresolved" }); }
  }
  if (!addresses.length) throw Object.assign(new Error("The provider's address could not be found."), { name: "EndpointRefused", code: "unresolved" });
  if (!opts.allowPrivate && addresses.some((a) => isPrivateAddress(a.address))) {
    throw Object.assign(new Error("That address points at a private or internal network, which cannot be used."), { name: "EndpointRefused", code: "private_address" });
  }
  const chosen = addresses[0];
  const { bytes, contentType } = await bodyOf(init);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  if (contentType && !headers["content-type"]) headers["content-type"] = contentType;
  if (bytes) headers["content-length"] = String(bytes.length);
  const lib = url.protocol === "https:" ? https : http;
  const maxBytes = opts.maxResponseBytes ?? 32 * 1024 * 1024;
  const signal = init.signal ?? undefined;
  return new Promise<Response>((resolveResponse, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const req = lib.request({
      protocol: url.protocol, hostname: host, port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`, method: (init.method ?? "GET").toUpperCase(), headers,
      /* the socket goes to the address that was checked — no second lookup */
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: chosen.address, family: chosen.family }]) : cb(null, chosen.address, chosen.family))) as never,
      servername: net.isIP(host) ? undefined : host,
    }, (res) => {
      const status = res.statusCode ?? 0;
      /* a redirect is a request for a different address, which nobody validated */
      if (status >= 300 && status < 400) { res.resume(); return resolveResponse(new Response(null, { status: 502, statusText: "redirect refused" })); }
      let bytesRead = 0;
      const limited = new Readable({ read() { /* pushed below */ } });
      res.on("data", (c: Buffer) => { bytesRead += c.length; if (bytesRead > maxBytes) { res.destroy(); limited.destroy(Object.assign(new Error("The provider's answer is too large."), { name: "ResponseTooLarge" })); } else limited.push(c); });
      res.on("end", () => limited.push(null));
      res.on("error", (e) => limited.destroy(e));
      const rh = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) rh.set(k, Array.isArray(v) ? v.join(", ") : String(v));
      const noBody = status === 204 || status === 205 || status === 304;
      resolveResponse(new Response(noBody ? null : (Readable.toWeb(limited) as unknown as ReadableStream), { status, statusText: res.statusMessage ?? "", headers: rh }));
    });
    const onAbort = () => { req.destroy(Object.assign(new Error("aborted"), { name: "AbortError" })); };
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e) => { signal?.removeEventListener("abort", onAbort); reject((e as Error).name === "AbortError" ? e : e); });
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    if (bytes) req.write(bytes);
    req.end();
  });
}
