import { createHmac } from "node:crypto";

/**
 * ERASING ONE RESPONDENT, END TO END (audit 2026-11-17, P1-11).
 *
 * A data subject asks the client to erase them; the client (the controller) finds them in a project by what they
 * know — an email address on the invitation list, the respondent code printed in the data, the panel's own id for the
 * person, or a session id — and erases. Before this, the per-response purge removed the row and its recordings, but a
 * person invited by email kept their invitation row (email, name, embedded fields), their mail log, their quota and
 * balance holds, their list-fill slots and their vendor mapping; nothing checked afterwards; and nothing recorded the
 * request except a line about a purge.
 *
 * Three steps, each one testable without a database (the route supplies `ErasureDeps`):
 *
 *   find      every response and invitation in the project that the identifier names
 *   erase     media first (the row says which objects), then the rows that have no foreign key to cascade from,
 *             then the responses (soft delete + purge: the cascade takes reviews, edits, media rows, assessment
 *             results), then the invitation rows and their mail log
 *   verify    `find` again, and each table by the ids erased: every count must be zero
 *
 * THE RECORD keeps no personal data: the kind of identifier, a keyed fingerprint of it (the same request can be
 * recognised later; the value cannot be read back), the counts per table, the verification, and the exports of this
 * project made before the erasure. A file already downloaded cannot be recalled by the platform; the record lists
 * them so the controller can delete those copies.
 */

export type ErasureIdentifier = { kind: "email" | "respondent_code" | "panel_id" | "session_id"; value: string };
export interface ErasureMatch { responses: { id: string; session_id: string | null; respondent_id: string | null; is_test: boolean }[]; invitations: { id: string; email: string | null }[] }
export interface ErasureDeps {
  findResponses(id: ErasureIdentifier, invitationIds: string[]): Promise<ErasureMatch["responses"]>;
  findInvitations(id: ErasureIdentifier): Promise<ErasureMatch["invitations"]>;
  purgeMedia(sessionIds: string[]): Promise<{ objects: number; warnings: string[] }>;
  /** delete rows of `table` whose `column` is one of `values` (scoped to the project); the number removed */
  deleteWhere(table: string, column: string, values: string[]): Promise<number>;
  purgeResponses(ids: string[]): Promise<number>;
  /** rows of `table` left whose `column` is one of `values` */
  countWhere(table: string, column: string, values: string[]): Promise<number>;
  exportsBefore(): Promise<{ at: string; format: string | null; by: string | null }[]>;
}

/** tables with no foreign key to responses: what the cascade would leave behind */
export const SESSION_TABLES: [table: string, column: "session_id" | "response_id"][] = [
  ["quota_holds", "session_id"],
  ["balance_claims", "session_id"],
  ["listfill_allocations", "session_id"],
  ["participation_ledger", "response_id"],
];
/** what the cascade on responses removes — checked afterwards, not deleted by hand */
export const CASCADE_TABLES: [string, "response_id"][] = [["response_reviews", "response_id"], ["response_edits", "response_id"], ["media_objects", "response_id"], ["media_deliveries", "response_id"], ["assessment_results", "response_id"]];

export function normaliseIdentifier(raw: unknown): ErasureIdentifier | null {
  const r = raw as { kind?: unknown; value?: unknown } | null;
  const kind = r?.kind;
  const value = typeof r?.value === "string" ? r.value.trim() : "";
  if (!value || value.length > 320) return null;
  if (kind === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? { kind, value: value.toLowerCase() } : null;
  if (kind === "respondent_code" || kind === "panel_id" || kind === "session_id") return { kind, value };
  return null;
}

/** a keyed fingerprint: equal for the same identifier, unreadable without the key */
export const fingerprint = (id: ErasureIdentifier, key: Buffer | string) => createHmac("sha256", key).update(`${id.kind}|${id.value}`).digest("hex").slice(0, 32);

export async function findErasure(id: ErasureIdentifier, deps: ErasureDeps): Promise<ErasureMatch> {
  const invitations = await deps.findInvitations(id);
  const responses = await deps.findResponses(id, invitations.map((i) => i.id));
  return { invitations, responses };
}

export interface ErasureResult {
  found: { responses: number; invitations: number };
  removed: Record<string, number>;
  mediaObjects: number;
  warnings: string[];
  verified: boolean;
  /** table → rows still there (all zero when verified) */
  remaining: Record<string, number>;
  exportsBefore: { at: string; format: string | null; by: string | null }[];
}

export async function eraseRespondent(id: ErasureIdentifier, deps: ErasureDeps): Promise<ErasureResult> {
  const m = await findErasure(id, deps);
  const responseIds = m.responses.map((r) => r.id);
  const sessionIds = m.responses.map((r) => r.session_id).filter((s): s is string => !!s);
  const invitationIds = [...new Set([...m.invitations.map((i) => i.id), ...m.responses.map((r) => r.respondent_id).filter((x): x is string => !!x)])];
  const removed: Record<string, number> = {};
  const warnings: string[] = [];

  /* 1. recordings and uploads, while the rows still say which objects are theirs */
  let mediaObjects = 0;
  if (sessionIds.length) {
    try { const p = await deps.purgeMedia(sessionIds); mediaObjects = p.objects; warnings.push(...p.warnings); }
    catch (e) { warnings.push(`media: ${(e as Error).message}`); }
  }
  /* 2. what no cascade reaches */
  for (const [table, col] of SESSION_TABLES) {
    const values = col === "session_id" ? sessionIds : responseIds;
    if (values.length) removed[table] = await deps.deleteWhere(table, col, values);
  }
  /* 3. the responses (soft delete then purge; the cascade takes reviews, edits, media rows, assessment results) */
  if (responseIds.length) removed.responses = await deps.purgeResponses(responseIds);
  /* 4. the invitation rows and the mail sent to them */
  const emails = [...new Set(m.invitations.map((i) => i.email).filter((e): e is string => !!e).map((e) => e.toLowerCase()))];
  if (id.kind === "email" && !emails.includes(id.value)) emails.push(id.value);
  if (emails.length) removed.mail_deliveries = await deps.deleteWhere("mail_deliveries", "to_email", emails);
  if (invitationIds.length) removed.respondents = await deps.deleteWhere("respondents", "id", invitationIds);
  if (id.kind === "panel_id") removed.vendor_participant_mappings = await deps.deleteWhere("vendor_participant_mappings", "participant_id", [id.value]);

  /* 5. verify: nothing the identifier names, and nothing under the ids erased */
  const again = await findErasure(id, deps);
  const remaining: Record<string, number> = { responses_found_again: again.responses.length, invitations_found_again: again.invitations.length };
  if (responseIds.length) {
    remaining.responses = await deps.countWhere("responses", "id", responseIds);
    for (const [t, c] of CASCADE_TABLES) remaining[t] = await deps.countWhere(t, c, responseIds);
    remaining.participation_ledger = await deps.countWhere("participation_ledger", "response_id", responseIds);
  }
  if (sessionIds.length) for (const [t, c] of SESSION_TABLES) if (c === "session_id") remaining[t] = await deps.countWhere(t, c, sessionIds);
  if (invitationIds.length) remaining.respondents = await deps.countWhere("respondents", "id", invitationIds);
  if (emails.length) remaining.mail_deliveries = await deps.countWhere("mail_deliveries", "to_email", emails);
  const verified = Object.values(remaining).every((n) => n === 0);

  return { found: { responses: m.responses.length, invitations: m.invitations.length }, removed, mediaObjects, warnings, verified, remaining, exportsBefore: await deps.exportsBefore() };
}
