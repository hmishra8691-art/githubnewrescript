import type { ReportBrief } from "@rescript/analytics";

const MAX_ANALYSES = 60;
/* ------------------------------------------------------------ request parsing */

const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** A brief from a request body: every field checked and bounded, unknown fields dropped. */
export function parseBrief(raw: unknown): ReportBrief {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const audience = b.audience === "executive" || b.audience === "researcher" ? b.audience : "client";
  const tone = b.tone === "formal" || b.tone === "concise" ? b.tone : "plain";
  const keyQuestions = (Array.isArray(b.keyQuestions) ? b.keyQuestions : typeof b.keyQuestions === "string" ? b.keyQuestions.split(/\r?\n/) : []).map((q) => str(q, 300)).filter(Boolean).slice(0, 10);
  const analysisIds = Array.isArray(b.analysisIds) ? b.analysisIds.filter(isUuid).slice(0, MAX_ANALYSES) : undefined;
  const maxItems = typeof b.maxItems === "number" && Number.isFinite(b.maxItems) ? Math.max(1, Math.min(40, Math.round(b.maxItems))) : undefined;
  return {
    objective: str(b.objective, 1000), audience, tone, keyQuestions,
    ...(analysisIds?.length ? { analysisIds } : {}), ...(maxItems ? { maxItems } : {}),
    ...(b.includeTests === false ? { includeTests: false } : {}), ...(b.includeCrosstabs === false ? { includeCrosstabs: false } : {}),
    ...(str(b.title, 120) ? { title: str(b.title, 120) } : {}), ...(str(b.client, 120) ? { client: str(b.client, 120) } : {}),
  };
}
