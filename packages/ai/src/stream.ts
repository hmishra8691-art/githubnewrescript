import { ProviderError, type ProviderErrorKind } from "./provider.js";

/**
 * STREAMED REPLIES (2026-10-18) — the provider's answer read as it is written.
 *
 * `completeJson(…, { onText })` asks the provider to stream (Anthropic Messages
 * SSE, OpenAI-compatible chat SSE) and hands each piece of text to `onText` as
 * it arrives; the call still ends with the same parsed JSON and the same usage
 * report (input, output, cache read and cache write tokens) as the
 * non-streaming call — billing does not change with the transport.
 *
 * This file holds the pure parts, so they are tested without a network:
 *
 *   SseDecoder           server-sent events from text chunks (CRLF/LF/CR, a
 *                        line split across chunks, multi-line data, comments)
 *   readAnthropicSse     a Messages stream → text, stop reason, usage, model
 *   readChatSse          a chat-completions stream → the same
 *   JsonTextExtractor    the human-readable string field(s) of a JSON object,
 *                        decoded progressively from the partial JSON text
 *   fakeStreamText       the fake provider's stream: chunks, a delay, a
 *                        scripted mid-stream failure
 */

export interface SseEvent { event: string; data: string }

/** Server-sent events from text, chunk by chunk. A line (or a CRLF) split across chunks is held until it is whole. */
export class SseDecoder {
  private buf = "";
  private event = "";
  private data: string[] = [];
  push(text: string): SseEvent[] {
    this.buf += text;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      /* a CR at the very end may be the first half of a CRLF: wait for the next chunk */
      if (m[0] === "\r" && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this.line(line, out);
    }
    return out;
  }
  /** the stream ended: a last event without its blank line is still an event */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) { this.line(this.buf.replace(/\r$/, ""), out); this.buf = ""; }
    this.line("", out);
    return out;
  }
  private line(line: string, out: SseEvent[]) {
    if (line === "") {
      if (this.data.length) out.push({ event: this.event || "message", data: this.data.join("\n") });
      this.event = ""; this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
  }
}

/** What a streamed reply came to: the same parts `completeJson` reads from a whole response */
export interface StreamedReply {
  content: string;
  /** "length" when cut off at max_tokens (both shapes), else the provider's stop reason */
  finish: string | null;
  /** the provider's usage object, in its own shape (read by `chatUsageFrom`) — null when it sent none */
  usage: Record<string, unknown> | null;
  model?: string;
  /** the stream said it was finished (message_stop / [DONE] / a finish reason) */
  complete: boolean;
  /** the provider reported an error inside the stream */
  error?: { type?: string; message?: string };
}

/** Read a byte stream as SSE events; `onEvent` returns true to stop reading. */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (e: SseEvent) => boolean | void): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const sse = new SseDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      const events = done ? [...sse.push(dec.decode()), ...sse.end()] : sse.push(dec.decode(value, { stream: true }));
      for (const e of events) if (onEvent(e)) { await reader.cancel().catch(() => {}); return; }
      if (done) return;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

const parse = (s: string): Record<string, unknown> | null => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v as Record<string, unknown> : null; } catch { return null; } };
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});

/**
 * An Anthropic Messages stream: `message_start` (the model, and the input usage — `input_tokens`,
 * `cache_read_input_tokens`, `cache_creation_input_tokens`), `content_block_delta` text, `message_delta`
 * (the stop reason and the output usage, which may repeat the input counts), `message_stop`, `error`.
 * The usage objects are merged, later values winning: the result is the usage a whole response carries.
 */
export async function readAnthropicSse(body: ReadableStream<Uint8Array>, onText?: (delta: string) => void): Promise<StreamedReply> {
  const out: StreamedReply = { content: "", finish: null, usage: null, complete: false };
  await readSse(body, (e) => {
    const j = parse(e.data);
    if (!j) return;
    const type = String(j.type ?? e.event);
    if (type === "message_start") {
      const m = obj(j.message);
      if (typeof m.model === "string") out.model = m.model;
      if (m.usage && typeof m.usage === "object") out.usage = { ...(out.usage ?? {}), ...obj(m.usage) };
    } else if (type === "content_block_start") {
      const b = obj(j.content_block);
      if (b.type === "text" && typeof b.text === "string" && b.text) { out.content += b.text; onText?.(b.text); }
    } else if (type === "content_block_delta") {
      const d = obj(j.delta);
      if (d.type === "text_delta" && typeof d.text === "string" && d.text) { out.content += d.text; onText?.(d.text); }
    } else if (type === "message_delta") {
      const d = obj(j.delta);
      if (typeof d.stop_reason === "string") out.finish = d.stop_reason === "max_tokens" ? "length" : d.stop_reason;
      if (j.usage && typeof j.usage === "object") {
        /* a null in the delta's usage is "not reported here", not zero */
        const u = Object.fromEntries(Object.entries(obj(j.usage)).filter(([, v]) => v != null));
        out.usage = { ...(out.usage ?? {}), ...u };
      }
    } else if (type === "message_stop") {
      out.complete = true;
      return true;
    } else if (type === "error") {
      const er = obj(j.error);
      out.error = { type: typeof er.type === "string" ? er.type : undefined, message: typeof er.message === "string" ? er.message : undefined };
      return true;
    }
  });
  return out;
}

