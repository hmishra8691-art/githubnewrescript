import type { SurveyDefinition } from "@rescript/schema";
import type { InterviewSummary } from "@rescript/engine";
import { runtimeBaseUrl } from "@/lib/runtime-url";
import type { LiveView, TurnView } from "@/lib/aiInterviews/view";

/**
 * THE AI INTERVIEWS TAB'S DATA (2026-10-22): a saved project reads and acts through
 * `/api/surveys/[id]/ai-interviews/**` (its tables, the member's Data access); the sandbox through the
 * same routes' sandbox branch, which forwards to the runtime's in-memory studies (fake provider) — its
 * handle (the observer key) is kept for this tab's life in sessionStorage.
 */
export interface AiView extends LiveView { can?: { manage?: boolean; read?: boolean; pii?: boolean }; sandbox?: boolean; warnings?: string[]; estimateUsd?: number; transcripts?: { id: string; title: string; transcript: { segments: { speaker: string; start: number; text: string }[] } }[] }
export interface InterviewDetail { id: string; turns: TurnView[]; pii?: boolean }
export class AiApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}
export interface AiInterviewApi {
  sandbox: boolean;
  load(): Promise<AiView>;
  launch(o?: { relaunch?: boolean }): Promise<AiView>;
  status(action: "pause" | "resume" | "close"): Promise<AiView>;
  interview(id: string): Promise<InterviewDetail>;
  act(id: string, action: "end" | "exclude" | "include", reason?: string): Promise<{ transcriptKept?: boolean; citations?: number }>;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init });
  const b = await r.json().catch(() => null);
  if (!r.ok) throw new AiApiError(b?.error ?? `request failed (${r.status})`, r.status, b?.code);
  return b as T;
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function httpAiInterviewApi(surveyId: string): AiInterviewApi {
  const base = `/api/surveys/${surveyId}/ai-interviews`;
  return {
    sandbox: false,
    load: () => call<AiView>(base),
    launch: (o = {}) => call<AiView>(base, post({ action: "launch", relaunch: !!o.relaunch })),
    status: (action) => call<AiView>(base, post({ action })),
    interview: (id) => call<InterviewDetail>(`${base}/${id}`),
    act: (id, action, reason) => call(`${base}/${id}`, post({ action, ...(reason ? { reason } : {}) })),
  };
}

const KEY = "rescript.aiInterviews.sandboxKey";
const getKey = () => { try { return window.sessionStorage.getItem(KEY); } catch { return null; } };
const setKey = (k: string) => { try { window.sessionStorage.setItem(KEY, k); } catch { /* private window */ } };

/** the runtime's sandbox list, in the shape the Studio's routes answer */
function normalise(b: Record<string, unknown>): AiView {
  const st = b.study as Record<string, unknown> | null;
  const rt = runtimeBaseUrl();
  return {
    study: st ? { id: String(st.id), title: String(st.title), status: st.status as "live", link: `${rt}/i/${st.linkToken}`, testLink: `${rt}/i/${st.linkToken}?test=${st.testToken}`, spentUsd: Number(st.spentUsd ?? 0), launchedAt: "", objectives: (st.objectives as { id: string; text: string }[]) ?? [], modes: (st.modes as string[]) ?? [], languages: (st.languages as string[]) ?? [], budgetUsd: null } : null,
    counts: (b.counts as AiView["counts"]) ?? null, quotas: (b.quotas as AiView["quotas"]) ?? [], target: (b.target as number | null) ?? null,
    interviews: (b.interviews as InterviewSummary[]) ?? [], available: true, sandbox: true, can: { manage: true, read: true, pii: true },
    transcripts: (b.transcripts as AiView["transcripts"]) ?? [], ...(b.warnings ? { warnings: b.warnings as string[] } : {}),
  };
}

export function sandboxAiInterviewApi(getDef: () => SurveyDefinition): AiInterviewApi {
  const base = "/api/surveys/sandbox/ai-interviews";
  const key = () => getKey() ?? "";
  return {
    sandbox: true,
    async load() { const k = key(); if (!k) return { study: null, counts: null, quotas: [], target: null, interviews: [], available: true, sandbox: true, can: { manage: true, read: true, pii: true } }; return normalise(await call<Record<string, unknown>>(`${base}?key=${encodeURIComponent(k)}`)); },
    async launch() {
      const def = getDef();
      const r = await call<{ observerKey: string; warnings?: string[] }>(base, post({ action: "launch", guide: def.qualStudy, title: def.qualStudy?.title ?? def.meta.title, guideLanguage: def.localization?.sourceLanguage ?? "en" }));
      setKey(r.observerKey);
      return { ...(await this.load()), warnings: r.warnings ?? [] };
    },
    async status(action) { normalise(await call<Record<string, unknown>>(base, post({ action, observerKey: key() }))); return this.load(); },
    async interview(id) { const r = await call<{ id: string; turns: (TurnView & { decision: Record<string, unknown> | null })[] }>(`${base}/${id}?key=${encodeURIComponent(key())}`); return { id: r.id, turns: r.turns.map((t) => ({ ...t, hasAudio: false, hasVideo: false })), pii: true }; },
    async act(id, action, reason) { await call(`${base}/${id}`, post({ action, observerKey: key(), ...(reason ? { reason } : {}) })); return {}; },
  };
}
