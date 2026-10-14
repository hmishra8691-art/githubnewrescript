import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireUser } from "@/lib/guard";
import { byokDeps, readJson } from "@/lib/byok/server";
import { testConnection } from "@/lib/byok/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** TEST CONNECTION — one tiny real request to the configuration in the body, with a typed key or one of MY saved keys. Answers in words; never echoes the provider's text or the key. */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Send the settings as JSON." }, { status: 400 });
  const r = await testConnection(user.userId, body, await byokDeps(user));
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code, ...(r.errors ? { problems: r.errors } : {}) }, { status: r.status, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ ok: true, result: r.result }, { headers: { "cache-control": "no-store" } });
}
