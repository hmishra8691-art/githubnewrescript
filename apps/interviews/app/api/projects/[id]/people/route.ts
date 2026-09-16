import { NextRequest, NextResponse } from "next/server";
import { findExistingPerson, isParticipantRole, type Person } from "@rescript/interviews";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireProject } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * THE PEOPLE ON A PROJECT — the roster a recording's participants are chosen from.
 *
 * Interviewers, observers, interpreters: anybody who might appear in a
 * recording. The respondent of each interview is here too, mirrored by the
 * database from `interviews.candidate_name`, so a participant selector offers
 * one list of one shape instead of joining two sources and special-casing one.
 *
 * ## The duplicate problem, and why it is solved twice
 *
 * §9 asks that adding somebody who already exists SELECTS them. That is done
 * here, before the insert, so the caller gets the existing person back and the
 * UI can say "already on this project" rather than showing a stranger a
 * constraint violation. The unique indexes in 0033 then enforce the same rule
 * underneath, because two researchers adding the same colleague at the same
 * moment both pass the check and one of them must still lose.
 *
 * The check is on account and email, never on name. Two people share a name;
 * one person spells theirs three ways. Merging on a name match would one day
 * combine two real people, and nothing would ever tell anybody.
 */

interface PersonRow {
  id: string; display_name: string; email: string | null; user_id: string | null;
  kind: string; derived: boolean; interview_id: string | null; archived_at: string | null;
  created_at: string;
}

/*
 * The database check constraint already limits `kind` to the five roles the
 * package knows. Narrowing here rather than widening `Person` keeps the domain
 * type honest; the fallback is what happens if a sixth role is added to the
 * constraint and nobody updates the package — an unknown role reads as an
 * observer rather than crashing a roster.
 */
type RosterPerson = Person & { interviewId: string | null };

const toPerson = (r: PersonRow): RosterPerson => ({
  id: r.id,
  displayName: r.display_name,
  email: r.email,
  userId: r.user_id,
  derived: r.derived,
  archivedAt: r.archived_at,
  kind: isParticipantRole(r.kind) ? r.kind : "observer",
  interviewId: r.interview_id,
});

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "candidates.read");
  if (isFailure(ctx)) return ctx.response;

  const url = new URL(req.url);
  const forInterview = url.searchParams.get("interview");

  const db = supabaseAdmin();
  const { data, error } = await db.from("interview_people")
    .select("id, display_name, email, user_id, kind, derived, interview_id, archived_at, created_at")
    .eq("project_id", params.id)
    .is("archived_at", null)
    .order("kind", { ascending: true })
    .order("display_name", { ascending: true });
  if (error) {
    return NextResponse.json({ error: "We could not load the people on this project." }, { status: 503 });
  }

  /*
   * Project staff always; the respondent only of the interview being asked
   * about. A selector for one sitting must not offer forty other people's
   * respondents — that is a participant list leaking names across interviews,
   * which is the same class of mistake §18 names across projects.
   */
  const rows = (data ?? []) as PersonRow[];
  const people = rows
    .filter((r) => !r.interview_id || (forInterview && r.interview_id === forInterview))
    .map(toPerson);

  return NextResponse.json({ ok: true, people }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.manage_members");
  if (isFailure(ctx)) return ctx.response;

  const body = await req.json().catch(() => ({}));
  const displayName = String(body?.displayName ?? "").trim();
  const email = String(body?.email ?? "").trim();
  const kind = isParticipantRole(body?.kind) ? body.kind : "interviewer";

  if (!displayName) {
    return NextResponse.json({ error: "A name is required." }, { status: 400 });
  }
  if (kind === "respondent") {
    /*
     * The respondent is derived from the interview and maintained by a
     * trigger. Letting somebody author one by hand creates a second name for
     * the same person that nothing keeps in step.
     */
    return NextResponse.json(
      { error: "A respondent comes from the interview itself. Edit the candidate's name there." },
      { status: 400 },
    );
  }

  const db = supabaseAdmin();

  /*
   * If this email belongs to a Rescript account in this workspace, attach it.
   * §4: do not rely on free text when a known identity is available. The
   * lookup is scoped to the customer, so adding an interviewer cannot be used
   * to discover whether an address has an account somewhere else.
   */
  let userId: string | null = null;
  if (email) {
    const { data: profile } = await db
      .from("profiles")
      .select("id")
      .eq("customer_id", ctx.project.customer_id)
      .ilike("email", email)
      .maybeSingle();
    userId = profile?.id ?? null;
  }

  const { data: existingRows } = await db
    .from("interview_people")
    .select("id, display_name, email, user_id, kind, derived, interview_id, archived_at, created_at")
    .eq("project_id", params.id)
    .is("archived_at", null);

  const roster = ((existingRows ?? []) as PersonRow[]).map(toPerson);
  const already = findExistingPerson({ userId, email: email || null }, roster);
  if (already) {
    /*
     * 200, not 409. The researcher's intent — "this person should be on the
     * project" — is satisfied, and handing back the existing row lets the UI
     * select them. An error here would make the obvious action feel like a
     * mistake.
     */
    return NextResponse.json({ ok: true, person: already, alreadyExisted: true });
  }

  const { data: created, error } = await db
    .from("interview_people")
    .insert({
      customer_id: ctx.project.customer_id,
      project_id: params.id,
      display_name: displayName,
      email: email || null,
      user_id: userId,
      kind,
      created_by: ctx.user.userId,
    })
    .select("id, display_name, email, user_id, kind, derived, interview_id, archived_at, created_at")
    .maybeSingle();

  if (error || !created) {
    /*
     * The unique indexes are the backstop for two people adding the same
     * colleague at once. Whoever loses that race gets the row the winner
     * created rather than an error about an index they have never heard of.
     */
    const { data: raced } = await db
      .from("interview_people")
      .select("id, display_name, email, user_id, kind, derived, interview_id, archived_at, created_at")
      .eq("project_id", params.id)
      .is("archived_at", null);
    const found = findExistingPerson({ userId, email: email || null },
      ((raced ?? []) as PersonRow[]).map(toPerson));
    if (found) return NextResponse.json({ ok: true, person: found, alreadyExisted: true });

    return NextResponse.json({ error: "We could not add that person." }, { status: 503 });
  }

  return NextResponse.json({ ok: true, person: toPerson(created as PersonRow) });
}
