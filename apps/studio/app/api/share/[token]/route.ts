import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { buildPptx, buildXlsx, buildStoryPptx, ExportUnsupportedError } from "@rescript/analytics/export";
import { composeReport, type StoryReport } from "@rescript/analytics/story";
import { loadReportFonts } from "@rescript/reportvideo";
import { join } from "node:path";
import { DEFAULT_THEME, type AnalysisResult, type ReportDefinition, type ReportTheme } from "@rescript/analytics";
import { supabaseService } from "@/lib/authServer";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { verifyPassword, hashPassword } from "@/lib/analytics";
import { assertNotReadOnly, getMeter } from "@/lib/metering";
import { needsRehash, tooManyGuesses, SHARE_GUESS_WINDOW_MS, tooManyDownloads, SHARE_DOWNLOAD_WINDOW_MS } from "@/lib/sharePassword";

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
 *   GET  /api/share/<token>                     the snapshot (401 until the password — sent in the x-share-password header, never the URL — is right)
 *   POST /api/share/<token>  { format }         PowerPoint / Excel of the same snapshot, if the share permits downloads
 *                                               (a shared STORY: PowerPoint built from the story document itself)
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
  // specific users: a signed-in platform user on the list
  let user: { userId: string; email: string } | null = null;
  /* "private" is what the sharing panel calls "Project members": a signed-in member of this survey's project can open it, nobody else (audit R-3 — it used to answer 403 to everyone, owners included) */
  if (r.access === "private") {
    const u = await requireUser(req);
    if (isFailure(u)) return { denied: deny("Sign in to view this report.", 401, { status: "sign_in", reportName: r.report_name }) };
    user = { userId: u.userId, email: u.email };
    const { data: role } = await db.rpc("rescript_project_role", { p_user: u.userId, p_survey: r.survey_id });
    if (!role) { await record("denied", user); return { denied: deny("This report is shared with the project's members only.", 403, { status: "private", reportName: r.report_name }) }; }
  } else if (r.access === "users") {
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
    /* a password may be guessed only so many times: wrong attempts are already recorded on the share, so count them (audit R-4) */
    if (password) {
      const since = new Date(Date.now() - SHARE_GUESS_WINDOW_MS).toISOString();
      const { count } = await db.from("analytics_share_access").select("id", { count: "exact", head: true }).eq("share_id", r.share_id).eq("event", "denied").gte("created_at", since);
      if (tooManyGuesses(count ?? 0)) return { denied: deny("Too many incorrect passwords. Try again in a few minutes.", 429, { status: "throttled", reportName: r.report_name }) };
    }
    const { data: sh } = await db.from("analytics_shares").select("password_hash").eq("id", r.share_id).single();
    if (!password || !sh?.password_hash || !(await verifyPassword(password, sh.password_hash))) {
      if (password) await record("denied", user);
      return { denied: deny(password ? "That password is not correct." : "This report is password protected.", 401, { status: "password", reportName: r.report_name }) };
    }
    if (needsRehash(sh.password_hash)) await db.from("analytics_shares").update({ password_hash: await hashPassword(password) }).eq("id", r.share_id);
  }
  return { r, record, user, db };
}

