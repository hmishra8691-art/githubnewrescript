import { NextRequest, NextResponse } from "next/server";
import {
  MOCK_RETENTION_HOURS, RESPONDENT_RETENTION_SCOPE, findMockTemplate, seedFor,
} from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireUser } from "@/lib/auth";
import { mintInterviewToken } from "@/lib/candidate";

export const dynamic = "force-dynamic";

/**
 * PRESS START, BE INTERVIEWING.
 *
 * A mock interview is an ordinary project with `mode = 'mock'`, created here
 * from a library template for the signed-in person, with that person as its
 * only candidate. Everything after this is the same machinery a hiring
 * interview uses — the recorder, the upload, the transcription, the analysis,
 * the scorecard. The two differences are who reads the result (the candidate,
 * through `/api/candidate/feedback`) and how long it is kept (a day).
 *
 * ## Why a whole project per session
 *
 * Because that is what the tables are. A project owns questions, requirements,
 * retention, and the billing subject; an interview owns one person's sitting.
 * Reusing one shared "mock project" per template across everybody would put
 * strangers' recordings under one project id, visible to whoever holds the
 * project role — the one thing the access model here exists to prevent.
 * Copying is cheap; it is a few rows.
 *
 * ## Retention
 *
 * Twenty-four hours, in hours — the reason `retention_hours` exists — with the
 * full respondent scope, so the recording, the transcript, the typed answers,
 * the telemetry and the person's own identifying fields all go. The analysis
 * is kept: a score and its quotes are the person's feedback and are small. The
 * candidate is told the period on their own screen.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  if (!user.customerId) {
    return NextResponse.json({ error: "Your account is not in a workspace yet." }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const template = findMockTemplate(String(body?.template ?? ""));
  if (!template) return NextResponse.json({ error: "No such practice interview." }, { status: 404 });

  const db = supabaseAdmin();
  const projectId = crypto.randomUUID();
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

  const { error: projectError } = await db.from("interview_projects").insert({
    id: projectId,
    customer_id: user.customerId,
    owner_id: user.userId,
    created_by: user.userId,
    code: `MOCK_${template.key.toUpperCase().slice(0, 12)}_${stamp}`.slice(0, 40),
    name: `Practice: ${template.title}`,
    description: template.blurb,
    status: "open",
    mode: "mock",
    category: template.category,
    template_key: template.key,
    instructions: [
      `This is a practice interview — ${template.minutes} minutes or so. Answer as you would in the real thing.`,
      "When you finish, your answers are transcribed and read against the requirements below, and you get feedback on what you said.",
      `Your recording is kept for ${MOCK_RETENTION_HOURS} hours so you can download it, then deleted.`,
    ].join("\n\n"),
    consent_text: [
      "This practice interview is recorded so it can be transcribed and read back to you.",
      "",
      `The recording, transcript and your answers are deleted automatically after ${MOCK_RETENTION_HOURS} hours. Only you and administrators of your workspace can see them before then.`,
      "",
      "By continuing you agree to be recorded for this purpose.",
    ].join("\n"),
    retention_days: null,
    retention_hours: MOCK_RETENTION_HOURS,
    retention_scope: { ...RESPONDENT_RETENTION_SCOPE, analysis: false },
  });
  if (projectError) return NextResponse.json({ error: "The practice interview could not be set up." }, { status: 503 });

  const { error: qError } = await db.from("interview_questions").insert(template.questions.map((q, i) => ({
    project_id: projectId, code: q.code, kind: q.kind, prompt: q.prompt, guidance: q.guidance ?? "",
    required: true, max_seconds: q.maxSeconds ?? 180, max_retries: 1, think_seconds: q.thinkSeconds ?? 0,
    position: i + 1, category: "custom",
  })));
  if (qError) return NextResponse.json({ error: "The practice questions could not be set up." }, { status: 503 });

  const { error: rError } = await db.from("interview_requirements").insert(template.requirements.map((r, i) => ({
    project_id: projectId, code: r.code, title: r.title, criteria: r.criteria,
    weight: r.weight ?? 1, category: r.category, position: i + 1,
  })));
  if (rError) return NextResponse.json({ error: "The practice requirements could not be set up." }, { status: 503 });

  /* the person is their own candidate */
  const { token, hash, prefix } = mintInterviewToken();
  const interviewId = crypto.randomUUID();
  const { error: ivError } = await db.from("interviews").insert({
    id: interviewId,
    project_id: projectId,
    customer_id: user.customerId,
    candidate_name: null,
    candidate_email: null,
    token_hash: hash,
    token_prefix: prefix,
    expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    is_test: false,
    selection_seed: seedFor(interviewId, "mock"),
  });
  if (ivError) return NextResponse.json({ error: "The practice session could not be started." }, { status: 503 });

  const base = (process.env.INTERVIEWS_PUBLIC_URL ?? req.nextUrl.origin).replace(/\/+$/, "");
  return NextResponse.json({
    ok: true, projectId, interviewId,
    link: `${base}/i/${token}`,
    retentionHours: MOCK_RETENTION_HOURS,
  }, { status: 201 });
}
