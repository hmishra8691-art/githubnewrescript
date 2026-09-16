import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/auth";
import { mintInterviewToken } from "@/lib/candidate";
import { seedFor } from "@rescript/interviews";

export const dynamic = "force-dynamic";

/**
 * INVITE A CANDIDATE — AND SHOW THE LINK EXACTLY ONCE.
 *
 * The reply carries the full URL. The database carries a SHA-256 of the
 * token and its first eight characters, and nothing else. There is no route
 * anywhere in this application that can return the link again, because there
 * is nothing to return it from.
 *
 * That is a deliberate trade against convenience, and it is the right way
 * round for this product: a link is a bearer credential to a named person's
 * recorded answers. Losing one costs a re-issue — one click, a new token, the
 * old one dead — and the alternative costs a database leak becoming a set of
 * working links into every candidate's interview.
 *
 * ## Why no email is sent from here
 *
 * The company decides how a candidate is contacted, and in an ATS the answer
 * is usually "through the ATS". Sending mail from the invite route would make
 * that decision for them and put our sender in front of their candidate.
 * `@rescript/mail` is wired for the survey product and is the obvious next
 * step when somebody asks; nothing here is shaped to prevent it.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "candidates.invite");
  if (isFailure(gate)) return gate.response;

  const body = await req.json().catch(() => ({}));
  const db = supabaseAdmin();

  /*
   * An interview with no questions is a link that opens onto nothing. Caught
   * here, when somebody can still do something about it, rather than by the
   * candidate.
   */
  const { count } = await db
    .from("interview_questions")
    .select("id", { count: "exact", head: true })
    .eq("project_id", params.id)
    .is("archived_at", null);
  if (!count) {
    return NextResponse.json(
      { error: "This project has no questions yet, so an invitation would open onto an empty interview." },
      { status: 409 },
    );
  }

  const { token, hash, prefix } = mintInterviewToken();
  const id = crypto.randomUUID();
  const expiresInDays = Number.isInteger(body?.expiresInDays) ? Math.max(1, body.expiresInDays) : 14;

  const { data, error } = await db.from("interviews").insert({
    id,
    project_id: params.id,
    customer_id: gate.project.customer_id,
    candidate_name: trimmed(body?.candidateName, 200),
    candidate_email: trimmed(body?.candidateEmail, 200)?.toLowerCase() ?? null,
    candidate_reference: trimmed(body?.candidateReference, 120),
    token_hash: hash,
    token_prefix: prefix,
    expires_at: new Date(Date.now() + expiresInDays * 86400_000).toISOString(),
    is_test: body?.isTest === true,
    /* the seed is fixed at invitation, so the draw is decided by something
       written down rather than by whatever the clock said at first open */
    selection_seed: seedFor(id, String(body?.seedSalt ?? "")),
  }).select("id, token_prefix, expires_at, candidate_name, is_test, status, created_at").single();

  if (error) return NextResponse.json({ error: "We could not create that invitation." }, { status: 503 });

  const base = (process.env.INTERVIEWS_PUBLIC_URL ?? req.nextUrl.origin).replace(/\/+$/, "");
  return NextResponse.json({
    ok: true,
    interview: data,
    /* the one and only time this exists outside the candidate's browser */
    link: `${base}/i/${token}`,
    warning: "This link is shown once. It cannot be recovered — issue a new one if it is lost.",
  }, { status: 201 });
}

const trimmed = (v: unknown, max: number): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
};
