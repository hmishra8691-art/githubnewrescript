import { NextRequest, NextResponse } from "next/server";
import type { PanelConfig } from "@rescript/schema";
import { outcomeForSurveyEnd } from "@rescript/engine";
import { supabaseAdmin } from "@/lib/admin";
import { runtimePanels } from "@/lib/panels";

export const dynamic = "force-dynamic";

/**
 * THE SURVEY LINK'S SIGNED PANEL EXIT (2026-10-22, G3) — GET /api/panel/exit?r=<response id>.
 *
 * A survey's end redirect is built in the respondent's browser, which must never hold a panel's signing secret —
 * and must not be trusted to say how the survey ended. So a survey whose panel signs its end links sends every end
 * here (`…/api/panel/exit?r={{response.id}}`, set from the Studio's Panels box), and this route:
 *
 *   1. reads the response's FINAL status from the database (in progress → no exit: nothing to report yet);
 *   2. maps it to the panel's outcome (complete / screened → screen-out / quota full / terminated);
 *   3. builds the panel's end link from the DEPLOYED definition's panel settings, signs it with the secret opened
 *      for this call, records the outcome once on the panel entry (the first outcome stands), and redirects.
 *
 * Who may call: anyone holding a response id (a random UUID, the respondent's own) — the answer is only ever that
 * respondent's own end link, which is what their browser was about to visit anyway. A code-only panel (MTurk-style)
 * gets a page showing the code.
 */
const page = (title: string, body: string, status = 200) => new NextResponse(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1f2a44"><h1 style="font-size:22px">${title}</h1>${body}</body>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function GET(req: NextRequest) {
  const r = req.nextUrl.searchParams.get("r") ?? "";
  if (!/^[0-9a-f-]{16,64}$/i.test(r)) return page("This link is not valid", "<p>Please return to the panel you came from.</p>", 400);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return page("Thank you", "<p>(Test environment: the panel exit needs a database.)</p>", 503);
  const db = supabaseAdmin();
  const { data: resp } = await db.from("responses").select("session_id, survey_id, version_id, status, is_test, deleted_at").eq("session_id", r).maybeSingle();
  if (!resp || resp.deleted_at) return page("This link is not valid", "<p>Please return to the panel you came from.</p>", 404);
  const outcome = outcomeForSurveyEnd(String(resp.status));
  if (!outcome) return page("Not finished yet", "<p>This survey has not been completed yet. Please go back and finish it.</p>", 409);
  const { data: ver } = resp.version_id ? await db.from("survey_versions").select("definition").eq("id", resp.version_id).maybeSingle() : { data: null };
  const panels = ((ver?.definition as { panels?: PanelConfig[] } | null)?.panels ?? []) as PanelConfig[];
  const port = runtimePanels({ panels });
  const out = port ? await port.exit({ sessionRef: String(resp.session_id), outcome, status: String(resp.status) }) : null;
  if (!out) return page("Thank you", "<p>Thank you for taking part. You can close this page.</p>");
  if (out.url) return NextResponse.redirect(out.url, { status: 302, headers: { "cache-control": "no-store" } });
  return page("Thank you", `<p>Thank you for taking part.</p>${out.showCode && out.code ? `<p>Your code: <b data-testid="panel-code">${esc(out.code)}</b></p><p>Copy it back into ${esc(out.panel)}.</p>` : "<p>Please return to the panel you came from.</p>"}`);
}
