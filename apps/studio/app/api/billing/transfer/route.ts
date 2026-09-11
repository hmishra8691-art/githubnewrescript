import { NextRequest, NextResponse } from "next/server";
import { can, parseIdentifier } from "@rescript/access";
import { supabaseAdmin } from "@/lib/admin";
import { audit, isFailure, requireProjectFor, requireUser, type AuthedUser } from "@/lib/guard";
import { getMeter } from "@/lib/metering";

export const dynamic = "force-dynamic";

/**
 * TRANSFER MY OWN CREDITS.
 *
 * Credits belong to the person or the project that holds them, so the person
 * who holds them is who moves them. An administrator could already do this
 * for anyone; this is the same engine — the same atomic SQL function, the
 * same two ledger lines under one transfer id — reached by the person whose
 * balance it actually is.
 *
 *   POST { action: "resolve", userCode }
 *        → { user: { userCode, name } }   who the recipient is, for the
 *          confirmation sentence. Same workspace only: this is not a lookup
 *          oracle for the whole installation.
 *
 *   POST { source?: { type: "project", id } , toUserCode | toProjectId, amount, message? }
 *        → { ok, transfer, source, destination }
 *          402 when the available balance is short · 403 when the source is
 *          not theirs to spend · 400 for a transfer to oneself
 *
 *   GET  → this person's own transfers, sent and received.
 *
 * WHAT MAY BE SPENT, AND BY WHOM.
 *   · their own wallet — theirs, no capability needed;
 *   · a project's wallet — only with `billing.transfer` on that project,
 *     which is the owner. An editor programs the survey; the owner decides
 *     what the budget is for.
 * And only the AVAILABLE balance: what an open reservation holds for an
 * operation in flight is not theirs to give away, and neither is overdraft
 * room. `Meter.transfer` enforces that; nothing here re-implements it.
 */

async function personalWallet(user: AuthedUser, create: boolean) {
  return getMeter().store.walletForUser(user.customerId ?? "", user.userId, { create });
}

/** The wallet this person is allowed to spend from, and the words for it. */
async function resolveSource(
  req: NextRequest,
  user: AuthedUser,
  source: unknown,
): Promise<{ walletId: string; label: string } | { response: NextResponse }> {
  const kind = (source as { type?: string } | null)?.type;
  if (!source || kind === "user" || kind === undefined) {
    const w = await personalWallet(user, true);
    if (!w) return { response: NextResponse.json({ error: "You have no credit wallet yet." }, { status: 404 }) };
    return { walletId: w.id, label: "your own credits" };
  }
  if (kind !== "project") return NextResponse.json({ error: "source.type must be user or project" }, { status: 400 }) as never;
  const id = String((source as { id?: string }).id ?? "");
  if (!id) return { response: NextResponse.json({ error: "source.id is required" }, { status: 400 }) };
  const gate = await requireProjectFor(user, id, "billing.transfer");
  if (isFailure(gate)) {
    return { response: NextResponse.json({
      error: "Only a project's owner can move its credits. Ask the owner, or transfer from your own credits instead.",
      code: "not_your_project",
    }, { status: 403 }) };
  }
  const w = await getMeter().walletFor({ customerId: gate.survey.customer_id ?? user.customerId ?? "", surveyId: id }, true);
  if (!w) return { response: NextResponse.json({ error: "That project has no wallet yet." }, { status: 404 }) };
  return { walletId: w.id, label: gate.survey.title };
}

