/**
 * THE REALTIME VOICE PROVIDER (G1 2026-10-22) — configuration from the environment, and the server-side
 * minting of a short-lived client secret for one interview. Plain fetch, no SDK. The installation's key
 * (AI_REALTIME_API_KEY) never leaves the server: the browser gets an ephemeral secret that opens ONE
 * WebRTC session with the instructions, tools, voice, transcription and turn detection fixed here.
 *
 *   AI_REALTIME_API_URL      e.g. https://api.openai.com/v1
 *   AI_REALTIME_API_KEY      the provider key (server only)
 *   AI_REALTIME_MODEL        e.g. gpt-realtime
 *   AI_REALTIME_VOICE        optional (default marin)
 *   AI_REALTIME_TRANSCRIBE_MODEL  optional (default gpt-4o-mini-transcribe) — both sides are transcribed
 *   AI_REALTIME_PROTOCOL     optional; only "openai" is accepted (see `realtimeRefusal`)
 *
 * Gating (why only this protocol): the session must (1) never answer on its own — server VAD with
 * `create_response: false`, so every participant utterance reaches the engine's rules before the
 * moderator says anything; (2) transcribe the participant's audio; (3) take function tools; (4) be
 * opened by a server-minted ephemeral secret. A provider that cannot do all four is refused, and the
 * registry and /platform say why.
 */

export interface RealtimeConfig { base: string; key: string; model: string; voice: string; transcribeModel: string; protocol: string }
type Env = Record<string, string | undefined>;

export function realtimeConfig(env: Env = process.env): RealtimeConfig | null {
  const base = (env.AI_REALTIME_API_URL ?? "").trim().replace(/\/+$/, "");
  const key = (env.AI_REALTIME_API_KEY ?? "").trim();
  const model = (env.AI_REALTIME_MODEL ?? "").trim();
  if (!base || !key || !model) return null;
  return { base, key, model, voice: (env.AI_REALTIME_VOICE ?? "").trim() || "marin", transcribeModel: (env.AI_REALTIME_TRANSCRIBE_MODEL ?? "").trim() || "gpt-4o-mini-transcribe", protocol: (env.AI_REALTIME_PROTOCOL ?? "openai").trim().toLowerCase() || "openai" };
}

/** why realtime interviews are not offered here, or null when they are */
export function realtimeRefusal(env: Env = process.env): string | null {
  const c = realtimeConfig(env);
  if (!c) return "No realtime voice provider is configured (AI_REALTIME_API_URL, AI_REALTIME_API_KEY and AI_REALTIME_MODEL).";
  if (c.protocol !== "openai") return `AI_REALTIME_PROTOCOL=${c.protocol} is not supported: only the OpenAI Realtime protocol can be gated (manual responses, input transcription, tools, ephemeral secrets).`;
  if (!/^https:\/\//i.test(c.base)) return "AI_REALTIME_API_URL must be an https address.";
  return null;
}

export interface MintArgs { instructions: string; tools: readonly unknown[]; language: string }
export interface MintedSession { clientSecret: string; expiresAt: number | null; callUrl: string; model: string; voice: string }
export class RealtimeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** the request that mints one interview's session (exported for the unit test) */
export function mintRequest(c: RealtimeConfig, a: MintArgs): { url: string; init: { method: string; headers: Record<string, string>; body: string } } {
  const session = {
    type: "realtime",
    model: c.model,
    instructions: a.instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: c.transcribeModel, ...(a.language ? { language: a.language } : {}) },
        noise_reduction: { type: "near_field" },
        /* the gate: the provider detects the end of the participant's turn but never answers by itself */
        turn_detection: { type: "server_vad", create_response: false, interrupt_response: true, silence_duration_ms: 650, prefix_padding_ms: 300 },
      },
      output: { voice: c.voice },
    },
    tools: a.tools,
    tool_choice: "auto",
  };
  return { url: `${c.base}/realtime/client_secrets`, init: { method: "POST", headers: { authorization: `Bearer ${c.key}`, "content-type": "application/json" }, body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 600 }, session }) } };
}

/** mint the session; `fetchImpl` is the test seam */
export async function mintRealtimeSession(a: MintArgs, o: { env?: Env; fetchImpl?: typeof fetch } = {}): Promise<MintedSession> {
  const refused = realtimeRefusal(o.env);
  if (refused) throw new RealtimeError(refused, 501);
  const c = realtimeConfig(o.env)!;
  const { url, init } = mintRequest(c, a);
  let res: Response;
  try { res = await (o.fetchImpl ?? fetch)(url, init); } catch { throw new RealtimeError("The realtime voice provider could not be reached.", 502); }
  const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !j) throw new RealtimeError(res.status === 401 || res.status === 403 ? "The realtime voice provider refused the key." : `The realtime voice provider answered ${res.status}.`, 502);
  /* GA answers { value, expires_at }; the older beta { client_secret: { value, expires_at } } */
  const cs = (j.client_secret && typeof j.client_secret === "object" ? j.client_secret : j) as { value?: unknown; expires_at?: unknown };
  const secret = typeof cs.value === "string" ? cs.value : "";
  if (!secret) throw new RealtimeError("The realtime voice provider returned no session secret.", 502);
  return { clientSecret: secret, expiresAt: typeof cs.expires_at === "number" ? cs.expires_at : null, callUrl: `${c.base}/realtime/calls`, model: c.model, voice: c.voice };
}
