/**
 * COMING BACK TO AN UNFINISHED SURVEY.
 *
 * The runtime always saved every page to the database — that part was never
 * the problem. The problem was the POINTER: the session id lived in
 * `window.sessionStorage`, which by definition dies with the tab. So a
 * respondent who closed the tab, or whose phone killed the tab to reclaim
 * memory, or who followed a link from their email in a new window, could not
 * get back to their own half-finished response. The row stayed `in_progress`
 * for ever, and the next attempt started a second one.
 *
 * Three things change here, and each is a different failure the old shape had:
 *
 *   1. the pointer is durable — `localStorage`, so closing the tab is not
 *      losing the interview;
 *   2. it can travel — a resume LINK carries the session id, which is how a
 *      "continue where you left off" email is possible at all;
 *   3. it expires — an `in_progress` row with no expiry resumes for ever,
 *      which is how live data fills with attempts from months ago. After
 *      `RESUME_MAX_AGE_DAYS` the pointer is dropped and the respondent starts
 *      cleanly rather than being stitched onto a stale row.
 *
 * And one more thing that is not resume but shares its machinery: answers are
 * cached locally between saves, so a save that fails — a tunnel, a dropped
 * wifi, a laptop lid — is recoverable instead of losing the page. That is the
 * whole of the platform's offline story today, and it is deliberately small:
 * a local cache that replays on the next successful save, not a service
 * worker pretending the survey works offline.
 */

/** How long a local resume pointer stays valid. */
export const RESUME_MAX_AGE_DAYS = 30;

const KEY = (mode: string, surveyDbId: string) => `rescript:session:${mode}:${surveyDbId}`;
const CACHE_KEY = (sessionId: string) => `rescript:pending:${sessionId}`;

interface Pointer {
  sessionId: string;
  /** when this pointer was written, so it can go stale */
  at: number;
}

/** Both stores, so a browser that blocks one still works with the other. */
function stores(): Storage[] {
  const out: Storage[] = [];
  try { if (typeof window !== "undefined" && window.localStorage) out.push(window.localStorage); } catch { /* blocked */ }
  try { if (typeof window !== "undefined" && window.sessionStorage) out.push(window.sessionStorage); } catch { /* blocked */ }
  return out;
}

/**
 * The session to resume, if any.
 *
 * A `?r=` parameter wins over stored state: it is an explicit instruction
 * from a link the respondent just followed, and it is how a resume email
 * works on a device that has never seen this survey. The stored pointer is
 * the fallback, and a pointer written before the last release is still read —
 * the old shape was a bare session id, not JSON.
 */
export function readResume(mode: string, surveyDbId: string, url?: string): string | null {
  const fromLink = (() => {
    try {
      const search = url ?? (typeof window !== "undefined" ? window.location.search : "");
      const v = new URLSearchParams(search).get("r");
      return v && /^[A-Za-z0-9_-]{16,128}$/.test(v) ? v : null;
    } catch { return null; }
  })();
  if (fromLink) return fromLink;

  for (const store of stores()) {
    let raw: string | null = null;
    try { raw = store.getItem(KEY(mode, surveyDbId)); } catch { continue; }
    if (!raw) continue;
    // the pre-JSON shape: a bare session id with no timestamp
    if (!raw.startsWith("{")) return raw;
    try {
      const p = JSON.parse(raw) as Pointer;
      if (!p?.sessionId) continue;
      const ageDays = (Date.now() - (p.at ?? 0)) / 86_400_000;
      if (ageDays > RESUME_MAX_AGE_DAYS) {
        clearResume(mode, surveyDbId);
        continue;
      }
      return p.sessionId;
    } catch { /* unreadable — treat as absent */ }
  }
  return null;
}

export function writeResume(mode: string, surveyDbId: string, sessionId: string): void {
  const value = JSON.stringify({ sessionId, at: Date.now() } satisfies Pointer);
  for (const store of stores()) {
    try { store.setItem(KEY(mode, surveyDbId), value); } catch { /* full or blocked */ }
  }
}

export function clearResume(mode: string, surveyDbId: string): void {
  for (const store of stores()) {
    try { store.removeItem(KEY(mode, surveyDbId)); } catch { /* ignore */ }
  }
}

