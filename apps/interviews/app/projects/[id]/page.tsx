import { cookies } from "next/headers";
import Link from "next/link";
import { SESSION_COOKIE_NAME, projectPageGate } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/admin";
import { ProjectWorkbench } from "@/components/ProjectWorkbench";
import { INTERVIEW_SAY, analysisReadiness, readScorecard, type InterviewStatus } from "@rescript/interviews";
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
      .select("id, code, prompt, guidance, kind, required, min_seconds, max_seconds, max_retries, think_seconds, position, category, options, visible_if, skip_logic, prompt_media_id, pool_id, settings")
      .eq("project_id", params.id).is("archived_at", null).order("position"),
    db.from("interview_requirements")
      .select("id, code, title, description, criteria, weight, category, position")
      .eq("project_id", params.id).order("position"),
    db.from("interviews")
      .select("id, candidate_name, status, token_prefix, created_at, completed_at, expires_at, is_test")
      .eq("project_id", params.id).is("deleted_at", null)
      .order("created_at", { ascending: false }).limit(200),
  ]);

  /*
   * THE RECRUITER'S OVERVIEW — the columns that answer "who is worth opening".
   * The scorecard snapshot is small and already computed, so one query gives
   * the whole table its numbers; nothing is recomputed per row. `candidate_email`
   * is deliberately no longer selected: it was serialised into the page for
   * every workspace member and rendered nowhere.
   */
  const { data: analyses } = (interviews ?? []).length
    ? await db.from("interview_analysis")
        .select("interview_id, status, score")
        .in("interview_id", (interviews ?? []).map((i) => i.id))
    : { data: [] as { interview_id: string; status: string; score: unknown }[] };
  const analysisByInterview = new Map((analyses ?? []).map((a) => [a.interview_id as string, a]));

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

      <div className="card" data-testid="candidates">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <h2 style={{ margin: 0 }}>Candidates</h2>
          {gate.ctx.role === "manager" && (
            <Link className="btn small secondary" href={`/projects/${params.id}/data`} data-testid="open-data">Data view</Link>
          )}
        </div>
        {(interviews ?? []).length === 0 ? (
          <p className="muted small">Nobody has been invited yet.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Candidate</th><th>Status</th><th>Evidence score</th><th>Coverage</th><th>Link</th><th>Invited</th></tr>
            </thead>
            <tbody>
              {(interviews ?? []).map((i) => {
                const a = analysisByInterview.get(i.id);
                const card = a?.status === "complete" ? readScorecard(a.score) : null;
                return (
                  <tr key={i.id} data-testid="candidate-row">
                    <td>
                      {/* the row is the way in: recordings, transcript, analysis */}
                      <Link href={`/interviews/${i.id}`}>
                        {i.candidate_name ?? <span className="muted">unnamed</span>}
                      </Link>
                      {i.is_test && <span className="pill" style={{ marginLeft: 8 }}>test</span>}
                    </td>
                    <td><span className="pill">{INTERVIEW_SAY[i.status as InterviewStatus] ?? i.status}</span></td>
                    {/*
                      * The number and its meaning in the same cell. A column
                      * headed "Score" invites sorting people by it; "Evidence
                      * score" with the coverage beside it says what it counts.
                      */}
                    <td data-testid="candidate-score">
                      {card ? (card.overall === null ? <span className="muted">—</span> : <strong>{card.overall}</strong>)
                        : a?.status === "complete" ? <span className="muted">—</span>
                        : <span className="muted tiny">{i.status === "processed" || i.status === "processing" ? "analysing…" : "not analysed"}</span>}
                    </td>
                    <td className="muted tiny">
                      {card ? `${card.coverage.met} of ${card.coverage.total} with evidence${card.coverage.partial ? `, ${card.coverage.partial} partly` : ""}` : ""}
                    </td>
                    {/* the prefix identifies a link in conversation and cannot be used as one */}
                    <td className="muted"><code>{i.token_prefix}…</code></td>
                    <td className="muted tiny">{new Date(i.created_at).toLocaleDateString()}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}
