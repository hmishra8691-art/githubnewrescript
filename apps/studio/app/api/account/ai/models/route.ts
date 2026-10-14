import { NextRequest, NextResponse } from "next/server";
import { isFailure, requireUser } from "@/lib/guard";
import { byokDeps, readJson } from "@/lib/byok/server";
import { modelsFor } from "@/lib/byok/service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** The models a provider offers THIS key (typed, or one of MY saved keys) — or suggestions and a sentence when the provider does not list them. */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const body = await readJson(req);
  if (!body) return NextResponse.json({ error: "Send the request as JSON." }, { status: 400 });
  const r = await modelsFor(user.userId, body, await byokDeps(user));
  if (!r.ok) return NextResponse.json({ error: r.message, code: r.code, ...(r.errors ? { problems: r.errors } : {}) }, { status: r.status, headers: { "cache-control": "no-store" } });
  return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
}
