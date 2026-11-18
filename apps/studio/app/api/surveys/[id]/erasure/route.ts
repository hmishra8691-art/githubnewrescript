import { NextRequest, NextResponse } from "next/server";
import { deriveKey } from "@rescript/ai";
import { purgeSessionMedia, type MediaDb } from "@rescript/media";
import { customerDb } from "@/lib/db";
import { audit, isFailure, requireProject } from "@/lib/guard";
import { recountQuotas } from "@/lib/quotaRecount";
import { eraseRespondent, findErasure, fingerprint, normaliseIdentifier, type ErasureDeps, type ErasureIdentifier } from "@/lib/erasureCore";

export const dynamic = "force-dynamic";

/**
 * ERASE ONE RESPONDENT FROM THIS PROJECT (audit 2026-11-17, P1-11; the steps and their reasons: lib/erasureCore.ts).
 *
 *   POST { identifier: { kind: "email" | "respondent_code" | "panel_id" | "session_id", value }, dryRun: true }
 *        → what would be erased: { responses, invitations } — counts only, nothing changes
 *   POST { identifier, confirm: { responses, invitations } }
 *        → erased, verified, recorded. The counts must equal what the dry run showed (the data may have moved), so an
 *          erasure is never larger than what the person was shown.
 *
 * Needs `responses.manage`. The record is an audit entry `privacy.erasure` with the identifier's KIND and a keyed
 * fingerprint — never the value — the counts per table, the verification and the exports made earlier.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "responses.manage");
  if (isFailure(gate)) return gate.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const id = normaliseIdentifier(body?.identifier);
  if (!id) return NextResponse.json({ error: "Name the person by an email address, a respondent code, a panel id or a session id." }, { status: 400 });

  const db = customerDb(gate.survey.customer_id);
  const surveyId = params.id;
  const by = gate.user.fullName || gate.user.userCode;
  const deps: ErasureDeps = {
    findInvitations: async (x: ErasureIdentifier) => {
      if (x.kind !== "email" && x.kind !== "panel_id") return [];
      const q = db.from("respondents").select("id, email").eq("survey_id", surveyId);
      const { data, error } = await (x.kind === "email" ? q.ilike("email", x.value) : q.eq("external_id", x.value));
      if (error) throw new Error(error.message);
      return (data ?? []) as { id: string; email: string | null }[];
    },
    findResponses: async (x, inv) => {
      const cols = "id, session_id, respondent_id, is_test";
      const out = new Map<string, { id: string; session_id: string | null; respondent_id: string | null; is_test: boolean }>();
      const add = (rows: unknown[] | null) => { for (const r of (rows ?? []) as { id: string; session_id: string | null; respondent_id: string | null; is_test: boolean }[]) out.set(r.id, r); };
      if (inv.length) { const { data, error } = await db.from("responses").select(cols).eq("survey_id", surveyId).in("respondent_id", inv); if (error) throw new Error(error.message); add(data); }
      const col = x.kind === "respondent_code" ? "respondent_code" : x.kind === "panel_id" ? "sample_source_respondent" : x.kind === "session_id" ? "session_id" : null;
      if (col) { const { data, error } = await db.from("responses").select(cols).eq("survey_id", surveyId).eq(col, x.value); if (error) throw new Error(error.message); add(data); }
      return [...out.values()];
    },
    purgeMedia: (sessions) => purgeSessionMedia(db as unknown as MediaDb, sessions),
    deleteWhere: async (table, col, values) => {
      let q = db.from(table).delete({ count: "exact" }).in(col, values);
      if (table !== "vendor_participant_mappings") q = q.eq("survey_id", surveyId);
      else if (gate.survey.customer_id) q = q.eq("customer_id", gate.survey.customer_id);
      const { count, error } = await q;
      if (error && !/does not exist|schema cache/i.test(error.message)) throw new Error(`${table}: ${error.message}`);
      return count ?? 0;
    },
    purgeResponses: async (ids) => {
      const soft = await db.rpc("rescript_soft_delete_responses", { p_survey: surveyId, p_ids: ids, p_by: by, p_reason: "erasure request" });
      if (soft.error) throw new Error(soft.error.message);
      const { data, error } = await db.rpc("rescript_purge_responses", { p_survey: surveyId, p_ids: ids, p_by: by });
      if (error) throw new Error(error.message);
      return typeof data === "number" ? data : ids.length;
    },
    countWhere: async (table, col, values) => {
      const { count, error } = await db.from(table).select("*", { count: "exact", head: true }).in(col, values);
      if (error) { if (/does not exist|schema cache/i.test(error.message)) return 0; throw new Error(`${table}: ${error.message}`); }
      return count ?? 0;
    },
    exportsBefore: async () => {
      const { data } = await db.from("audit_logs").select("created_at, detail, user_id").eq("survey_id", surveyId).eq("action", "responses.exported").order("created_at", { ascending: false }).limit(200);
      return ((data ?? []) as { created_at: string; detail: { format?: string } | null; user_id: string | null }[]).map((r) => ({ at: r.created_at, format: r.detail?.format ?? null, by: r.user_id }));
    },
  };

  try {
    const found = await findErasure(id, deps);
    const counts = { responses: found.responses.length, invitations: found.invitations.length };
    if (body?.dryRun) return NextResponse.json({ ok: true, dryRun: true, ...counts });
    const c = body?.confirm as { responses?: unknown; invitations?: unknown } | undefined;
    if (!c || c.responses !== counts.responses || c.invitations !== counts.invitations) {
      return NextResponse.json({ error: `The data changed: this now names ${counts.responses} response${counts.responses === 1 ? "" : "s"} and ${counts.invitations} invitation${counts.invitations === 1 ? "" : "s"}. Check again and confirm those numbers.`, ...counts }, { status: 409 });
    }
    const r = await eraseRespondent(id, deps);
    const key = deriveKey("erasure-fingerprint");
    if (r.found.responses) await recountQuotas(db, undefined, surveyId, false).catch(() => null);
    await audit({
      action: "privacy.erasure", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId, customerId: gate.user.customerId,
      entity: "respondent", entityId: null,
      detail: {
        identifierKind: id.kind, fingerprint: key ? fingerprint(id, key) : null,
        found: r.found, removed: r.removed, mediaObjects: r.mediaObjects, verified: r.verified, remaining: r.remaining,
        exportsBefore: r.exportsBefore.length, lastExportAt: r.exportsBefore[0]?.at ?? null, warnings: r.warnings,
      },
    });
    return NextResponse.json({ ok: r.verified, ...r, note: r.exportsBefore.length ? `${r.exportsBefore.length} export${r.exportsBefore.length === 1 ? " was" : "s were"} made of this project's data before now. Files already downloaded are outside the platform: delete this person from those copies.` : null }, { status: r.verified ? 200 : 500 });
  } catch (e) {
    return NextResponse.json({ error: `The erasure did not finish: ${(e as Error).message}. Nothing reported as removed is restored; run it again to finish.` }, { status: 500 });
  }
}
