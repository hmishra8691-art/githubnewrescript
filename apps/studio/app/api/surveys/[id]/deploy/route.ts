import { launchReadiness } from "@rescript/engine";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { runtimeBaseUrl, surveyBaseUrl } from "@/lib/runtime-url";
import { audit, isFailure, requireProject } from "@/lib/guard";
import { SurveyDefinition } from "@rescript/schema";
import { publishGate, gateRefusal } from "@/lib/publishGate";

export const dynamic = "force-dynamic";

/** Deploy a specific version to /s/<client>/<study> (live) or /t/... (test). */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "deploy.manage");
  if (isFailure(gate)) return gate.response;

  const body = await req.json().catch(() => null);
  const { versionId, clientSlug, studySlug, mode } = body ?? {};
  if (!versionId || !clientSlug || !studySlug || !["test", "live"].includes(mode))
    return NextResponse.json({ error: "versionId, clientSlug, studySlug, mode required" }, { status: 400 });

  const slugRe = /^[a-z0-9][a-z0-9-]{0,60}$/;
  if (!slugRe.test(clientSlug) || !slugRe.test(studySlug))
    return NextResponse.json({ error: "slugs must be lowercase letters/digits/hyphens" }, { status: 400 });

  const db = supabaseAdmin();
  /*
   * R10 — the definition, not just its id.
   *
   * This route used to select `id` alone: it confirmed the version existed
   * and deployed it without ever looking at what was in it. That is why a
   * survey whose mask resolves to the empty set — a page that renders no
   * options — could go live in silence. It could not lint even in principle,
   * because it never loaded the thing to lint.
   */
  const { data: ver } = await db
    .from("survey_versions")
    .select("id, version, definition")
    .eq("survey_id", params.id)
    .eq("id", versionId)
    .single();
  if (!ver) return NextResponse.json({ error: "version not found" }, { status: 404 });

  /*
   * THE GATE, AND WHY TEST AND LIVE ARE TREATED DIFFERENTLY.
   *
   * A LIVE deploy is refused outright, with no override: this is the step at
   * which a real respondent opens the link, and there is no version of "we
   * knew it was broken and published it anyway" worth supporting in code.
   *
   * A TEST deploy reports the same findings and proceeds. Testing is how a
   * programmer FINDS these problems — a gate that stopped them opening the
   * test link would take away the tool they need to fix what the gate is
   * complaining about, and they would route around it. So the findings
   * travel back on the response and the test link still opens.
   */
  const parsedVersion = SurveyDefinition.safeParse(ver.definition);
  const verdict = parsedVersion.success ? publishGate(parsedVersion.data) : null;
  if (!parsedVersion.success) {
    /* a stored version that no longer parses cannot be reasoned about at all */
    return NextResponse.json({
      error: "This version cannot be read against the current schema, so it was not deployed.",
      issues: parsedVersion.error.issues.slice(0, 10),
    }, { status: 422 });
  }
  if (mode === "live" && verdict && !verdict.ok) {
    console.warn("[rescript:deploy] REFUSED broken live deploy", JSON.stringify({
      surveyId: params.id, versionId, errors: verdict.result.errors,
      areas: verdict.problems.map((p) => p.area),
    }));
    await audit({
      action: "deployment.refused", userId: gate.user.userId, sessionId: gate.user.sessionId,
      surveyId: params.id, customerId: gate.user.customerId,
      entity: "deployment", entityId: `${clientSlug}/${studySlug}`,
      detail: { mode, versionId, reason: "quality check", errors: verdict.result.errors, problems: verdict.problems },
    });
    return NextResponse.json(gateRefusal(verdict, "deployed"), { status: 422 });
  }

  /*
   * THE LAUNCH-READINESS GATE (Intelligent Mode IM10, 2026-11-06). The quality check above is the questionnaire's;
   * these are the launch's — a password access with no password, unique-link or invitation access with no links, a
   * closing date already passed, consent the study requires and the survey does not ask. Each would make a live link
   * refuse everyone or launch without what the study promised, so a LIVE deploy is refused with the fix for each;
   * the warnings (no production-like test, missing quotas or languages …) travel back and do not block. Test deploys
   * report and proceed, as above.
   */
  let readiness: ReturnType<typeof launchReadiness> | null = null;
  try {
    const access = parsedVersion.data.deployment.access.mode;
    const { count: links } = access === "unique_links" || access === "invitation" ? await db.from("respondents").select("id", { count: "exact", head: true }).eq("survey_id", params.id).eq("is_test", false) : { count: null };
    readiness = launchReadiness(parsedVersion.data, { tested: true, links: links ?? null });
  } catch { readiness = null; }
  const launchBlockers = readiness ? readiness.checks.filter((c) => !c.ok && c.level === "blocker" && c.id !== "lint" && c.id !== "questions") : [];
  if (mode === "live" && launchBlockers.length) {
    await audit({
      action: "deployment.refused", userId: gate.user.userId, sessionId: gate.user.sessionId,
      surveyId: params.id, customerId: gate.user.customerId,
      entity: "deployment", entityId: `${clientSlug}/${studySlug}`,
      detail: { mode, versionId, reason: "launch readiness", blockers: launchBlockers.map((b) => b.id) },
    });
    return NextResponse.json({ error: `Not launched: ${launchBlockers.map((b) => b.message).join(" ")}`, blockers: launchBlockers, warnings: readiness!.checks.filter((c) => !c.ok && c.level === "warning") }, { status: 422 });
  }

  const { data: existing } = await db
    .from("deployments")
    .select("id, survey_id")
    .eq("client_slug", clientSlug)
    .eq("study_slug", studySlug)
    .eq("mode", mode)
    .maybeSingle();
  if (existing && existing.survey_id !== params.id)
    return NextResponse.json({ error: "that client/study URL is used by another survey" }, { status: 409 });

  const { error } = existing
    ? await db.from("deployments").update({ version_id: versionId, active: true }).eq("id", existing.id)
    : await db.from("deployments").insert({
        survey_id: params.id, version_id: versionId,
        client_slug: clientSlug, study_slug: studySlug, mode, active: true,
      });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await audit({
    action: "deployment.completed", userId: gate.user.userId, sessionId: gate.user.sessionId,
    surveyId: params.id, customerId: gate.user.customerId,
    entity: "deployment", entityId: `${clientSlug}/${studySlug}`,
    detail: {
      mode, versionId, clientSlug, studySlug,
      /* a test deploy that went out with known problems says so, here and in the reply */
      ...(verdict && !verdict.ok ? { lintErrors: verdict.result.errors, lintProblems: verdict.problems } : {}),
    },
  });

  /*
   * The link handed back is the one a respondent would follow, so it honours
   * the survey's own domain when it has one. The deployment row still points
   * at the platform runtime — a custom domain is a front door, not a second
   * deployment.
   */
  const base = surveyBaseUrl(body?.customDomain ?? null) || runtimeBaseUrl();
  const url = `${base}/${mode === "test" ? "t" : "s"}/${clientSlug}/${studySlug}`;
  return NextResponse.json({
    ok: true, url,
    lint: verdict ? {
      status: verdict.result.status,
      errors: verdict.result.errors,
      warnings: verdict.result.warnings,
      summary: verdict.summary,
      ...(verdict.ok ? {} : { problems: verdict.problems }),
    } : null,
    /* IM10: the launch's own checks — blockers (a test deploy proceeds with them) and warnings, each with its fix */
    readiness: readiness ? { summary: readiness.summary, issues: readiness.checks.filter((c) => !c.ok && c.id !== "tested") } : null,
  });
}
