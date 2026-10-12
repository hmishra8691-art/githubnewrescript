/**
 * PROVIDERS — who makes what, with a deterministic fallback for everything.
 *
 * The analytical content of a video (charts, numbers, tables, text) is
 * always drawn by the deterministic renderer. Two optional parts can come
 * from an external service, each behind an interface with a fallback:
 *
 *   narration  a text-to-speech service, when one is configured on the
 *              server (`AI_API_URL` + `AI_API_KEY`, the platform's existing
 *              speech provider). The narration script is the scene's own
 *              words — the report's text, which is the research data's
 *              summary — so it is only sent when the organisation has
 *              enabled narration for reports (`REPORT_NARRATION_ENABLED`).
 *              Fallback: no narration (a silent track), and the video says
 *              so in its record.
 *   visuals    decorative imagery for the cover and section scenes. No
 *              generative image or video provider is configured in this
 *              deployment; the deterministic provider draws the design's
 *              geometric decoration. A generative provider plugs in here;
 *              its prompt is built only from the design (colours, mood),
 *              never from research data.
 *
 * Credentials stay in the server's environment: they are read here, sent
 * only in the request header to the provider, and never logged, stored in a
 * render record, or written into an artifact.
 */
import type { StoryReport } from "@rescript/analytics/story";
import { voiceoverFor } from "@rescript/analytics/story";
import { audioSeconds, type NarrationClip } from "./video.js";

export interface ProviderRecord { kind: "narration" | "visuals" | "renderer"; provider: string; model?: string; status: "used" | "fallback" | "not_requested" | "failed"; detail?: string }

export interface SpeechFn { (text: string, opts: { language: string; voiceId?: string; speed?: number; format?: "mp3" | "wav" }): Promise<{ bytes: Uint8Array; mimeType: string } | null> }

export interface NarrationProvider { id: string; available(): { ok: boolean; why?: string }; synthesize: SpeechFn }

/** narration through the platform's configured speech service (passed in, so this package holds no credentials) */
export function speechNarration(id: string, speak: SpeechFn, configured: () => boolean): NarrationProvider {
  return {
    id,
    available() {
      if (!configured()) return { ok: false, why: "no speech service is configured on the server" };
      if (!/^(1|true|yes)$/i.test(process.env.REPORT_NARRATION_ENABLED ?? "")) return { ok: false, why: "narration for reports is not enabled for this organisation (REPORT_NARRATION_ENABLED)" };
      return { ok: true };
    },
    synthesize: speak,
  };
}

/** narration for every main scene; scenes the provider fails on are silent and listed */
export async function narrate(report: StoryReport, provider: NarrationProvider | null, opts: { cache?: Map<string, NarrationClip>; signal?: AbortSignal } = {}): Promise<{ clips: NarrationClip[]; record: ProviderRecord; failed: string[] }> {
  if (!report.design.video.narration) return { clips: [], record: { kind: "narration", provider: "none", status: "not_requested" }, failed: [] };
  const avail = provider?.available() ?? { ok: false, why: "no narration provider" };
  if (!provider || !avail.ok) return { clips: [], record: { kind: "narration", provider: provider?.id ?? "none", status: "fallback", detail: `${avail.why}; the video has a silent audio track` }, failed: [] };
  const clips: NarrationClip[] = [];
  const failed: string[] = [];
  for (const s of report.scenes.filter((x) => x.section === "main")) {
    if (opts.signal?.aborted) break;
    const text = voiceoverFor(s).slice(0, 1800);
    if (!text) continue;
    const key = `${report.design.video.voice ?? ""}|${text}`;
    const hit = opts.cache?.get(key);
    if (hit) { clips.push({ ...hit, sceneId: s.id }); continue; }
    const r = await provider.synthesize(text, { language: "en", ...(report.design.video.voice ? { voiceId: report.design.video.voice } : {}), format: "wav" });
    if (!r) { failed.push(s.id); continue; }
    const seconds = await audioSeconds(r.bytes, r.mimeType);
    if (!seconds) { failed.push(s.id); continue; }
    const clip = { sceneId: s.id, text, bytes: r.bytes, mimeType: r.mimeType, seconds };
    opts.cache?.set(key, clip);
    clips.push(clip);
  }
  return { clips, record: { kind: "narration", provider: provider.id, status: failed.length && !clips.length ? "failed" : "used", ...(failed.length ? { detail: `${failed.length} scene${failed.length === 1 ? "" : "s"} without narration (the provider returned nothing)` } : {}) }, failed };
}

export interface VisualProvider { id: string; generative: boolean; available(): { ok: boolean; why?: string } }

/** the deterministic visuals: the design's geometric decoration, drawn by the renderer */
export const deterministicVisuals: VisualProvider = { id: "deterministic", generative: false, available: () => ({ ok: true }) };

/** which visual provider renders this report: a generative one only when configured and asked for, else the deterministic one */
export function visualsFor(report: StoryReport, generative: VisualProvider | null): { provider: VisualProvider; record: ProviderRecord } {
  if (report.design.imagery !== "geometric" || !generative) return { provider: deterministicVisuals, record: { kind: "visuals", provider: "deterministic", status: "used", detail: report.design.imagery === "geometric" ? "geometric decoration drawn by the renderer (no generative image service is configured)" : `imagery: ${report.design.imagery}` } };
  const a = generative.available();
  if (!a.ok) return { provider: deterministicVisuals, record: { kind: "visuals", provider: generative.id, status: "fallback", detail: `${a.why}; drawn deterministically instead` } };
  return { provider: generative, record: { kind: "visuals", provider: generative.id, status: "used" } };
}

/* ------------------------------------------------------------ estimate */

export interface RenderEstimate { scenes: number; seconds: number; frames: number; renderSeconds: number; narrationCharacters: number; storageMB: number; note: string }

/**
 * Cost and time before rendering: frames actually drawn (entrances only —
 * holds are repeated inside the encoder), encoder time per second of
 * output, narration characters billed by the speech service, and the file
 * size. Cached segments cost nothing.
 */
export function estimateRender(plan: { segments: { timing: { enter: number; total: number }; hash: string }[]; fps: number; width: number; height: number; total: number }, report: StoryReport, cached: Set<string> = new Set()): RenderEstimate {
  const todo = plan.segments.filter((s) => !cached.has(s.hash));
  const pixels = (plan.width * plan.height) / (1920 * 1080);
  const drawn = todo.reduce((a, s) => a + Math.ceil(s.timing.enter * plan.fps) + 1, 0);
  const encodeSeconds = todo.reduce((a, s) => a + s.timing.total, 0) * 0.12 * pixels * (plan.fps / 30);
  const renderSeconds = Math.round(drawn * 0.07 * pixels + encodeSeconds + todo.length * 0.6 + 3);
  const narrationCharacters = report.design.video.narration ? report.scenes.filter((s) => s.section === "main").reduce((a, s) => a + voiceoverFor(s).length, 0) : 0;
  const storageMB = Math.round(plan.total * 0.55 * pixels * 10) / 10;
  return { scenes: plan.segments.length, seconds: plan.total, frames: Math.round(plan.total * plan.fps), renderSeconds, narrationCharacters, storageMB, note: `${todo.length} of ${plan.segments.length} scene${plan.segments.length === 1 ? "" : "s"} to render${todo.length < plan.segments.length ? ` (${plan.segments.length - todo.length} unchanged, reused)` : ""}` };
}
