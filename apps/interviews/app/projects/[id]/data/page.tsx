import { cookies } from "next/headers";
import Link from "next/link";
import { SESSION_COOKIE_NAME, projectPageGate } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/admin";
import { readScorecard } from "@rescript/interviews";

export const dynamic = "force-dynamic";

const MAX_INTERVIEWS = 200;

/**
 * THE DATA VIEW — every row the project holds, joined by id.
 *
 * A recruiter's page shows people; this one shows records. One line per
 * interview × response, and beside it the media, transcript, analysis and
 * telemetry rows that hang off that response, each by its own id, so a
 * manager can answer "where is the recording for question 3 of interview
 * 7f2a…?" without a database console. It is the page the retention sweep is
 * checked against: after the window passes, the media column should say
 * `purged`, the identity columns should be empty, and the deletions table at
 * the bottom should list what went and whether the object was confirmed gone.
 *
 * ## Who
 *
 * Managers only — gated on `retention.manage`, the capability nobody but a
 * manager holds. Identity here is the respondent id and the name, never the
 * email: a `viewer` could once read participant emails through a different
 * page, and this one does not repeat that. Transcript TEXT is not on this page
 * at all (open the interview for that, under its own gate); only the status.
 *
 * ## Why the service role is safe here
 *
 * The gate runs first and every query is pinned to `params.id`; nothing here
 * takes a second id from the URL or the query string.
 */
