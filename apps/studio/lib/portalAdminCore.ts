/**
 * RESPONDENT PORTAL — THE RESEARCHER'S SIDE, THE PARTS THAT ARE DECISIONS (phase 1, 2026-11-20).
 *
 * Pure: what a request may ask for, which respondent rows get a new account and which join an existing one, and
 * the words of the emails. `portalAdmin.ts` does the reading and writing.
 *
 * WHO SEES WHAT. An account is one person across every workspace they are invited by (owner decision, 2026-11-20).
 * A workspace still sees only its OWN enrolments: linking a row by email returns the person's Respondent ID and
 * nothing else — not that the account already existed, not where else it is used, not its status elsewhere.
 */
export type PortalAction =
  | "create_accounts" | "invite" | "initial_password" | "unlink"
  | "suspend" | "reactivate" | "lock" | "unlock" | "reopen" | "access" | "sign_out";

export const PORTAL_ACTIONS: readonly PortalAction[] = ["create_accounts", "invite", "initial_password", "unlink", "suspend", "reactivate", "lock", "unlock", "reopen", "access", "sign_out"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_IDS = 2000;

export interface PortalRequest {
  action: PortalAction;
  ids: string[];
  identity: "persistent" | "assessment";
  sendEmail: boolean;
  /** reopen: editable until; access: the window */
  until: string | null;
  from: string | null;
  /** access: null clears the limit */
  maxAttempts: number | null;
  setAttempts: boolean;
  setWindow: boolean;
  /**
   * "Everyone in this list" instead of ticked rows (2026-11-21): the server finds the people, so a list of thousands
   * does not have to be loaded into the page to be acted on. `list` undefined = every list; null = people added
   * without a list name.
   */
  everyone: PortalEveryone | null;
}
export interface PortalEveryone { list?: string | null; noAccount: boolean }

/** what the request says about "everyone in …", or null when it names people one by one */
export function readEveryone(v: unknown): PortalEveryone | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  const out: PortalEveryone = { noAccount: e.noAccount === true };
  if (e.list === null) out.list = null;
  else if (typeof e.list === "string" && e.list.trim()) out.list = e.list.trim().slice(0, 120);
  return out;
}

const date = (v: unknown): string | null | undefined => {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

/** the request as the route will act on it, or the sentence that says what is wrong with it */
export function readPortalRequest(body: unknown, now: number): PortalRequest | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const action = b.action as PortalAction;
  if (!PORTAL_ACTIONS.includes(action)) return { error: "Unknown action." };
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((x): x is string => typeof x === "string" && UUID.test(x)))] : [];
  const everyone = ids.length ? null : readEveryone(b.everyone);
  if (!ids.length && !everyone) return { error: "Choose at least one respondent." };
  if (everyone && (action === "initial_password" || action === "sign_out" || action === "unlink")) return { error: "Choose the people one by one for this action." };
  if (ids.length > MAX_IDS) return { error: `Choose at most ${MAX_IDS} respondents at a time.` };
  if ((action === "initial_password" || action === "sign_out") && ids.length !== 1) return { error: "Choose one respondent for this action." };

  const out: PortalRequest = { action, ids, identity: b.identity === "assessment" ? "assessment" : "persistent", sendEmail: b.sendEmail !== false, until: null, from: null, maxAttempts: null, setAttempts: false, setWindow: false, everyone };
  if (action === "reopen") {
    const until = date(b.until);
    if (!until || Date.parse(until) <= now) return { error: "Choose a time in the future until which answers can be changed." };
    if (Date.parse(until) - now > 366 * 86_400_000) return { error: "A reopening can last at most a year." };
    out.until = until;
  }
  if (action === "access") {
    if ("from" in b || "until" in b) {
      const from = date(b.from), until = date(b.until);
      if (from === undefined || until === undefined) return { error: "The dates could not be read." };
      if (from && until && Date.parse(until) <= Date.parse(from)) return { error: "The closing time must be after the opening time." };
      out.from = from; out.until = until; out.setWindow = true;
    }
    if ("maxAttempts" in b) {
      const n = b.maxAttempts;
      if (n !== null && !(Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 1000)) return { error: "Attempts must be a whole number from 1 to 1000, or empty for the survey's own rule." };
      out.maxAttempts = n as number | null; out.setAttempts = true;
    }
    if (!out.setWindow && !out.setAttempts) return { error: "Nothing to change." };
  }
  return out;
}

/* ------------------------------------------------------------------ the lists people were added in */

export interface PortalListSummary { name: string | null; people: number; withAccount: number }

/** one line per list, in the order the lists first appear; people added without a list name are one group (null) */
export function summariseLists(rows: { list: string | null; hasAccount: boolean }[]): PortalListSummary[] {
  const by = new Map<string, PortalListSummary>();
  for (const r of rows) {
    const key = r.list ?? "\u0000";
    const at = by.get(key) ?? { name: r.list, people: 0, withAccount: 0 };
    at.people++; if (r.hasAccount) at.withAccount++;
    by.set(key, at);
  }
  return [...by.values()];
}

/**
 * HOW AN INVITATION OR A PASSWORD REACHES A PERSON — the sentences the Studio shows before anything is sent
 * (the rule itself is `credentialRoute` below; this only says it in words, so the two cannot drift apart silently:
 * the test checks each sentence against the rule).
 */
export function sharingExplained(mailConfigured: boolean): { withEmail: string; withoutEmail: string } {
  return {
    withEmail: mailConfigured
      ? "A person with an email address is emailed a link to set their own password. You never see the link or the password."
      : "A person with an email address would be emailed a link to set their own password, but email is not set up on this installation, so their account is created and no invitation can be sent yet.",
    withoutEmail: "A person with no email address cannot be emailed: you are shown their sign-in link (or a first password) once, on this page, to hand over yourself.",
  };
}

