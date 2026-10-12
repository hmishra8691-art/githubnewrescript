/**
 * THE STORY REPORT AS A VIDEO — plan, render scene by scene, assemble.
 *
 * 1. `planVideo` composes the report for the video canvas, checks it, times
 *    every scene (entrances, reading time, narration), fits the pacing to a
 *    requested length without cutting below reading time, and gives every
 *    scene a content hash. Same hash, same segment: an unchanged scene is
 *    never rendered twice, and an edit re-renders only what it touched.
 * 2. `renderSegment` draws one scene's frames with the shared renderer
 *    (`renderFrame` — the preview's code) and encodes them: the entrances
 *    frame by frame, the still hold by repeating its last frame inside the
 *    encoder, the exit as a fade to the scene's background. With narration,
 *    the scene's audio sits under it, padded to the scene's length.
 * 3. `assembleVideo` joins the segments (stream copy — no re-encode) and
 *    muxes the subtitles as a text track.
 *
 * Every analytical element is drawn deterministically from the report
 * definition; nothing on a chart or in a number comes from a generative
 * model.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeReport, sceneTiming, fitToDuration, subtitlesFor, voiceoverFor, renderFrame, outputSize, audioLead,
  type Composed, type ComposedPage, type SceneTiming, type StoryReport,
} from "@rescript/analytics/story";
import { rasterize, type ReportFonts } from "./fonts.js";
import { runFfmpeg, probe } from "./ffmpeg.js";

/** bump when the renderer's output changes, so cached segments are not reused across versions */
export const RENDERER_VERSION = "story-video/1";

export interface NarrationClip { sceneId: string; text: string; bytes: Uint8Array; mimeType: string; seconds: number }

export interface SegmentPlan {
  index: number;
  sceneId: string;
  title: string;
  start: number;
  timing: SceneTiming;
  /** content hash: page geometry, timing, output settings, narration */
  hash: string;
  narration?: { text: string; seconds: number; hash: string };
}

export interface VideoPlan {
  report: StoryReport;
  composed: Composed;
  width: number;
  height: number;
  fps: number;
  segments: SegmentPlan[];
  total: number;
  pacingNote?: string;
  subtitles: string | null;
  narration: boolean;
  /** the plan's own hash: every segment, in order */
  hash: string;
}

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

/** time and hash every scene of the report's video */
export function planVideo(report: StoryReport, fonts: ReportFonts, narration: NarrationClip[] = []): VideoPlan {
  const composed = composeReport(report, fonts.measurer, "video");
  const v = report.design.video;
  const { width, height } = outputSize(v.aspect, v.height);
  const fps = v.fps;
  const clips = new Map(narration.map((n) => [n.sceneId, n]));
  const raw = composed.pages.map((p) => sceneTiming(p, report.scenes[p.sceneIndex], report, clips.get(p.sceneId)?.seconds));
  const fit = fitToDuration(raw, v.targetDurationSec);
  let start = 0;
  const segments: SegmentPlan[] = composed.pages.map((p, i) => {
    const t = fit.timings[i];
    const clip = clips.get(p.sceneId);
    const scene = report.scenes[p.sceneIndex];
    const hash = sha(JSON.stringify({ r: RENDERER_VERSION, el: p.elements, bg: p.background, c: p.canvas, t: [t.enter, t.hold, t.outro, t.total], w: width, h: height, fps, fade: fadeOf(report, scene), a: clip ? sha(clip.bytes) : null, n: v.narration }));
    const seg: SegmentPlan = { index: i, sceneId: p.sceneId, title: scene.title, start: Math.round(start * 1000) / 1000, timing: t, hash, ...(clip ? { narration: { text: clip.text, seconds: clip.seconds, hash: sha(clip.bytes) } } : {}) };
    start += t.total;
    return seg;
  });
  const total = Math.round(start * 100) / 100;
  /* subtitles: the narration when there is one, else what each scene says */
  const subtitles = v.subtitles ? subtitlesFor(segments.map((s) => {
    const scene = report.scenes.find((x) => x.id === s.sceneId)!;
    const lead = s.narration ? audioLead(s.timing.enter) : Math.min(0.5, s.timing.enter);
    const dur = s.narration ? s.narration.seconds : Math.max(1, s.timing.total - lead - s.timing.outro - 0.1);
    return { text: s.narration?.text ?? voiceoverFor(scene), start: s.start + lead, duration: dur };
  })) : null;
  return { report, composed, width, height, fps, segments, total, ...(fit.note ? { pacingNote: fit.note } : {}), subtitles, narration: v.narration, hash: sha(segments.map((s) => s.hash).join(",") + (subtitles ?? "")) };
}

function fadeOf(report: StoryReport, scene: StoryReport["scenes"][number]): { in: number; out: number } {
  const transition = scene.motion.transition === "inherit" ? report.design.motion.transition : scene.motion.transition;
  if (transition === "cut" || report.design.motion.style === "none") return { in: 0, out: 0 };
  return { in: 0.35, out: 0.4 };
}

const bgHex = (c: string) => `0x${c.replace("#", "").slice(0, 6)}`;

