import { NextResponse, type NextRequest } from "next/server";

/**
 * PAGE ROUTING FOR SIGNED-OUT VISITORS.
 *
 * This is a redirect, NOT a security boundary, and the distinction is the
 * whole reason for this comment.
 *
 * All it does is check whether a session cookie is PRESENT, so somebody who
 * is not signed in lands on the login screen instead of an empty dashboard
 * that fails every request. It does not and cannot validate the session:
 * middleware runs at the edge with no database, so "is this session still
 * active, and whose is it?" is unanswerable here.
 *
 * Authorization happens in `lib/guard.ts`, in the route handlers, against the
 * database, on every single request. The requirement is explicit that the
 * backend must refuse an unauthorized action even if the frontend is
 * manipulated (§17, §23, §40) — so forging this cookie gets a visitor a
 * rendered page shell and a 401 from every endpoint that page calls, which is
 * exactly right.
 *
 * The runtime app (respondent-facing survey links) is a different Next.js
 * application and is deliberately untouched: a respondent must never be asked
 * to sign in to answer a survey.
 */

const PUBLIC_PATHS = ["/login", "/signup", "/forgot", "/reset", "/sandbox"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // never interfere with the API: those routes answer 401 in JSON, which is
  // what a client can actually act on. A redirect would turn every expired
  // request into an HTML login page arriving where JSON was expected.
  if (pathname.startsWith("/api/")) return NextResponse.next();

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const hasCookie = !!req.cookies.get("rescript_session")?.value;

  if (!hasCookie && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  /*
   * THE REDIRECT THAT USED TO LIVE HERE IS GONE. It was half of P0-3 and all
   * of P0-4.
   *
   * It sent any cookie-holder away from `/login` to `/`, on the reasonable-
   * sounding grounds that a signed-in user does not need a sign-in form. But
   * this file cannot tell a signed-in user from someone holding a cookie for
   * a session that ended hours ago — it runs at the edge, with no database —
   * and for that second person it was a trap:
   *
   *     /  →  page loads  →  /api/auth/me 401  →  /login  →  HERE  →  /  →  …
   *
   * an infinite loop, and no way to reach the login form by typing the URL
   * either. Two changes retire it. The API now DELETES the cookie whenever it
   * finds the session dead (`failAndSignOut` in lib/guard.ts), so a stale
   * cookie stops existing the first time anything is asked of it; and the
   * "you are already signed in" bounce moved to the login page itself, which
   * is a server component and can actually check.
   *
   * The rule this leaves behind: middleware may redirect on the ABSENCE of a
   * cookie, never on its presence. Absence is a fact it can verify.
   */

  return NextResponse.next();
}

export const config = {
  // everything except Next's own assets and the favicon
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
