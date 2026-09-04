import { NextRequest, NextResponse } from "next/server";
import { avatarHue, initialsOf } from "@rescript/access";
import { supabaseService } from "@/lib/authServer";
import { audit, isFailure, notifyProject, requireProject } from "@/lib/guard";

export const dynamic = "force-dynamic";

/**
 * INTERNAL NOTES (§26).
 *
 * A collaboration layer that is structurally separate from anything a
 * respondent can reach: its own table, its own routes, and no code path from
 * it into the survey definition or the runtime. A note cannot leak into a
 * questionnaire because nothing that builds a questionnaire reads this table.
 *
 * Notes are anchored to whatever the reader was looking at — a question, a
 * panel, a version — so "check the routing after Q18" opens next to Q18
 * instead of in a general comment pile. Threads are one level deep, which is
 * what a routing discussion actually looks like.
 *
 * Reviewers and test users can comment but cannot change the survey. That is
 * the point of those roles existing, and it is the same capability check as
 * everywhere else.
 */
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.read");
  if (isFailure(ctx)) return ctx.response;

  const url = new URL(req.url);
  const includeResolved = url.searchParams.get("resolved") === "1";
  const questionId = url.searchParams.get("questionId");

  const db = supabaseService();
  let q = db
    .from("project_comments")
    .select("id, parent_id, author_id, body, target, mentions, resolved_at, resolved_by, created_at, updated_at")
    .eq("survey_id", params.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(500);
  if (!includeResolved) q = q.is("resolved_at", null);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const ids = [...new Set(rows.flatMap((r) => [r.author_id, r.resolved_by]).filter(Boolean))] as string[];
  const people = new Map<string, { name: string; code: string }>();
  if (ids.length) {
    const { data: profiles } = await db.from("profiles").select("id, full_name, user_code").in("id", ids);
    for (const p of profiles ?? []) people.set(p.id, { name: p.full_name ?? "", code: p.user_code ?? "" });
  }

  const shape = (r: (typeof rows)[number]) => {
    const who = people.get(r.author_id);
    return {
      id: r.id,
      parentId: r.parent_id,
      author: {
        userId: r.author_id,
        name: who?.name ?? "Unknown",
        userCode: who?.code ?? "",
        initials: initialsOf(who?.name, "?"),
        hue: avatarHue(r.author_id),
        isMe: r.author_id === ctx.user.userId,
      },
      body: r.body,
      target: r.target as Record<string, unknown>,
      mentions: r.mentions as string[],
      resolved: !!r.resolved_at,
      resolvedAt: r.resolved_at,
      resolvedBy: r.resolved_by ? people.get(r.resolved_by)?.name ?? null : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      /** an author may edit or delete their own; the owner may moderate any */
      mine: r.author_id === ctx.user.userId,
      canModerate: r.author_id === ctx.user.userId || ctx.role === "owner",
    };
  };

  const filtered = questionId
    ? rows.filter((r) => (r.target as { questionId?: string } | null)?.questionId === questionId
        || rows.some((p) => p.id === r.parent_id && (p.target as { questionId?: string } | null)?.questionId === questionId))
    : rows;

  const threads = filtered
    .filter((r) => !r.parent_id)
    .map((root) => ({
      ...shape(root),
      replies: filtered.filter((r) => r.parent_id === root.id).map(shape),
    }));

  return NextResponse.json({
    threads,
    openCount: rows.filter((r) => !r.parent_id && !r.resolved_at).length,
    canComment: ctx.role ? ["owner", "editor", "programmer", "reviewer", "test_user", "deployment_manager"].includes(ctx.role) : false,
    canResolve: ctx.role ? ["owner", "editor", "programmer", "reviewer"].includes(ctx.role) : false,
  }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "comment.create");
  if (isFailure(ctx)) return ctx.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const text = String(body?.body ?? "").trim();
  if (!text) return NextResponse.json({ error: "Write a note first." }, { status: 400 });
  if (text.length > 8000) return NextResponse.json({ error: "That note is too long (8000 characters maximum)." }, { status: 400 });

  const parentId = body?.parentId ? String(body.parentId) : null;
  const target = body?.target && typeof body.target === "object" ? body.target : {};

  const db = supabaseService();
  if (parentId) {
    const { data: parent } = await db
      .from("project_comments").select("id, survey_id, parent_id").eq("id", parentId).maybeSingle();
    if (!parent || parent.survey_id !== params.id) {
      return NextResponse.json({ error: "Unknown note." }, { status: 404 });
    }
    if (parent.parent_id) {
      return NextResponse.json({ error: "Reply to the note itself rather than to a reply." }, { status: 400 });
    }
  }

  /*
   * Mentions are resolved to project MEMBERS only. A mention that reached
   * someone with no access to the project would either notify a stranger or
   * dangle — both worse than quietly not being a mention.
   */
  let mentions: string[] = [];
  if (Array.isArray(body?.mentions) && body.mentions.length) {
    const { data: members } = await db.rpc("rescript_project_members", { p_survey: params.id, p_present_within_seconds: 60 });
    const allowed = new Set(((members ?? []) as { user_id: string }[]).map((m) => m.user_id));
    mentions = body.mentions.map(String).filter((id: string) => allowed.has(id)).slice(0, 20);
  }

  const { data: created, error } = await db
    .from("project_comments")
    .insert({ survey_id: params.id, author_id: ctx.user.userId, parent_id: parentId, body: text, target, mentions })
    .select("id, created_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await audit({
    action: "comment.created", userId: ctx.user.userId, sessionId: ctx.user.sessionId,
    surveyId: params.id, customerId: ctx.user.customerId,
    detail: { commentId: created.id, reply: !!parentId, target },
  });
  await notifyProject({
    surveyId: params.id, action: "comment.created",
    exceptUserId: ctx.user.userId,
    onlyUserIds: mentions.length ? mentions : undefined,
    detail: { actorName: ctx.user.fullName, excerpt: text.slice(0, 140), commentId: created.id, mentioned: mentions.length > 0 },
  });

  return NextResponse.json({ ok: true, id: created.id, createdAt: created.created_at });
}

