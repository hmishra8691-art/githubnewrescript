import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { adminPageGate } from "@/lib/guard";
import { SESSION_COOKIE_NAME } from "@/lib/authServer";
import PlatformClient from "./PlatformClient";

export const dynamic = "force-dynamic";

/**
 * /platform — PLATFORM ADMINISTRATORS ONLY (2026-11-10).
 *
 * Authorized here, on the server, on every request — not by hiding a link. A signed-out visitor is sent to the login
 * (and back here afterwards); a signed-in user without the platform_admin role gets Access denied, and none of the
 * tool's code or data is rendered for them. The middleware also bounces a request with no session cookie, and
 * `/api/platform` refuses non-administrators on its own, so a saved link, a typed URL or a direct API call cannot get
 * round any one of the three.
 */
export default async function PlatformPage() {
  const gate = await adminPageGate(cookies().get(SESSION_COOKIE_NAME)?.value ?? null);
  if (!gate.ok) {
    if (gate.kind === "signed_out") redirect(`/login?next=${encodeURIComponent("/platform")}`);
    return (
      <div className="dash" data-testid="platform-denied">
        <h1>{gate.kind === "forbidden" ? "Access denied" : "Cannot check your access"}</h1>
        <div className="card" style={{ borderColor: "var(--red)", color: "var(--red)" }}>{gate.message}</div>
        <p className="muted">If you need this page, ask a platform administrator.</p>
        <a className="btn" href="/">← back to your projects</a>
      </div>
    );
  }
  return <PlatformClient />;
}
