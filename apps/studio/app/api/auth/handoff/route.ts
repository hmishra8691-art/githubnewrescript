import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import {
  HANDOFF_START_PATH, HANDOFF_TTL_SECONDS, handoffCallbackUrl,
  normaliseOrigin, originAllowed, parseAllowedOrigins, safeNextPath,
} from "@rescript/access";
import { ipHashOf, supabaseService } from "@/lib/authServer";
import { isFailure, requireUser } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * HAND THIS SESSION TO A SIBLING APP ON ANOTHER ORIGIN.
 *
 * `rescript_session` is host-only — `setSessionCookie` sets no `domain` — so
 * it reaches this app and nothing else. That was right while there was one
 * app. Rescript Interviews is on its own origin, and a shared cookie domain is
 * not available to fix it: `vercel.app` is on the Public Suffix List precisely
 * so one deployment cannot set cookies for another, and no browser will accept
 * `domain=.vercel.app`.
 *
 * So the session is carried over once, by hand:
 *
 *   GET /api/auth/handoff?origin=https://interviews.example&next=/projects/x
 *     → 303 https://interviews.example/api/auth/callback?code=…&next=/projects/x
 *
 * The code is random, stored here only as a SHA-256, redeemable once, for
 * sixty seconds, and only by the origin it was minted for. `0032_auth_handoff`
 * enforces all four in SQL rather than trusting either app to remember.
 *
 * ## Why `origin` and not a full return URL
 *
 * A `return` parameter that the visitor controls is an open redirect wearing a
 * different hat, and an open redirect on an endpoint that mints credentials is
 * how the credential leaves. So the caller names an ORIGIN, it is checked
 * against an allowlist, and the path is a constant this file owns. There is no
 * input that can steer where the code goes.
 *
 * ## Nothing here changes how the Studio itself authenticates
 *
 * No existing route, cookie or table is touched. An installation that never
 * sets `AUTH_HANDOFF_ORIGINS` has an endpoint that refuses every request,
 * which is the correct behaviour for a feature nobody has configured.
 */

/*
 * The path, the lifetime and every validation rule come from
 * `@rescript/access` so that this file and the receiving app cannot drift.
 * `AUTH_HANDOFF_ORIGINS` is the one thing that is local: which applications
 * this particular installation is willing to hand a session to. Unset means
 * none, which is the right answer for a feature nobody has configured.
 */
function noStore(res: NextResponse): NextResponse {
  res.headers.set("cache-control", "no-store");
  /* the code is in the URL for one hop; do not let it leave in a Referer */
  res.headers.set("referrer-policy", "no-referrer");
  return res;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const origin = normaliseOrigin(url.searchParams.get("origin"));
  const next = safeNextPath(url.searchParams.get("next"));
  const allowed = parseAllowedOrigins(process.env.AUTH_HANDOFF_ORIGINS);

  /*
   * A browser that tells us what this request is for must say "a page I am
   * navigating to". Older browsers send nothing and are not punished for it —
   * the allowlist is the real control, and this only closes the narrower case
   * of a code being minted by a subresource load the visitor never saw.
   */
  const dest = req.headers.get("sec-fetch-dest");
  if (dest && dest !== "document") {
    return noStore(NextResponse.json(
      { error: "This link must be opened as a page." }, { status: 400 }));
  }

  if (!origin) {
    return noStore(NextResponse.json(
      { error: "Missing or unreadable origin." }, { status: 400 }));
  }
  if (!originAllowed(origin, allowed)) {
    /*
     * Deliberately says which origin was refused and not which are allowed:
     * enough for whoever is configuring it to see the mismatch, nothing for
     * somebody probing for the list.
     */
    return noStore(NextResponse.json(
      { error: `This application is not permitted to receive a session: ${origin}` },
      { status: 403 }));
  }

  const user = await requireUser(req);
  if (isFailure(user)) {
    /*
     * Not signed in. Send them to the form and come straight back here
     * afterwards — `LoginForm` already accepts `next` and already refuses
     * anything that is not a same-origin path, which this is.
     *
     * A 503 (we could not check) must NOT become a login redirect: that turns
     * a database hiccup into an apparent sign-out, which is the loop
     * `failAndSignOut` exists to prevent. Only a 401 goes to the form.
     */
    if (user.response.status !== 401) return noStore(user.response);
    const back = `${HANDOFF_START_PATH}?origin=${encodeURIComponent(origin)}&next=${encodeURIComponent(next)}`;
    return noStore(NextResponse.redirect(
      new URL(`/login?next=${encodeURIComponent(back)}`, url.origin), 303));
  }

  /*
   * 32 bytes from the CSPRNG, and only its hash is written down. The value
   * below is the only time it exists in plaintext anywhere we control.
   */
  const code = randomBytes(32).toString("base64url");
  const codeHash = createHash("sha256").update(code).digest("hex");

  const { error } = await supabaseService().rpc("rescript_auth_issue_handoff", {
    p_code_hash: codeHash,
    p_session: user.sessionId,
    p_user: user.userId,
    p_origin: origin,
    p_ttl_seconds: HANDOFF_TTL_SECONDS,
    p_ip_hash: ipHashOf(req),
  });
  if (error) {
    return noStore(NextResponse.json(
      { error: "We could not complete the sign-in. Please try again." }, { status: 503 }));
  }

  const target = handoffCallbackUrl(origin, code, next);
  if (!target) {
    return noStore(NextResponse.json(
      { error: "We could not complete the sign-in. Please try again." }, { status: 503 }));
  }
  return noStore(NextResponse.redirect(target, 303));
}
