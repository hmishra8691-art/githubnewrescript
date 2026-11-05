import { NextRequest, NextResponse } from "next/server";
import { BLOCKING_STATUSES, loadDeployment } from "@/lib/deployment";
import { clientIp } from "@rescript/quality/server";
import { admitArrival } from "@/lib/identity";
import { runGateway } from "@/lib/gateway";
import { panelParams, runtimePanels } from "@/lib/panels";
import { doorCheck, quotaProject, recordTurnedAway } from "@/lib/quota";
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
 *
 * ## The one refusal that is not about fraud (0088 / 0089)
 *
 * A full quota cell. It is checked here, at the door, because this is the only moment at which turning
 * somebody away is cheap: thirty seconds, against the twenty minutes of a survey they would be owed an
 * incentive for either way. A respondent refused for a full cell is sent to the vendor's QUOTA FULL end link,
 * which is a different outcome from a screen-out in every panel's reconciliation and is paid differently.
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

  /* one read for both of this project's settings: the gateway's mode and the quota's vendor mapping */
  const project = await quotaProject(dep.surveyId);

  /*
   * The quota, before a token is minted and before the admission decision is written down — neither should
   * record an arrival that is about to be sent back.
   *
   * A duplicate is still decided first (`admission.admit`): that refusal is about THIS person and the
   * vendor's invoice reconciliation turns on it, where a full cell is about everybody like them. And the
   * check is skipped entirely when no mapping is declared, because nothing could resolve and the round trip
   * would buy an answer of "no cells matched" every time.
   */
  if (project?.mapped && admission.admit) {
    const door = await doorCheck(project, panelParams(urlParams));
    if (!door.admit) {
      await recordTurnedAway(project.id, door.fullCells);
      console.info("[rescript:quota] turned away at the door", JSON.stringify({
        survey: dep.surveyId.slice(0, 8), cells: door.fullCells,
      }));
      if (entry && entry.kind === "admitted" && panels) {
        const back = await panels.exit({ entryId: entry.entryId, outcome: "quota_full" });
        if (back && typeof back.url === "string" && back.url) return NextResponse.redirect(back.url, 302);
      }
      /* no end link configured: the same shape the panel's own over-quota answer uses */
      return NextResponse.json(
        { error: "This study already has enough responses from people in your group.", code: "quota_full" },
        { status: 409 },
      );
    }
  }

  if (!admission.checked || !admission.customerId) {
    // nothing is configured for this study — send them on, exactly as the plain link would
    return NextResponse.redirect(surveyUrl(req, client, study, null), 302);
  }

  const mode = project?.admissionMode ?? "off";
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
