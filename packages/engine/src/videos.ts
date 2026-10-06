import type { Question } from "@rescript/schema";

/**
 * THE CLIPS OF A VIDEO QUESTION (October 2026 review).
 *
 * Video Hotspot / Annotation and Watch-Time Tracking may hold several clips
 * ("+ Add Video"), each with a title and description; Video Rating holds one.
 * They live in `settings.videos`; a question authored before the list existed
 * has its single clip in `settings.mediaUrl`, and reads exactly as it did.
 */
export interface VideoClip {
  url: string;
  title?: string;
  description?: string;
  /** Video Hotspot: the reactions offered on this clip; absent = all */
  reactions?: (string | number)[];
}

export function videoList(q: Pick<Question, "settings">): VideoClip[] {
  const vs = (q.settings.videos ?? []).filter((v) => v && typeof v.url === "string");
  const first = q.settings.mediaUrl;
  if (!vs.length) return first ? [{ url: first }] : [];
  /*
   * `mediaUrl` IS THE FIRST CLIP. The Studio keeps the two equal, but the
   * Copilot, an import or a JSON edit may only know `mediaUrl` — a new URL
   * written there must not be shadowed by an older list.
   */
  return first && vs[0].url !== first ? [{ ...vs[0], url: first }, ...vs.slice(1)] : vs;
}

/**
 * WATCH-TIME TRACKING'S FIELDS ARE THE SYSTEM'S, NOT THE AUTHOR'S.
 *
 * "The fields in this section can be edited, but the changes are not
 * reflected in the Preview … Since these video-tracking variables are already
 * fixed and handled in the backend, allowing users to edit or add fields in
 * the builder creates confusion" (October 2026 review). The builder no longer
 * shows them; they are derived from the clip list — four per clip, the first
 * clip keeping the names every existing export already has (`watched`,
 * `duration`, `percent`, `completed`), the rest suffixed `_2`, `_3` …
 */
export const WATCH_FIELDS: readonly { code: string; label: string }[] = [
  { code: "watched", label: "Seconds watched" },
  { code: "duration", label: "Clip duration (s)" },
  { code: "percent", label: "Percent watched" },
  { code: "completed", label: "Watched to the end" },
];

export function watchFieldCode(field: string, clipIndex: number): string {
  return clipIndex === 0 ? field : `${field}_${clipIndex + 1}`;
}

export function watchTimeRows(clips: number): Question["rows"] {
  const n = Math.max(1, clips);
  const rows: Question["rows"] = [];
  for (let i = 0; i < n; i++) {
    for (const f of WATCH_FIELDS) {
      rows.push({
        code: watchFieldCode(f.code, i),
        label: n === 1 ? f.label : `${f.label} — video ${i + 1}`,
        fieldType: "number", flags: [], validation: [], required: false,
      } as Question["rows"][number]);
    }
  }
  return rows;
}

/** The clips whose `completed` field is not 1 (indexes from 0) — what "must watch to the end" still waits for. */
export function unfinishedClips(q: Pick<Question, "rows">, value: unknown): number[] {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const out: number[] = [];
  for (const r of q.rows ?? []) {
    const m = /^completed(?:_(\d+))?$/.exec(String(r.code));
    if (!m) continue;
    const i = m[1] ? Number(m[1]) - 1 : 0;
    if (Number(v[String(r.code)]) !== 1) out.push(i);
  }
  return out.sort((a, b) => a - b);
}
