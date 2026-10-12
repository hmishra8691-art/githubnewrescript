/**
 * IS THE VIDEO WHAT THE REPORT SAYS IT IS?
 *
 * Checked on the finished file, decoded by ffmpeg — not on the plan:
 *   - the container and streams: H.264 High, yuv420p, the requested size and
 *     frame rate, the planned duration, an AAC track when narrated, a text
 *     subtitle track when subtitled;
 *   - the whole file decodes without an error, to its last frame;
 *   - every scene: its settled frame and its last held frame are compared,
 *     pixel by pixel at a reduced size, with the reference drawn straight
 *     from the report definition (the final state) — a missing, blank,
 *     corrupt or wrong scene does not match;
 *   - the hold is still (the two frames match each other: no flicker);
 *   - reading time and narration fit inside every scene.
 * A video that fails any critical check is not delivered as complete.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFrame } from "@rescript/analytics/story";
import { runFfmpeg, parseInfo, type MediaInfo } from "./ffmpeg.js";
import { rasterize, rgbaToRgb, type ReportFonts } from "./fonts.js";
import type { VideoPlan } from "./video.js";

export interface VideoCheck { code: string; severity: "critical" | "warning"; scene?: number; message: string }
export interface VideoQa {
  ok: boolean;
  info: MediaInfo;
  frames: number | null;
  checks: VideoCheck[];
  scenes: { index: number; sceneId: string; settledDiff: number; endDiff: number; holdDiff: number; luma: { mean: number; sd: number } }[];
  checkedAt: string;
}

const SAMPLE_W = 320;

function stats(rgb: Buffer): { mean: number; sd: number } {
  let s = 0, s2 = 0; const n = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 3) { const y = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]; s += y; s2 += y * y; }
  const mean = s / n; return { mean, sd: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
}
/** mean absolute difference per channel, 0–255 */
function diff(a: Buffer, b: Buffer): number {
  if (a.length !== b.length || !a.length) return 255;
  let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}