/* ------------------------------------------------------------------ which rows get which account */

export interface RowForAccount { id: string; email: string | null; name: string | null; accountId: string | null }
export type AccountPlan =
  | { row: string; do: "already" }
  | { row: string; do: "link"; accountId: string }
  | { row: string; do: "create"; email: string | null; name: string | null; scope: "persistent" | "assessment" }
  | { row: string; do: "skip"; why: string };

const emailOf = (e: string | null) => { const v = (e ?? "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? v : null; };

/**
 * One account per person. A PERSISTENT identity is keyed by email: a row whose address already has an account joins
 * it; two rows of the same survey with one address cannot both be that person (the second is skipped and said so).
 * A row with no usable address, or an ASSESSMENT-only identity, gets an account of its own that no email can find.
 */
export function planAccounts(rows: RowForAccount[], existingByEmail: Map<string, string>, alreadyEnrolled: Set<string>, identity: "persistent" | "assessment"): AccountPlan[] {
  const taken = new Set(alreadyEnrolled);
  const seenEmail = new Set<string>();
  return rows.map((r): AccountPlan => {
    if (r.accountId) return { row: r.id, do: "already" };
    const email = emailOf(r.email);
    if (identity === "assessment" || !email) return { row: r.id, do: "create", email: identity === "assessment" ? email : null, name: r.name, scope: identity === "assessment" ? "assessment" : "persistent" };
    if (seenEmail.has(email)) return { row: r.id, do: "skip", why: "another respondent in this list has the same email address" };
    seenEmail.add(email);
    const existing = existingByEmail.get(email);
    if (existing) {
      if (taken.has(existing)) return { row: r.id, do: "skip", why: "this person is already on this survey's list" };
      taken.add(existing);
      return { row: r.id, do: "link", accountId: existing };
    }
    return { row: r.id, do: "create", email, name: r.name, scope: "persistent" };
  });
}

/* ------------------------------------------------------------------ who may be handed a credential */

/**
 * HOW A SIGN-IN CREDENTIAL (an invitation link, a first password) MAY LEAVE THE SYSTEM.
 *
 * An account can be shared by several workspaces, so a credential a researcher can SEE would let that researcher
 * sign in as the person and open what other workspaces assigned. Therefore:
 *
 *   - an account with an email address: the credential is only ever EMAILED to that address — never shown;
 *   - an account without one exists in exactly one workspace (nothing else can find it): the workspace that
 *     created it is shown the link or the first password once, to hand over in person or on paper;
 *   - anyone else is refused.
 */
export type CredentialRoute = { how: "email" } | { how: "show" } | { how: "refuse"; why: string };
export function credentialRoute(account: { email: string | null; createdCustomerId: string | null }, workspaceId: string | null, mailConfigured: boolean, want: "link" | "password"): CredentialRoute {
  if (account.email) {
    if (want === "password") return { how: "refuse", why: "This person signs in with their email address and can reset their own password. A password cannot be issued for them." };
    return mailConfigured ? { how: "email" } : { how: "refuse", why: "Email is not set up on this installation, so an invitation cannot be sent to this person's address." };
  }
  if (!workspaceId || account.createdCustomerId !== workspaceId) return { how: "refuse", why: "This account was not created by your workspace." };
  return { how: "show" };
}

/* ------------------------------------------------------------------ the emails */

const hello = (name: string | null) => (name?.trim() ? `Hello ${name.trim()},` : "Hello,");

export function invitationMail(m: { name: string | null; respondentId: string; link: string; surveyTitle: string; days: number; from: string | null }): { subject: string; text: string } {
  return {
    subject: `Your access to “${m.surveyTitle}”`,
    text: [
      hello(m.name), "",
      `${m.from?.trim() || "The organiser"} has invited you to “${m.surveyTitle}”.`, "",
      "Set your password to open your personal page, where you can take the assessment and return to it later:", "",
      m.link, "",
      `Your Respondent ID is ${m.respondentId}. Keep it: you can sign in with it.`,
      `This link works once, for ${m.days} days. If it has expired, ask the organiser for a new one.`, "",
      "If you were not expecting this message you can ignore it.",
    ].join("\n"),
  };
}

export function resetMail(m: { name: string | null; respondentId: string; link: string; minutes: number }): { subject: string; text: string } {
  return {
    subject: "Choose a new password",
    text: [
      hello(m.name), "",
      "Someone asked to reset the password for your respondent account. To choose a new password, open:", "",
      m.link, "",
      `The link works once, for ${m.minutes} minutes. Your Respondent ID is ${m.respondentId}.`, "",
      "If you did not ask for this, you can ignore this message: your password has not been changed.",
    ].join("\n"),
  };
}

/** one sentence for the audit log */
export function actionSummary(r: Pick<PortalRequest, "action" | "until" | "maxAttempts" | "setAttempts" | "setWindow">): string {
  switch (r.action) {
    case "create_accounts": return "created portal accounts for respondents";
    case "invite": return "sent portal invitations";
    case "initial_password": return "issued a first portal password";
    case "unlink": return "removed respondents' portal access to this survey";
    case "suspend": return "paused respondents' access to this survey";
    case "reactivate": return "restored respondents' access to this survey";
    case "lock": return "locked respondents' answers";
    case "unlock": return "unlocked respondents' answers";
    case "reopen": return `reopened respondents' answers for editing until ${r.until}`;
    case "access": return `changed respondents' access (${[r.setWindow ? "window" : "", r.setAttempts ? `attempts: ${r.maxAttempts ?? "survey rule"}` : ""].filter(Boolean).join(", ")})`;
    case "sign_out": return "signed a respondent out of the portal";
  }
}
