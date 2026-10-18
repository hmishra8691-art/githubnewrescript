import { NextRequest } from "next/server";
import { isFailure, requireProject } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { sttPrecheck } from "@/lib/byok/connect";
import { qualAbilities, qualGuardCapability } from "@/lib/qual/qualAccess";
import { json, loadWorkspace, refuse, QualStoreError, storeFailure } from "@/lib/qual/qualStore";

export const dynamic = "force-dynamic";

/**
 * THE QUALITATIVE WORKSPACE (2026-10-18) — GET: the project's sessions,
 * transcripts (segments with speakers and timestamps), codebook, excerpts and
 * history, for one member: Data view required (403 otherwise, like every data
 * route); text redacted unless the member holds contact details. Also what
 * this member may do (the buttons) and whether speech-to-text is available
 * to them (their own provider or the installation's AI_STT_*).
 *
 * The guide is not here: it is `definition.qualStudy`, edited in Intelligent
 * Mode and exported by `qual/export`.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, qualGuardCapability("read"));
  if (isFailure(gate)) return gate.response;
  const refused = refuse(gate, "read");
  if (refused) return refused;
  const can = qualAbilities(gate.grant);
  const stt = await sttPrecheck(gate.user, params.id, "qual_transcription").catch(() => null);
  const sttView = stt?.ok ? { ready: true, via: stt.via } : { ready: false, reason: stt && !stt.ok ? stt.error : "Speech-to-text could not be checked." };
  try {
    const ws = await loadWorkspace(supabaseService(), gate);
    return json({ ok: true, available: true, can, stt: sttView, ...ws });
  } catch (e) {
    if (e instanceof QualStoreError && e.code === "migration_required") return json({ ok: true, available: false, note: e.message, can, stt: sttView });
    return storeFailure(e);
  }
}
