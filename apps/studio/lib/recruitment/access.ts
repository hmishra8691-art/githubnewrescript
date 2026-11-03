import "server-only";
import { NextResponse } from "next/server";
import { isFailure, type AuthedUser, type GuardFailure } from "@/lib/guard";

/**
 * WHO MAY DO WHAT WITH THE RECRUITMENT EXCHANGE (2026-11-03). No new permission model — the same shape as alerts
 * (lib/notify/access.ts), because a vendor relationship is the same KIND of thing as an alert channel: it belongs
 * to the organisation, not to a study.
 *
 *   the vendor directory, integrations,   its members whose platform role is platform_admin, programmer or
 *   rate cards and commercial terms       researcher; platform admins for any organisation. Clients and viewers
 *                                         do not see CPI, margin or what a vendor costs — that is commercial
 *                                         information about the organisation, and a client of a project is
 *                                         frequently the party being billed.
 *   a study's recruitment project,        the project's own capabilities: `fieldwork.read` to read (the role model
 *   allocation and orders                 already has a `vendor` role holding exactly that), and `deploy.manage`
 *                                         to authorise an allocation or place an order — the capability that
 *                                         ships links, and the nearest existing capability to spending money.
 *
 * Authorising an allocation is the one action here that commits real money, so it is deliberately NOT given to
 * everyone who can read the dashboard.
 */
export interface RecruitmentActor {
  userId: string;
  customerId: string;
  email: string | null;
  /** may configure vendors, rate cards and commercial terms */
  canManage: boolean;
  user: AuthedUser;
}

const MANAGING_ROLES = ["platform_admin", "programmer", "researcher"];

export function recruitmentActor(authed: AuthedUser | GuardFailure): RecruitmentActor | GuardFailure {
  if (isFailure(authed)) return authed;
  if (!authed.customerId && !authed.isPlatformAdmin) {
    return { response: NextResponse.json({ error: "Your account belongs to no organisation, so it has no sample vendors." }, { status: 409 }) };
  }
  return {
    userId: authed.userId,
    customerId: authed.customerId ?? "",
    email: authed.email,
    canManage: authed.isPlatformAdmin || MANAGING_ROLES.includes(authed.platformRole),
    user: authed,
  };
}

export const noStore = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export const refuseManage = () =>
  noStore({ error: "Only programmers, researchers and administrators of your organisation can configure sample vendors." }, 403);

export const refuseSpend = () =>
  noStore({ error: "Authorising an allocation or placing an order needs the right to deploy this project." }, 403);
