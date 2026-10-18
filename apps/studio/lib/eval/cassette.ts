import { readAnthropicSse, readChatSse } from "@rescript/ai";

/**
 * CASSETTES (AI evaluation harness): a real run's provider answers, recorded at
 * the HTTP boundary so a later run can re-score them offline with no key.
 *
 *   --record   the real `fetch` to the provider is wrapped: each answer is kept
 *              per case and turn, NORMALISED (the reply text, why it stopped,
 *              the provider's usage object, the model) — never a request
 *              header, never the key, never the prompt.
 *   --replay   `fetch` to the recorded provider base answers from the cassette,
 *              in order, in whatever shape the request asks for: a whole
 *              response or a stream (SSE), OpenAI-compatible chat or Anthropic
 *              Messages. So the WHOLE real pipeline runs — the provider client's
 *              parsing, continuations, the usage the meter prices (cache read /
 *              write included), the route's gate — and only the network is
 *              replaced. A request the cassette has no answer for fails the turn
 *              (the pipeline changed: record again), it is never invented.
 */

export interface CassetteExchange {
  /** which endpoint answered */
  path: "chat" | "messages" | "embeddings" | "other";
  status: number;
  /** a non-2xx answer's body (truncated), as the provider said it */
  errorBody?: string;
  content: string;
  finish: string | null;
  usage: Record<string, unknown> | null;
  model?: string;
  /** the raw JSON of an endpoint that is not a chat (embeddings) */
  raw?: unknown;
  latencyMs: number;
}
export interface CassetteTurn { latencyMs: number; exchanges: CassetteExchange[] }
export interface Cassette {
  version: 1;
  recordedAt: string;
  /** the provider the recording was made against — the replay talks to the same base and model, without a network */
  provider: { base: string; model: string; modelSmall?: string };
  cases: Record<string, { turns: CassetteTurn[] }>;
}

