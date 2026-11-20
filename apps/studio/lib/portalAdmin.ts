import "server-only";
import { PORTAL_POLICY, hashPassword, hashToken, mintToken, newInitialPassword, newRespondentId } from "@rescript/access/respondent";
import { audit, type ProjectContext } from "./guard";
import { platformDb } from "./db";
import { mailConfig, sendMail } from "./mail";
import { runtimeBaseUrl } from "./runtime-url";
import { actionSummary, credentialRoute, invitationMail, planAccounts, type PortalRequest } from "./portalAdminCore";

/**
 * RESPONDENT PORTAL — THE RESEARCHER'S SIDE (phase 1, 2026-11-20). Reads and writes for /api/surveys/[id]/portal.
 *
 * Enrolments (`respondents` rows) are the survey's own data, read and written through `ctx.db` and always scoped to
 * this survey and the LIVE list. Accounts, credentials, sessions and the access log are platform data.
 * The decisions — who gets which account, how a credential may leave the system — are in portalAdminCore.ts.
 */
type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);
const ENROL = "id, email, name, external_id, list_name, status, account_id, access_from, access_until, max_attempts, portal_suspended, portal_locked_at, portal_reopened_until";
const missing = (m: string | undefined) => /account_id|access_from|portal_|schema cache|does not exist/i.test(m ?? "");

export interface PortalRow {
  id: string; email: string | null; name: string | null; externalId: string | null; list: string | null; status: string;
  accessFrom: string | null; accessUntil: string | null; maxAttempts: number | null; suspended: boolean; lockedAt: string | null; reopenedUntil: string | null;
  account: { respondentId: string; status: string; scope: string; hasPassword: boolean; invitePending: boolean; lastLoginAt: string | null } | null;
}

async function accountsById(ids: string[]) {
  const out = new Map<string, { id: string; respondentId: string; email: string | null; name: string | null; status: string; scope: string; lastLoginAt: string | null; createdCustomerId: string | null; hasPassword: boolean; inviteExpiresAt: string | null }>();
  if (!ids.length) return out;
  const db = platformDb();
  const [{ data: accounts }, { data: creds }] = await Promise.all([
    db.from("portal_accounts").select("id, respondent_id, email, name, status, scope, last_login_at, created_customer_id").in("id", ids),
    /* never the hash itself: only whether a password was ever set */
    db.from("portal_credentials").select("account_id, password_changed_at, invite_expires_at").in("account_id", ids),
  ]);
  const cred = new Map(((creds ?? []) as Row[]).map((c) => [String(c.account_id), c]));
  for (const a of (accounts ?? []) as Row[]) {
    const c = cred.get(String(a.id));
    out.set(String(a.id), { id: String(a.id), respondentId: String(a.respondent_id), email: str(a.email), name: str(a.name), status: String(a.status), scope: String(a.scope), lastLoginAt: str(a.last_login_at), createdCustomerId: str(a.created_customer_id), hasPassword: !!c?.password_changed_at, inviteExpiresAt: str(c?.invite_expires_at) });
  }
  return out;
}

