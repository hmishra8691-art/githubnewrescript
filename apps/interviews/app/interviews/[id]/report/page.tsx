import { cookies } from "next/headers";
import Link from "next/link";
import {
  ANALYSIS_CAVEAT, CATEGORY_SAY, SCORE_CAVEAT, describeOverall, readScorecard, VERDICT_SAY,
  type RequirementCategory, type Scorecard as ScorecardData, type Verdict,
} from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { SESSION_COOKIE_NAME, can, projectPageGate, signInUrl } from "@/lib/auth";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";

/**
 * THE REPORT — A DOCUMENT WITH PAGES, MADE BY THE BROWSER.
 *
 * Nothing in this repository generates a PDF and the decision was not to add
 * a renderer: the established route here is paginated HTML plus print CSS,
 * which is how survey reports already become PDFs. So this page IS the PDF.
 * `@media print` hides the chrome, forces page breaks between sections, keeps
 * a quote with its heading, and repeats the header. Pressing Download opens the
 * print dialog; Save as PDF is one click from there on every platform.
 *
 * ## What is in it, and the order
 *
 * Cover: interview, candidate, when, who ran it. Then the scorecard with its
 * caveat first, the categories, every requirement with its quotes or what a
 * stronger answer would have contained, then question by question — the
 * question, the interviewer's words if they were on video, the transcript, and
 * the findings against that answer. The human review, if one was written,
 * closes it: the machine's reading and the person's decision are on different
 * pages, in that order, deliberately.
 *
 * ## Gated like the interview page
 *
 * `analysis.read` opens it; `transcript.read` is what puts words on it. A role
 * without transcript access gets coverage and verdicts but no quotes — and the
 * scorecard is withheld too, because a score nobody can open into words is the
 * bare number this product refuses to emit.
 */
