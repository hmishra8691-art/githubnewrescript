import { NextRequest, NextResponse } from "next/server";
import { platformDb } from "@/lib/db";
import { audit, isFailure, requireUser } from "@/lib/guard";
import { cleanScopes, newApiKey, API_SCOPES, SCOPE_WORDS } from "@/lib/apiKeysCore";

export const dynamic = "force-dynamic";

/**
 * YOUR API KEYS (audit 2026-11-17, P2-13). A key acts as you — never more than your own project roles allow — within
 * the scopes you give it. The key is shown once, on creation; only its hash is kept.
 *
 *   GET                                   your keys (name, prefix, scopes, created, last used, expiry, revoked)
 *   POST   { name, scopes, expiresInDays? }  a new key → { key } once
 *   DELETE ?id=…                          revoke one of your keys (immediately)
 */
const missing = (m: string) => /api_keys|does not exist|schema cache/i.test(m);
const unavailable = () => NextResponse.json({ error: "API keys need migration 0100 (api_keys) on this server.", migration: "0100" }, { status: 503 });

export async function GET(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const { data, error } = await platformDb().from("api_keys").select("id, name, prefix, scopes, created_at, expires_at, last_used_at, revoked_at").eq("user_id", user.userId).order("created_at", { ascending: false });
  if (error) return missing(error.message) ? unavailable() : NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ keys: data ?? [], scopes: API_SCOPES.map((s) => ({ id: s, label: SCOPE_WORDS[s] })) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 80) : "";
  const scopes = cleanScopes(body?.scopes);
  if (!name) return NextResponse.json({ error: "Give the key a name, so you can tell it apart later." }, { status: 400 });
  if (!scopes) return NextResponse.json({ error: `Choose at least one scope: ${API_SCOPES.join(", ")}.` }, { status: 400 });
  const days = Number(body?.expiresInDays ?? 0);
  const expiresAt = Number.isFinite(days) && days > 0 ? new Date(Date.now() + Math.min(days, 730) * 86_400_000).toISOString() : null;
  const k = newApiKey();
  const { data, error } = await platformDb().from("api_keys").insert({ user_id: user.userId, customer_id: user.customerId, name, prefix: k.prefix, key_hash: k.hash, scopes, expires_at: expiresAt }).select("id").single();
  if (error) return missing(error.message) ? unavailable() : NextResponse.json({ error: error.message }, { status: 500 });
  await audit({ action: "api_key.created", userId: user.userId, sessionId: user.sessionId, customerId: user.customerId, entity: "api_key", entityId: data.id, detail: { name, prefix: k.prefix, scopes, expiresAt } });
  return NextResponse.json({ ok: true, id: data.id, key: k.key, prefix: k.prefix, scopes, expiresAt, note: "Copy this key now — it is not shown again." }, { headers: { "cache-control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  const user = await requireUser(req);
  if (isFailure(user)) return user.response;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Name the key to revoke." }, { status: 400 });
  const { data, error } = await platformDb().from("api_keys").update({ revoked_at: new Date().toISOString() }).eq("id", id).eq("user_id", user.userId).is("revoked_at", null).select("id, name, prefix");
  if (error) return missing(error.message) ? unavailable() : NextResponse.json({ error: error.message }, { status: 500 });
  if (!data?.length) return NextResponse.json({ error: "No such active key of yours." }, { status: 404 });
  await audit({ action: "api_key.revoked", userId: user.userId, sessionId: user.sessionId, customerId: user.customerId, entity: "api_key", entityId: id, detail: { name: data[0].name, prefix: data[0].prefix } });
  return NextResponse.json({ ok: true });
}
