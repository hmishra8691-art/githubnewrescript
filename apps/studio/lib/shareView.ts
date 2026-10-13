/**
 * A share as the API shows it (audit R-10). The link, the allow-list of
 * e-mail addresses and the people's ids are for whoever manages the link; a
 * project member who can only read sees that the share exists, who it is
 * for in a count, and nothing they could lift or learn from it. Never the
 * password hash.
 */
export function shareView(row: Record<string, unknown>, canManage: boolean): Record<string, unknown> {
  const emails = Array.isArray(row.allowed_emails) ? (row.allowed_emails as unknown[]) : [];
  const ids = Array.isArray(row.allowed_user_ids) ? (row.allowed_user_ids as unknown[]) : [];
  const base = { ...row, password_hash: undefined, has_password: !!row.password_hash, can_manage: canManage, allowed_count: Math.max(emails.length, ids.length) };
  return canManage ? base : { ...base, token: undefined, allowed_emails: undefined, allowed_user_ids: undefined };
}