/** Render and encode one scene. Returns the MP4 segment's bytes. */
export async function renderSegment(plan: VideoPlan, index: number, fonts: ReportFonts, opts: { audio?: NarrationClip; signal?: AbortSignal; workDir?: string } = {}): Promise<{ bytes: Buffer; frames: number; rasterized: number; ms: number }> {
  const t0 = Date.now();
  const seg = plan.segments[index];
  const page = plan.composed.pages[index];
  const scene = plan.report.scenes[page.sceneIndex];
  const fade = fadeOf(plan.report, scene);
  const { width, height, fps } = plan;
  const t = seg.timing;
  /* frames drawn one by one up to the moment the scene is still; the encoder holds the last */
  const animated = Math.max(1, Math.ceil(t.enter * fps) + 1);
  const totalFrames = Math.round(t.total * fps);
  const drawn = Math.min(animated, totalFrames);
  const holdSeconds = Math.max(0, (totalFrames - drawn) / fps);
  const dir = opts.workDir ?? mkdtempSync(join(tmpdir(), "story-seg-"));
  const out = join(dir, `seg-${index}.mp4`);
  const args: string[] = ["-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-framerate", String(fps), "-i", "-"];
  let audioArgs: string[] = [];
  if (plan.narration) {
    if (opts.audio) {
      const ext = opts.audio.mimeType.includes("wav") ? "wav" : "mp3";
      const af = join(dir, `seg-${index}.${ext}`);
      writeFileSync(af, opts.audio.bytes);
      const lead = Math.round(audioLead(t.enter) * 1000);
      args.push("-i", af);
      audioArgs = ["-filter_complex", `[1:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${lead}|${lead},apad[a]`, "-map", "0:v", "-map", "[a]"];
    } else {
      args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      audioArgs = ["-map", "0:v", "-map", "1:a"];
    }
    audioArgs.push("-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2");
  }
  const vf = [
    holdSeconds > 0 ? `tpad=stop_mode=clone:stop_duration=${holdSeconds.toFixed(3)}` : null,
    fade.out > 0 ? `fade=t=out:st=${Math.max(0, t.total - fade.out).toFixed(3)}:d=${fade.out}:color=${bgHex(page.background)}` : null,
    "format=yuv420p",
  ].filter(Boolean).join(",");
  args.push(...audioArgs, "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", String(fps), "-t", t.total.toFixed(3), "-video_track_timescale", "90000", "-movflags", "+faststart", out);
  let rasterized = 0;
  const res = await runFfmpeg(args, async (write) => {
    let prevSvg = "", prev: Buffer | null = null;
    for (let f = 0; f < drawn; f++) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      const svg = renderFrame(page, f / fps, { total: t.total, fadeIn: fade.in, fadeOut: 0, width, height, measure: fonts.measurer });
      if (svg !== prevSvg || !prev) { prev = rasterize(svg, fonts).pixels; prevSvg = svg; rasterized++; }
      await write(prev);
    }
  }, { signal: opts.signal });
  if (res.code !== 0) { cleanup(dir, opts.workDir); throw new Error(`encoding scene ${index + 1} failed: ${res.stderr.split("\n").filter(Boolean).slice(-3).join(" | ")}`); }
  const bytes = readFileSync(out);
  cleanup(dir, opts.workDir);
  return { bytes, frames: totalFrames, rasterized, ms: Date.now() - t0 };
}

function cleanup(dir: string, keep?: string) { if (!keep) try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } }

/** Join the segments (in order) and add the subtitle track. */
export async function assembleVideo(plan: VideoPlan, segments: Buffer[], opts: { signal?: AbortSignal } = {}): Promise<Buffer> {
  if (segments.length !== plan.segments.length) throw new Error(`expected ${plan.segments.length} segments, have ${segments.length}`);
  const dir = mkdtempSync(join(tmpdir(), "story-join-"));
  try {
    const list = segments.map((b, i) => { const f = join(dir, `s${String(i).padStart(4, "0")}.mp4`); writeFileSync(f, b); return `file '${f}'`; }).join("\n");
    writeFileSync(join(dir, "list.txt"), list);
    const out = join(dir, "out.mp4");
    const args = ["-y", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt")];
    if (plan.subtitles) { writeFileSync(join(dir, "subs.srt"), plan.subtitles); args.push("-i", join(dir, "subs.srt"), "-map", "0", "-map", "1", "-c:s", "mov_text", "-metadata:s:s:0", "language=eng"); }
    args.push("-c:v", "copy", ...(plan.narration ? ["-c:a", "copy"] : []), "-movflags", "+faststart", "-metadata", `title=${plan.report.title.replace(/[\r\n]/g, " ")}`, "-metadata", `comment=rescript ${RENDERER_VERSION} ${plan.hash.slice(0, 16)}`, out);
    const r = await runFfmpeg(args, undefined, { signal: opts.signal });
    if (r.code !== 0) throw new Error(`joining the scenes failed: ${r.stderr.split("\n").filter(Boolean).slice(-3).join(" | ")}`);
    return readFileSync(out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** measure an audio clip's real length (the provider's estimate is not trusted) */
export async function audioSeconds(bytes: Uint8Array, mimeType: string): Promise<number | null> {
  const dir = mkdtempSync(join(tmpdir(), "story-aud-"));
  try {
    const f = join(dir, `a.${mimeType.includes("wav") ? "wav" : "mp3"}`);
    writeFileSync(f, bytes);
    return (await probe(f)).duration;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** the page a segment draws (for previews and checks) */
export function pageOf(plan: VideoPlan, index: number): ComposedPage { return plan.composed.pages[index]; }
