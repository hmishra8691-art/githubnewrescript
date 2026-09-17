import { cookies } from "next/headers";
import Link from "next/link";
import { SESSION_COOKIE_NAME, projectPageGate } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/admin";
import { ProjectWorkbench } from "@/components/ProjectWorkbench";
import { INTERVIEW_SAY, analysisReadiness, type InterviewStatus } from "@rescript/interviews";
import { readSelection } from "@/lib/candidate";

export const dynamic = "force-dynamic";

/**
 * One hiring project: its questions, and the people invited to answer them.
 *
 * The gate runs BEFORE any read — the pattern the survey product's
 * `projectPageGate` was introduced to enforce after server pages were found
 * reading with the service role and deciding afterwards.
 */
export default async function ProjectPage({ params }: { params: { id: string } }) {
  const gate = await projectPageGate(
    cookies().get(SESSION_COOKIE_NAME)?.value ?? null, params.id, "project.read",
  );
  if (!gate.ok) {
    return (
      <main className="wrap">
        <div className="card">
          <h1>{gate.kind === "signed_out" ? "Please sign in" : gate.message}</h1>
          <p><Link href="/">Back to your projects</Link></p>
        </div>
      </main>
    );
  }

  const db = supabaseAdmin();
  const [{ data: project }, { data: pools }, { data: questions }, { data: requirements }, { data: interviews }] = await Promise.all([
    db.from("interview_projects")
      .select("id, code, name, description, status, instructions, consent_text, retention_days, selection")
      .eq("id", params.id).maybeSingle(),
    db.from("interview_pools")
      .select("id, code, name, description, draw, position")
      .eq("project_id", params.id).order("position"),
    db.from("interview_questions")
      .select("id, code, prompt, guidance, kind, required, min_seconds, max_seconds, max_retries, think_seconds, position, category, options, visible_if, skip_logic, prompt_media_id, pool_id")
      .eq("project_id", params.id).is("archived_at", null).order("position"),
    db.from("interview_requirements")
      .select("id, code, title, description, criteria, weight, position")
      .eq("project_id", params.id).order("position"),
    db.from("interviews")
      .select("id, candidate_name, candidate_email, status, token_prefix, created_at, completed_at, expires_at, is_test")
      .eq("project_id", params.id).is("deleted_at", null)
      .order("created_at", { ascending: false }).limit(200),
  ]);

  return (
    <main className="wrap wide">
      <p className="tiny muted"><Link href="/">← All projects</Link></p>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>{gate.ctx.project.name}</h1>
        <span className="pill">{gate.ctx.role}</span>
      </div>

      <ProjectWorkbench
        project={(project ?? {
          id: params.id, code: "", name: gate.ctx.project.name, description: null,
          status: "draft", instructions: null, consent_text: null, retention_days: null,
        }) as never}
        role={gate.ctx.role}
        questions={(questions ?? []) as never}
        requirements={(requirements ?? []) as never}
        readiness={analysisReadiness({
          requirements: requirements ?? [],
          questions: questions ?? [],
        })}
        pools={(pools ?? []).map((p) => ({
          ...p, description: (p.description as string) ?? "",
          randomize: readSelection(project?.selection).pools.find((x) => x.id === p.id)?.randomize ?? false,
        })) as never}
        randomizePools={readSelection(project?.selection).randomizePools}
      />

      <div className="card">
        <h2>Candidates</h2>
        {(interviews ?? []).length === 0 ? (
          <p className="muted small">Nobody has been invited yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Candidate</th><th>Status</th><th>Link</th><th>Invited</th></tr>
            </thead>
            <tbody>
              {(interviews ?? []).map((i) => (
                <tr key={i.id}>
                  <td>
                    {/* the row is the way in: recordings, transcript, analysis */}
                    <Link href={`/interviews/${i.id}`}>
                      {i.candidate_name ?? <span className="muted">unnamed</span>}
                    </Link>
                    {i.is_test && <span className="pill" style={{ marginLeft: 8 }}>test</span>}
                  </td>
                  <td><span className="pill">{INTERVIEW_SAY[i.status as InterviewStatus] ?? i.status}</span></td>
                  {/* the prefix identifies a link in conversation and cannot be used as one */}
                  <td className="muted"><code>{i.token_prefix}…</code></td>
                  <td className="muted tiny">{new Date(i.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
