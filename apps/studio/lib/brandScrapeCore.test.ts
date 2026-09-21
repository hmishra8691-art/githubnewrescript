import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import {
  validateScrapeUrl, isPrivateAddress, fetchHtmlSafely,
  extractMetaThemeColor, extractLogoCandidate, extractStylesheetLinks,
  extractCssColorSignals, rankSeedColors, analyzeBrandHtml,
} from "./brandScrapeCore.ts";

/*
 * URL-BASED BRAND COLOR SCRAPING — the part that doesn't need a server.
 *
 * Three groups below:
 *   1. URL validation + the SSRF address guard — pure, exhaustive.
 *   2. HTML/CSS extraction — pure, against literal fixture strings. This is
 *      where §2/§3's actual requirement lives ("prioritize actual brand
 *      colors... generate a balanced palette, not one color copied
 *      everywhere") — every "not a brand color" filter and every role-
 *      scoring rule is checked directly, not just observed in aggregate.
 *   3. `fetchHtmlSafely`'s network mechanics (redirects, size cap, timeout,
 *      content-type) against a REAL local fixture server — using an
 *      explicit `isAddressAllowed: () => true` override, which only a test
 *      calling the function directly can supply (nothing in the API route
 *      threads a request-controllable override through). The very last test
 *      in this group proves the PRODUCTION DEFAULT — no override — refuses
 *      that same loopback server, so the override never weakens what
 *      actually ships.
 */

/* ============================================================ 1. URL + SSRF */

test("validateScrapeUrl accepts a plain https URL", () => {
  const r = validateScrapeUrl("https://example.com/about");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.url.hostname, "example.com");
});

test("validateScrapeUrl accepts a bare domain and adds https://", () => {
  const r = validateScrapeUrl("example.com");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.url.protocol, "https:");
});

test("validateScrapeUrl rejects non-http(s) schemes", () => {
  for (const bad of ["javascript:alert(1)", "ftp://example.com", "file:///etc/passwd", "data:text/html,<script>"]) {
    const r = validateScrapeUrl(bad);
    assert.equal(r.ok, false, `expected ${bad} to be rejected`);
  }
});

test("validateScrapeUrl rejects empty, malformed and credential-embedded URLs", () => {
  assert.equal(validateScrapeUrl("").ok, false);
  assert.equal(validateScrapeUrl("   ").ok, false);
  assert.equal(validateScrapeUrl("not a url at all, spaces and all").ok, false);
  assert.equal(validateScrapeUrl("https://user:pass@example.com").ok, false);
  assert.equal(validateScrapeUrl(`https://example.com/${"a".repeat(3000)}`).ok, false);
});

test("isPrivateAddress: IPv4 private/reserved ranges are all caught", () => {
  const shouldBlock = [
    "127.0.0.1", "127.255.255.255", // loopback
    "10.0.0.1", "10.255.255.255", // 10/8
    "172.16.0.1", "172.31.255.255", // 172.16/12
    "192.168.0.1", "192.168.255.255", // 192.168/16
    "169.254.169.254", // cloud metadata — the one that matters most
    "169.254.0.1",
    "100.64.0.1", "100.100.1.1", // CGNAT
    "0.0.0.0",
    "224.0.0.1", "255.255.255.255", // multicast / reserved
  ];
  for (const ip of shouldBlock) assert.equal(isPrivateAddress(ip), true, `${ip} must be blocked`);
});

test("isPrivateAddress: real public IPv4 addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.255.255"]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} must NOT be blocked`);
  }
});

test("isPrivateAddress: IPv6 loopback, unique-local, link-local and IPv4-mapped are all caught", () => {
  for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.5"]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} must be blocked`);
  }
});

test("isPrivateAddress: a real public IPv6 address is allowed", () => {
  assert.equal(isPrivateAddress("2001:4860:4860::8888"), false); // Google public DNS
});

/* ==================================================== 2. HTML/CSS extraction */

test("extractMetaThemeColor finds the meta tag regardless of attribute order, and normalizes the hex", () => {
  assert.equal(extractMetaThemeColor(`<meta name="theme-color" content="#2563EB">`), "#2563eb");
  assert.equal(extractMetaThemeColor(`<meta content="#16a34a" name="theme-color">`), "#16a34a");
  assert.equal(extractMetaThemeColor(`<meta name="viewport" content="width=device-width">`), null);
  assert.equal(extractMetaThemeColor(`<html><head><title>x</title></head></html>`), null);
});

