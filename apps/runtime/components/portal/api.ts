"use client";

/**
 * The portal's one way to talk to its server (phase 1). Same-origin, cookie session, never cached; a change carries
 * the header the server requires of every change. A 401 anywhere sends the person to sign in, remembering nothing
 * about where they were beyond the path.
 */
export interface ApiError { status: number; code: string; error: string; [k: string]: unknown }
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export async function portalApi<T = Record<string, unknown>>(path: string, body?: Record<string, unknown>, opts: { redirectOn401?: boolean } = {}): Promise<ApiResult<T>> {
  try {
    const r = await fetch(`/api/portal/${path}`, {
      method: body ? "POST" : "GET", cache: "no-store", credentials: "same-origin",
      headers: body ? { "content-type": "application/json", "x-rescript-portal": "1" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.ok) return { ok: true, data: j as T };
    if (r.status === 401 && opts.redirectOn401 !== false && typeof window !== "undefined") {
      window.location.assign(`/portal/login${j.code === "session_idle" ? "?ended=idle" : ""}`);
    }
    return { ok: false, error: { status: r.status, code: String(j.code ?? "error"), error: String(j.error ?? "Something went wrong. Please try again."), ...j } };
  } catch {
    return { ok: false, error: { status: 0, code: "offline", error: "You appear to be offline. Check your connection and try again." } };
  }
}

/** a token carried in the page's #fragment — read once, then removed from the address bar */
export function takeFragmentToken(): string | null {
  if (typeof window === "undefined") return null;
  const m = /(?:^|[#&])token=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
  if (m) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return m ? m[1]! : null;
}

export const when = (iso: string | null | undefined, withTime = false): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) });
};

/** take or continue an assessment: the server decides whether it may be, and where it is */
export async function begin(id: string, onError: (m: string) => void): Promise<void> {
  const r = await portalApi<{ url: string }>(`assessments/${id}`, { action: "start" });
  if (r.ok) window.location.assign(r.data.url); else onError(r.error.error);
}