export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const password = req.headers.get("x-share-password");
  const res = await resolve(req, params.token, password);
  if ("denied" in res) return res.denied;
  const { r, record, user, db } = res;
  await record("view", user);

  /*
   * §36 — the frozen viewer-filter results, if this version has any.
   *
   * Read through `rescript_resolve_share_variants`, which is keyed on the
   * TOKEN rather than on a report or a version — so this route still cannot
   * name a version it was not issued against, and a revoked or expired share
   * gets nothing, exactly as with `rescript_resolve_share`. The reason it is
   * a second function and not a wider first one is that widening the first
   * would mean dropping a function every live share link depends on.
   *
   * A database without migration 0014 answers with an error, which is simply
   * "no variants" — a shared report without filter buttons, not a broken one.
   */
  let variants: { filters: { id: string; name: string }[]; results: Record<string, Record<string, AnalysisResult>> } | null = null;
  if ((r.definition?.viewerFilters ?? []).length) {
    const got = await db.rpc("rescript_resolve_share_variants", { p_token: params.token });
    const v = got.data as { filters?: { id: string; name: string }[]; results?: Record<string, Record<string, AnalysisResult>> } | null;
    if (v?.results && v.filters?.length) variants = { filters: v.filters, results: v.results };
  }
  // ONLY the snapshot leaves: no analysis ids that could be used elsewhere, no dataset spec beyond its summary
  const definition = r.definition!;
  return NextResponse.json({
    report: { name: r.report_name, title: definition.title, subtitle: definition.subtitle, blocks: definition.blocks, story: (definition as { story?: unknown }).story ?? null, storyDoc: (definition as { storyDoc?: unknown }).storyDoc ?? null, viewerSegments: definition.viewerSegments ?? [], branding: definition.branding ?? {}, widgets: (definition as unknown as { widgets?: unknown[] }).widgets ?? null, crossFilter: (definition as unknown as { crossFilter?: boolean }).crossFilter ?? false, /* §41 — the scenery travels with the dashboard, or a shared one loses its banner */ hero: (definition as unknown as { hero?: unknown }).hero ?? null, bands: (definition as unknown as { bands?: unknown[] }).bands ?? null },
    theme: r.theme ?? DEFAULT_THEME,
    results: r.snapshot,
    /* the filters this viewer may switch to, and the answer for each — no ids they could use elsewhere */
    viewerFilters: variants?.filters ?? [],
    filterResults: variants?.results ?? null,
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
  /* a public link must not be a free build farm (audit R-2): a ceiling per share per hour, and the owner's read-only wallet applies to a viewer's download as it does to the owner's */
  const since = new Date(Date.now() - SHARE_DOWNLOAD_WINDOW_MS).toISOString();
  const { count: recentDownloads } = await db.from("analytics_share_access").select("id", { count: "exact", head: true }).eq("share_id", r.share_id).in("event", ["download_pptx", "download_xlsx"]).gte("created_at", since);
  if (tooManyDownloads(recentDownloads ?? 0)) return deny("This report has been downloaded a lot in the last hour. Try again later.", 429, { status: "throttled" });
  const { data: owner } = await db.from("surveys").select("customer_id").eq("id", r.survey_id).maybeSingle();
  const blocked = await assertNotReadOnly(getMeter(), { customerId: (owner?.customer_id as string | null) ?? "sandbox", surveyId: r.survey_id }, "export");
  if (blocked) return deny("Downloads are paused for this report. Ask its owner.", 423, { status: "read_only" });
  const format = body.format === "xlsx" ? "xlsx" : "pptx";
  const report = r.definition!, results = r.snapshot ?? {}, theme = r.theme ?? DEFAULT_THEME;
  const storyDoc = (report as { storyDoc?: StoryReport }).storyDoc ?? null;
  if (storyDoc && format === "xlsx") return NextResponse.json({ error: "A story has no workbook. Download the PowerPoint or the page instead.", status: "nothing_to_export" }, { status: 422, headers: noStore });
  // a viewer may pick what to include, never restyle or recompute
  const include = body.settings?.include && typeof body.settings.include === "object" ? (body.settings.include as Record<string, boolean>) : undefined;
  const settings = include ? { include } : undefined;
  /* a build that fails is answered in a sentence (and logged with a reference), never an unhandled 500 the viewer sees as "Download not permitted" */
  let buf: Buffer;
  try {
    if (storyDoc) {
      /* a shared story is built from the story document the version froze — not from report blocks, which a story does not have */
      const fonts = loadReportFonts(join(process.cwd(), "public", "report-fonts"));
      const composed = composeReport(storyDoc, fonts.measurer, "pptx");
      buf = await buildStoryPptx({ report: storyDoc, pages: composed.pages, version: r.version ?? undefined });
    } else buf = format === "pptx"
      ? await buildPptx({ report: { ...report, date: r.published_at?.slice(0, 10) }, results, theme, settings: settings as never, meta: { dataset: `Published snapshot v${r.version}` } })
      : await buildXlsx({ report, results, theme, settings: settings as never, meta: { "Report version": r.version, "Published at": r.published_at, Mode: "snapshot" } });
  } catch (e) {
    if (e instanceof ExportUnsupportedError) return NextResponse.json({ error: e.message, status: "nothing_to_export" }, { status: 422, headers: noStore });
    const ref = Math.random().toString(36).slice(2, 8);
    console.error(`[rescript:share] download (${format}) failed (${ref}):`, e);
    return NextResponse.json({ error: `The download could not be built. Nothing was downloaded. Try again, or ask the owner of the report; quote reference ${ref}.`, status: "build_failed" }, { status: 500, headers: noStore });
  }
  await record(format === "pptx" ? "download_pptx" : "download_xlsx", user);
  await db.from("analytics_exports").insert({ survey_id: r.survey_id, report_id: r.report_id, format, settings: settings ?? {}, report_version: r.version, bytes: buf.length, created_by: user?.userId ?? null, share_id: r.share_id });
  void audit({ action: "analytics.report_downloaded", userId: user?.userId ?? null, surveyId: r.survey_id, entity: "analytics", entityId: r.share_id, detail: { name: r.report_name, format, version: r.version, viewer: user?.email ?? "share link" } });
  const filename = `${(r.report_name ?? "report").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "report"}_v${r.version}.${format}`;
  return new NextResponse(new Uint8Array(buf), { status: 200, headers: { ...noStore, "content-type": format === "pptx" ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": `attachment; filename="${filename}"` } });
}