export async function portalList(ctx: ProjectContext, q: { limit: number; offset: number; search: string; showEmail: boolean }): Promise<{ available: boolean; rows: PortalRow[]; total: number; mail: boolean }> {
  let query = ctx.db.from("respondents").select(ENROL, { count: "exact" }).eq("survey_id", ctx.surveyId).eq("is_test", false);
  const s = q.search.replace(/[%,()]/g, " ").trim();
  if (s) query = query.or(`name.ilike.%${s}%,email.ilike.%${s}%,external_id.ilike.%${s}%`);
  const { data, error, count } = await query.order("invited_at", { ascending: true }).range(q.offset, q.offset + q.limit - 1);
  if (error) {
    if (missing(error.message)) return { available: false, rows: [], total: 0, mail: mailConfig().configured };
    throw new Error(error.message);
  }
  const rows = (data ?? []) as Row[];
  const accounts = await accountsById([...new Set(rows.map((r) => str(r.account_id)).filter((x): x is string => !!x))]);
  const now = Date.now();
  return {
    available: true, total: count ?? rows.length, mail: mailConfig().configured,
    rows: rows.map((r) => {
      const a = r.account_id ? accounts.get(String(r.account_id)) : null;
      return {
        id: String(r.id), email: q.showEmail ? str(r.email) : null, name: str(r.name), externalId: str(r.external_id), list: str(r.list_name), status: String(r.status),
        accessFrom: str(r.access_from), accessUntil: str(r.access_until), maxAttempts: r.max_attempts == null ? null : Number(r.max_attempts),
        suspended: r.portal_suspended === true, lockedAt: str(r.portal_locked_at), reopenedUntil: str(r.portal_reopened_until),
        /* of the account, only what this workspace needs to manage its own enrolment — nothing about other workspaces */
        account: a ? { respondentId: a.respondentId, status: a.status === "active" ? "active" : a.status === "invited" ? "invited" : "unavailable", scope: a.scope, hasPassword: a.hasPassword, invitePending: !!a.inviteExpiresAt && Date.parse(a.inviteExpiresAt) > now, lastLoginAt: null } : null,
      } satisfies PortalRow;
    }),
  };
}

export interface PortalActResult {
  ok: true;
  changed: number;
  created?: number; linked?: number; emailed?: number;
  skipped: { id: string; why: string }[];
  /** credentials shown ONCE, for accounts without an email address created by this workspace */
  handOver: { id: string; respondentId: string; name: string | null; link?: string; password?: string }[];
}

async function createAccount(db: ReturnType<typeof platformDb>, a: { email: string | null; name: string | null; scope: "persistent" | "assessment"; userId: string; customerId: string | null; expiresAt: string | null }): Promise<{ id: string } | { existing: string } | { error: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await db.from("portal_accounts").insert({ respondent_id: newRespondentId(), email: a.email, name: a.name?.slice(0, 200) ?? null, scope: a.scope, status: "invited", created_by: a.userId, created_customer_id: a.customerId, expires_at: a.expiresAt }).select("id").single();
    if (!error && data) {
      const c = await db.from("portal_credentials").insert({ account_id: data.id });
      if (c.error) { await db.from("portal_accounts").delete().eq("id", data.id); return { error: c.error.message }; }
      return { id: String(data.id) };
    }
    /* somebody created the same person at the same moment: join that account */
    if (error && /portal_accounts_email_idx/.test(error.message) && a.email) {
      const { data: there } = await db.from("portal_accounts").select("id").eq("email", a.email).eq("scope", "persistent").maybeSingle();
      if (there) return { existing: String(there.id) };
    }
    if (error && !/respondent_id/.test(error.message)) return { error: error.message };
  }
  return { error: "a Respondent ID could not be generated" };
}

