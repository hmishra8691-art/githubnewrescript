/**
 * THE COPILOT TURN, STREAMED (2026-10-18) — docs/COPILOT-STREAMING-2026-10-18.md.
 *
 * `/api/copilot/turn` answers a request that says `Accept: application/x-ndjson` with one JSON event per
 * line while it works, ending in exactly one terminal event that carries the JSON the non-streaming path
 * returns. One code path makes both: the route runs with a SINK it reports to; without the header there is
 * no sink and the route's response is returned as it always was.
 *
 *   {"type":"start","v":1,"heartbeatMs":8000}           the model is about to be called (streaming begins)
 *   {"type":"heartbeat","at":…}                          every heartbeatMs while anything is pending
 *   {"type":"progress","stage":"item","item":2,"of":5,"id":"p2","label":"Screener"}
 *   {"type":"text","delta":"Here is","part":"reply"}     the human-readable reply as the model writes it
 *   {"type":"checkpoint","id":"p2","raw":{…}}            a plan item built (the browser keeps it at once)
 *   {"type":"result","status":200,"body":{…}}            terminal: the exact JSON body of the JSON path
 *   {"type":"error","status":503,"body":{…},"retryAfter":5}  terminal: the failure body and status of the JSON path
 *
 * Everything before `start` (auth, a bad body, a refusal without a model call, the wallet, the cache) is
 * answered as plain JSON with its own HTTP status — a client must accept either. A stream that ends
 * without a terminal event is a dropped connection.
 *
 * Pure (no Next imports): the route, the browser and the unit tests share it.
 */

export const NDJSON = "application/x-ndjson";

export type TurnStage = "plan" | "turn" | "item" | "gate" | "repair" | "coverage";
export type TurnEvent =
  | { type: "start"; v: 1; heartbeatMs: number }
  | { type: "heartbeat"; at: number }
  | { type: "progress"; stage: TurnStage; item?: number; of?: number; id?: string; label?: string }
  | { type: "text"; delta: string; part?: string }
  | { type: "checkpoint"; id: string; raw: unknown }
  | { type: "result"; status: number; body: unknown }
  | { type: "error"; status: number; body: unknown; retryAfter?: number };

/** one event, one line */
export function encodeEvent(e: TurnEvent): string {
  return `${JSON.stringify(e)}\n`;
}

const TYPES = new Set(["start", "heartbeat", "progress", "text", "checkpoint", "result", "error"]);

/** NDJSON lines from text chunks: a line split across chunks is held; blank lines and lines that are not an event are skipped (and counted) */
export class NdjsonDecoder {
  private buf = "";
  skipped = 0;
  push(text: string): TurnEvent[] {
    this.buf += text;
    const out: TurnEvent[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.line(line, out);
    }
    return out;
  }
  end(): TurnEvent[] {
    const out: TurnEvent[] = [];
    if (this.buf.trim()) this.line(this.buf, out);
    this.buf = "";
    return out;
  }
  private line(line: string, out: TurnEvent[]) {
    const t = line.trim();
    if (!t) return;
    try {
      const v = JSON.parse(t) as TurnEvent;
      if (v && typeof v === "object" && TYPES.has((v as { type?: string }).type ?? "")) { out.push(v); return; }
    } catch { /* counted below */ }
    this.skipped++;
  }
}

/** does this Accept header ask for the streamed protocol? (an explicit `application/x-ndjson`; `*\/*` does not) */
export function wantsStream(accept: string | null | undefined): boolean {
  return !!accept && accept.split(",").some((p) => p.trim().toLowerCase().split(";")[0] === NDJSON);
}

/**
 * Whether this server streams. `COPILOT_STREAMING`: `off` never (debugging: every client gets JSON), `on`
 * always when asked, `auto` (default) — when asked, except that with the FAKE provider a request must also
 * carry the `fakeStream` test seam: the browser suites written before streaming read the turn's response as
 * JSON, and keep doing so.
 */
export function streamingAllowed(env: Record<string, string | undefined>, fakeProvider: boolean, seam: boolean): boolean {
  const v = (env.COPILOT_STREAMING ?? "").trim().toLowerCase();
  if (/^(off|0|false|no)$/.test(v)) return false;
  if (/^(on|1|true|yes)$/.test(v)) return true;
  return !fakeProvider || seam;
}

/** the default interval between heartbeats: well under any idle cut-off we know of (proxies at 30–60 s, the browser's own) */
export const HEARTBEAT_MS = 8_000;