/**
 * An OpenAI-compatible chat stream: `data: {choices:[{delta:{content}, finish_reason}]}` chunks, a last
 * chunk with `usage` (asked for with `stream_options.include_usage`; `prompt_tokens_details.cached_tokens`
 * as in a whole response), `data: [DONE]`. Some gateways put `{error:{…}}` in a data line.
 */
export async function readChatSse(body: ReadableStream<Uint8Array>, onText?: (delta: string) => void): Promise<StreamedReply> {
  const out: StreamedReply = { content: "", finish: null, usage: null, complete: false };
  await readSse(body, (e) => {
    if (e.data.trim() === "[DONE]") { out.complete = true; return true; }
    const j = parse(e.data);
    if (!j) return;
    if (j.error) {
      const er = obj(j.error);
      out.error = { type: typeof er.type === "string" ? er.type : typeof er.code === "string" ? er.code : undefined, message: typeof er.message === "string" ? er.message : typeof j.error === "string" ? j.error : undefined };
      return true;
    }
    if (typeof j.model === "string" && j.model) out.model = j.model;
    const c = Array.isArray(j.choices) ? obj(j.choices[0]) : {};
    const d = obj(c.delta);
    if (typeof d.content === "string" && d.content) { out.content += d.content; onText?.(d.content); }
    if (typeof c.finish_reason === "string" && c.finish_reason) { out.finish = c.finish_reason; out.complete = true; }
    if (j.usage && typeof j.usage === "object") out.usage = obj(j.usage);
  });
  return out;
}

/** a provider's in-stream error, as the ProviderError the non-streaming path would have raised for the same failure */
export function streamError(err: { type?: string; message?: string } | undefined, host?: string): ProviderError {
  const t = (err?.type ?? "").toLowerCase();
  const kind: ProviderErrorKind = /overload/.test(t) ? "overloaded"
    : /rate_limit|rate-limit|429/.test(t) ? "rate_limited"
    : /auth/.test(t) ? "auth"
    : /permission/.test(t) ? "forbidden"
    : /not_found/.test(t) ? "not_found"
    : /invalid_request|request_too_large|bad_request/.test(t) ? "bad_request"
    : /quota|billing|credit/.test(t) ? "quota_exhausted"
    : "server";
  return new ProviderError({ kind, detail: `stream error${err?.type ? ` ${err.type}` : ""}${err?.message ? `: ${err.message}` : ""}`, host, exhausted: true });
}

/** a stream that ended before the provider said it was finished: the connection dropped — a temporary failure */
export function truncatedStream(host?: string): ProviderError {
  return new ProviderError({ kind: "network", detail: "the provider's stream ended before the reply was complete", host, exhausted: true });
}

/* ------------------------------------------------------------ the human-readable text inside partial JSON */

const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };

/**
 * THE READABLE PART OF A JSON REPLY, AS IT IS WRITTEN. The copilot's reply is one JSON object; its
 * `reply` (or a plan's `summary`) is what the researcher reads. Fed the raw text chunk by chunk, this
 * emits the decoded characters of the named top-level string fields as they arrive — tolerant of text
 * or a code fence before the object, of escapes (`\n`, `\"`, `\uXXXX`) and surrogate pairs split across
 * chunks (a high surrogate is held until its pair arrives), of nested objects and arrays (only
 * top-level keys count). It never throws; text that is not JSON yields nothing.
 */
