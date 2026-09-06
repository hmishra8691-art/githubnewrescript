import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { buildPptx, buildXlsx } from "@rescript/analytics/export";
import { DEFAULT_THEME, type AnalysisResult, type ReportDefinition, type ReportTheme } from "@rescript/analytics";
import { supabaseService } from "@/lib/authServer";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { verifyPassword } from "@/lib/analytics";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * THE PUBLIC DOOR (§18–§21, §33–§35).
 *
 * A share token resolves — through `rescript_resolve_share`, a security-definer
 * function that returns the PUBLISHED SNAPSHOT and nothing else — to a frozen
 * report version: its definition, theme and computed results. That is all a
 * viewer can ever receive here. There is no code path from a token to
 * `responses`, to a live analysis definition, or to any write.
 *
 *   GET  /api/share/<token>[?password=…]        the snapshot (403 until the password is right)
 *   POST /api/share/<token>  { format }         PowerPoint / Excel of the same snapshot, if the share permits downloads
 *
 * `access = users` additionally requires a signed-in platform user on the
 * allow-list (matched by user id, or by the email on their profile). Every
 * view and download is recorded on the share for the owner's access history.
 */

type Resolved = {
  share_id: string; survey_id: string; report_id: string; report_name: string | null; permission: "viewer" | "download"; access: "private" | "users" | "link";
  requires_password: boolean; allowed_user_ids: string[]; allowed_emails: string[];
  version: number | null; definition: ReportDefinition | null; theme: ReportTheme | null; snapshot: Record<string, AnalysisResult> | null; dataset: Record<string, unknown> | null; published_at: string | null; status: string;
};

const noStore = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };
const deny = (message: string, status: number, extra: Record<string, unknown> = {}) => NextResponse.json({ error: message, ...extra }, { status, headers: noStore });

async function resolve(req: NextRequest, token: string, password: string | null) {
  const db = supabaseService();
  if (!token || token.length < 16 || token.length > 128) return { denied: deny("This link is not valid.", 404) };
  const { data, error } = await db.rpc("rescript_resolve_share", { p_token: token });
  if (error) return { denied: deny("The shared report could not be loaded.", 500) };
  const r = (data as Resolved[] | null)?.[0];
  if (!r) return { denied: deny("This link is not valid.", 404) };
  const record = async (event: "view" | "download_pptx" | "download_xlsx" | "denied", user: { userId: string; email: string } | null) => {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "";
    await db.rpc("rescript_record_share_access", { p_share: r.share_id, p_event: event, p_user: user?.userId ?? null, p_email: user?.email ?? null, p_ip_hash: ip ? createHash("sha256").update(ip).digest("hex").slice(0, 32) : null, p_agent: req.headers.get("user-agent") ?? "" });
  };
  if (r.status === "revoked") return { denied: deny("This shared report has been revoked by its owner.", 410, { status: "revoked" }) };
  if (r.status === "expired") return { denied: deny("This shared link has expired.", 410, { status: "expired" }) };
  if (r.status === "missing" || r.status === "unpublished") return { denied: deny("This report is not available.", 404, { status: r.status }) };
  if (r.access === "private") return { denied: deny("This report is private.", 403, { status: "private" }) };
  // specific users: a signed-in platform user on the list
  let user: { userId: string; email: string } | null = null;
  if (r.access === "users") {
    const u = await requireUser(req);
    if (isFailure(u)) { return { denied: deny("Sign in to view this report.", 401, { status: "sign_in", reportName: r.report_name }) }; }
    user = { userId: u.userId, email: u.email };
    const ok = r.allowed_user_ids.includes(u.userId) || r.allowed_emails.includes((u.email ?? "").toLowerCase());
    if (!ok) { await record("denied", user); return { denied: deny("This report has not been shared with your account.", 403, { status: "not_shared", reportName: r.report_name }) }; }
  } else {
    const u = await requireUser(req).catch(() => null);
    if (u && !isFailure(u)) user = { userId: u.userId, email: u.email };
  }
  if (r.requires_password) {
    const { data: sh } = await db.from("analytics_shares").select("password_hash").eq("id", r.share_id).single();
    if (!password || !sh?.password_hash || !(await verifyPassword(password, sh.password_hash))) {
      if (password) await record("denied", user);
      return { denied: deny(password ? "That password is not correct." : "This report is password protected.", 401, { status: "password", reportName: r.report_name }) };
    }
  }
  return { r, record, user, db };
}

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const password = req.nextUrl.searchParams.get("password") ?? req.headers.get("x-share-password");
  const res = await resolve(req, params.token, password);
  if ("denied" in res) return res.denied;
  const { r, record, user } = res;
  await record("view", user);
  // ONLY the snapshot leaves: no analysis ids that could be used elsewhere, no dataset spec beyond its summary
  const definition = r.definition!;
  return NextResponse.json({
    report: { name: r.report_name, title: definition.title, subtitle: definition.subtitle, blocks: definition.blocks, viewerSegments: definition.viewerSegments ?? [], branding: definition.branding ?? {}, widgets: (definition as unknown as { widgets?: unknown[] }).widgets ?? null, crossFilter: (definition as unknown as { crossFilter?: boolean }).crossFilter ?? false },
    theme: r.theme ?? DEFAULT_THEME,
    results: r.snapshot,
    version: r.version, publishedAt: r.published_at, mode: "snapshot",
    dataset: r.dataset ? { responses: (r.dataset as { responses?: number }).responses, surveyVersion: (r.dataset as { surveyVersion?: string }).surveyVersion, computedAt: (r.dataset as { computedAt?: string }).computedAt } : null,
    permission: r.permission,
  }, { headers: noStore });
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const body = (await req.json().catch(() => ({}))) as { format?: string; password?: string; settings?: Record<string, unknown> };
  const res = await resolve(req, params.token, body.password ?? req.headers.get("x-share-password"));
  if ("denied" in res) return res.denied;
  const { r, record, user, db } = res;
  if (r.permission !== "download") return deny("Downloads are not enabled for this shared report.", 403, { status: "no_download" });
  const format = body.format === "xlsx" ? "xlsx" : "pptx";
  const report = r.definition!, results = r.snapshot ?? {}, theme = r.theme ?? DEFAULT_THEME;
  // a viewer may pick what to include, never restyle or recompute
  const include = body.settings?.include && typeof body.settings.include === "object" ? (body.settings.include as Record<string, boolean>) : undefined;
  const settings = include ? { include } : undefined;
  const buf = format === "pptx"
    ? await buildPptx({ report: { ...report, date: r.published_at?.slice(0, 10) }, results, theme, settings: settings as never, meta: { dataset: `Published snapshot v${r.version}` } })
    : await buildXlsx({ report, results, theme, settings: settings as never, meta: { "Report version": r.version, "Published at": r.published_at, Mode: "snapshot" } });
  await record(format === "pptx" ? "download_pptx" : "download_xlsx", user);
  await db.from("analytics_exports").insert({ survey_id: r.survey_id, report_id: r.report_id, format, settings: settings ?? {}, report_version: r.version, bytes: buf.length, created_by: user?.userId ?? null, share_id: r.share_id });
  void audit({ action: "analytics.report_downloaded", userId: user?.userId ?? null, surveyId: r.survey_id, entity: "analytics", entityId: r.share_id, detail: { name: r.report_name, format, version: r.version, viewer: user?.email ?? "share link" } });
  const filename = `${(r.report_name ?? "report").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "report"}_v${r.version}.${format}`;
  return new NextResponse(new Uint8Array(buf), { status: 200, headers: { ...noStore, "content-type": format === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${filename}"` } });
}
