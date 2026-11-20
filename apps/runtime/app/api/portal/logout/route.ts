import { NextRequest } from "next/server";
import { json, portalRoute, signedIn, withSessionCookie } from "@/lib/portal/http";
import { signOut } from "@/lib/portal/service";

export const dynamic = "force-dynamic";

/** POST — end this session. Always clears the cookie, signed in or not. */
export async function POST(req: NextRequest) {
  return portalRoute(req, { mutate: true }, async (deps) => {
    try { await signOut(deps, await signedIn(req, deps)); } catch { /* already signed out */ }
    return withSessionCookie(json({ ok: true }), null);
  });
}