const pathOf = (url: string): CassetteExchange["path"] => (/\/chat\/completions(?:\?|$)/.test(url) ? "chat" : /\/messages(?:\?|$)/.test(url) ? "messages" : /\/embeddings(?:\?|$)/.test(url) ? "embeddings" : "other");
const urlOf = (input: unknown): string => (typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: string })?.url ?? ""));
const bodyOf = (init: RequestInit | undefined): Record<string, unknown> => { try { return typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { return {}; } };
const streamOf = (text: string): ReadableStream<Uint8Array> => new Response(text).body!;

/** a provider answer, whole or streamed, in the normal form a cassette keeps */
export async function normalizeAnswer(path: CassetteExchange["path"], status: number, contentType: string, text: string): Promise<Omit<CassetteExchange, "latencyMs">> {
  if (status < 200 || status >= 300) return { path, status, errorBody: text.slice(0, 2000), content: "", finish: null, usage: null };
  if (/event-stream/i.test(contentType)) {
    const s = path === "messages" ? await readAnthropicSse(streamOf(text)) : await readChatSse(streamOf(text));
    return { path, status, content: s.content, finish: s.finish, usage: s.usage, ...(s.model ? { model: s.model } : {}) };
  }
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (path === "messages") {
    const blocks = Array.isArray(j?.content) ? j!.content as { type?: string; text?: string }[] : [];
    return { path, status, content: blocks.filter((b) => b?.type === "text").map((b) => b.text ?? "").join(""), finish: (j?.stop_reason as string) === "max_tokens" ? "length" : (j?.stop_reason as string) ?? null, usage: (j?.usage as Record<string, unknown>) ?? null, ...(typeof j?.model === "string" ? { model: j.model } : {}) };
  }
  if (path === "chat") {
    const c = Array.isArray(j?.choices) ? (j!.choices as { message?: { content?: string }; finish_reason?: string }[])[0] : undefined;
    return { path, status, content: c?.message?.content ?? "", finish: c?.finish_reason ?? null, usage: (j?.usage as Record<string, unknown>) ?? null, ...(typeof j?.model === "string" ? { model: j.model } : {}) };
  }
  return { path, status, content: "", finish: null, usage: (j?.usage as Record<string, unknown>) ?? null, raw: j };
}

/** the answer a request asks for, from what was recorded: whole or streamed, chat or Messages */
export function synthesize(x: CassetteExchange, req: { path: CassetteExchange["path"]; stream: boolean }): Response {
  if (x.status < 200 || x.status >= 300) return new Response(x.errorBody ?? "", { status: x.status, headers: { "content-type": "application/json" } });
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
  if (req.path === "embeddings" || req.path === "other") return json(x.raw ?? {});
  const model = x.model ?? "replay";
  if (req.path === "messages") {
    const stop = x.finish === "length" ? "max_tokens" : x.finish ?? "end_turn";
    if (!req.stream) return json({ id: "msg_replay", type: "message", role: "assistant", model, content: [{ type: "text", text: x.content }], stop_reason: stop, usage: x.usage ?? {} });
    const u = x.usage ?? {};
    const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const body = ev("message_start", { message: { id: "msg_replay", type: "message", role: "assistant", model, content: [], usage: { input_tokens: u.input_tokens ?? 0, cache_read_input_tokens: u.cache_read_input_tokens ?? 0, cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0, output_tokens: 1 } } })
      + ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
      + chunks(x.content).map((t) => ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } })).join("")
      + ev("content_block_stop", { index: 0 })
      + ev("message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: u.output_tokens ?? 0 } })
      + ev("message_stop", {});
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  const finish = x.finish ?? "stop";
  if (!req.stream) return json({ choices: [{ index: 0, message: { role: "assistant", content: x.content }, finish_reason: finish }], usage: x.usage ?? undefined, model });
  const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const body = chunks(x.content).map((t) => data({ model, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })).join("")
    + data({ model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })
    + (x.usage ? data({ model, choices: [], usage: x.usage }) : "") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const chunks = (s: string, n = 400): string[] => { const out: string[] = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out.length ? out : [""]; };

/** the base URLs a provider answers on (the configured one, without a trailing slash) */
const under = (url: string, base: string) => !!base && (url === base || url.startsWith(`${base.replace(/\/+$/, "")}/`));

/* ------------------------------------------------------------ recording */

export class CassetteRecorder {
  readonly cassette: Cassette;
  private at: { caseId: string; turn: number } | null = null;
  constructor(provider: Cassette["provider"]) { this.cassette = { version: 1, recordedAt: new Date().toISOString(), provider, cases: {} }; }
  begin(caseId: string, turn: number) {
    this.at = { caseId, turn };
    const c = (this.cassette.cases[caseId] ??= { turns: [] });
    c.turns[turn] = { latencyMs: 0, exchanges: [] };
  }
  end(latencyMs: number) { if (this.at) this.cassette.cases[this.at.caseId].turns[this.at.turn].latencyMs = latencyMs; this.at = null; }
  /** `fetch` that records what the provider answers (requests elsewhere pass untouched) */
  wrap(real: typeof fetch): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (!under(url, this.cassette.provider.base) || !this.at) return real(input, init);
      const t0 = Date.now();
      const res = await real(input, init);
      const text = await res.clone().text().catch(() => "");
      const norm = await normalizeAnswer(pathOf(url), res.status, res.headers.get("content-type") ?? "", text);
      this.cassette.cases[this.at.caseId].turns[this.at.turn].exchanges.push({ ...norm, latencyMs: Date.now() - t0 });
      return res;
    }) as typeof fetch;
  }
}

/* ------------------------------------------------------------ replaying */

export class CassettePlayer {
  private at: { caseId: string; turn: number; next: number } | null = null;
  readonly misses: string[] = [];
  readonly cassette: Cassette;
  constructor(cassette: Cassette) { this.cassette = cassette; }
  has(caseId: string) { return !!this.cassette.cases[caseId]; }
  begin(caseId: string, turn: number) { this.at = { caseId, turn, next: 0 }; }
  turnLatency(caseId: string, turn: number): number | null { return this.cassette.cases[caseId]?.turns[turn]?.latencyMs ?? null; }
  /** `fetch` that answers the recorded provider from the cassette — and lets nothing else reach that host */
  wrap(real: typeof fetch): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (!under(url, this.cassette.provider.base)) return real(input, init);
      const at = this.at;
      const turn = at ? this.cassette.cases[at.caseId]?.turns[at.turn] : undefined;
      const x = turn?.exchanges[at!.next];
      const path = pathOf(url);
      if (!at || !x) { this.misses.push(`${at?.caseId ?? "?"} turn ${(at?.turn ?? 0) + 1}: no recorded answer #${(at?.next ?? 0) + 1} (${path})`); return new Response(JSON.stringify({ error: { message: "cassette has no recorded answer for this request — record again" } }), { status: 400, headers: { "content-type": "application/json" } }); }
      at.next++;
      if (x.path !== path) this.misses.push(`${at.caseId} turn ${at.turn + 1}: recorded ${x.path}, asked ${path}`);
      return synthesize(x, { path, stream: bodyOf(init).stream === true });
    }) as typeof fetch;
  }
}
