import { NextRequest, NextResponse } from "next/server";
import { can, type Capability } from "@rescript/access";
import type { SurveyDefinition } from "@rescript/schema";
import { isFailure, requireProject } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { loadDefinition } from "@/lib/analytics";
import { ARTIFACT_LABEL, artifactCapability, artifactFingerprint, artifactState, type ArtifactType } from "@/lib/artifacts/core";
import { listArtifacts } from "@/lib/artifacts/service";
import { artifactDeps, documentLook, fingerprintInputs } from "@/lib/artifacts/server";

export const dynamic = "force-dynamic";

/**
 * A PROJECT'S KEPT DOCUMENTS (2026-10-18, docs/ARTIFACTS-AND-REPORT-THEMES-2026-10-18.md).
 *
 *   GET → { lines: [{ type, edition, label, latest, versions, state, current }], theme }
 *
 * Every document line the caller may see — the design documents with
 * `project.read`, the findings report and deck with `analytics.read`; a private
 * artifact only by its owner — with its latest version and the kept history,
 * and whether the document made NOW would differ (`state: "stale"` — "a new
 * version is available"), computed by the same function the output route
 * fingerprints with. Nothing is generated here; downloading a version is
 * `GET artifacts/<id>`.
 */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.read");
  if (isFailure(ctx)) return ctx.response;
  const may = (type: ArtifactType) => can(ctx.grant, artifactCapability(type, "list") as Capability);
  const deps = artifactDeps();
  const listed = await listArtifacts(deps, { surveyId: params.id, userId: ctx.user.userId, may });
  if (!listed.ok) return listed.code === "artifacts_unavailable" ? json({ lines: [], unavailable: listed.error }) : json({ error: listed.error, code: listed.code }, listed.status);
  /* what each line would be made from now — only for the lines that exist (nothing to compare otherwise) */
  const db = supabaseService();
  const loaded = listed.lines.length ? await loadDefinition(db, params.id) : null;
  const def = loaded && !("error" in loaded) ? (loaded.def as SurveyDefinition) : null;
  const look = await documentLook(db, { surveyId: params.id, customerId: ctx.user.customerId ?? null, userId: ctx.user.userId }).catch(() => ({ theme: null, structure: null, logo: null }));
  let clientName: string | undefined;
  if (def) {
    const { data: proj } = await db.from("surveys").select("client_name").eq("id", params.id).maybeSingle();
    clientName = def.research?.brief?.client ?? (proj?.client_name ? String(proj.client_name) : undefined);
  }
  const lines = await Promise.all(listed.lines.map(async (l) => {
    let current: string | null = null;
    if (def) {
      try {
        /* a findings document is compared on its own terms: the same dataset and narrative mode it was made with */
        const was = l.latest.inputs;
        const env = was.data?.environment === "TEST" || was.data?.environment === "ALL" ? was.data.environment : "LIVE";
        const fp = await fingerprintInputs(db, { surveyId: params.id, type: l.type, audience: l.edition, def, client: clientName ?? null, look, narrative: was.narrative === "engine" ? "engine" : "auto", environment: env, dataset: was.data?.dataset === "all" ? "all" : "clean" });
        current = artifactFingerprint(fp);
      } catch { current = null; }
    }
    return { ...l, label: ARTIFACT_LABEL[l.type], state: artifactState(l.latest.fingerprint.replace(/~v\d+$/, ""), current), current };
  }));
  return json({ lines, theme: look.theme ? { name: look.theme.name, ref: look.theme.id ?? null, version: look.theme.version ?? null } : null, structure: look.structure });
}