export default async function ReportPage({ params }: { params: { id: string } }) {
  const db = supabaseAdmin();
  const { data: interview } = await db
    .from("interviews")
    .select("id, project_id, customer_id, candidate_name, candidate_email, status, is_test, created_at, completed_at, deleted_at, question_sequence")
    .eq("id", params.id).maybeSingle();
  if (!interview || interview.deleted_at) {
    return <main className="wrap"><div className="card"><h1>Not found</h1></div></main>;
  }

  const gate = await projectPageGate(cookies().get(SESSION_COOKIE_NAME)?.value ?? null, interview.project_id, "analysis.read");
  if (!gate.ok) {
    const href = signInUrl(`/interviews/${params.id}/report`);
    return (
      <main className="wrap"><div className="card">
        <h1>Rescript Interviews</h1><p>{gate.message}</p>
        {gate.kind === "signed_out" && href && <p><a className="btn" href={href}>Sign in</a></p>}
      </div></main>
    );
  }
  const mayRead = can(gate.ctx.role, "transcript.read");

  const [{ data: project }, { data: questions }, { data: requirements }, { data: analysis }, { data: evidence }, { data: transcripts }, { data: responses }, { data: reviews }, { data: customer }] = await Promise.all([
    db.from("interview_projects").select("name, code, description, mode").eq("id", interview.project_id).maybeSingle(),
    db.from("interview_questions").select("id, code, prompt, kind, prompt_media_id, options").eq("project_id", interview.project_id),
    db.from("interview_requirements").select("id, code, title, criteria, weight, category").eq("project_id", interview.project_id).order("position"),
    db.from("interview_analysis").select("narrative, summary, status, score, completed_at, model, provider").eq("interview_id", params.id).maybeSingle(),
    db.from("interview_evidence").select("id, requirement_id, response_id, question_id, verdict, quote, explanation, quote_start_seconds").eq("interview_id", params.id),
    db.from("interview_transcripts").select("media_id, response_id, text, status").eq("interview_id", params.id).eq("status", "completed"),
    db.from("interview_responses").select("id, question_id, position, status, answer_kind, answer_text, answer_value").eq("interview_id", params.id).order("position"),
    db.from("interview_reviews").select("reviewer_id, status, assessments, notes, recommendation, completed_at").eq("interview_id", params.id).eq("status", "complete"),
    db.from("customers").select("name").eq("id", interview.customer_id).maybeSingle(),
  ]);

  const card = analysis?.status === "complete" ? readScorecard(analysis.score) : null;
  const qById = new Map((questions ?? []).map((q) => [q.id as string, q]));
  const reqById = new Map((requirements ?? []).map((r) => [r.id as string, r]));
  const transcriptByResponse = new Map((transcripts ?? []).filter((t) => t.response_id).map((t) => [t.response_id as string, t.text as string | null]));
  const promptTextByMedia = new Map((transcripts ?? []).filter((t) => !t.response_id).map((t) => [t.media_id as string, t.text as string | null]));
  const evidenceByResponse = new Map<string, typeof evidence>();
  for (const e of evidence ?? []) {
    const k = (e.response_id as string) ?? "";
    evidenceByResponse.set(k, [...(evidenceByResponse.get(k) ?? []), e]);
  }

  const answerText = (r: NonNullable<typeof responses>[number]): string | null => {
    const t = transcriptByResponse.get(r.id as string);
    if (t) return t;
    const q = qById.get(r.question_id as string);
    const opts = (Array.isArray(q?.options) ? q!.options : []) as { code: string; label: string }[];
    const label = (c: unknown) => opts.find((o) => o.code === String(c))?.label ?? String(c);
    if (r.answer_kind === "multi_choice" && Array.isArray(r.answer_value)) return r.answer_value.map(label).join(", ");
    if (r.answer_kind === "single_choice") return r.answer_value == null ? null : label(r.answer_value);
    return (r.answer_text as string | null) ?? null;
  };

  const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" }) : "—");

  return (
    <main className="report" data-testid="report">
      <style>{REPORT_CSS}</style>

      <div className="report-chrome no-print">
        <Link href={`/interviews/${params.id}`} className="btn secondary">← Back to the interview</Link>
        <PrintButton />
      </div>

      {/* ---------------------------------------------------------- cover */}
      <section className="page cover">
        <header className="brand">
          <div className="brand-name">{customer?.name ?? "Rescript Interviews"}</div>
          <div className="muted small">Interview evaluation report</div>
        </header>
        <h1>{project?.name ?? "Interview"}</h1>
        <table className="kv">
          <tbody>
            <tr><th>Candidate</th><td>{interview.candidate_name ?? "—"}{interview.is_test ? " (test run)" : ""}</td></tr>
            <tr><th>Interview</th><td className="mono">{project?.code} · {String(interview.id).slice(0, 8)}</td></tr>
            <tr><th>Invited</th><td>{when(interview.created_at)}</td></tr>
            <tr><th>Completed</th><td>{when(interview.completed_at)}</td></tr>
            <tr><th>Analysed</th><td>{analysis?.completed_at ? `${when(analysis.completed_at)} · ${analysis.provider ?? ""} ${analysis.model ?? ""}` : "not yet"}</td></tr>
            <tr><th>Questions</th><td>{(responses ?? []).length}</td></tr>
            <tr><th>Requirements</th><td>{(requirements ?? []).length}</td></tr>
          </tbody>
        </table>
        <p className="caveat">{ANALYSIS_CAVEAT}</p>
      </section>

      {/* ------------------------------------------------------ scorecard */}
      {card && mayRead ? (
        <section className="page">
          <h2>Scorecard</h2>
          <p className="caveat">{SCORE_CAVEAT}</p>
          <div className="overall">
            <div className="big">{card.overall === null ? "—" : card.overall}<span className="of">{card.overall === null ? "" : " / 100"}</span></div>
            <div className="muted">{describeOverall(card)}</div>
            <div className="muted small">{card.basis}</div>
          </div>

          {card.categories.length > 1 && (
            <>
              <h3>By category</h3>
              <table className="grid">
                <thead><tr><th>Category</th><th>Score</th><th>Requirements</th></tr></thead>
                <tbody>
                  {card.categories.map((c) => (
                    <tr key={c.category}>
                      <td>{c.say}</td>
                      <td>{c.score === null ? "not scored" : `${c.score} / 100`}</td>
                      <td className="muted small">{c.requirements.map((id) => reqById.get(id)?.code ?? "").join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <h3>Requirement coverage</h3>
          <table className="grid">
            <thead><tr><th>Code</th><th>Requirement</th><th>Category</th><th>Weight</th><th>Finding</th></tr></thead>
            <tbody>
              {card.requirements.map((r) => (
                <tr key={r.requirementId} className={`verdict-${r.verdict}`}>
                  <td className="mono">{r.code}</td>
                  <td>{r.title}</td>
                  <td className="muted small">{CATEGORY_SAY[r.category as RequirementCategory]}</td>
                  <td>{r.weight === 0 ? "—" : r.weight}</td>
                  <td>{r.say}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <section className="page">
          <h2>Scorecard</h2>
          <p className="muted">{card ? "Your role can see coverage but not the words behind it, so the score is withheld." : "This interview has not been analysed yet."}</p>
          {analysis?.summary && (
            <table className="grid"><thead><tr><th>Requirement</th><th>Finding</th></tr></thead><tbody>
              {(requirements ?? []).map((r) => {
                const v = (analysis.summary as Record<string, { verdict?: Verdict }>)[r.code as string]?.verdict;
                return <tr key={r.id as string}><td>{r.code} · {r.title}</td><td>{v ? VERDICT_SAY[v] : "—"}</td></tr>;
              })}
            </tbody></table>
          )}
        </section>
      )}

      {/* --------------------------------------------- strengths and gaps */}
      {card && mayRead && (
        <section className="page">
          <h2>Strengths, gaps and what a stronger answer contains</h2>
          <Group title="Requirements with quoted evidence" items={card.strengths} empty="None yet." />
          <Group title="Partly shown" items={card.improvements} empty="None." />
          <Group title="Not found in the candidate's words" items={card.gaps} empty="None — every requirement had quoted evidence." />
          {analysis?.narrative && (
            <>
              <h3>Summary of the transcripts</h3>
              <p className="narrative">{analysis.narrative as string}</p>
            </>
          )}
        </section>
      )}

      {/* --------------------------------------------- question by question */}
      <section className="page">
        <h2>Question by question</h2>
        {(responses ?? []).map((r) => {
          const q = qById.get(r.question_id as string);
          const ev = evidenceByResponse.get(r.id as string) ?? [];
          const text = mayRead ? answerText(r) : null;
          const qs = card?.questions.find((x) => x.responseId === r.id);
          return (
            <article key={r.id as string} className="qa">
              <h3><span className="mono">{q?.code}</span> {q?.prompt}</h3>
              {q?.prompt_media_id && promptTextByMedia.get(q.prompt_media_id as string) && mayRead && (
                <p className="asked"><span className="muted small">As asked on video: </span>&ldquo;{promptTextByMedia.get(q.prompt_media_id as string)}&rdquo;</p>
              )}
              <div className="row-meta muted small">
                {r.status === "skipped" ? "Skipped" : r.status === "stored" ? "Answered" : r.status}
                {qs && qs.score !== null ? ` · evidence for ${qs.demonstrated.length} requirement${qs.demonstrated.length === 1 ? "" : "s"}${qs.partial.length ? `, ${qs.partial.length} partly` : ""}` : ""}
              </div>
              {text ? <p className="transcript">{text}</p> : r.status === "stored" ? <p className="muted small">{mayRead ? "No transcript yet." : "Transcript withheld for your role."}</p> : null}
              {ev.length > 0 && mayRead && (
                <ul className="findings">
                  {ev.map((e) => {
                    const req = reqById.get(e.requirement_id as string);
                    return (
                      <li key={e.id as string} className={`verdict-${e.verdict}`}>
                        <strong>{req?.code}</strong> {req?.title} — <em>{VERDICT_SAY[e.verdict as Verdict]}</em>
                        {e.quote ? <blockquote>&ldquo;{e.quote as string}&rdquo;{e.quote_start_seconds != null ? <span className="muted small"> at {clock(Number(e.quote_start_seconds))}</span> : null}</blockquote> : null}
                        {e.explanation ? <div className="small muted">{e.explanation as string}</div> : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          );
        })}
      </section>

      {/* ----------------------------------------------------- human review */}
      {(reviews ?? []).length > 0 && (
        <section className="page">
          <h2>Reviewer assessment</h2>
          <p className="muted small">Written by a person, separately from the analysis above. The recommendation is theirs; the analysis makes none.</p>
          {(reviews ?? []).map((rv, i) => (
            <div key={i} className="review">
              <div className="row-meta muted small">Completed {when(rv.completed_at as string)}</div>
              <table className="grid"><tbody>
                {Object.entries((rv.assessments as Record<string, string>) ?? {}).map(([reqId, v]) => (
                  <tr key={reqId}><td>{reqById.get(reqId)?.code} · {reqById.get(reqId)?.title}</td><td>{VERDICT_SAY[v as Verdict] ?? v}</td></tr>
                ))}
              </tbody></table>
              {rv.notes ? <p>{rv.notes as string}</p> : null}
              <p><strong>Recommendation:</strong> {(rv.recommendation as string) ?? "—"}</p>
            </div>
          ))}
        </section>
      )}

      <footer className="report-footer muted small">
        {customer?.name ?? "Rescript"} · {project?.name} · generated {when(new Date().toISOString())}. Every finding is linked to the candidate&apos;s own words; unquoted claims were discarded before scoring.
      </footer>
    </main>
  );
}

function Group({ title, items, empty }: { title: string; items: ScorecardData["requirements"]; empty: string }) {
  return (
    <>
      <h3>{title}</h3>
      {items.length === 0 ? <p className="muted small">{empty}</p> : (
        <ul className="findings">
          {items.map((r) => (
            <li key={r.requirementId} className={`verdict-${r.verdict}`}>
              <strong>{r.code}</strong> {r.title}
              {r.quotes.map((q) => <blockquote key={q.evidenceId}>&ldquo;{q.quote}&rdquo;</blockquote>)}
              {r.wouldHaveShown && <div className="small"><span className="muted">A stronger answer would include:</span> {r.wouldHaveShown}</div>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Print is the delivery format. Screen gets a readable approximation of the
 * same pages so what the reviewer sees is what prints.
 */
const REPORT_CSS = `
.report { max-width: 820px; margin: 0 auto; padding: 24px 16px 64px; color: var(--ink, #111); }
.report .report-chrome { display: flex; justify-content: space-between; gap: 10px; margin-bottom: 18px; }
.report .page { background: var(--card, #fff); border: 1px solid var(--line, #e5e5e5); border-radius: 10px; padding: 28px 32px; margin-bottom: 18px; }
.report .brand { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid var(--ink, #111); padding-bottom: 8px; margin-bottom: 18px; }
.report .brand-name { font-weight: 700; letter-spacing: .02em; }
.report h1 { font-size: 28px; margin: 0 0 14px; }
.report h2 { font-size: 20px; margin: 0 0 12px; }
.report h3 { font-size: 15px; margin: 18px 0 8px; }
.report .kv th { text-align: left; padding: 4px 14px 4px 0; color: #666; font-weight: 500; width: 130px; }
.report .kv td { padding: 4px 0; }
.report .caveat { font-size: 12.5px; color: #555; border-left: 3px solid #bbb; padding: 6px 10px; margin: 12px 0; }
.report .overall .big { font-size: 44px; font-weight: 700; line-height: 1; }
.report .overall .of { font-size: 16px; font-weight: 400; color: #666; }
.report .grid { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.report .grid th, .report .grid td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line, #e5e5e5); vertical-align: top; }
.report .grid th { color: #666; font-weight: 500; }
.report .findings { list-style: none; padding: 0; margin: 0; }
.report .findings li { padding: 8px 0; border-bottom: 1px solid var(--line, #e5e5e5); break-inside: avoid; }
.report blockquote { margin: 6px 0; padding: 4px 10px; border-left: 3px solid #999; font-style: italic; }
.report .verdict-evidence > strong, .report tr.verdict-evidence td:last-child { color: #1a7f37; }
.report .verdict-partial > strong, .report tr.verdict-partial td:last-child { color: #9a6700; }
.report .verdict-insufficient > strong, .report tr.verdict-insufficient td:last-child { color: #8a8a8a; }
.report .qa { padding: 12px 0; border-bottom: 1px solid var(--line, #e5e5e5); break-inside: avoid; }
.report .qa h3 { margin-top: 0; }
.report .transcript { white-space: pre-wrap; font-size: 13.5px; line-height: 1.5; }
.report .asked { font-size: 13px; }
.report .narrative { line-height: 1.55; }
.report .report-footer { text-align: center; margin-top: 8px; }
@media print {
  .no-print { display: none !important; }
  body { background: #fff; }
  .report { max-width: none; padding: 0; color: #000; }
  .report .page { border: 0; border-radius: 0; padding: 0 0 24px; margin: 0; break-after: page; page-break-after: always; }
  .report .page:last-of-type { break-after: auto; page-break-after: auto; }
  .report .cover { min-height: 60vh; }
  .report .brand { position: running(brand); }
  .report .qa, .report .findings li, .report blockquote, .report table { break-inside: avoid; }
  a[href]::after { content: none; }
  @page { margin: 18mm 16mm; }
}
`;
