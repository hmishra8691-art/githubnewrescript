/**
 * THE HIGHLIGHT REEL AS ONE VIDEO (Level 5 roadmap Q4 — 2026-11-29).
 *
 * A reel (analytics qual/highlights.ts) is a researcher's ordered list of quotes, each with the time range of its
 * words in a recording. Until now its clips played one by one in the browser. This cuts each clip from its
 * recording on the server, burns the quote in as a caption, puts a branded title card first, and joins them into
 * one MP4.
 *
 *   planReel     decides each item, in order, BEFORE anything is cut:
 *                  footage   the participant consented to recording, the source has media, the quote has a time range
 *                  card      no recording consent (or no media / timing): the quote is shown as a text card instead,
 *                            with the speaker anonymised — the words are evidence, the face and voice are not ours
 *                  skip      the reel is set to leave such items out (withoutConsent: "skip"), or the item has no quote
 *                and fits the reel to its length budget, dropping from the end and saying which.
 *   renderReel   draws title, captions and cards with the report fonts (resvg — no system fonts), cuts and scales every
 *                clip to one size, frame rate and audio format, and concatenates without a second re-encode.
 *
 * Speakers are shown as the reel's labels (P1, P2…) unless `showSpeakers` is set; a clip is never shown for a
 * participant whose recording consent is not recorded as given.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpeg, probe } from "./ffmpeg.js";
import { rasterizePng, type ReportFonts } from "./fonts.js";

export interface ReelSource { sourceId: string; file?: string | null; hasVideo?: boolean; consent?: { recording?: boolean; captured?: boolean } | null; speakerLabel?: string }
export interface ReelItemIn { excerptId: string; sourceId: string; quote: string; speaker?: string; start?: number; end?: number; note?: string }
export interface ReelBrand { title: string; subtitle?: string; color?: string; background?: string; logoPng?: Buffer | null }
export interface ReelOptions { maxSeconds?: number; padSeconds?: number; withoutConsent?: "card" | "skip"; showSpeakers?: boolean; brand: ReelBrand }
export type ClipMode = "footage" | "card" | "skip";
export interface PlannedClip { excerptId: string; mode: ClipMode; reason: string; sourceId: string; file?: string; hasVideo: boolean; start?: number; end?: number; seconds: number; caption: string; speaker: string }
export interface ReelPlan { title: { seconds: number; brand: ReelBrand }; clips: PlannedClip[]; seconds: number; dropped: string[]; notes: string[] }

const TITLE_SECONDS = 3;
/** a text card holds long enough to read: about 2.5 words a second, at least 3 s, at most 10 s */
export const cardSeconds = (quote: string) => Math.min(10, Math.max(3, Math.round((quote.trim().split(/\s+/).length / 2.5 + 1.2) * 10) / 10));

