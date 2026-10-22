/**
 * THE MODERATOR'S REPLY AS A STREAM — the same NDJSON protocol as the copilot's turn route
 * (docs/COPILOT-STREAMING-2026-10-18.md), smaller: `start`, `text` (a piece of what the moderator
 * says; `replace: true` = the whole text, when the checks replaced the model's draft), `heartbeat`
 * every 8 s, then exactly ONE terminal event — `result` with the JSON body the plain path returns,
 * or `error` with its status and body. Opt-in with `Accept: application/x-ndjson`; without it the
 * route answers plain JSON. A stream that ends without a terminal event is a dropped connection: the
 * page resends with the same `afterSeq`, and the server replays the stored answer.
 */
export const wantsNdjson = (accept: string | null): boolean => /application\/x-ndjson/i.test(accept ?? "");

export function ndjsonResponse(run: (emit: (event: Record<string, unknown>) => void) => Promise<{ status: number; body: unknown }>, opts: { heartbeatMs?: number } = {}): Response {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: Record<string, unknown>) => { if (!closed) try { controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`)); } catch { closed = true; } };
      emit({ type: "start", v: 1, heartbeatMs: opts.heartbeatMs ?? 8000 });
      timer = setInterval(() => emit({ type: "heartbeat", at: Date.now() }), opts.heartbeatMs ?? 8000);
      try {
        const r = await run(emit);
        emit(r.status < 400 ? { type: "result", status: r.status, body: r.body } : { type: "error", status: r.status, body: r.body });
      } catch (e) {
        emit({ type: "error", status: 500, body: { error: (e as Error).message ? "Something went wrong — please try again." : null } });
      } finally {
        if (timer) clearInterval(timer);
        if (!closed) { closed = true; try { controller.close(); } catch { /* already closed */ } }
      }
    },
    cancel() { closed = true; if (timer) clearInterval(timer); },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" } });
}

/** read an NDJSON (or plain JSON) response — the page's reader, here so it is unit-tested with the writer */
export async function readNdjson(res: Response, onEvent: (e: Record<string, unknown>) => void): Promise<{ status: number; body: unknown }> {
  if (!/application\/x-ndjson/i.test(res.headers.get("content-type") ?? "")) {
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let terminal: { status: number; body: unknown } | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let e: Record<string, unknown>;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === "result" || e.type === "error") terminal = { status: Number(e.status) || (e.type === "error" ? 500 : 200), body: e.body };
      else onEvent(e);
    }
    if (done) break;
  }
  return terminal ?? { status: 0, body: null };
}
