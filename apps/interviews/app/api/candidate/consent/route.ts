import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { candidateGate, isCandidateFailure, recordTelemetry } from "@/lib/candidate";

export const dynamic = "force-dynamic";

/**
 * AGREEING, AND WHAT IS WRITTEN DOWN WHEN SOMEBODY DOES.
 *
 * The consent TEXT is snapshotted onto the interview row, not just a
 * timestamp. A company that edits its consent statement next month must not
 * thereby change what this person agreed to — and "we have a boolean and the
 * current text" cannot answer the only question anyone will ever ask about
 * it, which is *what did they actually see*.
 *
 * Consent is idempotent: agreeing twice is agreeing once, and the first
 * timestamp is kept.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const gate = await candidateGate(body?.token);
  if (isCandidateFailure(gate)) return gate.response;

  if (body?.agreed !== true) {
    return NextResponse.json(
      { error: "The interview cannot start until you agree to the consent statement." },
      { status: 400 },
    );
  }

  if (gate.interview.consent_given_at) {
    return NextResponse.json({ ok: true, consentGivenAt: gate.interview.consent_given_at });
  }

  const now = new Date().toISOString();
  const { error } = await supabaseAdmin().from("interviews").update({
    consent_given_at: now,
    consent_text_snapshot: gate.project.consent_text ?? "",
    status: "in_progress",
    last_seen_at: now,
  }).eq("id", gate.interview.id);
  if (error) {
    return NextResponse.json({ error: "We could not record your agreement. Please try again." }, { status: 503 });
  }

  await recordTelemetry(gate, [{ kind: "consent_given" }, { kind: "interview_started" }]);
  return NextResponse.json({ ok: true, consentGivenAt: now });
}
