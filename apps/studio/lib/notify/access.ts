import "server-only";
import { NextResponse } from "next/server";
import { isFailure, type AuthedUser, type GuardFailure } from "@/lib/guard";
import { notifySandbox } from "./server.ts";

/**
 * WHO MAY DO WHAT WITH ALERTS (2026-10-22, G3). No new permission model:
 *
 *   an organisation's channels and rules   its members whose platform role is platform_admin, programmer or researcher
 *                                          (clients and viewers do not configure where the organisation's alerts go);
 *                                          platform admins for any organisation
 *   a project's alerts, deliveries, panels the project's own capabilities (routes: responses.read to read,
 *                                          deploy.manage to change panels and secrets — the capability that ships links)
 *   my bell                                me
 *
 * The SANDBOX (no database, fake provider, not production) has one organisation and one person, "sandbox".
 */
export interface NotifyActor { userId: string; customerId: string; email: string | null; canManage: boolean; sandbox: boolean; user: AuthedUser | null }
export const SANDBOX_ORG = "sandbox";
export const SANDBOX_USER = "sandbox-user";

export function notifyActor(authed: AuthedUser | GuardFailure): NotifyActor | GuardFailure {
  if (isFailure(authed)) {
    if (notifySandbox()) return { userId: SANDBOX_USER, customerId: SANDBOX_ORG, email: null, canManage: true, sandbox: true, user: null };
    return authed;
  }
  if (!authed.customerId && !authed.isPlatformAdmin) return { response: NextResponse.json({ error: "Your account belongs to no organisation, so it has no alert channels." }, { status: 409 }) };
  return { userId: authed.userId, customerId: authed.customerId ?? "", email: authed.email, canManage: authed.isPlatformAdmin || ["platform_admin", "programmer", "researcher"].includes(authed.platformRole), sandbox: false, user: authed };
}

export const noStore = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
export const refuseManage = () => noStore({ error: "Only programmers, researchers and administrators of your organisation can change where its alerts go." }, 403);