export function planReel(items: ReelItemIn[], sources: ReelSource[], opts: ReelOptions): ReelPlan {
  const pad = opts.padSeconds ?? 0.25, max = opts.maxSeconds ?? 180;
  const byId = new Map(sources.map((s) => [s.sourceId, s]));
  const labels = new Map<string, string>();
  const label = (s: ReelSource | undefined, speaker: string | undefined, sourceId: string) => {
    if (opts.showSpeakers && speaker) return speaker;
    if (s?.speakerLabel) return s.speakerLabel;
    if (!labels.has(sourceId)) labels.set(sourceId, `Participant ${labels.size + 1}`);
    return labels.get(sourceId)!;
  };
  const clips: PlannedClip[] = [];
  for (const it of items) {
    const s = byId.get(it.sourceId);
    const speaker = label(s, it.speaker, it.sourceId);
    const base = { excerptId: it.excerptId, sourceId: it.sourceId, hasVideo: !!s?.hasVideo, caption: it.quote.trim(), speaker };
    if (!it.quote.trim()) { clips.push({ ...base, mode: "skip", reason: "the item has no quote", seconds: 0 }); continue; }
    const consented = s?.consent?.recording === true;
    const timed = typeof it.start === "number" && typeof it.end === "number" && it.end > it.start;
    const why = !consented ? "no recording consent is recorded for this participant" : !s?.file ? "the recording is not available" : !timed ? "the quote has no time range in the recording" : "";
    if (!why) {
      const start = Math.max(0, it.start! - pad), end = it.end! + pad;
      clips.push({ ...base, mode: "footage", reason: "consented recording, timed quote", file: s!.file!, start, end, seconds: Math.round((end - start) * 100) / 100 });
    } else if ((opts.withoutConsent ?? "card") === "skip" && !consented) clips.push({ ...base, mode: "skip", reason: `${why}; the reel leaves such quotes out`, seconds: 0 });
    else clips.push({ ...base, mode: "card", reason: `${why}: shown as a text card`, seconds: cardSeconds(it.quote) });
  }
  /* fit the budget: drop from the end, never cut a clip short */
  const dropped: string[] = [];
  let total = TITLE_SECONDS + clips.reduce((a, c) => a + c.seconds, 0);
  for (let i = clips.length - 1; i >= 0 && total > max; i--) {
    if (clips[i]!.mode === "skip") continue;
    total -= clips[i]!.seconds;
    dropped.push(clips[i]!.excerptId);
    clips[i] = { ...clips[i]!, mode: "skip", reason: `over the reel's ${max} s budget`, seconds: 0 };
  }
  const notes: string[] = [];
  const cards = clips.filter((c) => c.mode === "card").length, foot = clips.filter((c) => c.mode === "footage").length;
  if (cards) notes.push(`${cards} quote${cards === 1 ? " is" : "s are"} shown as text cards (${[...new Set(clips.filter((c) => c.mode === "card").map((c) => c.reason.replace(/: shown as a text card$/, "")))].join("; ")}).`);
  if (!foot) notes.push("No clip has consented, timed footage: the reel is text cards only.");
  if (dropped.length) notes.push(`${dropped.length} item${dropped.length === 1 ? "" : "s"} left out to keep the reel under ${max} s.`);
  return { title: { seconds: TITLE_SECONDS, brand: opts.brand }, clips, seconds: Math.round(total * 100) / 100, dropped, notes };
}

/* ---------------------------------------------------------------- drawing */

const W = 1280, H = 720, FPS = 30;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function wrap(text: string, fonts: ReportFonts, size: number, maxWidth: number, weight = 400, maxLines = 6): string[] {
  const words = text.split(/\s+/).filter(Boolean), lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (fonts.measurer.width(next, "Inter", weight, size) > maxWidth && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { const kept = lines.slice(0, maxLines); kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/[.,;:]?$/, "")}…`; return kept; }
  return lines;
}
function titleSvg(b: ReelBrand, fonts: ReportFonts): string {
  const bg = b.background ?? "#0f172a", fg = "#ffffff", accent = b.color ?? "#2563eb";
  const t = wrap(b.title, fonts, 54, W - 200, 700, 3);
  const y0 = H / 2 - (t.length * 64) / 2 + 40;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${bg}"/><rect x="100" y="${y0 - 70}" width="80" height="8" fill="${accent}"/>${t.map((l, i) => `<text x="100" y="${y0 + i * 64}" font-family="Inter" font-weight="700" font-size="54" fill="${fg}">${esc(l)}</text>`).join("")}${b.subtitle ? `<text x="100" y="${y0 + t.length * 64 + 20}" font-family="Inter" font-size="26" fill="#cbd5e1">${esc(b.subtitle)}</text>` : ""}${b.logoPng ? `<image href="data:image/png;base64,${b.logoPng.toString("base64")}" x="${W - 280}" y="60" width="200" height="80" preserveAspectRatio="xMaxYMin meet"/>` : ""}</svg>`;
}
function captionSvg(c: PlannedClip, fonts: ReportFonts): string {
  const lines = wrap(`“${c.caption}”`, fonts, 30, W - 160, 400, 3);
  const h = 40 + lines.length * 40 + 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}"><rect width="100%" height="100%" fill="#000000" fill-opacity="0.62"/>${lines.map((l, i) => `<text x="80" y="${50 + i * 40}" font-family="Inter" font-size="30" fill="#ffffff">${esc(l)}</text>`).join("")}<text x="80" y="${50 + lines.length * 40 + 8}" font-family="Inter" font-weight="700" font-size="22" fill="#e2e8f0">— ${esc(c.speaker)}</text></svg>`;
}
function cardSvg(c: PlannedClip, b: ReelBrand, fonts: ReportFonts): string {
  const lines = wrap(`“${c.caption}”`, fonts, 40, W - 240, 400, 7);
  const y0 = H / 2 - (lines.length * 54) / 2 + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#f8fafc"/><rect x="0" y="0" width="16" height="${H}" fill="${b.color ?? "#2563eb"}"/>${lines.map((l, i) => `<text x="120" y="${y0 + i * 54}" font-family="Inter" font-size="40" fill="#0f172a">${esc(l)}</text>`).join("")}<text x="120" y="${y0 + lines.length * 54 + 30}" font-family="Inter" font-weight="700" font-size="26" fill="#475569">— ${esc(c.speaker)}</text></svg>`;
}

