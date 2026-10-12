"use client";
import type { StoryReport, DesignConfig, DesignPatch, StoryOp, BrandInput, Measurer } from "@rescript/analytics/story";
import { REPORT_FONTS, createMeasurer } from "@rescript/analytics/story";
import type { storyPayload, previewRevision, interpretDesign, analyzeBrand } from "@/lib/storyEngine";

/** what the server answers — its own types, imported as types only */
export type StoryPayload = Awaited<ReturnType<typeof storyPayload>>;
export type RevisionPreview = ReturnType<typeof previewRevision>;
export type DesignReading = Awaited<ReturnType<typeof interpretDesign>>;
export type BrandReading = ReturnType<typeof analyzeBrand>;
export type RenderView = StoryPayload["renders"][number];
export type StoryListItem = { id: string; title: string; version: number; outputs: { pptx: boolean; video: boolean }; updatedAt: string; scenes: number; status: string; design: string };

export class ApiError extends Error { constructor(message: string, public status: number, public details?: unknown) { super(message); } }

/** Thin client for `/api/surveys/<id>/stories/*`. Every call is authorised on the server; numbers are never computed here. */
export class StoryApi {
  constructor(public surveyId: string) {}
  private base() { return `/api/surveys/${this.surveyId}/stories`; }
  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetch(`${this.base()}${path ? `/${path}` : ""}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, cache: "no-store" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${r.status})`, r.status, (body as { details?: unknown }).details);
    return body as T;
  }
  list() { return this.req<{ stories: StoryListItem[] }>(""); }
  create(body: Record<string, unknown>) { return this.req<StoryPayload>("", { method: "POST", body: JSON.stringify(body) }); }
  get(id: string) { return this.req<StoryPayload>(id); }
  save(id: string, definition: StoryReport, baseVersion: number, note?: string) { return this.req<StoryPayload & { saved: { version: number; changes: string } }>(id, { method: "PUT", body: JSON.stringify({ definition, baseVersion, note }) }); }
  remove(id: string) { return this.req<{ ok: true }>(id, { method: "DELETE" }); }
  setStatus(id: string, status: string) { return this.req<StoryPayload>(`${id}/status`, { method: "POST", body: JSON.stringify({ status }) }); }
  version(id: string, v: number) { return this.req<{ version: number; definition: StoryReport }>(`${id}/versions/${v}`); }
  compare(id: string, a: number, b: number) { return this.req<{ summary: string; diff: { added: string[]; removed: string[]; moved: string[]; changed: { title: string; fields: string[] }[]; design: string[] } }>(`${id}/compare?a=${a}&b=${b}`); }
  revert(id: string, version: number) { return this.req<StoryPayload>(`${id}/revert`, { method: "POST", body: JSON.stringify({ version }) }); }
  previewRevision(id: string, text: string, selected: string | null, baseVersion: number, brand?: BrandInput | null) { return this.req<{ preview: RevisionPreview; baseVersion: number }>(`${id}/revise`, { method: "POST", body: JSON.stringify({ text, selected, baseVersion, brand }) }); }
  applyRevision(id: string, ops: StoryOp[], text: string, baseVersion: number, brand?: BrandInput | null) { return this.req<StoryPayload & { result: { changes: string[]; refused: string[] } }>(`${id}/revise`, { method: "POST", body: JSON.stringify({ apply: true, ops, text, baseVersion, brand }) }); }
  interpretDesign(id: string, text: string, brand?: BrandInput | null) { return this.req<DesignReading>(`${id}/design`, { method: "POST", body: JSON.stringify({ text, brand }) }); }
  applyDesign(id: string, body: { patch?: DesignPatch; design?: DesignConfig; baseVersion: number; note: string; brand?: BrandInput | null }) { return this.req<StoryPayload & { adjustments: { token: string; from: string; to: string; why: string }[] }>(`${id}/design`, { method: "POST", body: JSON.stringify({ apply: true, ...body }) }); }
  /** brand files go as base64 in JSON (the platform's request limit is ~4.5 MB, so together they stay under 3 MB) */
  async brand(id: string, files: File[]) {
    const total = files.reduce((a, f) => a + f.size, 0);
    if (total > 3 * 1024 * 1024) throw new ApiError(`These files are ${(total / 1048576).toFixed(1)} MB together; brand files can be up to 3 MB at a time. Upload the logo and the template separately, or a smaller export of the template.`, 413);
    const enc = async (f: File) => { const b = new Uint8Array(await f.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return { name: f.name, type: f.type, data: btoa(s) }; };
    return this.req<BrandReading>(`${id}/brand`, { method: "POST", body: JSON.stringify({ files: await Promise.all(files.slice(0, 8).map(enc)) }) });
  }
  themes() { return this.req<{ themes: { id: string; name: string; design: DesignConfig; scope: "project" | "workspace" }[] }>("themes"); }
  saveTheme(body: { name: string; design: DesignConfig; scope: "project" | "workspace"; brand?: unknown }) { return this.req<{ theme: { id: string } }>("themes", { method: "POST", body: JSON.stringify(body) }); }
  regenerate(id: string, sceneId?: string | null) { return this.req<StoryPayload>(`${id}/regenerate`, { method: "POST", body: JSON.stringify({ sceneId: sceneId ?? null }) }); }
  startRender(id: string, kind: "video" | "pptx") { return this.req<{ render: RenderView }>(`${id}/renders`, { method: "POST", body: JSON.stringify({ kind }) }); }
  step(id: string, renderId: string) { return this.req<{ render: RenderView }>(`${id}/renders/${renderId}/step`, { method: "POST", body: "{}" }); }
  cancel(id: string, renderId: string) { return this.req<{ ok: true }>(`${id}/renders/${renderId}/cancel`, { method: "POST", body: "{}" }); }
  download(id: string, renderId: string, what: "file" | "subtitles" = "file") { return this.req<{ url: string; name: string }>(`${id}/renders/${renderId}/download${what === "subtitles" ? "?what=subtitles" : ""}`); }
}

/* ------------------------------------------------------------ the report fonts, in the browser */

let fontsPromise: Promise<Measurer> | null = null;
/**
 * The preview measures and draws text with the same font files the server
 * renders with, so what the storyboard shows — and the checks it runs — are
 * what the video and the deck will be.
 */
export function reportMeasurer(): Promise<Measurer> {
  if (typeof document !== "undefined" && !document.getElementById("report-font-faces")) {
    const style = document.createElement("style");
    style.id = "report-font-faces";
    style.textContent = REPORT_FONTS.map((f) => `@font-face{font-family:"${f.family}";src:url(/report-fonts/${f.file}) format("truetype");font-weight:${f.weight};font-display:block}`).join("\n");
    document.head.appendChild(style);
  }
  if (!fontsPromise) {
    fontsPromise = Promise.all(REPORT_FONTS.map(async (f) => {
      const r = await fetch(`/report-fonts/${f.file}`);
      if (!r.ok) throw new Error(`font ${f.file} did not load`);
      return { family: f.family, weight: f.weight, data: await r.arrayBuffer() };
    })).then(async (faces) => {
      /* the faces are ready to draw once the browser has them too */
      if (typeof document !== "undefined" && "fonts" in document) await Promise.all(REPORT_FONTS.map((f) => document.fonts.load(`${f.weight} 20px "${f.family}"`).catch(() => null)));
      return createMeasurer(faces);
    });
    fontsPromise.catch(() => { fontsPromise = null; });
  }
  return fontsPromise;
}
