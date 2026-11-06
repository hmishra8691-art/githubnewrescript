import type { Question, SurveyDefinition } from "@rescript/schema";
import { DeploymentConfig, QualityConfig } from "@rescript/schema";

/**
 * set_deployment — HOW THE SURVEY IS REACHED AND WHAT IT RECORDS ABOUT WHO ANSWERS (Intelligent Mode IM2, 2026-11-06).
 *
 * Every field is a setting the runtime honours (the audit's rule: an action never sets what nothing reads):
 *
 *   access         open | password | unique_links | invitation   (session/start + the live page; lib/session.ts)
 *   password       the password for `access: password` (null removes it; refused while access is password)
 *   allowRetake    one response per link / respondent, or retakes (lib/session.ts)
 *   activeFrom     the live link opens at this date-time (ISO; null removes) — session/start refuses before it
 *   activeUntil    the live link closes at this date-time (ISO; null removes) — session/start refuses after it
 *   speechInput    the microphone on open text fields (browser recogniser)
 *   speechServer   the server speech-to-text fallback (audio leaves the device after consent)
 *   anonymous      true: nothing that identifies the device or network is recorded — the IP hash and the device
 *                  hash are switched off (quality telemetry network/device) and cross-study linking is off; the
 *                  questions that ask for an identifier are named as warnings, because an anonymous survey that
 *                  asks for an email is not anonymous. false: both switched back on.
 *
 * Merged into `def.deployment` / `def.quality` and checked by the schema. Test links ignore the dates and the
 * password (the programmer's own links keep working), exactly as they ignore a paused status.
 */
export type DeploymentAction = {
  op: "set_deployment";
  access?: "open" | "password" | "unique_links" | "invitation";
  password?: string | null;
  allowRetake?: boolean;
  activeFrom?: string | null;
  activeUntil?: string | null;
  speechInput?: boolean;
  speechServer?: boolean;
  anonymous?: boolean;
};
export const DEPLOYMENT_ACTION_OPS = ["set_deployment"] as const;

const ACCESS = ["open", "password", "unique_links", "invitation"] as const;
const ACCESS_WORDS: Record<(typeof ACCESS)[number], string> = { open: "an open link", password: "a password", unique_links: "unique links (one per respondent)", invitation: "invitations only" };