/** what the route reports while it works; every method is a no-op until streaming has started (and when it never does) */
export interface TurnSink {
  /** turn streaming on for this request (the route decides once it has read the body); options are test seams */
  configure(o: { enabled: boolean; heartbeatMs?: number; dropAfterCheckpoints?: number; dropAfterMs?: number }): void;
  /** commit to a streamed response: called right before the first model call; idempotent */
  start(): void;
  progress(p: Omit<Extract<TurnEvent, { type: "progress" }>, "type">): void;
  text(delta: string, part?: string): void;
  checkpoint(id: string, raw: unknown): void;
  /** the client went away (or the test seam dropped the stream): the route starts no further optional work */
  readonly cancelled: boolean;
  readonly streaming: boolean;
}

export interface StreamOptions {
  /** the response when the route throws after streaming began (before, the exception propagates as it always did) */
  crash: (e: unknown) => { status: number; body: unknown };
  /** told about a stream that ended early (the client left, or a scripted drop) */
  onCancel?: () => void;
}

/**
 * Run the route with a sink. Until the route calls `start()` nothing is sent: if it finishes first, its own
 * response is returned untouched (status, headers, body). Once it starts, the response is a 200 NDJSON
 * stream; the route's eventual response becomes the terminal event (`result` below 400, `error` from 400,
 * with the same status and body and the Retry-After in seconds).
 */
export async function streamTurn(run: (sink: TurnSink) => Promise<Response>, o: StreamOptions): Promise<Response> {
  const encoder = new TextEncoder();
  let enabled = false, started = false, cancelled = false, closed = false;
  let heartbeatMs = HEARTBEAT_MS, dropAfterCheckpoints = Infinity, dropAfterMs = Infinity, checkpoints = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** the stage the route announced before streaming began (the plan stage says so before its model call): sent right after `start` */
  let early: TurnEvent | null = null;
  const pending: TurnEvent[] = [];
  let hb: ReturnType<typeof setInterval> | null = null;
  let dropTimer: ReturnType<typeof setTimeout> | null = null;
  let onStart!: () => void;
  const startedP = new Promise<void>((r) => { onStart = r; });
  const stop = () => { if (hb) clearInterval(hb); if (dropTimer) clearTimeout(dropTimer); hb = null; dropTimer = null; };
  const write = (e: TurnEvent) => {
    if (!started || closed) return;
    if (!controller) { pending.push(e); return; }
    try { controller.enqueue(encoder.encode(encodeEvent(e))); } catch { closed = true; cancelled = true; stop(); }
  };
  /** the stream ends WITHOUT a terminal event: a dropped connection, as the client will see it */
  const drop = () => {
    if (closed) return;
    closed = true; cancelled = true; stop();
    try { controller?.close(); } catch { /* already closed */ }
    o.onCancel?.();
  };
  const sink: TurnSink = {
    configure(c) {
      enabled = c.enabled;
      if (Number.isFinite(c.heartbeatMs) && (c.heartbeatMs as number) > 0) heartbeatMs = Math.max(50, Math.min(30_000, Math.round(c.heartbeatMs as number)));
      if (Number.isFinite(c.dropAfterCheckpoints)) dropAfterCheckpoints = Math.max(0, Math.round(c.dropAfterCheckpoints as number));
      if (Number.isFinite(c.dropAfterMs)) dropAfterMs = Math.max(0, Math.round(c.dropAfterMs as number));
    },
    start() {
      if (!enabled || started) return;
      started = true;
      pending.push({ type: "start", v: 1, heartbeatMs });
      if (early) pending.push(early);
      onStart();
    },
    progress(p) { if (!started) { early = { type: "progress", ...p }; return; } write({ type: "progress", ...p }); },
    text(delta, part) { if (delta) write({ type: "text", delta, ...(part ? { part } : {}) }); },
    checkpoint(id, raw) {
      write({ type: "checkpoint", id, raw });
      if (started && ++checkpoints >= dropAfterCheckpoints) drop();
    },
    get cancelled() { return cancelled; },
    get streaming() { return started; },
  };
  type Done = { r: Response } | { e: unknown };
  const runP: Promise<Done> = run(sink).then((r) => ({ r }), (e) => ({ e }));
  const first = await Promise.race([runP, startedP.then(() => null)]);
  /* once the route has started (a model call is under way) the answer is a stream, even if it finished in the same tick */
  if (first && !started) {
    if ("r" in first) return first.r;
    throw first.e;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      for (const e of pending.splice(0)) c.enqueue(encoder.encode(encodeEvent(e)));
      /* dropped (the test seam) before the body was even read: what was written goes out, then the end — no terminal event */
      if (closed) { try { c.close(); } catch { /* closed */ } return; }
      hb = setInterval(() => write({ type: "heartbeat", at: Date.now() }), heartbeatMs);
      if (dropAfterMs !== Infinity) dropTimer = setTimeout(drop, dropAfterMs);
      void runP.then(async (d) => {
        let terminal: TurnEvent;
        if ("r" in d) {
          const status = d.r.status;
          const text = await d.r.text().catch(() => "");
          let body: unknown = null;
          try { body = text ? JSON.parse(text) : null; } catch { body = { error: text.slice(0, 500) }; }
          const ra = Number(d.r.headers.get("retry-after"));
          terminal = status < 400 ? { type: "result", status, body } : { type: "error", status, body, ...(Number.isFinite(ra) && ra > 0 ? { retryAfter: ra } : {}) };
        } else {
          const c2 = o.crash(d.e);
          terminal = { type: "error", status: c2.status, body: c2.body };
        }
        write(terminal);
        stop();
        if (!closed) { closed = true; try { c.close(); } catch { /* the client left */ } }
      });
    },
    cancel() { closed = true; cancelled = true; stop(); o.onCancel?.(); },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": `${NDJSON}; charset=utf-8`, "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", "x-copilot-stream": "1" },
  });
}

