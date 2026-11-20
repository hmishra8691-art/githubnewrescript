import "server-only";
import { can } from "@rescript/access";
import { SurveyDefinition } from "@rescript/schema";
import { audit, type ProjectContext } from "./guard";
import { platformDb } from "./db";
import { personResults, PERSON_ATTEMPTS, type PersonResults } from "./portalPersonCore";
import { liveDefinition } from "./portalScores";
import type { CompletedRow } from "./portalScoresCore";

/**
 * ONE RESPONDENT'S PORTAL RESULTS, OPENED BY A MEMBER (phase 3, 2026-11-20; /api/surveys/[id]/portal/person).
 *
 * For the clinician, coach or teacher who follows named people. The route requires `responses.read_individual`.
 * What is returned is this person's scores in THIS survey and their history across its attempts — not their
 * answers, and not their results in any other survey (the member's permission is for this project). The name and
 * email come only with `responses.read_pii`. Every opening is audited, and noted in the person's own access log
 * so it can be shown to them.
 */
type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);

export interface PersonView extends PersonResults {
  available: boolean;
  why: string | null;
  person: { id: string; respondentId: string | null; name: string | null; email: string | null };
}

export async function personView(ctx: ProjectContext, enrolmentId: string): Promise<PersonView | { error: string; status: number }> {
  const { data: who, error } = await ctx.db.from("respondents").select("id, name, email, account_id").eq("id", enrolmentId).eq("survey_id", ctx.surveyId).eq("is_test", false).maybeSingle();
  if (error) return /account_id|schema cache|does not exist/i.test(error.message) ? { error: "The portal's tables are not on this database yet. Apply migration 0103.", status: 409 } : { error: error.message, status: 500 };
  const r = who as Row | null;
  if (!r) return { error: "That respondent is not on this survey's list.", status: 404 };

  const pii = can(ctx.grant, "responses.read_pii");
  let respondentId: string | null = null;
  if (typeof r.account_id === "string") {
    const { data: acc } = await platformDb().from("portal_accounts").select("respondent_id").eq("id", r.account_id).maybeSingle();
    respondentId = str((acc as Row | null)?.respondent_id);
  }
  const person = { id: String(r.id), respondentId, name: pii ? str(r.name) : null, email: pii ? str(r.email) : null };
  const empty: PersonResults = { attempts: 0, latestAt: null, latest: null, trends: [] };

  const live = await liveDefinition(ctx);
  if (!live?.portal?.enabled || !live.portal.scorecard?.dimensions.length) return { ...empty, available: false, why: !live ? "Publish the survey to see results." : "The published version has no scorecard.", person };

  const { data: rows, error: rErr } = await ctx.db.from("responses").select("id, survey_id, respondent_id, is_test, version_id, completed_at, answers, calculated, embedded")
    .eq("survey_id", ctx.surveyId).eq("respondent_id", enrolmentId).eq("status", "complete").eq("is_test", false).is("deleted_at", null).order("completed_at", { ascending: false }).limit(PERSON_ATTEMPTS);
  if (rErr) return { error: rErr.message, status: 500 };
  const done = (rows ?? []) as unknown as CompletedRow[];
  const versions = new Map<string, SurveyDefinition>();
  const ids = [...new Set(done.map((x) => x.version_id).filter((x): x is string => typeof x === "string"))];
  if (ids.length) {
    const { data: vs } = await ctx.db.from("survey_versions").select("id, definition").eq("survey_id", ctx.surveyId).in("id", ids);
    for (const v of (vs ?? []) as Row[]) { const p = SurveyDefinition.safeParse(v.definition); if (p.success) versions.set(String(v.id), p.data); }
  }

  /* who looked at whom — never what the results were */
  void audit({ action: "portal.individual_viewed", userId: ctx.user.userId, sessionId: ctx.user.sessionId, surveyId: ctx.surveyId, customerId: ctx.user.customerId, entity: "respondents", detail: { respondentId: respondentId ?? person.id } });
  if (typeof r.account_id === "string") {
    try { await platformDb().from("portal_events").insert({ account_id: r.account_id, event: "results_viewed_by_staff", survey_id: ctx.surveyId, customer_id: ctx.user.customerId, detail: {} }); } catch { /* the audit log above is the record */ }
  }
  return { ...personResults(done, live, versions), available: true, why: null, person };
}
