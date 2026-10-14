import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isPrivateAddress, validateEndpoint, guardedFetch } from "./netguard.js";

/** THE ENDPOINT GUARD: addresses, URL shapes, and the connection itself. */

test("addresses a user-named endpoint must never reach — every notation", () => {
  const blocked = [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "169.254.0.1",
    "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "192.0.0.5", "198.18.0.1", "203.0.113.9", "192.0.2.1",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "2001:db8::1", "2002:7f00:1::1", "2001::1", "64:ff9b::7f00:1", "100::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.1.2.3", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:192.168.0.1", "[::1]", "fe80::1%eth0",
    "not-an-ip", "", "999.1.1.1", "1.2.3",
  ];
  for (const ip of blocked) assert.equal(isPrivateAddress(ip), true, ip);
  const open = ["8.8.8.8", "1.1.1.1", "104.18.2.161", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.1.1", "192.169.0.1", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e", "::ffff:8.8.8.8", "::ffff:808:808"];
  for (const ip of open) assert.equal(isPrivateAddress(ip), false, ip);
});

test("URL shapes: https only, no credentials, no query, public names, port 443", () => {
  const ok = (u: string) => assert.equal(validateEndpoint(u).ok, true, u);
  const no = (u: string, code: string, o = {}) => { const r = validateEndpoint(u, o); assert.equal(r.ok, false, u); if (!r.ok) assert.equal(r.code, code, u); };
  ok("https://api.openai.com/v1"); ok("https://api.openai.com/v1/"); ok("https://generativelanguage.googleapis.com/v1beta/openai"); ok("https://llm.example.org:8443/v1"); ok("https://[2606:4700:4700::1111]/v1");
  assert.equal((validateEndpoint("https://API.OpenAI.com/v1/") as { base: string }).base, "https://api.openai.com/v1");
  no("http://api.openai.com/v1", "insecure"); no("ftp://x.example.com", "insecure"); no("javascript:alert(1)", "insecure"); no("", "invalid_url"); no("not a url", "invalid_url");
  no("https://user:pw@api.example.com/v1", "credentials"); no("https://user@api.example.com/v1", "credentials");
  no("https://api.example.com/v1?key=abc", "query"); no("https://api.example.com/v1#x", "query");
  no("https://localhost/v1", "private_host"); no("https://foo.localhost/v1", "private_host"); no("https://db.internal/v1", "private_host"); no("https://printer.local/v1", "private_host"); no("https://intranet/v1", "private_host"); no("https://metadata/computeMetadata", "private_host");
  no("https://127.0.0.1/v1", "private_address"); no("https://169.254.169.254/latest/meta-data", "private_address"); no("https://[::1]/v1", "private_address"); no("https://[::ffff:7f00:1]/v1", "private_address"); no("https://10.0.0.5/v1", "private_address");
  /* notations the URL parser normalises to dotted quads */
  no("https://2130706433/v1", "private_address"); no("https://0x7f.1/v1", "private_address"); no("https://017700000001/v1", "private_address"); no("https://127.1/v1", "private_address");
  no("https://api.example.com:5432/v1", "port"); no("https://api.example.com:22/v1", "port"); no("https://api." + "a".repeat(300) + ".com", "too_long");
  /* the operator's own network, said in the server environment */
  assert.equal(validateEndpoint("http://127.0.0.1:11434/v1", { allowPrivate: true }).ok, true);
  assert.equal(validateEndpoint("https://models.corp.internal/v1", { allowPrivate: true }).ok, true);
});