/** A link that resumes this session on any device. */
export function resumeLink(sessionId: string, base?: string): string {
  const href = base ?? (typeof window !== "undefined" ? window.location.href : "");
  try {
    const u = new URL(href);
    u.searchParams.set("r", sessionId);
    return u.toString();
  } catch {
    return href;
  }
}

/* ------------------------------------------------------------ local cache */

export interface PendingAnswers {
  answers: Record<string, unknown>;
  calculated: Record<string, unknown>;
  embedded: Record<string, unknown>;
  flags: unknown[];
  stepIndex: number;
  at: number;
  /** preview only: the response seed, so a reload re-derives the same design version and orders */
  seed?: number;
  /**
   * preview only (A66): one configuration fingerprint per question
   * (engine `configFingerprints`) at the time of the snapshot, so the next
   * resume drops the stored answers of exactly the questions whose options,
   * Hidden setting, punch rules or logic changed in the builder since — and
   * keeps everything else. Absent on a snapshot written before this existed.
   */
  fingerprints?: Record<string, string>;
}

/**
 * Keep the page's answers where a reload can find them.
 *
 * Written on every page submit and cleared as soon as the server confirms the
 * save, so what is in here is exactly "the work the server has not
 * acknowledged". Keyed by session id, so it can only ever be replayed onto
 * the response it came from.
 */
export function cachePending(sessionId: string, p: Omit<PendingAnswers, "at">): number {
  const at = Date.now();
  try {
    window.localStorage.setItem(CACHE_KEY(sessionId), JSON.stringify({ ...p, at }));
  } catch { /* storage full or blocked — the in-memory retry still applies */ }
  return at;
}

export function readPending(sessionId: string): PendingAnswers | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY(sessionId));
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingAnswers;
    return p && typeof p === "object" && p.answers ? p : null;
  } catch { return null; }
}

/**
 * Drop the cache once the server has the work. With `at` (the stamp
 * `cachePending` returned for the snapshot that save carried) only THAT
 * snapshot is dropped: a Back and a Next in quick succession put two saves in
 * flight, and the earlier one's acknowledgement must not erase the later
 * snapshot whose own save may still fail (RUNTIME-06).
 */
export function clearPending(sessionId: string, at?: number): void {
  try {
    if (at !== undefined) {
      const cur = readPending(sessionId);
      if (cur && cur.at !== at) return;
    }
    window.localStorage.removeItem(CACHE_KEY(sessionId));
  } catch { /* ignore */ }
}

/**
 * The position and answers to resume with, given what the server saved and
 * what this browser cached but never got acknowledged (RUNTIME-06).
 *
 * The cache is by construction NEWER than the server row — it is cleared the
 * moment a save is acknowledged — so its step wins outright. It used to be
 * `Math.max(pending, saved)`, which is right only while a respondent only
 * ever moves forward: after Back, the cached step is LOWER than the saved
 * one, and the max put a reloading respondent further along than the page
 * they had gone back to.
 */
export function mergeResumeSnapshot(
  saved: { answers?: Record<string, unknown>; calculated?: Record<string, unknown>; embedded?: Record<string, unknown>; flags?: unknown[]; stepIndex?: number; nav?: unknown; savedAt?: string | null } | null | undefined,
  pending: PendingAnswers,
): { answers: Record<string, unknown>; calculated: Record<string, unknown>; embedded: Record<string, unknown>; flags: unknown[]; stepIndex: number; nav?: unknown; savedAt?: string | null } {
  const step = Number.isInteger(pending.stepIndex) && pending.stepIndex >= 0 ? pending.stepIndex : (saved?.stepIndex ?? 0);
  return {
    answers: { ...(saved?.answers ?? {}), ...pending.answers },
    calculated: { ...(saved?.calculated ?? {}), ...pending.calculated },
    embedded: { ...(saved?.embedded ?? {}), ...pending.embedded },
    flags: pending.flags ?? saved?.flags ?? [],
    stepIndex: step,
    /* the row's navigation trail (0077) travels with it — the Runner weighs it against this browser's copy (engine chooseNavTrail) */
    ...(saved?.nav !== undefined ? { nav: saved.nav, savedAt: saved.savedAt ?? null } : {}),
  };
}