const hexRgb = (c: string): [number, number, number] => { const n = parseInt(c.replace("#", "").slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

async function frameAt(file: string, t: number, w: number, h: number): Promise<Buffer> {
  const r = await runFfmpeg(["-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", `scale=${w}:${h}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return r.stdout;
}

export async function verifyVideo(bytes: Buffer, plan: VideoPlan, fonts: ReportFonts): Promise<VideoQa> {
  const dir = mkdtempSync(join(tmpdir(), "story-qa-"));
  const file = join(dir, "v.mp4");
  writeFileSync(file, bytes);
  const checks: VideoCheck[] = [];
  const crit = (code: string, message: string, scene?: number) => checks.push({ code, severity: "critical", message, ...(scene !== undefined ? { scene } : {}) });
  const warn = (code: string, message: string, scene?: number) => checks.push({ code, severity: "warning", message, ...(scene !== undefined ? { scene } : {}) });
  const sceneOut: VideoQa["scenes"] = [];
  let frames: number | null = null;
  let info: MediaInfo = { duration: null };
  try {
    /* streams */
    info = parseInfo((await runFfmpeg(["-i", file])).stderr);
    const v = info.video;
    if (!v) crit("no_video_stream", "the file has no video stream");
    else {
      if (v.codec !== "h264") crit("codec", `video codec is ${v.codec}, expected H.264`);
      if (v.pixFmt !== "yuv420p") crit("pixel_format", `pixel format is ${v.pixFmt}, expected yuv420p (plays everywhere)`);
      if (v.width !== plan.width || v.height !== plan.height) crit("resolution", `resolution is ${v.width}×${v.height}, expected ${plan.width}×${plan.height}`);
      if (v.fps !== null && Math.abs(v.fps - plan.fps) > 0.01) crit("frame_rate", `frame rate is ${v.fps}, expected ${plan.fps}`);
    }
    if (info.duration === null) crit("duration_unknown", "the file's duration cannot be read");
    else if (Math.abs(info.duration - plan.total) > Math.max(0.25, 1.5 / plan.fps)) crit("duration", `duration is ${info.duration.toFixed(2)}s, the plan is ${plan.total.toFixed(2)}s`);
    if (plan.narration && !info.audio) crit("no_audio", "narration was requested but the file has no audio track");
    if (plan.narration && info.audio && info.audio.codec !== "aac") crit("audio_codec", `audio codec is ${info.audio.codec}, expected AAC`);
    if (plan.subtitles && !info.subtitle) crit("no_subtitles", "subtitles were requested but the file has no subtitle track");

    /* full decode */
    const dec = await runFfmpeg(["-v", "error", "-stats", "-i", file, "-map", "0:v:0", "-f", "null", "-"]);
    const errors = dec.stderr.split("\n").filter((l) => l.trim() && !/^frame=|^\s*$|size=|speed=/.test(l.trim()) && !/frame=\s*\d+/.test(l));
    const fm = [...dec.stderr.matchAll(/frame=\s*(\d+)/g)].pop();
    frames = fm ? Number(fm[1]) : null;
    if (dec.code !== 0 || errors.length) crit("decode_errors", `the file does not decode cleanly: ${errors.slice(0, 3).join(" | ") || `exit ${dec.code}`}`);
    const expectFrames = plan.segments.reduce((a, s) => a + Math.round(s.timing.total * plan.fps), 0);
    if (frames !== null && Math.abs(frames - expectFrames) > 2) crit("frame_count", `${frames} frames decoded, ${expectFrames} planned`);

    /* every scene against its reference */
    const sh = Math.round((SAMPLE_W * plan.height) / plan.width / 2) * 2;
    for (const seg of plan.segments) {
      const page = plan.composed.pages[seg.index];
      const t = seg.timing;
      const ref = rgbaToRgb(rasterize(renderFrame(page, 0, { total: t.total, fadeIn: 0, fadeOut: 0, width: SAMPLE_W, height: sh, measure: fonts.measurer, final: true }), fonts).pixels, hexRgb(page.background));
      const settledT = seg.start + Math.min(t.enter + 0.15, t.total - t.outro - 0.1);
      const endT = seg.start + Math.max(t.enter, t.total - t.outro - 0.12);
      const a = await frameAt(file, settledT, SAMPLE_W, sh);
      const b = await frameAt(file, endT, SAMPLE_W, sh);
      const settledDiff = diff(a, ref), endDiff = diff(b, ref), holdDiff = diff(a, b);
      const luma = stats(b.length ? b : a);
      const refL = stats(ref);
      sceneOut.push({ index: seg.index, sceneId: seg.sceneId, settledDiff: Math.round(settledDiff * 100) / 100, endDiff: Math.round(endDiff * 100) / 100, holdDiff: Math.round(holdDiff * 100) / 100, luma: { mean: Math.round(luma.mean), sd: Math.round(luma.sd * 10) / 10 } });
      if (!a.length || !b.length) { crit("frame_missing", `scene ${seg.index + 1} (“${seg.title.slice(0, 50)}”) could not be decoded at ${settledT.toFixed(2)}s`, seg.index); continue; }
      if (luma.sd < 1.5 && refL.sd > 4) crit("blank_scene", `scene ${seg.index + 1} (“${seg.title.slice(0, 50)}”) is blank in the video`, seg.index);
      if (settledDiff > 6 || endDiff > 6) crit("scene_mismatch", `scene ${seg.index + 1} (“${seg.title.slice(0, 50)}”) does not match its definition (difference ${Math.max(settledDiff, endDiff).toFixed(1)}/255)`, seg.index);
      if (holdDiff > 3) crit("unstable_hold", `scene ${seg.index + 1} changes while it should be still (flicker, difference ${holdDiff.toFixed(1)}/255)`, seg.index);
      if (t.total + 0.01 < t.minimum) crit("too_short_to_read", `scene ${seg.index + 1} is ${t.total}s, its reading time is ${t.minimum}s`, seg.index);
      if (seg.narration && seg.narration.seconds > t.total - t.outro) crit("narration_overruns", `the narration of scene ${seg.index + 1} (${seg.narration.seconds.toFixed(1)}s) runs past the scene (${t.total}s)`, seg.index);
    }
    if (plan.pacingNote) warn("pacing", plan.pacingNote);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return { ok: !checks.some((c) => c.severity === "critical"), info, frames, checks, scenes: sceneOut, checkedAt: new Date().toISOString() };
}
