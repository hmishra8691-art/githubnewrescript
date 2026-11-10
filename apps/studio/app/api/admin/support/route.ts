import { NextRequest, NextResponse } from "next/server";
import { audit, isFailure, requireAdmin } from "@/lib/guard";
import { supabaseAdmin } from "@/lib/admin";
import { helpUsage, type UsageRow } from "@/lib/help/usage";
import { cacheStats } from "@/lib/help/cache";

export const dynamic = "force-dynamic";

/**
 * SUPPORT TICKETS AND HELP USAGE (2026-11-10) — platform administrators only.
 *   GET   ?status=open|in_progress|resolved|closed|all&days=30
 *         the tickets (newest first, 100) and the Help usage for the period: answers per level, model calls, cache
 *         hits, charge, escalations offered, "did this solve it" — aggregated from help_messages (lib/help/usage.ts)
 *   PATCH { id, status?, resolution? }  work a ticket; audited
 */
const json = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "cache-control": "no-store" } });
const STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
const missing = (m?: string) => !!m && /support_tickets|help_messages|does not exist|schema cache/i.test(m);
const noDb = () => !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;
  if (noDb()) return json({ error: "There is no database on this installation to read tickets from.", code: "no_database" }, 501);
  const db = supabaseAdmin();
  const status = req.nextUrl.searchParams.get("status") ?? "open";
  const days = Math.max(1, Math.min(365, Number(req.nextUrl.searchParams.get("days") ?? 30) || 30));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  let q = db.from("support_tickets").select("id, reference, user_email, survey_id, subject, reason, message, transcript, diagnostics, attempts, context, status, resolution, emailed, created_at, updated_at").order("created_at", { ascending: false }).limit(100);
  if ((STATUSES as readonly string[]).includes(status)) q = q.eq("status", status);
  const { data: tickets, error } = await q;
  const ticketsNote = error ? (missing(error.message) ? "Tickets are not stored until supabase/migrations/0095_support_tickets.sql is applied." : error.message) : null;

  const rows: UsageRow[] = [];
  let usageNote: string | null = null;
  for (let page = 0; page < 20; page++) {
    const { data, error: e2 } = await db.from("help_messages").select("content, created_at").eq("role", "assistant").gte("created_at", since).order("created_at").range(page * 1000, page * 1000 + 999);
    if (e2) { usageNote = missing(e2.message) ? "Help conversations are not stored until supabase/migrations/0094_help_conversations.sql is applied." : e2.message; break; }
    rows.push(...((data ?? []) as UsageRow[]));
    if (!data || data.length < 1000) break;
  }
  return json({ ok: true, days, tickets: tickets ?? [], ticketsNote, usage: helpUsage(rows), usageNote, cache: cacheStats() });
}

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (isFailure(admin)) return admin.response;
  if (noDb()) return json({ error: "no database", code: "no_database" }, 501);
  let body: { id?: unknown; status?: unknown; resolution?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const id = typeof body.id === "string" && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : null;
  if (!id) return json({ error: "id" }, 400);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.status !== undefined) {
    if (!(STATUSES as readonly unknown[]).includes(body.status)) return json({ error: "status" }, 400);
    patch.status = body.status;
    patch.resolved_at = body.status === "resolved" || body.status === "closed" ? new Date().toISOString() : null;
  }
  if (body.resolution !== undefined) patch.resolution = typeof body.resolution === "string" ? body.resolution.slice(0, 4000) : null;
  const { data, error } = await supabaseAdmin().from("support_tickets").update(patch).eq("id", id).select("reference, status").maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: "No such ticket." }, 404);
  await audit({ action: "support.ticket_updated", userId: admin.userId, entity: "support_ticket", entityId: data.reference, detail: { reference: data.reference, status: data.status } });
  return json({ ok: true, ticket: data });
}