export default async function DataViewPage({ params }: { params: { id: string } }) {
  const gate = await projectPageGate(
    cookies().get(SESSION_COOKIE_NAME)?.value ?? null, params.id, "retention.manage",
  );
  if (!gate.ok || gate.ctx.role !== "manager") {
    return (
      <main className="wrap">
        <div className="card">
          <h1>{!gate.ok && gate.kind === "signed_out" ? "Please sign in" : "Only a project manager can open the data view."}</h1>
          <p><Link href={`/projects/${params.id}`}>Back to the project</Link></p>
        </div>
      </main>
    );
  }

  const db = supabaseAdmin();
  const { data: interviews } = await db.from("interviews")
    .select("id, status, candidate_name, token_prefix, is_test, created_at, started_at, completed_at, last_seen_at, media_purged_at, deleted_at")
    .eq("project_id", params.id)
    .order("created_at", { ascending: false })
    .limit(MAX_INTERVIEWS);
  const ids = (interviews ?? []).map((i) => i.id as string);

  const empty = { data: [] as Record<string, unknown>[] };
  const [
    { data: questions }, { data: responses }, { data: media }, { data: transcripts },
    { data: analyses }, { data: telemetry }, { data: deletions }, { data: people },
  ] = await Promise.all([
    db.from("interview_questions").select("id, code, kind, position, archived_at").eq("project_id", params.id).order("position"),
    ids.length ? db.from("interview_responses")
      .select("id, interview_id, question_id, position, status, answer_text, answer_value, answer_kind, duration_seconds, retries, prompt_watched_at, started_at, recorded_at, stored_at, error")
      .in("interview_id", ids).order("position") : empty,
    ids.length ? db.from("interview_media")
      .select("id, interview_id, response_id, question_id, kind, file_size, duration_seconds, upload_status, processing_status, deleted_at")
      .in("interview_id", ids) : empty,
    ids.length ? db.from("interview_transcripts")
      .select("id, interview_id, response_id, status, attempts, updated_at")
      .in("interview_id", ids) : empty,
    ids.length ? db.from("interview_analysis")
      .select("id, interview_id, status, score, updated_at")
      .in("interview_id", ids) : empty,
    ids.length ? db.from("interview_telemetry")
      .select("interview_id, response_id")
      .in("interview_id", ids) : empty,
    db.from("interview_deletions")
      .select("id, interview_id, media_id, storage_key, what, reason, bytes, verified, deleted_at")
      .eq("project_id", params.id).order("deleted_at", { ascending: false }).limit(500),
    /* the respondent's roster row: one derived person per sitting */
    ids.length ? db.from("interview_people")
      .select("id, interview_id, archived_at")
      .in("interview_id", ids).eq("derived", true) : empty,
  ]);
  const personByInterview = new Map((people ?? []).map((p) => [p.interview_id as string, p]));

  const questionById = new Map((questions ?? []).map((q) => [q.id as string, q]));
  const responsesByInterview = groupBy(responses ?? [], (r) => r.interview_id as string);
  const mediaByResponse = groupBy((media ?? []).filter((m) => m.response_id), (m) => m.response_id as string);
  const promptMediaByInterview = groupBy((media ?? []).filter((m) => !m.response_id), (m) => m.interview_id as string);
  const transcriptByResponse = new Map((transcripts ?? []).map((t) => [t.response_id as string, t]));
  const analysisByInterview = new Map((analyses ?? []).map((a) => [a.interview_id as string, a]));
  const telemetryByInterview = countBy(telemetry ?? [], (t) => t.interview_id as string);
  const telemetryByResponse = countBy((telemetry ?? []).filter((t) => t.response_id), (t) => t.response_id as string);

  const totals = {
    interviews: ids.length,
    responses: (responses ?? []).length,
    media: (media ?? []).filter((m) => !m.deleted_at).length,
    mediaGone: (media ?? []).filter((m) => m.deleted_at).length,
    transcripts: (transcripts ?? []).length,
    telemetry: (telemetry ?? []).length,
    deletions: (deletions ?? []).length,
    deletionsUnverified: (deletions ?? []).filter((d) => d.verified === false).length,
  };

  return (
    <main className="wrap wide" data-testid="data-view">
      <p className="tiny muted"><Link href={`/projects/${params.id}`}>← {gate.ctx.project.name}</Link></p>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12, alignItems: "baseline" }}>
        <h1 style={{ margin: 0 }}>Data view</h1>
        <span className="tiny muted">
          {totals.interviews} interview{totals.interviews === 1 ? "" : "s"}
          {totals.interviews === MAX_INTERVIEWS ? ` (newest ${MAX_INTERVIEWS})` : ""} · {totals.responses} responses ·{" "}
          {totals.media} media object{totals.media === 1 ? "" : "s"} ({totals.mediaGone} purged) · {totals.transcripts} transcripts ·{" "}
          {totals.telemetry} telemetry events
        </span>
      </div>
      <p className="note" style={{ marginTop: 0 }}>
        Records, not people: every cell is an id or a status. Transcript text and recordings open from the interview page
        under their own permissions. Identity columns empty out when retention has run.
      </p>

      {(interviews ?? []).length === 0 && <div className="card"><p className="muted">No interviews yet.</p></div>}

      {(interviews ?? []).map((iv) => {
        const rows = responsesByInterview.get(iv.id as string) ?? [];
        const analysis = analysisByInterview.get(iv.id as string);
        const card = analysis?.status === "complete" ? readScorecard(analysis.score) : null;
        const prompts = promptMediaByInterview.get(iv.id as string) ?? [];
        return (
          <section key={iv.id as string} className="card" data-testid="data-interview" data-interview-id={iv.id as string}>
            <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
              <strong><code>{iv.id as string}</code></strong>
              <span className="pill">{iv.status as string}</span>
              {iv.is_test ? <span className="pill">test</span> : null}
              {iv.deleted_at ? <span className="pill warn">deleted</span> : null}
              {iv.media_purged_at ? <span className="pill">media purged</span> : null}
            </div>
            <dl className="kv" style={{ marginTop: 8 }}>
              <dt>Respondent id</dt>
              <dd>
                {personByInterview.get(iv.id as string)
                  ? <><code>{personByInterview.get(iv.id as string)!.id as string}</code>{personByInterview.get(iv.id as string)!.archived_at ? <span className="tiny muted"> · archived</span> : ""}</>
                  : <span className="muted">—</span>}
              </dd>
              <dt>Name</dt><dd>{(iv.candidate_name as string | null) ?? <span className="muted">—</span>}</dd>
              <dt>Token prefix</dt><dd><code>{iv.token_prefix as string}</code></dd>
              <dt>Created</dt><dd>{when(iv.created_at)}</dd>
              <dt>Started</dt><dd>{when(iv.started_at)}</dd>
              <dt>Completed</dt><dd>{when(iv.completed_at)}</dd>
              <dt>Last seen</dt><dd>{when(iv.last_seen_at)}</dd>
              <dt>Analysis</dt>
              <dd>
                {analysis ? <><code>{analysis.id as string}</code> · {analysis.status as string}</> : <span className="muted">none</span>}
                {card && <> · score {card.overall === null ? "—" : card.overall} · {card.coverage.met}/{card.requirements.length} evidenced</>}
              </dd>
              <dt>Telemetry</dt><dd>{telemetryByInterview.get(iv.id as string) ?? 0} events</dd>
              {prompts.length > 0 && (
                <><dt>Other media</dt><dd>{prompts.map((m) => <span key={m.id as string}><code>{m.id as string}</code> ({m.kind as string}) </span>)}</dd></>
              )}
            </dl>

            {rows.length > 0 && (
              <div style={{ overflowX: "auto", marginTop: 10 }}>
                <table className="table small" data-testid="data-responses">
                  <thead>
                    <tr>
                      <th>#</th><th>Response id</th><th>Question</th><th>Status</th><th>Answer</th>
                      <th>Media</th><th>Transcript</th><th>Events</th><th>Watched</th><th>Recorded</th><th>Stored</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const q = questionById.get(r.question_id as string);
                      const ms = mediaByResponse.get(r.id as string) ?? [];
                      const t = transcriptByResponse.get(r.id as string);
                      return (
                        <tr key={r.id as string} data-testid="data-response" data-response-id={r.id as string}>
                          <td>{r.position as number}</td>
                          <td><code>{short(r.id as string)}</code></td>
                          <td>
                            <code>{q?.code ?? short(r.question_id as string)}</code>
                            {q && <span className="tiny muted"> {q.kind as string}{q.archived_at ? " (archived)" : ""}</span>}
                          </td>
                          <td>
                            {r.status as string}
                            {r.error ? <span className="tiny warn"> · {String(r.error).slice(0, 60)}</span> : null}
                            {(r.retries as number) > 0 && <span className="tiny muted"> · {r.retries as number} retr{(r.retries as number) === 1 ? "y" : "ies"}</span>}
                          </td>
                          <td>{answerCell(r)}</td>
                          <td>
                            {ms.length === 0 ? <span className="muted">—</span> : ms.map((m) => (
                              <div key={m.id as string} className="tiny">
                                <code>{short(m.id as string)}</code> {m.kind as string} · {m.upload_status as string}
                                {m.processing_status ? `/${m.processing_status as string}` : ""}
                                {m.file_size ? ` · ${mb(m.file_size as number)}` : ""}
                                {m.duration_seconds ? ` · ${m.duration_seconds as number}s` : ""}
                                {m.deleted_at ? <span className="warn"> · purged {when(m.deleted_at)}</span> : ""}
                              </div>
                            ))}
                          </td>
                          <td>
                            {t ? <><code>{short(t.id as string)}</code> {t.status as string}{(t.attempts as number) > 1 ? ` (${t.attempts as number})` : ""}</> : <span className="muted">—</span>}
                          </td>
                          <td>{telemetryByResponse.get(r.id as string) ?? 0}</td>
                          <td>{when(r.prompt_watched_at)}</td>
                          <td>{when(r.recorded_at)}</td>
                          <td>{when(r.stored_at)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}

      <section className="card" data-testid="data-deletions">
        <h2 style={{ marginTop: 0 }}>Deletions</h2>
        <p className="tiny muted">
          What the retention and orphan sweeps removed from storage and the database, newest first. &ldquo;Verified&rdquo;
          means the object was checked absent after the delete; an unverified row is retried on the next sweep.
          {totals.deletionsUnverified > 0 && <strong className="warn"> {totals.deletionsUnverified} unverified.</strong>}
        </p>
        {(deletions ?? []).length === 0 ? <p className="muted small">Nothing has been deleted yet.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table className="table small">
              <thead><tr><th>When</th><th>Interview</th><th>Media</th><th>What</th><th>Reason</th><th>Bytes</th><th>Verified</th></tr></thead>
              <tbody>
                {(deletions ?? []).map((d) => (
                  <tr key={d.id as string}>
                    <td>{when(d.deleted_at)}</td>
                    <td><code>{d.interview_id ? short(d.interview_id as string) : "—"}</code></td>
                    <td><code>{d.media_id ? short(d.media_id as string) : "—"}</code></td>
                    <td>{d.what as string}</td>
                    <td>{d.reason as string}</td>
                    <td>{d.bytes ? mb(d.bytes as number) : "—"}</td>
                    <td>{d.verified === true ? "yes" : d.verified === false ? <span className="warn">no</span> : "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

/* ------------------------------------------------------------------ helpers */

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row); else out.set(k, [row]);
  }
  return out;
}

function countBy<T>(rows: T[], key: (row: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) out.set(key(row), (out.get(key(row)) ?? 0) + 1);
  return out;
}

function when(v: unknown): string {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().replace("T", " ").slice(0, 19);
}

function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function mb(bytes: number): string {
  return bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** The typed/chosen answer, trimmed — the recording itself is in the media column. */
function answerCell(r: Record<string, unknown>) {
  if (r.answer_value !== null && r.answer_value !== undefined) {
    const s = JSON.stringify(r.answer_value);
    return <span className="tiny"><code>{s.length > 80 ? `${s.slice(0, 80)}…` : s}</code></span>;
  }
  if (r.answer_text) {
    const s = String(r.answer_text);
    return <span className="tiny">{s.length > 80 ? `${s.slice(0, 80)}…` : s}</span>;
  }
  if (r.duration_seconds) return <span className="tiny muted">{r.answer_kind ? `${r.answer_kind as string} · ` : ""}{r.duration_seconds as number}s recording</span>;
  return <span className="muted">—</span>;
}