async function server(handler: http.RequestListener): Promise<{ url: string; port: number; close: () => Promise<void>; hits: () => number }> {
  let n = 0;
  const s = http.createServer((req, res) => { n++; handler(req, res); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, port, hits: () => n, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
}

test("guardedFetch: refuses a name that resolves to a private address — whatever the name looks like", async () => {
  const s = await server((_q, r) => r.end("secret"));
  try {
    for (const answer of ["127.0.0.1", "169.254.169.254", "10.0.0.7", "::1", "::ffff:7f00:1"]) {
      await assert.rejects(guardedFetch("https://api.looks-public.com/v1/chat", { method: "POST", body: "{}" }, { resolve: async () => [{ address: answer, family: answer.includes(":") ? 6 : 4 }] }), (e: Error & { code?: string }) => e.name === "EndpointRefused" && e.code === "private_address", answer);
    }
    /* ANY private answer among several refuses: a public one cannot launder it */
    await assert.rejects(guardedFetch("https://api.looks-public.com/v1", {}, { resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }] }), (e: Error & { code?: string }) => e.code === "private_address");
    assert.equal(s.hits(), 0, "nothing was sent");
    await assert.rejects(guardedFetch("https://nowhere.example.com/v1", {}, { resolve: async () => { throw new Error("ENOTFOUND"); } }), (e: Error & { code?: string }) => e.code === "unresolved");
    await assert.rejects(guardedFetch("https://127.0.0.1/v1"), (e: Error & { code?: string }) => e.code === "private_address");
    await assert.rejects(guardedFetch("http://api.example.com/v1"), (e: Error & { code?: string }) => e.code === "insecure");
  } finally { await s.close(); }
});

test("guardedFetch (operator's own network): the socket goes to the CHECKED address, with the right Host, body, headers and answer", async () => {
  let seen: { host?: string; auth?: string; ct?: string; body: string; method?: string; url?: string } = { body: "" };
  const s = await server((q, r) => { let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { seen = { host: q.headers.host, auth: q.headers.authorization, ct: q.headers["content-type"], body: b, method: q.method, url: q.url }; r.writeHead(200, { "content-type": "application/json", "retry-after": "3" }); r.end('{"ok":true}'); }); });
  try {
    /* the name is resolved by the injected resolver — the connection must follow it, not the system's DNS */
    const r = await guardedFetch(`http://llm.example.test:${s.port}/v1/chat/completions?x=1`, { method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) }, { allowPrivate: true, resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true }); assert.equal(r.headers.get("retry-after"), "3");
    assert.deepEqual([seen.host, seen.auth, seen.ct, seen.body, seen.method, seen.url], [`llm.example.test:${s.port}`, "Bearer k", "application/json", '{"a":1}', "POST", "/v1/chat/completions?x=1"]);
    /* multipart: the platform picks the boundary and the guard carries it */
    const form = new FormData(); form.append("model", "whisper-1"); form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), "a.webm");
    await guardedFetch(`http://llm.example.test:${s.port}/v1/audio/transcriptions`, { method: "POST", body: form }, { allowPrivate: true, resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    assert.match(seen.ct ?? "", /^multipart\/form-data; boundary=/); assert.match(seen.body, /name="model"\r\n\r\nwhisper-1/); assert.match(seen.body, /filename="a\.webm"/);
  } finally { await s.close(); }
});

test("guardedFetch: a redirect is not followed (it is an address nobody validated); an oversized answer and an abort end the call", async () => {
  const internal = await server((_q, r) => r.end("INTERNAL"));
  const s = await server((q, r) => {
    if (q.url === "/redirect") { r.writeHead(302, { location: `${internal.url}/` }); return r.end(); }
    if (q.url === "/big") { r.writeHead(200); const chunk = Buffer.alloc(64 * 1024, 65); let i = 0; const t = setInterval(() => { if (i++ > 64) { clearInterval(t); r.end(); } else r.write(chunk); }, 1); return; }
    if (q.url === "/slow") return; /* never answers */
    r.end("ok");
  });
  const opts = { allowPrivate: true, resolve: async () => [{ address: "127.0.0.1", family: 4 }] };
  try {
    const r = await guardedFetch(`http://x.test:${s.port}/redirect`, {}, opts);
    assert.equal(r.status, 502); assert.equal(internal.hits(), 0, "the redirect target was never contacted");
    const big = await guardedFetch(`http://x.test:${s.port}/big`, {}, { ...opts, maxResponseBytes: 100_000 });
    await assert.rejects(big.arrayBuffer(), /too large/i);
    const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 50);
    await assert.rejects(guardedFetch(`http://x.test:${s.port}/slow`, { signal: ctrl.signal }, opts), (e: Error) => e.name === "AbortError");
  } finally { await s.close(); await internal.close(); }
});
