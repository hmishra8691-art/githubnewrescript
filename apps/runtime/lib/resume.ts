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
}

/**
 * Keep the page's answers where a reload can find them.
 *
 * Written on every page submit and cleared as soon as the server confirms the
 * save, so what is in here is exactly "the work the server has not
 * acknowledged". Keyed by session id, so it can only ever be replayed onto
 * the response it came from.
 */
export function cachePending(sessionId: string, p: Omit<PendingAnswers, "at">): void {
  try {
    window.localStorage.setItem(CACHE_KEY(sessionId), JSON.stringify({ ...p, at: Date.now() }));
  } catch { /* storage full or blocked — the in-memory retry still applies */ }
}

export function readPending(sessionId: string): PendingAnswers | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY(sessionId));
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingAnswers;
    return p && typeof p === "object" && p.answers ? p : null;
  } catch { return null; }
}

export function clearPending(sessionId: string): void {
  try { window.localStorage.removeItem(CACHE_KEY(sessionId)); } catch { /* ignore */ }
}
