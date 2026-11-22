/**
 * GZIP FOR LARGE JSON REQUEST BODIES (scale readiness, step 1, 2026-11-22).
 *
 * Browsers never compress a request body. The Studio's autosave PUTs the whole survey definition on every 900 ms
 * pause in typing — 849 KB on average and up to 2.6 MB in production (claude/prelaunch-audit.md) — so every save
 * crossed the network, the CDN↔function hop and the function's memory at full size. Survey JSON is repetitive:
 * measured on the Master Demo, 196 KB → 37 KB (5.3×), so an average 849 KB save is roughly 160 KB on the wire.
 *
 * Both halves use only web-standard streams (CompressionStream / DecompressionStream), which exist in every
 * supported browser and in Node ≥ 18, so this file has no Node imports and is safe in the client bundle.
 *
 * SAFE ACROSS DEPLOY SKEW, in both directions:
 *   - an older browser without CompressionStream, or a small body, sends plain JSON exactly as before;
 *   - a newer editor talking to an older server (which cannot read gzip and answers 400 "definition required")
 *     or to any server that answers 415 is retried ONCE as plain JSON, and gzip is switched off for this tab.
 *   - the server still accepts plain JSON, so an older editor talking to a newer server is unchanged.
 *
 * The server side caps the DECOMPRESSED size (a small gzip can expand enormously), refusing with 413.
 */

/** below this, compressing costs more than it saves */
export const GZIP_MIN_BYTES = 16 * 1024;
/** largest decompressed JSON body accepted (the largest production survey is ~2.6 MB) */
export const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

const hasCompression = (): boolean => typeof CompressionStream !== "undefined";

/** gzip a JSON string, or null when it is too small, unsupported here, or compression fails */
export async function gzipJson(json: string, minBytes = GZIP_MIN_BYTES): Promise<ArrayBuffer | null> {
  if (json.length < minBytes || !hasCompression()) return null;
  try {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    return await new Response(stream).arrayBuffer();
  } catch {
    return null;
  }
}

let gzipRefused = false;
/** for tests: forget that a server refused gzip */
export function resetGzipRefusal(): void { gzipRefused = false; }
export function isGzipRefused(): boolean { return gzipRefused; }

/** did this response come from a server that could not read the gzip body? */
async function refusedEncoding(r: Response): Promise<boolean> {
  if (r.status === 415) return true;
  if (r.status !== 400) return false;
  // an older draft route reads the gzip bytes as JSON, gets nothing, and says the definition is missing
  const d = await r.clone().json().catch(() => ({} as { error?: unknown }));
  return d?.error === "definition required";
}

/**
 * Send a JSON string, gzipped when worthwhile. Same contract as `fetch`: the caller reads the Response as before.
 * `fetchImpl` is for tests.
 */
export async function sendJson(
  url: string,
  json: string,
  init: { method: string; cache?: RequestCache },
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!gzipRefused) {
    const packed = await gzipJson(json);
    if (packed) {
      const r = await fetchImpl(url, {
        ...init,
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: packed,
      });
      if (!(await refusedEncoding(r))) return r;
      gzipRefused = true;
    }
  }
  return fetchImpl(url, { ...init, headers: { "content-type": "application/json" }, body: json });
}

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 | 415; error: string };

/**
 * Read a request's JSON body, plain or gzip. Never throws. An unreadable body is `{ ok: false, status: 400 }`,
 * which a route can map to the reply it already gives for a missing body.
 */
export async function readJsonBody(req: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<JsonBodyResult> {
  const encoding = (req.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") {
    try { return { ok: true, value: await req.json() }; }
    catch { return { ok: false, status: 400, error: "body is not valid JSON" }; }
  }
  if (encoding !== "gzip") return { ok: false, status: 415, error: `unsupported content-encoding: ${encoding}` };
  if (!req.body || typeof DecompressionStream === "undefined") {
    return { ok: false, status: req.body ? 415 : 400, error: req.body ? "gzip is not supported here" : "empty body" };
  }

  const reader = req.body.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: `body larger than ${maxBytes} bytes once decompressed` };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, error: "body is not valid gzip" };
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  try { return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) }; }
  catch { return { ok: false, status: 400, error: "body is not valid JSON" }; }
}