test("extractLogoCandidate prefers og:image, then a logo-classed <img>, then touch-icon, then favicon, and always resolves to an absolute URL", () => {
  const base = "https://example.com/pricing";
  assert.equal(
    extractLogoCandidate(`<meta property="og:image" content="/social.png">`, base),
    "https://example.com/social.png",
  );
  assert.equal(
    extractLogoCandidate(`<img src="/assets/logo-dark.svg" class="site-logo" alt="Acme">`, base),
    "https://example.com/assets/logo-dark.svg",
  );
  assert.equal(
    extractLogoCandidate(`<link rel="apple-touch-icon" href="https://cdn.example.com/icon.png">`, base),
    "https://cdn.example.com/icon.png",
  );
  // nothing at all -> a best-guess /favicon.ico, never null (§6: don't fail, degrade)
  assert.equal(extractLogoCandidate(`<html></html>`, base), "https://example.com/favicon.ico");
});

test("extractStylesheetLinks resolves relative hrefs and caps the count", () => {
  const html = `
    <link rel="stylesheet" href="/css/a.css">
    <link rel="preload" href="/css/ignored.css" as="style">
    <link rel="stylesheet" href="https://cdn.example.com/b.css">
    <link rel="stylesheet" href="/css/c.css">
    <link rel="stylesheet" href="/css/d.css">
  `;
  const links = extractStylesheetLinks(html, "https://example.com/", 3);
  assert.deepEqual(links, ["https://example.com/css/a.css", "https://cdn.example.com/b.css", "https://example.com/css/c.css"]);
});

test("extractCssColorSignals scores custom-property brand colors highest, followed by button/header/link context", () => {
  const css = `
    :root { --color-primary: #16a34a; --color-secondary: #0f172a; }
    .btn-primary { background: #dc2626; }
    header.site-header { background: #111827; }
    a:hover { color: #2563eb; }
    body { background: #ffffff; }
  `;
  const signals = extractCssColorSignals(css);
  const byHex = Object.fromEntries(signals.map((s) => [s.hex, s]));
  assert.equal(byHex["#16a34a"].role, "primary");
  assert.ok(byHex["#16a34a"].weight >= 90, "a --color-primary custom property should score very highly");
  assert.equal(byHex["#dc2626"].role, "primary");
  assert.equal(byHex["#111827"].role, "header");
  assert.equal(byHex["#2563eb"].role, "link");
  assert.ok(byHex["#16a34a"].weight > byHex["#dc2626"].weight, "an explicit --primary custom property should outrank a .btn-primary background");
});

test("rankSeedColors filters out near-white/near-black/grayscale, and collapses near-duplicate colors", () => {
  const signals = [
    { hex: "#ffffff", role: "background", weight: 20 }, // near-white -> filtered
    { hex: "#000000", role: "text", weight: 10 }, // near-black -> filtered
    { hex: "#808080", role: "text", weight: 10 }, // gray, zero saturation -> filtered
    { hex: "#2563eb", role: "primary", weight: 100 },
    { hex: "#2660e6", role: "primary", weight: 70 }, // a near-duplicate of the one above -> collapsed
    { hex: "#16a34a", role: "accent", weight: 90 },
  ];
  const ranked = rankSeedColors(signals);
  assert.deepEqual(ranked.map((r) => r.hex), ["#2563eb", "#16a34a"]);
});

test("analyzeBrandHtml: a theme-color meta tag wins outright as the primary seed", () => {
  const html = `<html><head><meta name="theme-color" content="#7c3aed">
    <style>.btn{background:#dc2626}a{color:#0891b2}</style></head></html>`;
  const a = analyzeBrandHtml(html, "https://example.com/");
  assert.equal(a.source, "meta");
  assert.equal(a.seeds[0].hex, "#7c3aed");
  assert.equal(a.seeds[0].role, "primary");
  assert.ok(a.seeds.length > 1, "CSS-derived colors should still fill in behind the meta color");
});

test("analyzeBrandHtml: falls back to CSS-derived colors when there is no theme-color meta tag", () => {
  const html = `<html><head><style>
    :root { --brand: #ea580c; }
    .cta-button { background: #ea580c; }
  </style></head></html>`;
  const a = analyzeBrandHtml(html, "https://example.com/");
  assert.equal(a.source, "css");
  assert.equal(a.seeds[0].hex, "#ea580c");
});

