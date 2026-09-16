import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import { isFailure, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The projects this person can see: their own, plus their workspace's. */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("interview_projects")
    .select("id, code, name, description, status, owner_id, created_at, retention_days")
    .eq("customer_id", user.customerId ?? "")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: "We could not load your projects." }, { status: 503 });

  /* one query for the counts rather than one per project — a hiring team with
     forty projects should not make forty round trips to draw a list */
  const ids = (data ?? []).map((p) => p.id);
  const counts = new Map<string, { total: number; completed: number }>();
  if (ids.length) {
    const { data: rows } = await db
      .from("interviews")
      .select("project_id, status")
      .in("project_id", ids)
      .is("deleted_at", null);
    for (const r of rows ?? []) {
      const c = counts.get(r.project_id) ?? { total: 0, completed: 0 };
      c.total++;
      if (["completed", "processing", "processed"].includes(r.status)) c.completed++;
      counts.set(r.project_id, c);
    }
  }

  return NextResponse.json({
    ok: true,
    projects: (data ?? []).map((p) => ({
      ...p,
      isOwner: p.owner_id === user.userId,
      interviews: counts.get(p.id) ?? { total: 0, completed: 0 },
    })),
  });
}

/**
 * Create one.
 *
 * The creator becomes the owner, which is what makes the billing work: the
 * wallet an interview project draws on is resolved through
 * `interview_projects.owner_id` to that person's personal wallet, exactly as
 * a survey's is through `surveys.owner_id`. A project with no owner would
 * fall through to the workspace wallet, which is a decision nobody made.
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  if (!user.customerId) {
    return NextResponse.json({ error: "Your account is not in a workspace yet." }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "A project needs a name." }, { status: 400 });

  const db = supabaseAdmin();
  const code = await uniqueCode(db, user.customerId, body?.code ?? name);

  const { data, error } = await db.from("interview_projects").insert({
    customer_id: user.customerId,
    owner_id: user.userId,
    created_by: user.userId,
    code,
    name: name.slice(0, 200),
    description: String(body?.description ?? "").slice(0, 2000),
    instructions: String(body?.instructions ?? "").slice(0, 8000),
    consent_text: String(body?.consentText ?? DEFAULT_CONSENT).slice(0, 8000),
    retention_days: Number.isInteger(body?.retentionDays) ? body.retentionDays : 90,
  }).select("*").single();
  if (error) return NextResponse.json({ error: "We could not create that project." }, { status: 503 });

  return NextResponse.json({ ok: true, project: data }, { status: 201 });
}

/**
 * The default a company gets if they write nothing.
 *
 * Deliberately complete rather than a placeholder: a consent statement is the
 * one piece of copy where an empty default becomes a live product with no
 * consent statement, and nobody notices until it matters.
 */
const DEFAULT_CONSENT = [
  "This interview is recorded.",
  "",
  "Your video and audio answers are recorded and stored securely, and are shared with the "
  + "hiring team for this role. A written transcript is produced from your answers. You can "
  + "stop at any time by closing this page.",
  "",
  "By continuing you confirm that you are happy to be recorded for this purpose.",
].join("\n");

async function uniqueCode(db: ReturnType<typeof supabaseAdmin>, customerId: string, from: string): Promise<string> {
  const base = String(from).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 16) || "PROJECT";
  for (let n = 0; n < 50; n++) {
    const code = n === 0 ? base : `${base}_${n + 1}`;
    const { data } = await db.from("interview_projects")
      .select("id").eq("customer_id", customerId).eq("code", code).maybeSingle();
    if (!data) return code;
  }
  return `${base}_${Date.now().toString(36).toUpperCase()}`;
}
