/**
 * AUDIT — the vocabulary of recordable events, and how each one reads.
 *
 * §25 asks for a complete project activity log, and the reason it matters in
 * a professional research environment is that "who changed the routing after
 * the client signed off" is a question that gets asked weeks later, by
 * someone who was not there.
 *
 * The events are a closed list defined here rather than free-text strings
 * passed at each call site, because a log written as ad-hoc strings becomes
 * unfilterable within a month — `survey.save` in one route and `saved_survey`
 * in another, and no report can count either. `describeEvent` turns a stored
 * row back into the sentence a human reads, so the log's wording is one
 * function and not one per screen.
 *
 * These rows land in the existing `audit_logs` table, widened with a
 * `survey_id`. The platform already had an audit trail; this gives it a
 * vocabulary and a reader rather than a second table beside it.
 */

export const AUDIT_EVENTS = [
  /* identity */
  "user.created",
  "user.logged_in",
  "user.login_blocked",
  "user.login_failed",
  "user.logged_out",
  "user.profile_updated",
  "user.password_changed",

  /* sessions */
  "session.started",
  "session.expired",
  "session.revoked",
  "session.taken_over",

  /* accounts, by an administrator */
  "account.disabled",
  "account.enabled",
  "account.unlocked",
  "account.role_changed",

  /* projects */
  "project.created",
  "project.opened",
  "project.deleted",
  "project.shared",
  "project.access_removed",
  "project.permission_changed",
  "project.ownership_transferred",
  "project.invitation_sent",
  "project.invitation_accepted",
  "project.invitation_revoked",

  /* collaborative editing */
  "lock.acquired",
  "lock.released",
  "lock.force_released",
  "lock.expired",
  "lock.requested",
  "lock.denied",

  /* the survey itself */
  "survey.modified",
  "survey.saved",
  "version.created",
  "version.restored",
  "deployment.started",
  "deployment.completed",
  "responses.modified",
  "responses.deleted",
  "responses.imported",

  /* quota management (the dashboard records each numeric change with before/after) */
  "quota.created",
  "quota.modified",
  "quota.deleted",

  /* collaboration */
  "comment.created",
  "comment.resolved",
  "comment.deleted",
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export function isAuditEvent(v: unknown): v is AuditEvent {
  return typeof v === "string" && (AUDIT_EVENTS as readonly string[]).includes(v);
}

/** A row as it comes back from the database, for the activity panel. */
export interface AuditRow {
  id: number | string;
  action: string;
  entity: string | null;
  entityId: string | null;
  surveyId?: string | null;
  userId: string | null;
  actorName?: string | null;
  actorUserCode?: string | null;
  detail?: Record<string, unknown> | null;
  createdAt: string;
}

const actorOf = (r: AuditRow) => r.actorName ?? r.actorUserCode ?? (r.userId ? "A user" : "The system");
const str = (v: unknown) => (v == null ? "" : String(v));

/**
 * One row as a sentence.
 *
 * Written to be read in a list by someone reconstructing a day, so it always
 * names the actor first and never makes the reader decode an id. Where the
 * event has a subject — a person shared with, a role granted — the detail
 * carries it and the sentence uses it; where the detail is missing the
 * sentence still has to make sense, because a log that renders "undefined"
 * for old rows is a log nobody trusts.
 */
export function describeEvent(r: AuditRow): string {
  const who = actorOf(r);
  const d = r.detail ?? {};
  const target = str(d.targetName || d.targetUserCode || d.targetEmail);
  const role = str(d.role);
  switch (r.action as AuditEvent) {
    case "user.created": return `${who} created an account`;
    case "user.logged_in": return `${who} signed in`;
    case "user.login_blocked": return `${who} tried to sign in while another session was active`;
    case "user.login_failed": return `A failed sign-in attempt for ${str(d.identifier) || "an account"}`;
    case "user.logged_out": return `${who} signed out`;
    case "user.profile_updated": return `${who} updated their profile`;
    case "user.password_changed": return `${who} changed their password`;

    case "session.started": return `${who} started a session${d.device ? ` on ${str(d.device)}` : ""}`;
    case "session.expired": return `${who}'s session expired after inactivity`;
    case "session.revoked": return `${who} revoked ${target ? `${target}'s` : "a"} session`;
    case "session.taken_over": return `${who} signed in and displaced their previous session`;

    case "account.disabled": return `${who} disabled the account ${target}`;
    case "account.enabled": return `${who} re-enabled the account ${target}`;
    case "account.unlocked": return `${who} unlocked the account ${target}`;
    case "account.role_changed": return `${who} changed ${target}'s platform role to ${role}`;

    case "project.created": return `${who} created this project`;
    case "project.opened": return `${who} opened this project${d.readOnly ? " (read-only)" : ""}`;
    case "project.deleted": return `${who} deleted this project`;
    case "project.shared": return `${who} shared this project with ${target}${role ? ` as ${role}` : ""}`;
    case "project.access_removed": return `${who} removed ${target}'s access`;
    case "project.permission_changed": return `${who} changed ${target}'s role to ${role}`;
    case "project.ownership_transferred": return `${who} transferred ownership to ${target}`;
    case "project.invitation_sent": return `${who} invited ${target} as ${role || "a collaborator"}`;
    case "project.invitation_accepted": return `${target || who} accepted the invitation to this project`;
    case "project.invitation_revoked": return `${who} revoked the invitation for ${target}`;

    case "lock.acquired": return `${who} started editing${d.section ? ` (${str(d.section)})` : ""}`;
    case "lock.released": return `${who} released the edit lock`;
    case "lock.force_released": return `${who} force-released the edit lock held by ${target}`;
    case "lock.expired": return `${who}'s edit lock expired after inactivity and was released`;
    case "lock.requested": return `${who} requested edit access`;
    case "lock.denied": return `${who} was refused an edit because ${target || "another user"} held the lock`;

    case "survey.modified": return `${who} modified the survey${d.summary ? ` — ${str(d.summary)}` : ""}`;
    case "survey.saved": return `${who} saved the survey`;
    case "version.created": return `${who} created version ${str(d.version) || "?"}`;
    case "quota.created": return `${who} created quota “${str(d.quotaName) || str(d.quotaId)}”`;
    case "quota.modified": {
      const changes = d.changes && typeof d.changes === "object" ? Object.entries(d.changes as Record<string, { before: unknown; after: unknown }>) : [];
      const shown = changes.slice(0, 3).map(([k, v]) => `${k}: ${str(v?.before ?? "—")} → ${str(v?.after ?? "—")}`).join(", ");
      return `${who} changed quota “${str(d.quotaName) || str(d.quotaId)}”${shown ? ` — ${shown}${changes.length > 3 ? ", …" : ""}` : ""}`;
    }
    case "quota.deleted": return `${who} deleted quota “${str(d.quotaName) || str(d.quotaId)}”${d.cells != null ? ` (${str(d.cells)} cells; response data kept)` : ""}`;
    case "version.restored": return `${who} restored version ${str(d.version) || "?"}`;
    case "deployment.started": return `${who} started a ${str(d.mode) || ""} deployment`.replace("  ", " ");
    case "deployment.completed": return `${who} completed a ${str(d.mode) || ""} deployment`.replace("  ", " ");
    case "responses.modified": return `${who} edited response data${d.count ? ` (${str(d.count)} rows)` : ""}`;
    case "responses.deleted": return `${who} deleted response data${d.count ? ` (${str(d.count)} rows)` : ""}`;
    case "responses.imported": return `${who} imported response data${d.count ? ` (${str(d.count)} rows)` : ""}`;

    case "comment.created": return `${who} left an internal note`;
    case "comment.resolved": return `${who} resolved a note`;
    case "comment.deleted": return `${who} deleted a note`;
    default: return `${who} — ${r.action}`;
  }
}

/** Grouping for the activity panel's filter chips. */
export type AuditCategory = "identity" | "session" | "access" | "editing" | "survey" | "data" | "collaboration";

export function auditCategory(action: string): AuditCategory {
  if (action.startsWith("user.")) return "identity";
  if (action.startsWith("session.") || action.startsWith("account.")) return "session";
  if (action.startsWith("lock.")) return "editing";
  if (action.startsWith("comment.")) return "collaboration";
  if (action.startsWith("responses.")) return "data";
  if (action.startsWith("survey.") || action.startsWith("version.") || action.startsWith("deployment.") || action.startsWith("quota.")) return "survey";
  return "access";
}

/**
 * Events worth telling a collaborator about (§39). Kept here beside the
 * vocabulary so adding an event forces the question "should anyone hear about
 * this?" to be answered once, rather than a notification rule growing in a
 * route somewhere.
 */
export const NOTIFIABLE: AuditEvent[] = [
  "project.shared",
  "project.permission_changed",
  "project.access_removed",
  "project.ownership_transferred",
  "project.invitation_sent",
  "lock.released",
  "lock.requested",
  "lock.force_released",
  "comment.created",
  "deployment.completed",
];

export function isNotifiable(action: string): boolean {
  return (NOTIFIABLE as string[]).includes(action);
}
