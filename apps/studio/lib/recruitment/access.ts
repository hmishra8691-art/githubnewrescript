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
  /** may work the fraud queue and the organisation's recruitment projects */
  canManage: boolean;
  /**
   * MAY SEE THE SUPPLY CHAIN: vendor names, their rate cards, their costs, and which of them a project's
   * sample was bought from.
   *
   * Platform administrators only, and deliberately narrower than `canManage`. A researcher runs recruitment
   * projects, authorises spend and reads the dashboard without ever learning that a given complete came from
   * Prolific — not because the screen hides it, but because the API never sends it. The two flags are separate
   * because the fraud review queue is research-operations work, while the vendor directory is commercial
   * information about the organisation's own supply agreements.
   */
  canSeeVendors: boolean;
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
    canSeeVendors: authed.isPlatformAdmin || authed.platformRole === "platform_admin",
    user: authed,
  };
}

export const noStore = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export const refuseManage = () =>
  noStore({ error: "Only programmers, researchers and administrators of your organisation can configure sample vendors." }, 403);

/**
 * Refused because the caller is not a platform administrator.
 *
 * The message says what the person CAN do rather than only what they cannot: a researcher reading "you may not
 * see vendors" with no further explanation reasonably concludes the feature is broken for them, when in fact
 * every recruitment action is available and only the supply chain behind it is not theirs to see.
 */
export const refuseVendorVisibility = () =>
  noStore({
    error: "The recruitment partner network is managed by your platform administrators. You can plan, authorise and monitor recruitment without it.",
    code: "vendor_visibility",
  }, 403);

export const refuseSpend = () =>
  noStore({ error: "Authorising an allocation or placing an order needs the right to deploy this project." }, 403);
