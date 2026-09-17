import { cookies } from "next/headers";
import Link from "next/link";
import { SESSION_COOKIE_NAME, userForSession, isFailure, signInUrl, studioUrl } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/admin";
import { NewProject } from "@/components/NewProject";

export const dynamic = "force-dynamic";

/**
 * The company's list of hiring projects.
 *
 * Signed out, it says so and points at the Studio's login rather than growing
 * a second sign-in form — one authentication system, and this app is not it.
 */
/**
 * What to say when a sign-in attempt came back without a session.
 *
 * Each of these is a different thing to do next, which is why they are
 * different messages: an expired code is "press it again", an unavailable
 * database is "wait a moment", and a misconfiguration is not the visitor's
 * problem at all and must not pretend to be.
 */
const SIGNIN_NOTICE: Record<string, string> = {
  expired: "That sign-in link had already been used or had expired. Please try again.",
  failed: "That sign-in link was incomplete. Please try again.",
  unavailable: "We could not reach the sign-in service just then. Please try again in a moment.",
  misconfigured:
    "This deployment is missing its public address, so sign-in cannot complete. " +
    "Set INTERVIEWS_PUBLIC_URL and redeploy.",
};

export default async function Home({
  searchParams,
}: {
  searchParams?: { signin?: string };
}) {
  const user = await userForSession(cookies().get(SESSION_COOKIE_NAME)?.value ?? null);
  if (isFailure(user)) {
    const notice = SIGNIN_NOTICE[searchParams?.signin ?? ""] ?? null;
    /*
     * The link goes to the Studio's HANDOFF, not its login form. Sending
     * somebody to `/login` signed them in on the Studio's origin and returned
     * them here still signed out, because `rescript_session` is host-only and
     * `vercel.app` is on the Public Suffix List — no cookie can span the two.
     * The handoff signs them in there if they are not already, then hands this
     * origin a single-use code for the session they already have.
     */
    const href = signInUrl("/");
    return (
      <main className="wrap">
        <div className="card">
          <h1>Rescript Interviews</h1>
          {notice ? <p className="note warn">{notice}</p> : null}
          <p>Please sign in to your Rescript account to continue.</p>
          {href ? (
            <p><a className="btn" href={href}>Sign in</a></p>
          ) : (
            <p className="muted small">
              Sign-in is unavailable until <code>INTERVIEWS_PUBLIC_URL</code> is set on this
              deployment.
            </p>
          )}
          <p className="muted small">
            Interviews uses the same account as Rescript Studio. Signing in there signs you in here.
          </p>
        </div>
      </main>
    );
  }

  const { data: projects } = await supabaseAdmin()
    .from("interview_projects")
    .select("id, code, name, description, status, created_at, retention_days")
    .eq("customer_id", user.customerId ?? "")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(100);

  return (
    <main className="wrap wide">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Interviews</h1>
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <Link className="btn secondary small" href="/practice" data-testid="open-practice">Practice interviews</Link>
          {/* the way back. A plain link: the session cookie is already on that origin. */}
          <a className="btn secondary small" href={studioUrl()} data-testid="back-to-studio">
            Rescript Studio
          </a>
          <span className="muted small">{user.email}</span>
        </div>
      </div>

      <NewProject />

      {(projects ?? []).length === 0 ? (
        <div className="card">
          <h2>No projects yet</h2>
          <p className="muted">
            A project holds the questions you ask, the requirements you assess against, and
            everyone you invite.
          </p>
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr><th>Project</th><th>Code</th><th>Status</th><th>Retention</th></tr>
            </thead>
            <tbody>
              {(projects ?? []).map((p) => (
                <tr key={p.id}>
                  <td><Link href={`/projects/${p.id}`}>{p.name}</Link></td>
                  <td><code>{p.code}</code></td>
                  <td><span className="pill">{p.status}</span></td>
                  <td className="muted">{p.retention_days ? `${p.retention_days} days` : "kept"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
