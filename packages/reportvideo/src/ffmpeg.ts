/**
 * FFMPEG, FOUND AND RUN.
 *
 * The binary is `FFMPEG_PATH` when set, else the one `ffmpeg-static` ships
 * for this platform, else `ffmpeg` on the PATH. Nothing here touches the
 * network; the arguments never carry a credential.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import ffmpegStatic from "ffmpeg-static";

let cached: string | null = null;
export function ffmpegPath(): string {
  if (cached) return cached;
  const env = process.env.FFMPEG_PATH?.trim();
  if (env && existsSync(env)) return (cached = env);
  const p = ffmpegStatic as unknown as string | null;
  if (p && existsSync(p)) return (cached = p);
  return (cached = "ffmpeg");
}

export interface RunResult { code: number; stdout: Buffer; stderr: string }

/** run ffmpeg; `feed` writes to its stdin (back-pressure respected) and must resolve when done */
export function runFfmpeg(args: string[], feed?: (write: (b: Buffer) => Promise<void>) => Promise<void>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-nostdin", ...(feed ? [] : []), ...args], { stdio: [feed ? "pipe" : "ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let done = false;
    const timer = setTimeout(() => { if (!done) child.kill("SIGKILL"); }, opts.timeoutMs ?? 240_000);
    const abort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => { err += d.toString(); if (err.length > 400_000) err = err.slice(-200_000); });
    child.on("error", (e) => { done = true; clearTimeout(timer); reject(e); });
    child.on("close", (code) => { done = true; clearTimeout(timer); opts.signal?.removeEventListener("abort", abort); resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err }); });
    if (feed) {
      const stdin = child.stdin!;
      stdin.on("error", () => { /* ffmpeg exited early; its stderr says why */ });
      const write = (b: Buffer) => new Promise<void>((res) => { if (stdin.destroyed) return res(); if (stdin.write(b)) res(); else stdin.once("drain", () => res()); });
      feed(write).then(() => stdin.end(), (e) => { stdin.destroy(); child.kill("SIGKILL"); reject(e); });
    }
  });
}

/** what ffmpeg says about a media file's streams */
export interface MediaInfo {
  duration: number | null;
  video?: { codec: string; profile?: string; pixFmt?: string; width: number; height: number; fps: number | null };
  audio?: { codec: string; sampleRate?: number; channels?: string };
  subtitle?: { codec: string };
}

export function parseInfo(stderr: string): MediaInfo {
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const info: MediaInfo = { duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null };
  const v = /Stream #\d+:\d+[^:]*: Video: (\w+)(?: \(([^)]+)\))?[^,]*, (\w+)(?:\([^)]*\))?, (\d+)x(\d+)[^\n]*?(?:, (\d+(?:\.\d+)?) fps)?/.exec(stderr);
  if (v) info.video = { codec: v[1], ...(v[2] ? { profile: v[2] } : {}), pixFmt: v[3], width: Number(v[4]), height: Number(v[5]), fps: v[6] ? Number(v[6]) : null };
  if (info.video && info.video.fps === null) { const f = /(\d+(?:\.\d+)?) fps/.exec(stderr); if (f) info.video.fps = Number(f[1]); }
  const a = /Stream #\d+:\d+[^:]*: Audio: (\w+)[^,]*, (\d+) Hz, ([\w.]+)/.exec(stderr);
  if (a) info.audio = { codec: a[1], sampleRate: Number(a[2]), channels: a[3] };
  const s = /Stream #\d+:\d+[^:]*: Subtitle: (\w+)/.exec(stderr);
  if (s) info.subtitle = { codec: s[1] };
  return info;
}

export async function probe(file: string): Promise<MediaInfo> {
  const r = await runFfmpeg(["-i", file]);
  return parseInfo(r.stderr);
}