test("analyzeBrandHtml: a page with only grayscale/near-white CSS yields no usable seeds — never a random 'brand color'", () => {
  const html = `<html><head><style>body{background:#fdfdfd}p{color:#222222}.border{border-color:#cccccc}</style></head></html>`;
  const a = analyzeBrandHtml(html, "https://example.com/");
  assert.equal(a.source, "none");
  assert.equal(a.seeds.length, 0);
});

test("analyzeBrandHtml: picks up a button's color even from an inline style attribute", () => {
  const html = `<html><body><button style="background:#f97316;color:#fff">Buy now</button></body></html>`;
  const a = analyzeBrandHtml(html, "https://example.com/");
  assert.ok(a.seeds.some((s) => s.hex === "#f97316"), "an inline-styled button's color should still surface as a candidate");
});

test("analyzeBrandHtml: a stylesheet's own CSS (passed as extraCss) is scored the same way as inline styles", () => {
  const html = `<html><head></head><body></body></html>`;
  const extraCss = `.btn-primary { background: #059669; }`;
  const a = analyzeBrandHtml(html, "https://example.com/", extraCss);
  assert.equal(a.seeds[0].hex, "#059669");
});

/* ================================================ 3. fetchHtmlSafely mechanics */

let server: http.Server;
let base: string;

test("fixture server: start", async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><meta name=\"theme-color\" content=\"#2563eb\"></head><body>hi</body></html>");
    } else if (url === "/redirect1") {
      res.writeHead(302, { location: "/redirect2" }); res.end();
    } else if (url === "/redirect2") {
      res.writeHead(302, { location: "/" }); res.end();
    } else if (url === "/redirect-loop") {
      res.writeHead(302, { location: "/redirect-loop" }); res.end();
    } else if (url === "/big") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html>${"x".repeat(50_000)}</html>`);
    } else if (url === "/slow") {
      setTimeout(() => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>slow</html>"); }, 2000);
    } else if (url === "/wrong-type") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } else if (url === "/style.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(".btn{background:#16a34a}");
    } else {
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("expected a real listen address");
  base = `http://127.0.0.1:${addr.port}`;
});

test("fetchHtmlSafely follows redirects and returns the final page's HTML", async () => {
  const allowAll = { isAddressAllowed: () => true };
  const page = await fetchHtmlSafely(`${base}/redirect1`, allowAll);
  assert.match(page.html, /theme-color/);
  assert.equal(page.finalUrl, `${base}/`);
});

test("fetchHtmlSafely refuses a redirect loop rather than looping forever", async () => {
  await assert.rejects(
    () => fetchHtmlSafely(`${base}/redirect-loop`, { isAddressAllowed: () => true, maxRedirects: 3 }),
    /too many redirects/,
  );
});

test("fetchHtmlSafely enforces the byte cap", async () => {
  await assert.rejects(
    () => fetchHtmlSafely(`${base}/big`, { isAddressAllowed: () => true, maxBytes: 1000 }),
    /too large/,
  );
});

test("fetchHtmlSafely enforces the timeout", async () => {
  await assert.rejects(
    () => fetchHtmlSafely(`${base}/slow`, { isAddressAllowed: () => true, timeoutMs: 300 }),
  );
});

test("fetchHtmlSafely rejects a content-type that isn't a web page", async () => {
  await assert.rejects(
    () => fetchHtmlSafely(`${base}/wrong-type`, { isAddressAllowed: () => true }),
    /isn't a web page/,
  );
});

test("fetchHtmlSafely can fetch a stylesheet when the content-type check is loosened", async () => {
  const sheet = await fetchHtmlSafely(`${base}/style.css`, { isAddressAllowed: () => true, allowedContentType: /text\/css/i });
  assert.match(sheet.html, /#16a34a/);
});

test("THE ACTUAL SECURITY GUARANTEE: with no override, the real default refuses this exact loopback server", async () => {
  // no isAddressAllowed override here — this is what a real request through
  // the API route actually gets, and it must refuse localhost/127.0.0.1
  // even though the fixture server above is happily listening on it.
  await assert.rejects(
    () => fetchHtmlSafely(`${base}/`),
    /reachable from here/,
  );
});

test("fixture server: stop", async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
