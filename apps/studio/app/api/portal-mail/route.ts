import { NextRequest, NextResponse } from "next/server";
import { deriveKey, verifySignedHeader } from "@rescript/ai";
import { sendMail } from "@/lib/mail";
import { resetMail } from "@/lib/portalAdminCore";

export const dynamic = "force-dynamic";

/**
 * MAIL FOR THE RESPONDENT PORTAL (phase 1, 2026-11-20). The respondent app has no mail transport; it hands a
 * self-service password-reset email to the platform's one mailer here. Not a person and no session — authenticated
 * by a SIGNATURE, like /api/notify/ingest: `x-rescript-portal-mail: t=<unix>,v1=<HMAC-SHA256(key, "t.body")>` with a
 * sub-key of INTEGRATIONS_SECRET_KEY, checked over the raw body in the handler's first statement, five-minute window,
 * refused entirely when the key is unset.
 *
 *   POST { kind: "portal_reset", to, name, respondentId, link, minutes }
 *
 * The link must be a /portal/reset link; nothing else can be mailed through here.
 */
const key = () => deriveKey("portal-mail", process.env, null);

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => ""); const k = key(); if (raw.length > 8_000 || !k || !verifySignedHeader(k, req.headers.get("x-rescript-portal-mail"), raw)) return NextResponse.json({ error: "not authorised" }, { status: 401 });
  let b: Record<string, unknown>;
  try { b = JSON.parse(raw) as Record<string, unknown>; } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const to = typeof b.to === "string" ? b.to.trim().toLowerCase() : "";
  const link = typeof b.link === "string" ? b.link : "";
  const respondentId = typeof b.respondentId === "string" ? b.respondentId : "";
  if (b.kind !== "portal_reset" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !/^https?:\/\/[^\s#]+\/portal\/reset#token=[A-Za-z0-9_-]{43}$/.test(link) || !/^RSP-[0-9A-Z]{8}$/.test(respondentId)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const m = resetMail({ name: typeof b.name === "string" ? b.name.slice(0, 200) : null, respondentId, link, minutes: Number(b.minutes) > 0 ? Math.min(1440, Number(b.minutes)) : 60 });
  const sent = await sendMail({ to, subject: m.subject, text: m.text, kind: "portal_reset", stream: "transactional" });
  return NextResponse.json({ ok: true, sent: sent.sent, ...(sent.sent ? {} : { reason: sent.reason }) });
}
