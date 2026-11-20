import { NextRequest } from "next/server";
import { json, portalRoute, signedIn } from "@/lib/portal/http";
import { progress } from "@/lib/portal/service";

export const dynamic = "force-dynamic";

/**
 * MY PROGRESS (phase 3, 2026-11-20): the signed-in person's own scores over time — across the attempts of an
 * assessment and across the assessments of a series. Only what each researcher shows; like-for-like changes only
 * (lib/portal/service.ts `progress`).
 *
 *   GET → { tracks: [{ title, series, assessments, results, trends, nextDue }] }
 */
export async function GET(req: NextRequest) {
  return portalRoute(req, {}, async (deps) => json({ ok: true, ...(await progress(deps, await signedIn(req, deps))) }));
}
