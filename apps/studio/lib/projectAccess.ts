import {
  ACCESS_OPTIONS, CAPABILITY_LABEL, GRANTABLE_ROLES, ROLE_LABEL,
  accessLabel, can, decideAccess, describeEvent, describeExpiry, diffAccess, escalation, isExpired, isProjectRole,
  normalizePermissions, resolveExpiry, validateExpiry,
  type Actor, type AccessSubject, type AuditRow, type Capability, type CustomPermissions, type MemberGrant,
  type ProjectRole, type RoleSource,
} from "@rescript/access";

/**
 * PROJECT ACCESS — the pure half of the gate and of the collaborator routes.
 *
 * `guard.ts` and the route handlers import `server-only` and the database, so
 * nothing in them can be unit-tested; everything that DECIDES lives here and
 * is tested in `projectAccess.test.ts`. The rules themselves are not here
 * either: every answer below is `can()` / `decideAccess()` from
 * `@rescript/access`, applied to the membership the database returned.
 */

/** what `rescript_project_access` returns */
export interface AccessRow { project_role: string | null; role_source: string | null }
/** the membership columns the gate reads beside it (absent before migration 0062) */
export interface MemberRow { permissions?: unknown; expires_at?: string | null }

export type GateOutcome =
  | { ok: true; role: ProjectRole | null; roleSource: RoleSource; grant: AccessSubject; expiresAt: string | null; viaAdmin: boolean }
  | { ok: false; status: 403 | 404; body: Record<string, unknown> };

/**
 * One project-access decision. The order is the guard's, unchanged for every
 * existing role; two answers are new:
 *
 *   · `role_source = 'expired'` (migration 0062) or a membership whose
 *     `expires_at` has passed (the same check in code, so expiry holds even
 *     before the migration is applied) → 403 `access_expired`. A former
 *     member is told their access ended — they knew the project existed, so
 *     the 404 disguise protects nothing and would only confuse them.
 *   · a custom membership answers from its stored permissions: Data: None is
 *     a 403 from every data route, not merely a hidden button.
 */
export function decideProjectGate(args: {
  user: Actor;
  access: AccessRow | null | undefined;
  member: MemberRow | null | undefined;
  capability: Capability;
  now?: number;
}): GateOutcome {
  const { user, access, member, capability } = args;
  const now = args.now ?? Date.now();
  const role = isProjectRole(access?.project_role) ? (access!.project_role as ProjectRole) : null;
  const rawSource = access?.role_source ?? null;
  const roleSource: RoleSource = (["owner", "member", "workspace", "none"] as const).includes(rawSource as never)
    ? (rawSource as RoleSource)
    : role ? "member" : "none";
  const expiresAt = (roleSource === "member" || rawSource === "expired") && typeof member?.expires_at === "string" ? member.expires_at : null;
  const grant: AccessSubject = roleSource === "member" && role
    ? { role, permissions: role === "custom" ? member?.permissions ?? null : null, expiresAt }
    : role;

  if (rawSource === "expired" || (roleSource === "member" && isExpired(grant, now))) {
    /* a platform administrator's operational duties never depended on a membership */
    if (user.isPlatformAdmin && decideAccess(user, null, capability, "none", now).allowed) {
      return { ok: true, role: null, roleSource: "none", grant: null, expiresAt, viaAdmin: true };
    }
    return {
      ok: false, status: 403,
      body: {
        error: expiresAt
          ? `Your access to this project expired on ${expiresAt.slice(0, 10)}. Ask the project's owner to renew it.`
          : "Your access to this project has expired. Ask the project's owner to renew it.",
        code: "access_expired", expiresAt, capability,
      },
    };
  }

  const decision = decideAccess(user, grant, capability, roleSource, now);
  if (decision.allowed) return { ok: true, role, roleSource, grant, expiresAt, viaAdmin: decision.viaAdmin };
  if (decision.reason === "not_a_member") {
    // indistinguishable from a project that does not exist, on purpose
    return { ok: false, status: 404, body: { error: "Unknown project." } };
  }
  return {
    ok: false, status: 403,
    body: {
      error: roleSource === "workspace"
        ? `Your workspace grants ${ROLE_LABEL[role!].toLowerCase()} access to projects it does not own, which does not allow this. Ask the project's owner to share it with you directly.`
        : role === "custom"
          ? `Your access to this project does not include this (${CAPABILITY_LABEL[capability].toLowerCase()}). Ask the project's owner or admin to change your permissions.`
          : `Your role on this project (${ROLE_LABEL[role!] ?? role}) does not allow this.`,
      code: "insufficient_role",
      role,
      roleSource,
      capability,
    },
  };
}

/* ------------------------------------------------------------------ requests */

export interface AccessRequest {
  role: ProjectRole;
  /** null for a fixed role; normalized for custom */
  permissions: CustomPermissions | null;
  /** undefined = "not asked to change" (an older client); null = no expiry */
  expiresAt: string | null | undefined;
}