/* ------------------------------------------------------------ the browser's side */

/** what the page does with the events before the terminal one */
export interface TurnHandlers {
  onStart?(e: Extract<TurnEvent, { type: "start" }>): void;
  onHeartbeat?(): void;
  onProgress?(e: Extract<TurnEvent, { type: "progress" }>): void;
  onText?(delta: string, part: string | undefined): void;
  onCheckpoint?(id: string, raw: unknown): void;
}
/** the shape the copilot's resume logic already reads: status 0 = no answer (a dropped connection) */
export interface ReadTurn { status: number; ok: boolean; d: Record<string, unknown> | null; streamed: boolean; broken?: boolean; /** broken because nothing arrived for idleMs */ idle?: boolean }

/**
 * Read a turn's response, streamed or not. JSON (an older server, a proxy that rewrote it, any answer given
 * before streaming began) is read as it always was. A stream resolves with its terminal event; one that ends
 * without it — or goes `idleMs` without a byte (heartbeats count) — is `{ status: 0, broken: true }`, which
 * the copilot treats as the dropped connection it is (checkpoint, auto-resend, Resume).
 */
export async function readTurnResponse(r: Response, h: TurnHandlers = {}, opts: { idleMs?: number } = {}): Promise<ReadTurn> {
  const ct = r.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().includes(NDJSON) || !r.body) {
    const d = await r.json().catch(() => null) as Record<string, unknown> | null;
    return { status: r.status, ok: r.ok, d, streamed: false };
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  const nd = new NdjsonDecoder();
  const idleMs = opts.idleMs ?? 45_000;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  const arm = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, idleMs); };
  const handle = (e: TurnEvent): ReadTurn | null => {
    switch (e.type) {
      case "start": h.onStart?.(e); return null;
      case "heartbeat": h.onHeartbeat?.(); return null;
      case "progress": h.onProgress?.(e); return null;
      case "text": h.onText?.(e.delta, e.part); return null;
      case "checkpoint": h.onCheckpoint?.(e.id, e.raw); return null;
      case "result":
      case "error": {
        const status = Number(e.status) || (e.type === "result" ? 200 : 500);
        const d = e.body && typeof e.body === "object" ? e.body as Record<string, unknown> : null;
        return { status, ok: status >= 200 && status < 300, d, streamed: true };
      }
    }
    return null;
  };
  try {
    arm();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch { break; }
      arm();
      const events = chunk.done ? [...nd.push(dec.decode()), ...nd.end()] : nd.push(dec.decode(chunk.value, { stream: true }));
      for (const e of events) {
        const t = handle(e);
        if (t) { void reader.cancel().catch(() => {}); return t; }
      }
      if (chunk.done) break;
    }
  } finally {
    if (idle) clearTimeout(idle);
  }
  return { status: 0, ok: false, d: null, streamed: true, broken: true, ...(timedOut ? { idle: true } : {}) };
}

/** the browser's switch: `localStorage["rescript.copilot.stream"] = "off"` or NEXT_PUBLIC_COPILOT_STREAMING=off sends plain JSON requests */
export function clientStreaming(stored: string | null | undefined, env: string | undefined): boolean {
  if (/^(off|0|false|no)$/i.test((stored ?? "").trim())) return false;
  if (/^(off|0|false|no)$/i.test((env ?? "").trim()) && !/^(on|1|true|yes)$/i.test((stored ?? "").trim())) return false;
  return true;
}