/* ------------------------------------------------------------ preview resume
 *
 * A PREVIEW THAT SURVIVES A REFRESH.
 *
 * "When the page is refreshed, the survey should resume from the user's last
 * position instead of restarting from the beginning."
 *
 * Live and test interviews already did: every page is saved to the response
 * row, the pointer to that row outlives the tab (above), and `resumeAt` walks
 * back to where the respondent was. Preview had none of it — deliberately, in
 * that a preview writes nothing to the database — so it was the one place a
 * reload really did start the survey again, and it is the place a programmer
 * reloads most, because the Studio reloads it for them on every edit.
 *
 * So preview gets the same behaviour with no database: the same snapshot
 * shape, in `sessionStorage`.
 *
 *   · sessionStorage, not localStorage — a preview belongs to the tab it was
 *     opened in. Two previews of two surveys in two tabs must not collide,
 *     and yesterday's preview must not come back tomorrow.
 *   · keyed by the definition id AND the entry point, so "Preview block"
 *     starts where it was asked to start rather than resuming the last full
 *     run through.
 *   · dropped when the interview completes, so the next preview starts clean.
 *
 * Nothing here can reach a respondent: it is only read when `mode` is
 * "preview" (Runner.tsx).
 */
const PREVIEW_KEY = (previewId: string) => `rescript:preview-state:${previewId}`;

/** A preview's own position and answers, for the length of the tab. */
export function cachePreviewState(previewId: string, p: Omit<PendingAnswers, "at">): void {
  try {
    window.sessionStorage.setItem(PREVIEW_KEY(previewId), JSON.stringify({ ...p, at: Date.now() }));
  } catch { /* private mode / quota — preview simply starts from the top */ }
}

export function readPreviewState(previewId: string): PendingAnswers | null {
  try {
    const raw = window.sessionStorage.getItem(PREVIEW_KEY(previewId));
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingAnswers;
    return p && typeof p === "object" && p.answers ? p : null;
  } catch { return null; }
}

export function clearPreviewState(previewId: string): void {
  try { window.sessionStorage.removeItem(PREVIEW_KEY(previewId)); } catch { /* ignore */ }
}

/* ------------------------------------------------------------ section navigation trail
 *
 * SECTION NAVIGATION (2026-10-30): the Back trail and the pages seen live in
 * `state.meta`, which is never posted (it is not an answer and must not reach
 * an export). A reload would lose them — the navigator would forget which
 * sections were visited and Back would fall back to compiled order. They are
 * kept in THIS browser beside the resume pointer: localStorage for a live /
 * test session (keyed by session id), sessionStorage for a preview. Another
 * device resumes without them; the engine then derives "visited" from the
 * answers and the position (sectionNav.ts), which is the honest fallback.
 */
export interface NavTrail { visited: string[]; seen: string[]; at: number }
const NAV_KEY = (key: string) => `rescript:nav:${key}`;
const cleanIds = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-2000) : [];

export function writeNavTrail(key: string, trail: { visited: string[]; seen: string[] }, preview = false): void {
  try {
    const store = preview ? window.sessionStorage : window.localStorage;
    store.setItem(NAV_KEY(key), JSON.stringify({ visited: cleanIds(trail.visited), seen: cleanIds(trail.seen), at: Date.now() }));
  } catch { /* blocked storage — Back falls back to compiled order */ }
}

export function readNavTrail(key: string, preview = false): NavTrail | null {
  try {
    const store = preview ? window.sessionStorage : window.localStorage;
    const raw = store.getItem(NAV_KEY(key));
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<NavTrail>;
    if (!p || typeof p !== "object") return null;
    return { visited: cleanIds(p.visited), seen: cleanIds(p.seen), at: typeof p.at === "number" ? p.at : 0 };
  } catch { return null; }
}

export function clearNavTrail(key: string, preview = false): void {
  try { (preview ? window.sessionStorage : window.localStorage).removeItem(NAV_KEY(key)); } catch { /* ignore */ }
}
