import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure } from "@/lib/auth";
import { participantsOf, requireMedia } from "@/lib/recordings";

export const dynamic = "force-dynamic";

/**
 * SAY WHICH VOICE IS WHOSE.
 *
 * A diarizing provider returns anonymous labels — "Speaker 1", "Speaker 2" —
 * and mapping them to the people in the room is a judgement a person makes,
 * not a fact a machine produced. §12 is explicit that an uncertain
 * identification must not be silently assigned, so until somebody does this
 * the transcript renders the label itself and nobody is named.
 *
 * Separate from the participant list on purpose. Saying who was present and
 * saying which of them is speaking at 04:12 are different acts, done at
 * different times by possibly different people: the first before the recording
 * starts, the second after a transcript exists.
 *
 * `confirmed_by` records who decided, because an attribution somebody will act
 * on should be attributable itself.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireMedia(req, params.id, "transcript.read");
  if (isFailure(ctx)) return ctx.response;

  const body = await req.json().catch(() => ({}));
  const personId = String(body?.personId ?? "");
  /* null clears the mapping — how somebody withdraws a guess */
  const label = body?.speakerLabel == null ? null : String(body.speakerLabel);

  if (!personId) {
    return NextResponse.json({ error: "Which person?" }, { status: 400 });
  }

  const db = supabaseAdmin();

  /*
   * One label, one person. Without this a researcher correcting a mistake
   * leaves the old mapping in place and the transcript shows two names for one
   * voice — which looks like the provider heard two people and is worse than
   * the mistake being corrected.
   */
  if (label) {
    await db.from("interview_media_participants")
      .update({ speaker_label: null, confirmed_by: null, confirmed_at: null })
      .eq("media_id", params.id)
      .eq("speaker_label", label)
      .neq("person_id", personId);
  }

  const { data, error } = await db.rpc("rescript_interview_map_speaker", {
    p_media: params.id,
    p_person: personId,
    p_label: label,
    p_actor: ctx.user.userId,
  });

  if (error) {
    return NextResponse.json({ error: "That mapping could not be saved." }, { status: 503 });
  }
  if (data === false) {
    /*
     * The function returns false when the person is not in this recording —
     * which is a real thing to refuse: a voice in a recording belongs to
     * somebody who was in it.
     */
    return NextResponse.json(
      { error: "That person is not listed in this recording. Add them first." },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, participants: await participantsOf(params.id) });
}
