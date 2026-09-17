import { NextRequest, NextResponse } from "next/server";
import { checkParticipants } from "@rescript/interviews";
import { can, isFailure } from "@/lib/auth";
import { participantsOf, requireMedia, setParticipants } from "@/lib/recordings";

export const dynamic = "force-dynamic";

/**
 * WHO IS IN THIS RECORDING.
 *
 * §7 of the brief, and the reason 0033 exists: the people on a project are not
 * automatically the people in a recording. A researcher says who was present,
 * per recording, and changes it as an interviewer team rotates through a
 * study. Two recordings made ten minutes apart can have different answers, and
 * both are right.
 *
 * PUT replaces rather than patches, because that is what the researcher is
 * doing — ticking a list, not issuing add and remove instructions. The
 * replacement is one statement inside `rescript_interview_set_participants`,
 * so a half-applied list is never observable, and a participant who stays on
 * the list keeps the speaker mapping somebody confirmed for them.
 */

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireMedia(req, params.id, "candidates.read");
  if (isFailure(ctx)) return ctx.response;

  /* names for everybody who may see the recording; addresses only with `identity.read` */
  const mayIdentify = can(ctx.role, "identity.read");
  const participants = (await participantsOf(params.id)).map((p) => (mayIdentify ? p : { ...p, email: null }));
  return NextResponse.json(
    { ok: true, participants },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireMedia(req, params.id, "candidates.invite");
  if (isFailure(ctx)) return ctx.response;

  const body = await req.json().catch(() => ({}));
  const raw = Array.isArray(body?.participants) ? body.participants : null;
  if (!raw) {
    return NextResponse.json(
      { error: "Send a participants array. An empty array is how you clear the list." },
      { status: 400 },
    );
  }

  const list = raw
    .filter((p: unknown): p is { personId?: unknown; role?: unknown } => !!p && typeof p === "object")
    .map((p: { personId?: unknown; role?: unknown }) => ({
      personId: String(p.personId ?? ""),
      role: String(p.role ?? "interviewer"),
    }))
    .filter((p: { personId: string }) => !!p.personId);

  /*
   * Errors block, warnings do not. "No respondent in this recording" is a
   * legitimate thing — two researchers debriefing — so it is returned
   * alongside the saved list for the UI to show, rather than refused. A
   * duplicate person or an unknown role IS refused: those write a list nobody
   * can render.
   */
  const { errors, warnings } = checkParticipants(list);
  if (errors.length) {
    return NextResponse.json({ error: errors[0].message, errors }, { status: 400 });
  }

  const saved = await setParticipants(params.id, list, ctx.user.userId);
  if (!saved.ok) return saved.response;

  return NextResponse.json({
    ok: true,
    count: saved.count,
    warnings,
    participants: await participantsOf(params.id),
  });
}