/**
 * Read role + permissions + expiry from a share / invite / change request.
 *
 * Backward compatible by construction: `{ identifier, role }` — all an older
 * client sends — reads as that role, no permissions, and expiry NOT MENTIONED
 * (so an existing member's expiry is left alone rather than cleared).
 * Expiry may come as `expiry: { option: "7d" | "custom" | "none", date }` (the
 * panel) or `expiresAt` (ISO or YYYY-MM-DD, or null).
 */
export function parseAccessRequest(body: unknown, now: number = Date.now(), fallbackRole?: ProjectRole): { ok: true; value: AccessRequest } | { ok: false; error: string } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const role = b.role === undefined || b.role === null || b.role === "" ? fallbackRole : String(b.role);
  if (!role || !isProjectRole(role) || !GRANTABLE_ROLES.includes(role)) {
    // 'owner' lands here too: there is exactly one owner and it is transferred, never granted
    return { ok: false, error: `Choose one of: ${ACCESS_OPTIONS.map((o) => o.label).join(", ")}.` };
  }
  const permissions = role === "custom" ? normalizePermissions(b.permissions) : null;

  let expiresAt: string | null | undefined;
  if (b.expiry && typeof b.expiry === "object") {
    const e = b.expiry as Record<string, unknown>;
    const r = resolveExpiry(typeof e.option === "string" ? e.option : "none", typeof e.date === "string" ? e.date : null, now);
    if (!r.ok) return { ok: false, error: r.error };
    expiresAt = r.expiresAt;
  } else if ("expiresAt" in b) {
    const r = validateExpiry(b.expiresAt === null ? null : String(b.expiresAt ?? ""), now);
    if (!r.ok) return { ok: false, error: r.error };
    expiresAt = r.expiresAt;
  }
  return { ok: true, value: { role, permissions, expiresAt } };
}

/**
 * May this person grant that? Owners and platform administrators always may;
 * everybody else only up to what they hold themselves.
 */
export function grantRefusal(granter: AccessSubject, isPlatformAdmin: boolean, target: MemberGrant, now?: number): string | null {
  if (isPlatformAdmin) return null;
  const missing = escalation(granter, target, now);
  if (!missing.length) return null;
  return `You cannot grant access you do not have yourself: ${missing.map((c) => CAPABILITY_LABEL[c].toLowerCase()).join("; ")}.`;
}

/** Same grant? (role, the permissions that matter for it, and expiry) */
export function sameGrant(a: MemberGrant, b: MemberGrant): boolean {
  return diffAccess(a, b).length === 0;
}

/** Does this change take away the right to edit (so a held edit lock must go back)? */
export function losesEditing(after: MemberGrant, now?: number): boolean {
  return !can(after, "survey.edit", now);
}

/* ------------------------------------------------------------------ the panel's view of a member */

export function memberAccessView(m: { role: string; is_owner?: boolean; permissions?: unknown; expires_at?: string | null }, now: number = Date.now()) {
  const role = m.is_owner ? "owner" : m.role;
  const grant: MemberGrant = { role: isProjectRole(role) ? role : null, permissions: m.permissions ?? null, expiresAt: m.is_owner ? null : m.expires_at ?? null };
  const expired = isExpired(grant, now);
  return {
    accessLabel: accessLabel(role),
    permissions: role === "custom" ? normalizePermissions(m.permissions) : null,
    expiresAt: grant.expiresAt ?? null,
    expired,
    expiryText: grant.expiresAt ? describeExpiry(grant.expiresAt, now) : null,
    status: m.is_owner ? "owner" : expired ? "expired" : "active",
  };
}

/* ------------------------------------------------------------------ activity history */

const MEMBERSHIP_EVENTS = new Set([
  "project.shared", "project.access_removed", "project.permission_changed", "project.ownership_transferred",
  "project.invitation_sent", "project.invitation_accepted", "project.invitation_revoked", "project.invitation_resent",
]);

export interface HistoryEntry { id: string; action: string; text: string; at: string; actorName: string | null; changes: string[] }

/**
 * The collaborators panel's history: who invited whom, when access was
 * granted, what changed and who changed it, removals — from the audit log —
 * plus one entry per membership whose expiry has passed. Nothing is written
 * at the instant access ends, so that line is derived from `expires_at`
 * rather than pretended into the log.
 */
export function accessHistory(
  rows: AuditRow[],
  expiredMembers: { userId: string; name: string | null; expiresAt: string }[],
  now: number = Date.now(),
  limit = 50,
): HistoryEntry[] {
  const out: HistoryEntry[] = rows
    .filter((r) => MEMBERSHIP_EVENTS.has(r.action))
    .map((r) => ({
      id: String(r.id), action: r.action, text: describeEvent(r), at: r.createdAt, actorName: r.actorName ?? null,
      changes: Array.isArray(r.detail?.changes) ? (r.detail!.changes as unknown[]).map(String) : [],
    }));
  for (const m of expiredMembers) {
    if (Date.parse(m.expiresAt) > now) continue;
    const row: AuditRow = { id: `expired:${m.userId}`, action: "project.access_expired", entity: "survey", entityId: null, userId: null, actorName: null, detail: { targetName: m.name, expiresAt: m.expiresAt }, createdAt: m.expiresAt };
    out.push({ id: String(row.id), action: row.action, text: describeEvent(row), at: m.expiresAt, actorName: null, changes: [] });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
}
