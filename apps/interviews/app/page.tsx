import { cookies } from "next/headers";
import Link from "next/link";
import { SESSION_COOKIE_NAME, userForSession, isFailure } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/admin";
import { NewProject } from "@/components/NewProject";

export const dynamic = "force-dynamic";

/**
 * The company's list of hiring projects.
 *
 * Signed out, it says so and points at the Studio's login rather than growing
 * a second sign-in form — one authentication system, and this app is not it.
 */
export default async function Home() {
  const user = await userForSession(cookies().get(SESSION_COOKIE_NAME)?.value ?? null);
  if (isFailure(user)) {
    const studio = process.env.NEXT_PUBLIC_STUDIO_URL ?? "https://rescriptstudio.vercel.app";
    return (
      <main className="wrap">
        <div className="card">
          <h1>Rescript Interviews</h1>
          <p>Please sign in to your Rescript account to continue.</p>
          <p><a className="btn" href={`${studio}/login`}>Sign in</a></p>
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
        <span className="muted small">{user.email}</span>
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
