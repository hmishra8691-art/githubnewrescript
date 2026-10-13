/**
 * THE PROJECT'S AI SWITCH (Data Analytics audit A-2, Phase 2).
 *
 * `settings.ai.mode` ("internal" | "cloud") was honoured by ONE of the six
 * places that call a model — the workflow route that displays it — and
 * ignored by the other five: a project set to INTERNAL ("nothing is sent to a
 * language model") still had its findings narrated, its Ask question
 * interpreted, its report interpreted, its story narrated and its design
 * worded by one, if the account had a key. The setting was a label.
 *
 * Now it is a gate, and there is one: `meteredAi` (the door every model call
 * in the Studio already walks through for the wallet) asks `aiAllowed` first,
 * so a refusal happens BEFORE a reservation and BEFORE a provider is reached.
 * The few calls that reserve by hand ask it themselves. A repository test
 * (`aiPolicy.test.ts`) lists every file that reaches a provider and fails if
 * one is added without passing a gate.
 *
 * Three things switch a call off, and the person is told which:
 *   - the project runs INTERNAL (unless this one request carries the
 *     researcher's explicit one-time consent — the copilot's "send this once");
 *   - the project has turned this feature off (`settings.ai.disabled`: a list
 *     of operation names or prefixes — the per-feature kill switch);
 *   - the project's setting could not be read (fail closed: an unread opt-out
 *     is not an absent opt-out).
 */

/** the sandbox is the literal project "sandbox", or no project at all (the same rule as `metering.isSandboxProject`) */
const isSandboxProject = (surveyId: string | null | undefined): boolean => !surveyId || surveyId === "sandbox";

export type AiMode = "internal" | "cloud";
export type AiOffReason = "project_internal" | "feature_off" | "unreadable";
export interface AiSettings { mode: AiMode; disabled: string[] }
export interface AiDecision { allowed: boolean; reason?: AiOffReason; message?: string }
export interface AiRefusal { ok: false; reason: "ai_off"; why: AiOffReason; message: string }

/** the AI settings out of a project's `settings` bag — anything unrecognised is the default (cloud, nothing disabled) */
export function aiSettingsOf(settings: unknown): AiSettings {
  const bag = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
  const ai = bag.ai && typeof bag.ai === "object" ? bag.ai as Record<string, unknown> : {};
  const disabled = Array.isArray(ai.disabled) ? ai.disabled.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : [];
  return { mode: ai.mode === "internal" ? "internal" : "cloud", disabled };
}

const OFF_MESSAGE: Record<AiOffReason, string> = {
  project_internal: "AI is off for this project: it runs in Internal mode, so nothing is sent to a language model. The engine's own results and wording are unaffected. Change it in the project's AI setting.",
  feature_off: "AI is switched off for this feature in the project's AI settings. The engine's own results and wording are unaffected.",
  unreadable: "AI was not used because the project's AI setting could not be read. Try again; nothing was sent to a language model.",
};

/** is a call to `operation` allowed under these settings — pure, so it is tested without a database */
export function decideAi(settings: AiSettings, operation: string, opts: { once?: boolean } = {}): AiDecision {
  if (settings.disabled.some((d) => operation === d || operation.startsWith(d.endsWith("*") ? d.slice(0, -1) : `${d}_`) )) return { allowed: false, reason: "feature_off", message: OFF_MESSAGE.feature_off };
  if (settings.mode === "internal" && !opts.once) return { allowed: false, reason: "project_internal", message: OFF_MESSAGE.project_internal };
  return { allowed: true };
}

type Loader = (surveyId: string) => Promise<AiSettings | null>;
let loader: Loader | null = null;
/** the tests (and any non-Supabase host) supply how a project's settings are read */
export function setAiSettingsLoader(l: Loader | null): void { loader = l; }

async function defaultLoader(surveyId: string): Promise<AiSettings | null> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return { mode: "cloud", disabled: [] };
  const { supabaseAdmin } = await import("./admin");
  const { data, error } = await supabaseAdmin().from("surveys").select("settings").eq("id", surveyId).maybeSingle();
  if (error) return null;
  return aiSettingsOf((data as { settings?: unknown } | null)?.settings);
}

/**
 * May this project call a model for `operation` right now? The sandbox has no
 * project row (its choice lives in the browser and the client does not call
 * when it is internal), so it is allowed here.
 */
export async function aiAllowed(surveyId: string | null | undefined, operation: string, opts: { once?: boolean } = {}): Promise<AiDecision> {
  if (isSandboxProject(surveyId)) return { allowed: true };
  let s: AiSettings | null;
  try { s = await (loader ?? defaultLoader)(surveyId as string); } catch { s = null; }
  if (!s) return { allowed: false, reason: "unreadable", message: OFF_MESSAGE.unreadable };
  return decideAi(s, operation, opts);
}

export const aiRefusal = (d: AiDecision): AiRefusal => ({ ok: false, reason: "ai_off", why: d.reason ?? "project_internal", message: d.message ?? OFF_MESSAGE.project_internal });

/**
 * Run `run` only if the project's AI switch allows `operation` — the provider is not reached otherwise. For the few
 * call sites that do not go through `meteredAi`, and for the test that counts provider calls.
 */
export async function withAiGate<T>(surveyId: string | null | undefined, operation: string, opts: { once?: boolean }, run: () => Promise<T>): Promise<{ ok: true; value: T } | AiRefusal> {
  const d = await aiAllowed(surveyId, operation, opts);
  if (!d.allowed) return aiRefusal(d);
  return { ok: true, value: await run() };
}
