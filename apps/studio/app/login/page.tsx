import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionAuthorizes, type SessionRecord } from "@rescript/access";
import { loadPolicies, SESSION_COOKIE_NAME, supabaseService } from "@/lib/authServer";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

/**
 * THE "ARE YOU ALREADY SIGNED IN?" CHECK, MOVED SOMEWHERE IT CAN BE ANSWERED.
 *
 * This used to be two lines in `middleware.ts`: if there is a session cookie
 * and you are asking for `/login`, go to `/` instead. It read as an obvious
 * convenience and it was the second half of P0-3 and the whole of P0-4,
 * because the middleware could only see that a cookie EXISTED. Somebody whose
 * session had expired still had the cookie, so the login screen they were
 * being sent to by the expiry handler bounced them straight back to a page
 * that would expire them again — and typing `/login` by hand did the same
 * thing. There was no way in.
 *
 * Here the same question can actually be answered, because a server component
 * can read the database. A live session goes home; a dead one falls through to
 * the form, which is what the person needs. The cookie itself is cleared by
 * whichever API call next discovers the session is dead (`failAndSignOut`), so
 * this page does not need to write a response — and deliberately does not try,
 * since a server component cannot set cookies during render.
 *
 * If the lookup fails for any reason, the form is shown. The worst case of
 * showing a sign-in form to somebody already signed in is a redundant screen.
 * The worst case of the opposite is the loop this replaced.
 */
export default async function LoginPage() {
  const sessionId = cookies().get(SESSION_COOKIE_NAME)?.value;

  if (sessionId && sessionId.length >= 32) {
    try {
      const db = supabaseService();
      const { data: row } = await db
        .from("user_sessions")
        .select("id, user_id, status, created_at, last_seen_at, expires_at, device_label")
        .eq("id", sessionId)
        .maybeSingle();

      if (row) {
        const { data: profile } = await db
          .from("profiles").select("customer_id, status").eq("id", row.user_id).maybeSingle();
        if (profile?.status === "active") {
          const policies = await loadPolicies(profile.customer_id ?? null);
          const record: SessionRecord = {
            sessionId: row.id,
            userId: row.user_id,
            status: row.status as SessionRecord["status"],
            createdAt: row.created_at,
            lastSeenAt: row.last_seen_at,
            expiresAt: row.expires_at,
            deviceLabel: row.device_label,
          };
          // the SAME predicate the API gate uses. Two different notions of
          // "still signed in" between the page and the gate is how you get a
          // page that redirects to a dashboard that redirects back.
          if (sessionAuthorizes(record, policies.session)) redirect("/");
        }
      }
    } catch (e) {
      /*
       * `redirect()` throws by design — Next uses the throw to unwind — so it
       * must be re-thrown rather than swallowed by this catch.
       */
      if (e && typeof e === "object" && "digest" in e && String((e as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT")) {
        throw e;
      }
      /* anything else: show the form */
    }
  }

  return <LoginForm />;
}
