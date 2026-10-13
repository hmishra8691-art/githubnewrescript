"use client";
import type { AnalysisDefinition, AnalysisResult, AskOp, AskProposal, BuilderDraft, ChartAdvice, ChartRecommendation, ReportTemplate, StoryScene, UndoRecord, VariableMeta } from "@rescript/analytics";
import type { planPayload, ApplyPlanOutcome } from "@/lib/analysisPlanService";

/** Thin client for `/api/surveys/<id>/analytics/*`. Every call is server-authorised; the client never computes. */
/** an API failure that keeps its status and body — a 409 "not published" carries the reasons and whether it may be forced */
export class ApiError extends Error {
  constructor(message: string, public status: number, public body: unknown) { super(message); }
}

export class AxApi {
  constructor(public surveyId: string) {}
  private base() { return `/api/surveys/${this.surveyId}/analytics`; }
  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetch(`${this.base()}/${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${r.status})`, r.status, body);
    return body as T;
  }
  variables() { return this.req<{ variables: VariableMeta[]; counts: Record<string, number>; surveyVersion: string | null; revision: number | null }>("variables"); }
  home() { return this.req<{ analyses: Row[]; charts: Row[]; reports: Row[]; shares: Row[] }>("home"); }
  run(definition: AnalysisDefinition, opts?: { /** compute again instead of finding the stored result */ fresh?: boolean }) { return this.req<{ result: RunResult }>("run", { method: "POST", body: JSON.stringify({ definition, ...(opts?.fresh ? { fresh: true } : {}) }) }); }
  list(coll: string, query = "") { return this.req<{ items: Row[] }>(`${coll}${query ? `?${query}` : ""}`); }
  get(coll: string, id: string) { return this.req<{ item: Row }>(`${coll}/${id}`); }
  create(coll: string, body: unknown) { return this.req<{ item: Row }>(coll, { method: "POST", body: JSON.stringify(body) }); }
  update(coll: string, id: string, body: unknown) { return this.req<{ item: Row }>(`${coll}/${id}`, { method: "PUT", body: JSON.stringify(body) }); }
  patch(coll: string, id: string, body: unknown) { return this.req<{ item: Row }>(`${coll}/${id}`, { method: "PATCH", body: JSON.stringify(body) }); }
  remove(coll: string, id: string) { return this.req<{ ok: true }>(`${coll}/${id}`, { method: "DELETE" }); }
  versions(coll: "analyses" | "reports", id: string) { return this.req<{ versions: Row[] }>(`${coll}/${id}/versions`); }
  results(reportId: string, version?: number) { return this.req<{ mode: "live" | "snapshot"; version?: number; definition: unknown; theme: unknown; results: Record<string, AnalysisResult>; computedAt?: string; publishedAt?: string }>(`reports/${reportId}/results${version ? `?version=${version}` : ""}`); }
  publish(reportId: string, note?: string, force = false) { return this.req<{ version: number; publishedAt: string; viewerFilters?: number }>(`reports/${reportId}/publish`, { method: "POST", body: JSON.stringify({ note, ...(force ? { force: true } : {}) }) }); }
  /* §36 — report templates: the shape of a deliverable, reusable across studies */
  reportTemplates() { return this.req<{ templates: ReportTemplate[]; available: boolean; note?: string }>("report-templates"); }
  saveReportTemplate(body: { name: string; description?: string; fromReportId?: string; template?: unknown }) {
    return this.req<{ template: ReportTemplate }>("report-templates", { method: "POST", body: JSON.stringify(body) });
  }
  removeReportTemplate(id: string) { return this.req<{ ok: true }>(`report-templates/${id}`, { method: "DELETE" }); }
  applyReportTemplate(reportId: string, templateId: string) {
    return this.req<{ definition: unknown; appliedTemplate: string }>(`reports/${reportId}/apply-template`, { method: "POST", body: JSON.stringify({ templateId }) });
  }
  /** the report builder: a proposed report (and story) from the saved analyses and their results — nothing is saved until the person creates it */
  reportBuilderDraft(body: { brief: unknown; story?: boolean; interpretation?: boolean }) { return this.req<BuilderDraft & { model: { status: string; detail: string }; truncated: boolean; analysesRead: number }>("report-builder/draft", { method: "POST", body: JSON.stringify(body) }); }
  /** one story scene rebuilt from its analysis as it is now (or, for a model-written scene, asked for again through the number gate) */
  regenerateScene(reportId: string, sceneId: string) { return this.req<{ scene: StoryScene }>("report-builder/scene", { method: "POST", body: JSON.stringify({ reportId, sceneId }) }); }
  /** the story as one animated HTML file; `notes` says what it does not contain (narration that could not be made) */
  async exportStory(reportId: string, narration: boolean): Promise<{ notes: string[] }> {
    const r = await fetch(`${this.base()}/report-builder/story`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reportId, narration }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j as { error?: string }).error ?? `Story export failed (${r.status})`); }
    const blob = await r.blob();
    const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? "story.html";
    downloadBlob(blob, name);
    let notes: string[] = [];
    try { notes = JSON.parse(decodeURIComponent(r.headers.get("x-rescript-export-notes") ?? "[]")); } catch { /* no notes */ }
    return { notes };
  }
  /** Intelligent Mode: words → a proposal (writes nothing) */
  askPropose(body: { request: string; dataset: unknown; model?: boolean }) { return this.req<AskProposal & { model: { status: string; detail: string } }>("intelligent/propose", { method: "POST", body: JSON.stringify(body) }); }
  /** the chosen items, each validated again by the server; returns what was done and how to undo it */
  askApply(body: { request: string; dataset: unknown; ops: AskOp[] }) { return this.req<{ applied: { index: number; name: string; status: "done" | "blocked" | "failed"; message: string; undo?: UndoRecord; createdId?: string }[]; rejected: string[] }>("intelligent/apply", { method: "POST", body: JSON.stringify(body) }); }
  askUndo(records: UndoRecord[]) { return this.req<{ undone: { name: string; status: "undone" | "skipped"; message: string }[] }>("intelligent/undo", { method: "POST", body: JSON.stringify({ records }) }); }
  access(shareId: string) { return this.req<{ events: Row[] }>(`shares/${shareId}/access`); }
  /* the analysis plan (Data Analytics → Analysis plan): read, edit with analysis actions, apply */
  plan(dataset: { environment: string; dataset: string }) { return this.req<PlanPayload>(`plan?environment=${encodeURIComponent(dataset.environment)}&dataset=${encodeURIComponent(dataset.dataset)}`); }
  editPlan(body: { actions: unknown[]; baseRevision: number | null }) { return this.req<{ ok: true; plan: unknown; revision: number | null; results: { op: string; ok: boolean; description: string; error?: string }[]; warnings: string[]; savedAt: string }>("plan", { method: "PUT", body: JSON.stringify(body) }); }
  applyPlan(body: { environment: string; dataset: string; replaceReport?: boolean }) { return this.req<ApplyResponse>("plan/apply", { method: "POST", body: JSON.stringify(body) }); }
  /** returns the notes the server attached — what the file does NOT contain — so the caller can say so beside "downloaded" */
  async export(body: Record<string, unknown>): Promise<{ notes: string[] }> {
    const r = await fetch(`${this.base()}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      /* the server's own words when it sent JSON; otherwise the start of what the platform answered (a timeout, a crash) */
      const raw = await r.text().catch(() => "");
      let msg: string | undefined;
      try { msg = (JSON.parse(raw) as { error?: string }).error; } catch { msg = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || undefined; }
      throw new Error(msg ? `Export failed (${r.status}): ${msg}` : `Export failed (${r.status})`);
    }
    const blob = await r.blob();
    const name = /filename="([^"]+)"/.exec(r.headers.get("content-disposition") ?? "")?.[1] ?? `export.${body.format ?? "pptx"}`;
    downloadBlob(blob, name);
    let notes: string[] = [];
    try { notes = JSON.parse(decodeURIComponent(r.headers.get("x-rescript-export-notes") ?? "[]")); } catch { /* no notes */ }
    return { notes };
  }
}

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** what `GET plan` and `POST plan/apply` answer — the server's own types, imported as types only (the module itself is server-only) */
export type PlanPayload = Awaited<ReturnType<typeof planPayload>>;
export type ApplyResponse = ApplyPlanOutcome;
export type RunResult = AnalysisResult & { recommendations: ChartRecommendation[]; advice?: ChartAdvice };

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
