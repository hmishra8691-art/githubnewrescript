import { NextRequest, NextResponse } from "next/server";
import { SurveyDefinition } from "@rescript/schema";
import { aiProviderName, aiConfigured } from "@rescript/ai";
import { detectFormat, readSource, mapCanonical, buildReport, workload, type ImportScope } from "@rescript/import";
import { isFailure, requireUser, type AuthedUser } from "@/lib/guard";
import { billingProjectFor, estimateAi, recordUsage } from "@/lib/metering";
import { CUSTOM_LOGIC_SYSTEM_PROMPT } from "@/lib/import/customLogic";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * SUPER INTELLIGENT IMPORT — a questionnaire file in, a Rescript survey out
 * (the import brief, phases 1–3 and 6).
 *
 * Multipart form:
 *   file       the source: .qsf, Decipher .xml, .docx, .xlsx, .csv, .pdf, .txt
 *              — read by CONTENT, the extension is only a hint (§3)
 *   surveyId   the project this is billed to (the one open in the Studio;
 *              `sandbox` for the fixture)
 *   phase      "estimate" (default): what the file is, how big the job is,
 *              and what it would cost — nothing is charged (§33)
 *              "run": parse, reconstruct, validate; charged, and the actual
 *              charge is returned (§33, §34)
 *   scope      "full" | "structure" | "questions" — the cost-control scopes (§35)
 *   into       "new" (default) | "merge"
 *   existing   for "merge": the survey as it is open in the editor (JSON). The
 *              import is added beside it — nothing in it is overwritten (§27);
 *              the result goes back to the browser, where it is applied as one
 *              undoable edit, like every other Intelligent proposal.
 *
 * Nothing is saved here. A new project is created by POST /api/surveys with
 * the definition this returns (`strict`, so an invalid one is refused, never
 * swapped for a blank survey); a merge is applied in the editor and saved
 * like any edit. Both write a `survey.imported` audit record then (§38).
 *
 * The parse itself is deterministic — no model is involved, so nothing is
 * guessed (§36). The model is offered only for DEEP CUSTOM LOGIC ANALYSIS of
 * what the reader could not translate, priced here and run, item by item, by
 * /api/import/custom-logic when the programmer asks for it.
 *
 * Who may call: a signed-in Studio user billed to the named project (survey.edit
 * for a merge; for a new project the caller's workspace pays through the
 * project they are in). The `sandbox` fixture, on an installation whose AI is
 * the FAKE provider (the browser suites, a local developer), needs no session
 * — the same carve-out as every other Studio AI route.
 */
const MAX_BYTES = 25 * 1024 * 1024;
const SCOPES: ImportScope[] = ["full", "structure", "questions"];

export async function POST(req: NextRequest) {
  const authed = await requireUser(req);
  let form: FormData;
  try { form = await req.formData(); } catch { return isFailure(authed) ? authed.response : NextResponse.json({ error: "expected a multipart form with a file" }, { status: 400 }); }
  const surveyId = typeof form.get("surveyId") === "string" ? String(form.get("surveyId")) : "";
  let user: AuthedUser | null = null;
  if (isFailure(authed)) {
    if (!(surveyId === "sandbox" && aiProviderName() === "fake")) return authed.response;
  } else user = authed;

  const file = form.get("file");
  if (!(file instanceof Blob) || file.size === 0) return NextResponse.json({ error: "the file is empty" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: `the file is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${MAX_BYTES / 1048576} MB` }, { status: 413 });
  const fileName = (file as File).name || "upload";
  const phase = form.get("phase") === "run" ? "run" : "estimate";
  const scope = (SCOPES as string[]).includes(String(form.get("scope"))) ? (String(form.get("scope")) as ImportScope) : "full";
  const into = form.get("into") === "merge" ? "merge" : "new";

  const billing = await billingProjectFor(user, surveyId);
  if ("response" in billing) return billing.response;
  const { meter, ctx } = billing;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mb = Math.max(0.001, bytes.length / (1024 * 1024));
  const detection = detectFormat(bytes, fileName);
  const read = await readSource(bytes, fileName);
  const canonical = read.canonical;
  const work = canonical ? workload(canonical) : null;
  const cfg = await meter.config().catch(() => null);
  const currency = cfg?.currency ?? "USD";

  /* the estimate: before anything is charged */
  const importCharge = await meter.estimate(ctx, { eventType: "FILE_UPLOAD", quantity: mb, metadata: { operation: "survey_import" } }).then((b) => b.customerCharge).catch(() => 0);
  const deep = work && work.aiRequests > 0 && aiConfigured()
    ? { requests: work.aiRequests, customerCharge: await estimateAi(meter, ctx, "AI_REQUEST", { estimateText: CUSTOM_LOGIC_SYSTEM_PROMPT + "x".repeat(2400), maxTokens: 700, requests: work.aiRequests, operation: "import_custom_logic" }) }
    : { requests: work?.aiRequests ?? 0, customerCharge: 0, unavailable: !aiConfigured() };
  const estimate = { import: { customerCharge: importCharge }, deepAnalysis: deep, currency };

  if (!canonical) {
    return NextResponse.json({ ok: false, phase, detection, issues: read.issues, estimate, error: read.issues[0]?.message ?? "This file could not be read as a questionnaire." }, { status: 422 });
  }
  if (phase === "estimate") {
    return NextResponse.json({ ok: true, phase, detection, workload: work, bytes: bytes.length, title: canonical.source.title ?? null, estimate, readIssues: read.issues.filter((i) => i.severity === "high").slice(0, 20) });
  }

  /* the run */
  let existing: SurveyDefinition | undefined;
  if (into === "merge") {
    const raw = form.get("existing");
    const parsed = typeof raw === "string" ? SurveyDefinition.safeParse(JSON.parse(raw || "null")) : null;
    if (!parsed?.success) return NextResponse.json({ error: "to import into this survey, send the survey as it is open (existing)" }, { status: 400 });
    existing = parsed.data;
  }
  const started = Date.now();
  const result = mapCanonical(canonical, { surveyId: into === "merge" ? existing!.meta.id : "import_preview", existing, scope });
  const report = buildReport(detection, canonical, result, scope);

  const upload = await recordUsage(meter, ctx, { eventType: "FILE_UPLOAD", quantity: mb, metadata: { operation: "survey_import", fileName: fileName.slice(0, 120), format: detection.format, bytes: bytes.length } });
  const processing = await recordUsage(meter, ctx, {
    eventType: "DATA_PROCESSING", quantity: Math.max(1, canonical.questions.length),
    metadata: { operation: "survey_import", format: detection.format, platform: detection.platform, scope, into, questions: report.detected.questions, logicRules: work?.logicRules ?? 0, customLogic: work?.customLogic ?? 0, review: report.review.length, ms: Date.now() - started },
  });
  const actual = { customerCharge: (upload?.customerCharge ?? 0) + (processing?.customerCharge ?? 0), currency };

  return NextResponse.json({
    ok: report.ok, phase, detection, workload: work, estimate, actual,
    title: canonical.source.title ?? null,
    definition: result.def, report, mapping: result.mapping, confidence: result.confidence,
    // the custom logic the reader kept but did not translate — what Deep analysis would look at
    custom: [
      ...canonical.questions.flatMap((q) => q.custom.map((cu) => ({ ...cu, questionSource: q.sourceId, questionId: result.mapping.find((m) => m.kind === "question" && m.source === q.sourceId)?.rescript ?? null }))),
      ...canonical.custom.map((cu) => ({ ...cu, questionSource: null, questionId: null })),
    ].slice(0, 200),
  });
}