/** a date or date-time a person wrote, as an ISO string — "2026-12-01" opens / closes at midnight UTC that day */
export function isoDate(v: unknown): string | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function coerceDeploymentAction(o: Record<string, unknown>): DeploymentAction | string {
  const a: DeploymentAction = { op: "set_deployment" };
  const access = o.access ?? o.accessMode ?? (o.access_mode as unknown);
  if (access !== undefined) {
    const v = String(access).toLowerCase().replace(/[\s-]+/g, "_");
    const m = v === "unique" || v === "unique_link" ? "unique_links" : v === "invite" || v === "invitations" || v === "invite_only" ? "invitation" : v;
    if (!(ACCESS as readonly string[]).includes(m)) return `set_deployment access is ${ACCESS.join(" | ")}`;
    a.access = m as DeploymentAction["access"];
  }
  if (o.password === null || o.password === "") a.password = null;
  else if (typeof o.password === "string") { const p = o.password.trim(); if (p.length < 4 || p.length > 100) return "set_deployment password is 4–100 characters"; a.password = p; }
  for (const k of ["allowRetake", "speechInput", "speechServer", "anonymous"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") return `set_deployment ${k} must be true or false`;
    a[k] = o[k] as boolean;
  }
  for (const k of ["activeFrom", "activeUntil"] as const) {
    if (o[k] === undefined) continue;
    const d = isoDate(o[k]);
    if (d === undefined) return `set_deployment ${k} is a date (YYYY-MM-DD) or an ISO date-time, or null to remove it`;
    a[k] = d;
  }
  return Object.keys(a).length > 1 ? a : "set_deployment changes nothing — give access, password, allowRetake, activeFrom, activeUntil, speechInput, speechServer or anonymous";
}

class DeploymentActionError extends Error {}
const fail = (m: string): never => { throw new DeploymentActionError(m); };

const IDENTIFIER_WORDS = /\b(?:e-?mail|full\s+name|your\s+name|first\s+name|last\s+name|surname|phone|mobile\s+number|telephone|home\s+address|postal\s+address|street|employee\s+(?:id|number)|national\s+id|passport|social\s+security)\b/i;
const IDENTIFIER_VARS = /^(?:E_?MAIL|NAME|FULL_?NAME|FIRST_?NAME|LAST_?NAME|SURNAME|PHONE|MOBILE|TEL|ADDRESS|EMP_?ID|EMPLOYEE_?ID)(?:_|$)/i;
/** the questions that ask for something that identifies a person — by their wording or their variable name */
export function identifyingQuestions(def: SurveyDefinition): Question[] {
  return def.questions.filter((q) => (q.type === "open_text" || q.type === "long_text" || q.type === "text_list" || q.type === "embedded_data" || q.type === "hidden") && (IDENTIFIER_WORDS.test(q.text ?? "") || IDENTIFIER_VARS.test(q.variableName ?? "")));
}

/** anonymous as the survey records it: no IP hash, no device hash */
export const isAnonymous = (def: SurveyDefinition): boolean => def.quality?.telemetry?.network === false && def.quality?.telemetry?.device === false;

export function applyDeploymentAction(def: SurveyDefinition, a: DeploymentAction): { description: string; destructive?: string; warnings: string[]; touched: string[] } {
  const cur = DeploymentConfig.parse(def.deployment ?? {});
  const next = JSON.parse(JSON.stringify(cur)) as DeploymentConfig;
  const done: string[] = [];
  const warnings: string[] = [];
  const lossy: string[] = [];
  if (a.password !== undefined) {
    if (a.password === null) { delete next.access.password; done.push("no password"); } else { next.access.password = a.password; done.push("password set"); }
  }
  if (a.access && a.access !== cur.access.mode) {
    next.access.mode = a.access;
    done.push(`access by ${ACCESS_WORDS[a.access]}`);
    if (a.access === "unique_links" || a.access === "invitation") warnings.push("respondents now need their own link — create or import them in Respondents before launch; the open link stops working");
    if (cur.access.mode === "open") lossy.push(`the open link stops admitting anyone without ${a.access === "password" ? "the password" : "their own link"}`);
  }
  if (next.access.mode === "password" && !next.access.password) fail("a password-protected survey needs the password — give it with the access change");
  if (a.allowRetake !== undefined && a.allowRetake !== cur.access.allowRetake) {
    next.access.allowRetake = a.allowRetake;
    done.push(a.allowRetake ? "retakes allowed" : "one response per respondent");
    if (a.allowRetake) warnings.push("a respondent can now answer more than once — counts, quotas and incentives see each response separately");
  }
  if (a.activeFrom !== undefined) { if (a.activeFrom === null) { delete next.activeFrom; done.push("no opening date"); } else { next.activeFrom = a.activeFrom; done.push(`opens ${a.activeFrom.slice(0, 16).replace("T", " ")} UTC`); } }
  if (a.activeUntil !== undefined) { if (a.activeUntil === null) { delete next.activeUntil; done.push("no closing date"); } else { next.activeUntil = a.activeUntil; done.push(`closes ${a.activeUntil.slice(0, 16).replace("T", " ")} UTC`); } }
  if (next.activeFrom && next.activeUntil && next.activeFrom >= next.activeUntil) fail("the survey would close before it opens — the closing date must come after the opening date");
  if (a.activeUntil && Date.parse(a.activeUntil) < Date.now()) warnings.push("the closing date has passed — the live link refuses new respondents from now on");
  if (a.speechInput !== undefined && a.speechInput !== (cur.speechInput !== false)) { next.speechInput = a.speechInput; done.push(a.speechInput ? "dictation on" : "dictation off"); }
  if (a.speechServer !== undefined && a.speechServer !== (cur.speechServer !== false)) { next.speechServer = a.speechServer; done.push(a.speechServer ? "server dictation on" : "dictation stays on the device"); }

  let quality: QualityConfig | null = null;
  if (a.anonymous !== undefined && a.anonymous !== isAnonymous(def)) {
    const q = JSON.parse(JSON.stringify(QualityConfig.parse(def.quality ?? {}))) as QualityConfig;
    q.telemetry.network = !a.anonymous;
    q.telemetry.device = !a.anonymous;
    if (a.anonymous) q.privacy.longitudinal = false;
    quality = q;
    done.push(a.anonymous ? "anonymous (no IP or device hash, no cross-study linking)" : "IP and device hashes recorded again");
    if (a.anonymous) {
      lossy.push("the duplicate-device and shared-network quality checks stop running (they need the hashes)");
      const ids = identifyingQuestions(def);
      if (ids.length) warnings.push(`${ids.map((q) => q.code).join(", ")} ${ids.length === 1 ? "asks" : "ask"} for something that identifies the respondent — the answers are not anonymous while ${ids.length === 1 ? "it remains" : "they remain"}`);
      if (next.access.mode === "unique_links" || next.access.mode === "invitation") warnings.push("unique links and invitations tie each response to the person invited — the survey is confidential, not anonymous, while they are used");
    }
  }
  if (!done.length) fail("the deployment settings are already as asked");
  const parsed = DeploymentConfig.safeParse(next);
  if (!parsed.success) fail(`set_deployment: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  def.deployment = parsed.data!;
  if (quality) (def as { quality?: unknown }).quality = quality;
  return { description: `Deployment: ${done.join(", ")}`, ...(lossy.length ? { destructive: lossy.join("; ") } : {}), warnings, touched: [] };
}

export function describeDeploymentAction(a: DeploymentAction): string {
  const bits = [
    a.access ? `access ${a.access.replace("_", " ")}` : "",
    a.password !== undefined ? (a.password ? "password" : "no password") : "",
    a.allowRetake !== undefined ? (a.allowRetake ? "retakes" : "one response each") : "",
    a.activeFrom !== undefined ? (a.activeFrom ? `opens ${a.activeFrom.slice(0, 10)}` : "no opening date") : "",
    a.activeUntil !== undefined ? (a.activeUntil ? `closes ${a.activeUntil.slice(0, 10)}` : "no closing date") : "",
    a.speechInput !== undefined ? `dictation ${a.speechInput ? "on" : "off"}` : "",
    a.speechServer !== undefined ? `server dictation ${a.speechServer ? "on" : "off"}` : "",
    a.anonymous !== undefined ? (a.anonymous ? "anonymous" : "not anonymous") : "",
  ].filter(Boolean);
  return `Set deployment (${bits.join("; ")})`;
}

/**
 * THE FIELDWORK WINDOW, as the runtime applies it to a LIVE link (IM2). Before `activeFrom` a respondent is told
 * when it opens; after `activeUntil` that it has closed. A date that does not parse is ignored (never a link that
 * refuses everyone because of a typo in a hand-edited definition). Test links never call this.
 */
export function fieldworkWindow(deployment: { activeFrom?: string; activeUntil?: string } | undefined, now: number = Date.now()):
  { open: true } | { open: false; reason: "not_yet" | "closed"; at: string; title: string; body: string } {
  const from = deployment?.activeFrom ? Date.parse(deployment.activeFrom) : NaN;
  const until = deployment?.activeUntil ? Date.parse(deployment.activeUntil) : NaN;
  const day = (ms: number) => new Date(ms).toUTCString().replace(/:\d{2} GMT$/, " UTC");
  if (Number.isFinite(from) && now < from) return { open: false, reason: "not_yet", at: deployment!.activeFrom!, title: "This survey has not opened yet", body: `It opens on ${day(from)}. Please come back then.` };
  if (Number.isFinite(until) && now > until) return { open: false, reason: "closed", at: deployment!.activeUntil!, title: "This survey has closed", body: `It closed on ${day(until)}. Thank you for your interest.` };
  return { open: true };
}
