import { can, type Capability, type ProjectRole } from "@rescript/access";

/**
 * WHAT THE DATA ANALYTICS WORKSPACE MAY OFFER (the Apply audit, 2026-10-17).
 *
 * The /analytics page used to ask `can(role, …)` with the bare role from the
 * survey list. For every fixed role that is the whole answer; for a CUSTOM
 * member it is only the floor (`project.read`) — the real capabilities live in
 * the membership's per-module permissions — so a member granted Data Analytics:
 * Edit was told "no analytics access" and never saw Apply. The analytics route's
 * `access` branch answers with the membership's own capabilities
 * (`capabilitiesOf(ctx.grant)`, the set every route authorises against); this
 * decides from that when it is there, from the role when it is not, and waits
 * rather than refuses while a custom member's set is still on its way.
 */
export interface AnalyticsPermissions { waiting: boolean; canRead: boolean; canEdit: boolean; canEditPlan: boolean; canPublish: boolean; canExport: boolean }

export function analyticsPermissions(role: ProjectRole | null, capabilities: readonly string[] | null, opts: { settled?: boolean } = {}): AnalyticsPermissions {
  const allowed = (c: Capability) => (capabilities ? capabilities.includes(c) : can(role, c));
  /* a custom member waits only while the access request is in flight; once it settles without an answer, the role decides (fail open to the old behaviour — the server still enforces) */
  const waiting = role === "custom" && !capabilities && !opts.settled;
  return {
    waiting,
    canRead: !waiting && allowed("analytics.read"),
    canEdit: !waiting && allowed("analytics.edit"),
    canEditPlan: !waiting && allowed("survey.edit"),
    canPublish: !waiting && allowed("analytics.publish"),
    canExport: !waiting && allowed("analytics.export"),
  };
}
