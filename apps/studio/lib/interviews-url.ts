/**
 * Resolve the Interviews app's base URL.
 *
 * The same tolerance as `runtime-url.ts`, for the same reason: this is typed by
 * hand into Vercel, and the two mistakes people make are a missing scheme
 * ("interviews.example.com", which a browser resolves as a *relative* path) and
 * a trailing slash (which produces "//projects").
 *
 * ## Why an empty value means "not deployed" rather than localhost
 *
 * `runtimeBaseUrl()` falls back to `http://localhost:3001` because a developer
 * always has a runtime — every survey needs one, and a Studio with no runtime
 * is not a working install. Interviews is a SECOND PRODUCT that an installation
 * may simply not have. Falling back to a localhost URL here would put a link in
 * the header of every deployment, pointing at a port on the reader's own
 * machine, and a link that goes nowhere is worse than no link. So: null unless
 * somebody has said where it is, and the nav renders nothing.
 *
 * The development default is still available — set NEXT_PUBLIC_INTERVIEWS_URL
 * to `http://localhost:3002` in `.env.local` and the link appears.
 */
export function interviewsBaseUrl(): string | null {
  const raw = (process.env.NEXT_PUBLIC_INTERVIEWS_URL ?? "").trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * The link a person in the Studio should follow to reach Interviews.
 *
 * NOT the base URL. The two apps are on different hosts and the session cookie
 * is host-only — deliberately, since `vercel.app` is on the Public Suffix List
 * and a shared cookie domain is not available there at all — so a bare href
 * lands a signed-in person on a sign-in page. This goes through the handoff
 * route instead, which mints a single-use code the other app redeems for its
 * own cookie.
 *
 * `next` is a PATH on the Interviews side, never a URL: `safeNextPath` on the
 * callback refuses anything else, and building an absolute one here would just
 * be discarded there.
 */
export function interviewsHandoffHref(next = "/"): string | null {
  const base = interviewsBaseUrl();
  if (!base) return null;
  const params = new URLSearchParams({ origin: base });
  if (next && next !== "/") params.set("next", next);
  return `/api/auth/handoff?${params.toString()}`;
}
