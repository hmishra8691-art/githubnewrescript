import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { BLOCKING_STATUSES, loadDeployment } from "@/lib/deployment";
import { clientIp } from "@rescript/quality/server";
import { admitArrival } from "@/lib/identity";
import { runGateway, type AdmissionMode } from "@/lib/gateway";
import { panelParams, runtimePanels } from "@/lib/panels";
import type { PanelConfig } from "@rescript/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE RECRUITMENT GATEWAY (0084) — the link a sample vendor is given.
 *
 *   /r/<client>/<study>?RID=…   →   identity (0083) → risk (0084) → access token → /s/<client>/<study>?at=…
 *
 * Deliberately shaped like the survey link it redirects to, so a vendor swapping one for the other changes a
 * single character and keeps every parameter it already appends.
 *
 * ## Why a redirect and not a page
 *
 * Nothing is rendered here. A respondent who has been admitted should see the survey, not an interstitial
 * telling them they have been checked — the check is the platform's business, not theirs. A respondent who is
 * refused goes to the vendor's own end link where their panel expects them, with the right outcome, so the
 * vendor's reconciliation is correct without anybody being shown a message about fraud.
 *
 * ## What it never does
 *
 * It never refuses on a risk score. The worst band admits and holds the participation for review. It also fails
 * OPEN at every step: an unmigrated database, a missing key, an unreachable table all send the respondent to
 * the survey exactly as the plain link would have. A gateway that can take a study offline is worse than no
 * gateway.
 */

function surveyUrl(req: NextRequest, client: string, study: string, token: string | null): URL {
  const url = new URL(`/s/${encodeURIComponent(client)}/${encodeURIComponent(study)}`, req.nextUrl.origin);
  // every parameter the vendor appended travels on, so the survey's own embedded data still works
  for (const [k, v] of req.nextUrl.searchParams) url.searchParams.set(k, v);
  if (token) url.searchParams.set("at", token);
  return url;
}

export async function GET(req: NextRequest, { params }: { params: { client: string; study: string } }) {
  const { client, study } = params;

  const dep = await loadDeployment(client, study, "live");
  if (!dep) return NextResponse.json({ error: "Survey not found" }, { status: 404 });

  const blocked = BLOCKING_STATUSES[dep.surveyStatus];
  if (blocked) {
    // the study is paused or closed: that is the survey page's message to give, not ours
    return NextResponse.redirect(surveyUrl(req, client, study, null), 302);
  }

  const urlParams = Object.fromEntries(req.nextUrl.searchParams);

  /*
   * The panel entry first, exactly as `session/start` does it: it is what turns the vendor's parameter into a
   * participant id, and it already refuses a second arrival from the same panel id (0072).
   */
  const panelList = (dep.definition as { panels?: PanelConfig[] }).panels;
  const panels = Array.isArray(panelList) && panelList.length ? runtimePanels({ panels: panelList }) : null;
  const entry = panels
    ? await panels.enter({ surveyId: dep.surveyId, target: "survey", targetRef: dep.versionId ?? null, params: panelParams(urlParams), isTest: false })
    : null;

  if (entry && (entry.kind === "refused" || entry.kind === "duplicate")) {
    const back = entry.kind === "duplicate" ? await panels!.exit({ entryId: entry.entryId, outcome: "screenout" }) : null;
    if (back && typeof back.url === "string" && back.url) return NextResponse.redirect(back.url, 302);
    return NextResponse.json({ error: entry.message, code: `panel_${entry.kind}` }, { status: 409 });
  }
  if (entry && entry.kind === "over_quota") {
    // a panel with no over-quota end link configured has nowhere to send them; the survey page says so
    if (entry.redirect.url) return NextResponse.redirect(entry.redirect.url, 302);
    return NextResponse.json({ error: entry.message, code: "panel_over_quota" }, { status: 409 });
  }

  // identity and the ledger (0083). Shadow mode by default: this refuses nobody.
  const admission = await admitArrival(dep.surveyId, {
    vendorPid: entry && entry.kind === "admitted" ? entry.pid : null,
    ip: clientIp(req.headers),
    userAgent: req.headers.get("user-agent"),
  });

  if (!admission.checked || !admission.customerId) {
    // nothing is configured for this study — send them on, exactly as the plain link would
    return NextResponse.redirect(surveyUrl(req, client, study, null), 302);
  }

  const mode = await admissionMode(dep.surveyId);
  const outcome = await runGateway({
    customerId: admission.customerId,
    surveyId: dep.surveyId,
    mode,
    trustUuid: admission.trustUuid,
    ledgerId: admission.ledgerId,
    networkToken: admission.networkToken,
    deviceToken: admission.deviceToken,
    resolution: admission.resolution,
    identityRefused: !admission.admit,
    identityReason: admission.decision?.reason ?? null,
    identityCode: admission.decision?.code ?? null,
  });

  if (!outcome.admit) {
    // a confirmed duplicate: back to the vendor with the outcome its reconciliation expects
    if (entry && entry.kind === "admitted" && panels) {
      const back = await panels.exit({ entryId: entry.entryId, outcome: "screenout" });
      if (back && typeof back.url === "string" && back.url) return NextResponse.redirect(back.url, 302);
    }
    return NextResponse.json({ error: outcome.reason, code: `admission_${outcome.code}` }, { status: 409 });
  }

  if (outcome.risk.reasons.length) {
    console.info("[rescript:gateway]", JSON.stringify({
      survey: dep.surveyId.slice(0, 8), mode, band: outcome.risk.band, score: outcome.risk.score,
      reasons: outcome.risk.reasons, held: outcome.code === "admitted_flagged",
    }));
  }

  return NextResponse.redirect(surveyUrl(req, client, study, outcome.token), 302);
}

/** The project's admission setting. Absent project, unmigrated database, anything unexpected: off. */
async function admissionMode(surveyId: string): Promise<AdmissionMode> {
  try {
    const { data } = await supabaseAdmin()
      .from("recruitment_projects").select("admission_mode")
      .eq("survey_id", surveyId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const mode = data?.admission_mode as AdmissionMode | undefined;
    return mode === "review" || mode === "observe" ? mode : "off";
  } catch {
    return "off";
  }
}