const ENC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "-c:a", "aac", "-ar", "48000", "-ac", "2", "-video_track_timescale", "90000"];

async function stillSegment(png: string, seconds: number, out: string): Promise<void> {
  const r = await runFfmpeg(["-y", "-loop", "1", "-framerate", String(FPS), "-i", png, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-t", seconds.toFixed(3), "-vf", `scale=${W}:${H},setsar=1`, ...ENC, "-shortest", out]);
  if (r.code !== 0) throw new Error(`a card could not be encoded: ${r.stderr.slice(-400)}`);
}

export interface RenderedReel { bytes: Buffer; seconds: number; segments: number; footage: number; cards: number }

export async function renderReel(plan: ReelPlan, fonts: ReportFonts, opts: { workDir?: string; signal?: AbortSignal } = {}): Promise<RenderedReel> {
  const dir = opts.workDir ?? mkdtempSync(join(tmpdir(), "reel-"));
  const segs: string[] = [];
  try {
    const t = join(dir, "title.png"); writeFileSync(t, rasterizePng(titleSvg(plan.title.brand, fonts), fonts));
    const ts = join(dir, "s000.mp4"); await stillSegment(t, plan.title.seconds, ts); segs.push(ts);
    let i = 0;
    for (const c of plan.clips) {
      if (c.mode === "skip") continue;
      i++;
      const out = join(dir, `s${String(i).padStart(3, "0")}.mp4`);
      if (c.mode === "card") {
        const p = join(dir, `card${i}.png`); writeFileSync(p, rasterizePng(cardSvg(c, plan.title.brand, fonts), fonts));
        await stillSegment(p, c.seconds, out);
      } else {
        const cap = join(dir, `cap${i}.png`); writeFileSync(cap, rasterizePng(captionSvg(c, fonts), fonts));
        const info = await probe(c.file!);
        const hasAudio = !!info.audio;
        const video = c.hasVideo && info.video
          ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}[v0]`
          : `color=c=0x0f172a:s=${W}x${H}:r=${FPS}:d=${c.seconds}[v0]`;
        const args = ["-y", "-ss", c.start!.toFixed(3), "-to", c.end!.toFixed(3), "-i", c.file!, "-i", cap];
        if (!hasAudio) args.push("-f", "lavfi", "-t", c.seconds.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
        const filter = `${video};[v0][1:v]overlay=0:H-h[v]`;
        args.push("-filter_complex", filter, "-map", "[v]", "-map", hasAudio ? "0:a:0" : "2:a:0", "-t", c.seconds.toFixed(3), ...ENC, out);
        const r = await runFfmpeg(args, undefined, { signal: opts.signal });
        if (r.code !== 0) throw new Error(`clip ${c.excerptId} could not be cut: ${r.stderr.slice(-400)}`);
      }
      segs.push(out);
    }
    const list = join(dir, "list.txt");
    writeFileSync(list, segs.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"));
    const final = join(dir, "reel.mp4");
    const r = await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", "-metadata", `title=${plan.title.brand.title.replace(/[\r\n]/g, " ")}`, final]);
    if (r.code !== 0) throw new Error(`the reel could not be joined: ${r.stderr.slice(-400)}`);
    const info = await probe(final);
    return { bytes: readFileSync(final), seconds: info.duration ?? plan.seconds, segments: segs.length, footage: plan.clips.filter((c) => c.mode === "footage").length, cards: plan.clips.filter((c) => c.mode === "card").length };
  } finally {
    if (!opts.workDir) rmSync(dir, { recursive: true, force: true });
  }
}