/** Resolve, reopen, edit or delete a note. */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const ctx = await requireProject(req, params.id, "project.read");
  if (isFailure(ctx)) return ctx.response;

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const commentId = String(body?.commentId ?? "");
  if (!commentId) return NextResponse.json({ error: "Which note?" }, { status: 400 });

  const db = supabaseService();
  const { data: comment } = await db
    .from("project_comments").select("id, survey_id, author_id, resolved_at").eq("id", commentId).maybeSingle();
  if (!comment || comment.survey_id !== params.id) return NextResponse.json({ error: "Unknown note." }, { status: 404 });

  const isAuthor = comment.author_id === ctx.user.userId;
  const isOwner = ctx.role === "owner";
  const canResolve = ctx.role ? ["owner", "editor", "programmer", "reviewer"].includes(ctx.role) : false;

  if (typeof body?.resolved === "boolean") {
    if (!canResolve) return NextResponse.json({ error: "Your role cannot resolve notes." }, { status: 403 });
    await db.from("project_comments").update({
      resolved_at: body.resolved ? new Date().toISOString() : null,
      resolved_by: body.resolved ? ctx.user.userId : null,
      updated_at: new Date().toISOString(),
    }).eq("id", commentId);
    if (body.resolved) {
      await audit({
        action: "comment.resolved", userId: ctx.user.userId, sessionId: ctx.user.sessionId,
        surveyId: params.id, customerId: ctx.user.customerId, detail: { commentId },
      });
    }
    return NextResponse.json({ ok: true, resolved: body.resolved });
  }

  if (typeof body?.body === "string") {
    if (!isAuthor) return NextResponse.json({ error: "Only the author can edit a note." }, { status: 403 });
    const text = body.body.trim();
    if (!text) return NextResponse.json({ error: "A note cannot be empty." }, { status: 400 });
    await db.from("project_comments").update({ body: text.slice(0, 8000), updated_at: new Date().toISOString() }).eq("id", commentId);
    return NextResponse.json({ ok: true });
  }

  if (body?.delete === true) {
    if (!isAuthor && !isOwner) return NextResponse.json({ error: "Only the author or the project owner can delete a note." }, { status: 403 });
    // soft, and with the replies, so a thread never renders half-missing
    const now = new Date().toISOString();
    await db.from("project_comments").update({ deleted_at: now }).eq("id", commentId);
    await db.from("project_comments").update({ deleted_at: now }).eq("parent_id", commentId);
    await audit({
      action: "comment.deleted", userId: ctx.user.userId, sessionId: ctx.user.sessionId,
      surveyId: params.id, customerId: ctx.user.customerId, detail: { commentId, viaOwner: !isAuthor },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
}