/** The recipient, by User ID — within the sender's workspace. */
async function findRecipient(user: AuthedUser, raw: string): Promise<{ id: string; userCode: string; name: string } | null> {
  const ident = parseIdentifier(raw);
  if (ident.kind === "unknown") return null;
  const db = supabaseAdmin();
  let q = db.from("profiles").select("id, user_code, full_name, email, status, customer_id");
  q = ident.kind === "email" ? q.eq("email", ident.value) : q.eq("user_code", ident.value);
  const { data } = await q.maybeSingle();
  if (!data || data.status === "disabled") return null;
  /* a colleague, not a stranger: the same workspace, exactly as project sharing requires */
  if (user.customerId && data.customer_id && data.customer_id !== user.customerId) return null;
  return { id: data.id, userCode: data.user_code, name: data.full_name || data.email || data.user_code };
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }

  if (body?.action === "resolve") {
    const who = await findRecipient(user, String(body?.userCode ?? ""));
    if (!who) return NextResponse.json({ error: "No one in your workspace has that User ID.", code: "unknown_recipient" }, { status: 404 });
    if (who.id === user.userId) return NextResponse.json({ error: "That is your own User ID.", code: "self_transfer" }, { status: 400 });
    return NextResponse.json({ ok: true, user: { userCode: who.userCode, name: who.name } });
  }

  const amount = Number(body?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return NextResponse.json({ error: "Enter an amount greater than zero." }, { status: 400 });
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 2000) || null : null;

  const src = await resolveSource(req, user, body?.source);
  if ("response" in src) return src.response;

  /* the destination: a person by User ID, or one of this person's projects */
  let destWalletId: string | null = null;
  let destLabel = "";
  let recipientId: string | null = null;
  if (typeof body?.toUserCode === "string" && body.toUserCode.trim()) {
    const who = await findRecipient(user, body.toUserCode);
    if (!who) return NextResponse.json({ error: "No one in your workspace has that User ID.", code: "unknown_recipient" }, { status: 404 });
    if (who.id === user.userId && (!body?.source || body.source?.type === "user")) {
      return NextResponse.json({ error: "You cannot transfer credits to yourself.", code: "self_transfer" }, { status: 400 });
    }
    const w = await getMeter().store.walletForUser(user.customerId ?? "", who.id, { create: true });
    if (!w) return NextResponse.json({ error: "That person has no credit wallet." }, { status: 404 });
    destWalletId = w.id; destLabel = `${who.name} (${who.userCode})`; recipientId = who.id;
  } else if (typeof body?.toProjectId === "string" && body.toProjectId.trim()) {
    const gate = await requireProjectFor(user, body.toProjectId.trim(), "billing.read");
    if (isFailure(gate)) return NextResponse.json({ error: "You cannot add credits to a project you cannot open." }, { status: 403 });
    const w = await getMeter().walletFor({ customerId: gate.survey.customer_id ?? user.customerId ?? "", surveyId: gate.survey.id }, true);
    if (!w) return NextResponse.json({ error: "That project has no wallet." }, { status: 404 });
    destWalletId = w.id; destLabel = gate.survey.title;
  } else {
    return NextResponse.json({ error: "Name a recipient: a User ID, or one of your projects." }, { status: 400 });
  }

  if (destWalletId === src.walletId) {
    return NextResponse.json({ error: "The source and the destination are the same wallet.", code: "self_transfer" }, { status: 400 });
  }

  try {
    const r = await getMeter().transfer({
      sourceWalletId: src.walletId, destinationWalletId: destWalletId,
      amount, reason: "User transfer", note: message, by: user.userId,
    });
    if (!r.ok) {
      const status = r.reason === "insufficient_available" ? 402 : 400;
      return NextResponse.json({ error: r.message, code: `transfer_${r.reason}`, available: r.available ?? null }, { status });
    }
    await audit({
      action: "billing.credits_transferred", userId: user.userId, sessionId: user.sessionId, customerId: user.customerId,
      entity: "credit_transfer", entityId: r.transfer.id,
      detail: { code: r.transfer.code, amount, from: src.label, to: destLabel, recipientId, byOwner: true },
    });
    return NextResponse.json({
      ok: true,
      transfer: { ...r.transfer, sourceLabel: src.label, destinationLabel: destLabel },
      source: { balance: r.source.balance, currency: r.source.currency },
      destination: { balance: r.destination.balance },
    });
  } catch (e) {
    const msg = (e as Error).message;
    const unavailable = /relation .* does not exist|function .* does not exist|schema cache/i.test(msg);
    return NextResponse.json({ error: unavailable ? "Credit transfers are not enabled on this installation yet (migration 0024)." : msg, code: unavailable ? "billing_unavailable" : "billing_error" }, { status: unavailable ? 501 : 503 });
  }
}

