/**
 * HOW A FILE DESCRIBES ITSELF ON SCREEN — one implementation, three callers.
 *
 * The asset library had a correct size formatter and the interview recorder
 * had its own, which was `(n / 1048576).toFixed(1) + " MB"` for everything.
 * So the same 72 KB screenshot read "71 KB" on a library tile and "0.1 MB"
 * in the recorder panel, and a 40 KB one read "0.0 MB" — a rendering that
 * cannot tell an empty file from a small one.
 *
 * Two formatters for one fact is how that happens, so there is one now.
 */

/**
 * A size at its own scale. Empty for absent or zero, because a tile showing
 * "0 B" where a file has no recorded size is stating something it does not
 * know — use `fileSize` where the absence itself has to be visible.
 */
export function formatBytes(n: number | null | undefined): string {
  if (!n || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/**
 * The same, for a place that is describing ONE named file and must not go
 * silent about its size — a recorder panel with a file in flight. A blank
 * there reads as "no size", which is a different and wronger claim than
 * "we were not told".
 */
export function fileSize(n: number | null | undefined): string {
  if (n === 0) return "0 B";
  return formatBytes(n) || "unknown size";
}

/**
 * `video/webm;codecs=vp9,opus` is a MIME type; `webm` is what a person
 * reads. The codec parameters matter to the store and to nobody looking at
 * a properties panel.
 */
export function typeLabel(t: string | null | undefined): string {
  const base = (t ?? "").split(";")[0]!.trim().toLowerCase();
  if (!base) return "unknown type";
  return /^(video|audio|image)\//.test(base) ? base.split("/")[1]! : base;
}