export class JsonTextExtractor {
  private started = false;
  private finished = false;
  private depth = 0;
  private inString = false;
  private role: "key" | "target" | "other" = "other";
  private expectKey = false;
  private lastKey = "";
  private keyBuf = "";
  private esc: null | "start" | string = null;
  private high = "";
  private out = "";
  private field = "";
  private all = "";
  constructor(private readonly fields: readonly string[], private readonly onText: (delta: string, field: string) => void) {}
  /** everything extracted so far */
  get text(): string { return this.all; }
  push(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) this.step(chunk[i]);
    this.flush();
  }
  private flush() {
    if (!this.out) return;
    const d = this.out; this.out = "";
    this.all += d;
    this.onText(d, this.field);
  }
  private emit(ch: string) {
    const c = ch.charCodeAt(0);
    if (this.high) {
      const h = this.high; this.high = "";
      if (c >= 0xdc00 && c <= 0xdfff) { this.out += h + ch; return; }
      this.out += "�";           /* a lone high surrogate: the replacement character, never half a pair */
    }
    if (c >= 0xd800 && c <= 0xdbff) { this.high = ch; return; }
    if (c >= 0xdc00 && c <= 0xdfff) { this.out += "�"; return; }
    this.out += ch;
  }
  private append(ch: string) {
    if (this.role === "key") this.keyBuf += ch;
    else if (this.role === "target") this.emit(ch);
  }
  private step(ch: string) {
    if (this.finished) return;
    if (!this.started) {
      if (ch === "{") { this.started = true; this.depth = 1; this.expectKey = true; }
      return;
    }
    if (this.inString) {
      if (this.esc === "start") {
        if (ch === "u") { this.esc = ""; return; }
        this.esc = null;
        this.append(ESC[ch] ?? ch);
        return;
      }
      if (this.esc !== null) {
        this.esc += ch;
        if (this.esc.length < 4) return;
        const code = /^[0-9a-f]{4}$/i.test(this.esc) ? parseInt(this.esc, 16) : NaN;
        this.esc = null;
        if (Number.isFinite(code)) this.append(String.fromCharCode(code));
        return;
      }
      if (ch === "\\") { this.esc = "start"; return; }
      if (ch === '"') {
        this.inString = false;
        if (this.role === "key") { this.lastKey = this.keyBuf; this.expectKey = false; }
        if (this.role === "target") { if (this.high) { this.high = ""; this.out += "�"; } this.flush(); }
        this.role = "other";
        return;
      }
      this.append(ch);
      return;
    }
    if (ch === '"') {
      this.inString = true;
      if (this.depth === 1 && this.expectKey) { this.role = "key"; this.keyBuf = ""; }
      else if (this.depth === 1 && this.fields.includes(this.lastKey)) {
        this.flush();
        this.role = "target"; this.field = this.lastKey;
      } else this.role = "other";
      return;
    }
    if (ch === "{" || ch === "[") { this.depth++; return; }
    if (ch === "}" || ch === "]") { this.depth--; if (this.depth <= 0) this.finished = true; return; }
    if (this.depth === 1) {
      if (ch === ",") { this.expectKey = true; this.lastKey = ""; }
      else if (ch === ":") this.expectKey = false;
    }
  }
}

/* ------------------------------------------------------------ the fake provider's stream */

/** TEST SEAM (fake provider only): how the stand-in model streams its reply */
export interface FakeStreamScript {
  /** the text the stand-in "writes" (default: an empty object) */
  text?: string;
  /** characters per chunk (default 24) */
  chunkChars?: number;
  /** pause before each chunk, ms (default 0, at most 2000) */
  delayMs?: number;
  /** fail after this many characters were written */
  failAfterChars?: number;
  /** the failure's kind (default "network", as a dropped provider connection) */
  failKind?: ProviderErrorKind;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** the fake provider "writing": the text in chunks, each after the scripted pause; a scripted failure part-way */
export async function fakeStreamText(script: FakeStreamScript, onText?: (delta: string) => void): Promise<string> {
  const text = typeof script.text === "string" ? script.text : "{}";
  const size = Math.max(1, Math.min(10_000, Math.round(Number(script.chunkChars) || 24)));
  const delay = Math.max(0, Math.min(2000, Math.round(Number(script.delayMs) || 0)));
  const failAt = Number.isFinite(script.failAfterChars) ? Math.max(0, Math.round(script.failAfterChars as number)) : Infinity;
  let sent = 0;
  while (sent < text.length) {
    if (delay) await sleep(delay);
    if (sent >= failAt) throw new ProviderError({ kind: script.failKind ?? "network", detail: "scripted mid-stream failure", host: "fake", exhausted: true });
    const piece = text.slice(sent, Math.min(text.length, sent + size, failAt));
    sent += piece.length;
    onText?.(piece);
  }
  return text;
}
