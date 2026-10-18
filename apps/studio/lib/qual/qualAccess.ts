import { can, type AccessSubject, type Capability } from "@rescript/access";

/**
 * WHO MAY DO WHAT WITH QUALITATIVE DATA (2026-10-18).
 *
 * Qualitative data are respondents' own words and voices, so the DATA module
 * decides (docs/COLLABORATORS-ACCESS-2026-10-17.md §3): there is no second
 * permission model. Each operation names the capabilities it needs, ALL of
 * which the member must hold:
 *
 *   read        sessions, transcripts, codes, excerpts, history — Data view
 *   manage      add / edit / delete sessions, upload a recording, import or transcribe
 *               a transcript, snapshot open-ended answers — Data edit
 *   code        run AI coding, review codes, themes and excerpts — Data view + Analytics edit
 *   report      download the qualitative report (it carries excerpts) — Data view + Analytics export
 *   playback    play or download a recording — Data view + contact details (a voice or a face
 *               cannot be redacted)
 *   settings    the redaction names list (itself personal data) — Data edit + contact details
 *   guide       export the interview / discussion guide (the design, no data) — project read
 *
 * Text is shown unredacted only to a member with contact details
 * (`responses.read_pii`); everyone else reads transcripts, quotes and history
 * with e-mails, phone numbers and the names list replaced.
 *
 * The route's guard asks for the operation's FIRST capability (so a member
 * without Data access is refused there, 403, exactly as the data routes
 * refuse them); `qualRefusal` checks the rest.
 */

export type QualOperation = "read" | "manage" | "code" | "report" | "playback" | "settings" | "guide";

export const QUAL_CAPS: Record<QualOperation, readonly Capability[]> = {
  read: ["responses.read"],
  manage: ["responses.manage", "responses.read"],
  code: ["responses.read", "analytics.edit"],
  report: ["responses.read", "analytics.export"],
  playback: ["responses.read", "responses.read_pii"],
  settings: ["responses.manage", "responses.read_pii"],
  guide: ["project.read"],
};

const WORDS: Record<QualOperation, string> = {
  read: "read the qualitative data (Data: View)",
  manage: "add or change sessions, recordings and transcripts (Data: Edit)",
  code: "code the data (Data: View and Data Analytics: Edit)",
  report: "download the qualitative report (Data: View and report downloads)",
  playback: "play or download recordings (Data: View and contact details)",
  settings: "change the redaction list (Data: Edit and contact details)",
  guide: "export the guide",
};

/** the capability the route's guard asks for */
export const qualGuardCapability = (op: QualOperation): Capability => QUAL_CAPS[op][0];

/** null when the member holds every capability the operation needs; else the 403 body */
export function qualRefusal(grant: AccessSubject, op: QualOperation, now?: number): { error: string; code: "insufficient_role"; missing: Capability[] } | null {
  const missing = QUAL_CAPS[op].filter((c) => !can(grant, c, now));
  return missing.length ? { error: `Your access to this project does not let you ${WORDS[op]}.`, code: "insufficient_role", missing } : null;
}

/** what the workspace offers this member — the buttons it shows; the routes decide again */
export function qualAbilities(grant: AccessSubject, now?: number): Record<QualOperation, boolean> & { pii: boolean } {
  const out = {} as Record<QualOperation, boolean>;
  for (const op of Object.keys(QUAL_CAPS) as QualOperation[]) out[op] = qualRefusal(grant, op, now) === null;
  return { ...out, pii: can(grant, "responses.read_pii", now) };
}