/** This person's own transfers — what they sent and what they received. Nobody else's. */
export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const meter = getMeter();
  try {
    const mine = await personalWallet(user, false);
    const projects = await ownedProjectWalletIds(user);
    const walletIds = new Set([...(mine ? [mine.id] : []), ...projects.ids]);
    if (!walletIds.size) return NextResponse.json({ ok: true, transfers: [], wallet: null, projects: [] });

    const all = await meter.store.listTransfers({ customerId: user.customerId ?? undefined, limit: 500 });
    const involved = all.filter((t) => walletIds.has(t.sourceWalletId) || walletIds.has(t.destinationWalletId));
    const names = await labelsFor(user, involved.flatMap((t) => [t.sourceRef, t.destinationRef]).filter(Boolean) as string[]);
    return NextResponse.json({
      ok: true,
      wallet: mine ? { id: mine.id, balance: mine.balance, reserved: mine.reserved, available: Math.max(0, Math.round((mine.balance - mine.reserved) * 1e6) / 1e6), currency: mine.currency, totalAdded: mine.totalAdded } : null,
      projects: projects.list,
      transfers: involved.map((t) => ({
        id: t.id, code: t.code, at: t.createdAt, amount: t.amount, currency: t.currency, status: t.status,
        /* "Sent" and "Received" are from THIS person's point of view */
        direction: walletIds.has(t.sourceWalletId) ? "sent" : "received",
        counterparty: walletIds.has(t.sourceWalletId)
          ? names[t.destinationRef ?? ""] ?? "—"
          : names[t.sourceRef ?? ""] ?? "—",
        from: names[t.sourceRef ?? ""] ?? "—",
        to: names[t.destinationRef ?? ""] ?? "—",
        message: t.note, reversalOf: t.reversalOf,
      })),
    });
  } catch (e) {
    const msg = (e as Error).message;
    const unavailable = /relation .* does not exist|function .* does not exist|schema cache/i.test(msg);
    return NextResponse.json({ error: unavailable ? "Credit transfers are not enabled on this installation yet (migration 0024)." : msg, code: unavailable ? "billing_unavailable" : "billing_error" }, { status: unavailable ? 501 : 503 });
  }
}

/** The projects this person may spend from, with their wallets. */
async function ownedProjectWalletIds(user: AuthedUser): Promise<{ ids: string[]; list: { id: string; code: string; title: string; walletId: string | null; balance: number; available: number; currency: string }[] }> {
  const db = supabaseAdmin();
  const { data: mine } = await db.rpc("rescript_my_projects", { p_user: user.userId, p_lock_stale_seconds: user.policies.lock.staleAfterSeconds });
  const rows = ((mine ?? []) as { survey_id: string; code: string; title: string; my_role: string }[])
    .filter((r) => can(r.my_role as never, "billing.transfer"));
  if (!rows.length) return { ids: [], list: [] };
  const wallets = await getMeter().store.listWallets({ customerId: user.customerId ?? undefined });
  const byProject = new Map(wallets.filter((w) => w.surveyId).map((w) => [w.surveyId!, w]));
  const list = rows.map((r) => {
    const w = byProject.get(r.survey_id);
    return {
      id: r.survey_id, code: r.code, title: r.title,
      walletId: w?.id ?? null, balance: w?.balance ?? 0,
      available: w ? Math.max(0, Math.round((w.balance - w.reserved) * 1e6) / 1e6) : 0,
      currency: w?.currency ?? "USD",
    };
  });
  return { ids: list.map((p) => p.walletId).filter(Boolean) as string[], list };
}

/** Readable names for the refs a transfer names — projects by title, people by name. */
async function labelsFor(user: AuthedUser, refs: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const unique = [...new Set(refs)];
  if (!unique.length) return out;
  const db = supabaseAdmin();
  const [{ data: ss }, { data: ps }] = await Promise.all([
    db.from("surveys").select("id, code, title").in("id", unique),
    db.from("profiles").select("id, full_name, email, user_code").in("id", unique),
  ]);
  for (const s of ss ?? []) out[s.id] = `${s.title} · ${s.code}`;
  for (const p of ps ?? []) out[p.id] = p.id === user.userId ? "You" : `${p.full_name || p.email} (${p.user_code})`;
  return out;
}
