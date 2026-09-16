import { cookies } from "next/headers";
import Link from "next/link";
import { SESSION_COOKIE_NAME, projectPageGate, signInUrl } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/admin";
import { SessionRecorder, type RecorderPerson } from "@/components/SessionRecorder";

export const dynamic = "force-dynamic";

/**
 * RECORDING A MODERATED INTERVIEW.
 *
 * The researcher's side. The candidate's self-service page at `/i/[token]` is
 * unauthenticated and driven by a link; this one is inside the product, gated
 * by a project role, and the person on the screen is the one asking the
 * questions.
 *
 * Everything the recorder needs is fetched here and handed down, so the client
 * component starts with the roster already in hand: a participant picker that
 * appears empty for a second and then fills in is a picker somebody starts
 * recording without.
 */
export default async function RecordPage({
  params, searchParams,
}: {
  params: { id: string };
  searchParams?: { question?: string };
}) {
  const db = supabaseAdmin();

  const { data: interview } = await db
    .from("interviews")
    .select("id, project_id, customer_id, candidate_name, status, deleted_at")
    .eq("id", params.id)
    .maybeSingle();

  if (!interview || interview.deleted_at) {
    return (
      <main className="wrap">
        <div className="card"><h1>Not found</h1><p>That interview does not exist.</p></div>
      </main>
    );
  }

  /*
   * `candidates.invite` rather than `project.read`: recording somebody is the
   * same weight of act as inviting them, and a `viewer` who may follow a
   * project's progress has no business starting a camera on its behalf.
   */
  const gate = await projectPageGate(
    cookies().get(SESSION_COOKIE_NAME)?.value ?? null, interview.project_id, "candidates.invite",
  );
  if (!gate.ok) {
    const href = signInUrl(`/interviews/${params.id}/record`);
    return (
      <main className="wrap">
        <div className="card">
          <h1>Rescript Interviews</h1>
          <p>{gate.message}</p>
          {gate.kind === "signed_out" && href && <p><a className="btn" href={href}>Sign in</a></p>}
        </div>
      </main>
    );
  }

  const [{ data: questions }, { data: people }] = await Promise.all([
    db.from("interview_questions")
      .select("id, code, prompt, position")
      .eq("project_id", interview.project_id)
      .is("archived_at", null)
      .order("position", { ascending: true }),
    db.from("interview_people")
      .select("id, display_name, email, user_id, kind, derived, interview_id")
      .eq("project_id", interview.project_id)
      .is("archived_at", null),
  ]);

  /*
   * Project staff, plus THIS interview's respondent. Offering every other
   * sitting's respondent would put forty strangers' names in a picker — the
   * same leak between interviews that §18 names between projects.
   */
  const roster: RecorderPerson[] = ((people ?? []) as {
    id: string; display_name: string; email: string | null; user_id: string | null;
    kind: string; derived: boolean; interview_id: string | null;
  }[])
    .filter((p) => !p.interview_id || p.interview_id === interview.id)
    .map((p) => ({
      id: p.id, displayName: p.display_name, email: p.email,
      userId: p.user_id, kind: p.kind, derived: p.derived,
    }));

  const qs = (questions ?? []) as { id: string; code: string; prompt: string }[];
  const chosen = qs.find((q) => q.id === searchParams?.question) ?? qs[0] ?? null;

  return (
    <main className="wrap wide">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>{interview.candidate_name ?? "Interview"}</h1>
          <p className="muted small" style={{ margin: 0 }}>Moderated recording</p>
        </div>
        <Link className="btn secondary" href={`/projects/${interview.project_id}`}>Back to project</Link>
      </div>

      {qs.length > 1 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginTop: 0 }}>Question</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {qs.map((q) => (
              <Link
                key={q.id}
                className={`btn ${q.id === chosen?.id ? "" : "secondary"}`}
                href={`/interviews/${params.id}/record?question=${q.id}`}
              >
                {q.code}
              </Link>
            ))}
          </div>
        </div>
      )}

      <SessionRecorder
        interviewId={interview.id}
        projectId={interview.project_id}
        questionId={chosen?.id ?? null}
        questionText={chosen?.prompt ?? ""}
        people={roster}
        me={{ userId: gate.ctx.user.userId, displayName: gate.ctx.user.fullName || gate.ctx.user.email }}
      />
    </main>
  );
}