export async function portalAct(ctx: ProjectContext, req: PortalRequest, surveyTitle: string): Promise<PortalActResult | { error: string; status: number }> {
  const platform = platformDb();
  const own = () => ctx.db.from("respondents");
  const { data: found, error } = await own().select(ENROL).eq("survey_id", ctx.surveyId).eq("is_test", false).in("id", req.ids);
  if (error) return missing(error.message) ? { error: "The respondent portal is not set up on this database yet (migration 0103).", status: 409 } : { error: error.message, status: 500 };
  const rows = (found ?? []) as Row[];
  if (!rows.length) return { error: "Those respondents are not on this survey's live list.", status: 404 };
  const ids = rows.map((r) => String(r.id));
  const result: PortalActResult = { ok: true, changed: 0, skipped: [], handOver: [] };
  const workspace = ctx.survey.customer_id;
  const scoped = (columns: string) => own().select(columns).eq("survey_id", ctx.surveyId).eq("is_test", false);
  const patch = async (p: Row, only: string[] = ids) => {
    const { error: e, count } = await ctx.db.from("respondents").update(p, { count: "exact" }).eq("survey_id", ctx.surveyId).eq("is_test", false).in("id", only);
    if (e) throw new Error(e.message);
    result.changed += count ?? only.length;
  };

  /* ---------------------------------------------------------------- invitations and first passwords */
  const invite = async (targets: Row[]) => {
    const accounts = await accountsById([...new Set(targets.map((r) => str(r.account_id)).filter((x): x is string => !!x))]);
    const mail = mailConfig().configured;
    result.emailed ??= 0;
    for (const r of targets) {
      const a = r.account_id ? accounts.get(String(r.account_id)) : null;
      if (!a) { result.skipped.push({ id: String(r.id), why: "no portal account yet" }); continue; }
      if (a.hasPassword) { result.skipped.push({ id: String(r.id), why: "already has a password — this assessment is on their page when they sign in" }); continue; }
      if (a.status !== "invited" && a.status !== "active") { result.skipped.push({ id: String(r.id), why: "this account is not available" }); continue; }
      const route = credentialRoute(a, workspace, mail, "link");
      if (route.how === "refuse") { result.skipped.push({ id: String(r.id), why: route.why }); continue; }
      const token = mintToken();
      const { error: e } = await platform.from("portal_credentials").update({ invite_token_hash: hashToken(token), invite_expires_at: new Date(Date.now() + PORTAL_POLICY.inviteDays * 86_400_000).toISOString(), updated_at: new Date().toISOString() }).eq("account_id", a.id);
      if (e) { result.skipped.push({ id: String(r.id), why: "the invitation could not be prepared" }); continue; }
      /* the token is in the fragment, so it is never sent in a request for the page */
      const link = `${runtimeBaseUrl()}/portal/invitation#token=${token}`;
      if (route.how === "email") {
        const m = invitationMail({ name: a.name ?? str(r.name), respondentId: a.respondentId, link, surveyTitle, days: PORTAL_POLICY.inviteDays, from: ctx.user.fullName || null });
        const sent = await sendMail({ to: a.email!, subject: m.subject, text: m.text, kind: "portal_invitation", stream: "bulk", dedupeKey: `portal-invite:${a.id}:${hashToken(token).slice(0, 16)}`, surveyId: ctx.surveyId, customerId: workspace, userId: ctx.user.userId });
        if (sent.sent) result.emailed++; else result.skipped.push({ id: String(r.id), why: `the invitation email was not sent (${sent.reason.replace("_", " ")})` });
      } else {
        result.handOver.push({ id: String(r.id), respondentId: a.respondentId, name: a.name ?? str(r.name), link });
      }
      result.changed++;
    }
  };

  try {
    switch (req.action) {
      case "create_accounts": {
        const emails = [...new Set(rows.map((r) => (str(r.email) ?? "").trim().toLowerCase()).filter((e) => e.includes("@")))];
        const existing = new Map<string, string>();
        if (req.identity === "persistent" && emails.length) {
          const { data } = await platform.from("portal_accounts").select("id, email").eq("scope", "persistent").in("email", emails);
          for (const a of (data ?? []) as Row[]) existing.set(String(a.email), String(a.id));
        }
        const { data: enrolled } = await scoped("account_id").not("account_id", "is", null);
        const plan = planAccounts(rows.map((r) => ({ id: String(r.id), email: str(r.email), name: str(r.name), accountId: str(r.account_id) })), existing, new Set(((enrolled ?? []) as unknown as Row[]).map((e) => String(e.account_id))), req.identity);
        result.created = 0; result.linked = 0;
        const linkedRows: string[] = [];
        /* an assessment-only account ends with the enrolment's own window, when it has one */
        const until = (id: string) => str(rows.find((r) => String(r.id) === id)?.access_until);
        for (const p of plan) {
          if (p.do === "already") continue;
          if (p.do === "skip") { result.skipped.push({ id: p.row, why: p.why }); continue; }
          let accountId: string;
          if (p.do === "link") { accountId = p.accountId; result.linked++; }
          else {
            const made = await createAccount(platform, { email: p.email, name: p.name, scope: p.scope, userId: ctx.user.userId, customerId: workspace, expiresAt: p.scope === "assessment" ? until(p.row) : null });
            if ("error" in made) { result.skipped.push({ id: p.row, why: "the account could not be created" }); continue; }
            if ("existing" in made) { accountId = made.existing; result.linked++; } else { accountId = made.id; result.created++; }
          }
          const { error: e } = await ctx.db.from("respondents").update({ account_id: accountId }).eq("id", p.row).eq("survey_id", ctx.surveyId).is("account_id", null);
          if (e) { result.skipped.push({ id: p.row, why: /respondents_account_survey_idx/.test(e.message) ? "this person is already on this survey's list" : "the account could not be linked" }); continue; }
          linkedRows.push(p.row); result.changed++;
        }
        if (req.sendEmail && linkedRows.length) {
          const { data: fresh } = await scoped(ENROL).in("id", linkedRows);
          const before = result.changed;
          await invite((fresh ?? []) as unknown as Row[]);
          result.changed = before;
        }
        break;
      }
      case "invite": await invite(rows); break;
      case "initial_password": {
        const r = rows[0]!;
        const a = r.account_id ? (await accountsById([String(r.account_id)])).get(String(r.account_id)) : null;
        if (!a) return { error: "This respondent has no portal account yet.", status: 409 };
        const route = credentialRoute(a, workspace, mailConfig().configured, "password");
        if (route.how !== "show") return { error: route.how === "refuse" ? route.why : "A password cannot be issued for this person.", status: 403 };
        const password = newInitialPassword();
        const now = new Date().toISOString();
        const { error: e } = await platform.from("portal_credentials").update({ password_hash: await hashPassword(password), password_changed_at: now, must_change: true, failed_attempts: 0, last_failed_at: null, invite_token_hash: null, invite_expires_at: null, reset_token_hash: null, reset_expires_at: null, updated_at: now }).eq("account_id", a.id);
        if (e) return { error: "The password could not be set.", status: 500 };
        await platform.from("portal_sessions").update({ revoked_at: now, revoked_reason: "password_issued" }).eq("account_id", a.id).is("revoked_at", null);
        result.handOver.push({ id: String(r.id), respondentId: a.respondentId, name: a.name ?? str(r.name), password });
        result.changed = 1;
        break;
      }
      case "sign_out": {
        const r = rows[0]!;
        if (!r.account_id) return { error: "This respondent has no portal account yet.", status: 409 };
        await platform.from("portal_sessions").update({ revoked_at: new Date().toISOString(), revoked_reason: "ended_by_researcher" }).eq("account_id", String(r.account_id)).is("revoked_at", null);
        result.changed = 1;
        break;
      }
      case "unlink": await patch({ account_id: null }); break;
      case "suspend": await patch({ portal_suspended: true }); break;
      case "reactivate": await patch({ portal_suspended: false }); break;
      case "lock": await patch({ portal_locked_at: new Date().toISOString(), portal_reopened_until: null }); break;
      case "unlock": await patch({ portal_locked_at: null }); break;
      case "reopen": await patch({ portal_reopened_until: req.until }); break;
      case "access": await patch({ ...(req.setWindow ? { access_from: req.from, access_until: req.until } : {}), ...(req.setAttempts ? { max_attempts: req.maxAttempts } : {}) }); break;
    }
  } catch (e) {
    return { error: (e as Error).message, status: 500 };
  }

  /* the access log (per person) and the project's audit trail (one line) */
  const summary = actionSummary(req);
  const accountIds = [...new Set(rows.map((r) => str(r.account_id)).filter((x): x is string => !!x))];
  if (accountIds.length) {
    await platform.from("portal_events").insert(accountIds.map((id) => ({ account_id: id, event: `researcher_${req.action}`, survey_id: ctx.surveyId, customer_id: workspace, actor_user_id: ctx.user.userId, detail: { ...(req.until ? { until: req.until } : {}), ...(req.setAttempts ? { maxAttempts: req.maxAttempts } : {}) } }))).then(() => null, () => null);
  }
  void audit({ action: "portal.access_changed", userId: ctx.user.userId, sessionId: ctx.user.sessionId, surveyId: ctx.surveyId, customerId: ctx.user.customerId, entity: "respondents", detail: { summary, action: req.action, count: result.changed, skipped: result.skipped.length, ...(result.created !== undefined ? { created: result.created, linked: result.linked } : {}) } });
  return result;
}
