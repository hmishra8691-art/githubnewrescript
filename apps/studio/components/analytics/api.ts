"use client";
import type { AnalysisDefinition, AnalysisResult, ChartRecommendation, VariableMeta } from "@rescript/analytics";

/** Thin client for `/api/surveys/<id>/analytics/*`. Every call is server-authorised; the client never computes. */
export class AxApi {
  constructor(public surveyId: string) {}
  private base() { return `/api/surveys/${this.surveyId}/analytics`; }
  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetch(`${this.base()}/${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${r.status})`);
    return body as T;
  }
  variables() { return this.req<{ variables: VariableMeta[]; counts: Record<string, number>; surveyVersion: string | null; revision: number | null }>("variables"); }
  home() { return this.req<{ analyses: Row[]; charts: Row[]; reports: Row[]; shares: Row[] }>("home"); }
  run(definition: AnalysisDefinition) { return this.req<{ result: RunResult }>("run", { method: "POST", body: JSON.stringify({ definition }) }); }
  list(coll: string, query = "") { return this.req<{ items: Row[] }>(`${coll}${query ? `?${query}` : ""}`); }
  get(coll: string, id: string) { return this.req<{ item: Row }>(`${coll}/${id}`); }
  create(coll: string, body: unknown) { return this.req<{ item: Row }>(coll, { method: "POST", body: JSON.stringify(body) }); }
  update(coll: string, id: string, body: unknown) { return this.req<{ item: Row }>(`${coll}/${id}`, { method: "PUT", body: JSON.stringify(body) }); }
  patch(coll: string, id: string, body: unknown) { return this.req<{ item: Row }>(`${coll}/${id}`, { method: "PATCH", body: JSON.stringify(body) }); }
  remove(coll: string, id: string) { return this.req<{ ok: true }>(`${coll}/${id}`, { method: "DELETE" }); }
  versions(coll: "analyses" | "reports", id: string) { return this.req<{ versions: Row[] }>(`${coll}/${id}/versions`); }
  results(reportId: string, version?: number) { return this.req<{ mode: "live" | "snapshot"; version?: number; definition: unknown; theme: unknown; results: Record<string, AnalysisResult>; computedAt?: string; publishedAt?: string }>(`reports/${reportId}/results${version ? `?version=${version}` : ""}`); }
  publish(reportId: string, note?: string) { return this.req<{ version: number; publishedAt: string }>(`reports/${reportId}/publish`, { method: "POST", body: JSON.stringify({ note }) }); }
  access(shareId: string) { return this.req<{ events: Row[] }>(`shares/${shareId}/access`); }
  async export(body: Record<string, unknown>): Promise<void> {
    const r = await fetch(`${this.base()}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j as { error?: string }).error ?? `Export failed (${r.status})`); }
    const blob = await r.blob();
    const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? `export.${body.format ?? "pptx"}`;
    downloadBlob(blob, name);
  }
}

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type RunResult = AnalysisResult & { recommendations: ChartRecommendation[] };

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 2) return "yesterday";
  return `${Math.floor(s / 86400)} days ago`;
}
