import "server-only";
import { mintToken, newRespondentId } from "@rescript/access/respondent";
import { mailConfig } from "./mail";
import { runtimeBaseUrl } from "./runtime-url";
import { credentialRoute, planAccounts, summariseLists, type PortalEveryone, type PortalRequest } from "./portalAdminCore";
import { sandboxPeople } from "./respondentIntake";
import type { PortalActResult, PortalRow } from "./portalAdmin";

/**
 * THE PORTAL'S PEOPLE LIST IN THE DATABASE-LESS SANDBOX (2026-11-21) — so the Studio's "People" section can be
 * driven in a browser with no database: pick a list, add people, create accounts, see what is handed over.
 *
 * It keeps accounts in memory and takes its DECISIONS from the same pure functions as the product
 * (`planAccounts`, `credentialRoute`, `summariseLists`). It is not the product's storage and proves nothing about
 * the SQL: lib/portalAdmin.ts is that. Only reachable where `peopleSandboxAllowed` says so — never in production.
 */
interface SandboxAccount { respondentId: string; email: string | null; invitePending: boolean; suspended: boolean; locked: boolean }
declare global {
  // eslint-disable-next-line no-var
  var __rescriptSandboxAccounts: Map<string, SandboxAccount> | undefined;
}
const accounts = () => (globalThis.__rescriptSandboxAccounts ??= new Map());
const live = () => sandboxPeople().filter((p) => !p.is_test);
const WORKSPACE = "sandbox-workspace";

const inScope = (e: { list?: string | null; noAccount?: boolean }) => live().filter((p) => (e.list === undefined || p.list_name === e.list) && (!e.noAccount || !accounts().has(p.id)));

export function sandboxPortalList(q: { limit: number; offset: number; search: string; list?: string | null; noAccount?: boolean }) {
  const s = q.search.trim().toLowerCase();
  const all = inScope(q).filter((p) => !s || [p.name, p.email, p.external_id].some((v) => v?.toLowerCase().includes(s)));
  const rows: PortalRow[] = all.slice(q.offset, q.offset + q.limit).map((p) => {
    const a = accounts().get(p.id);
    return {
      id: p.id, email: p.email, name: p.name, externalId: p.external_id, list: p.list_name, status: p.status,
      accessFrom: null, accessUntil: null, maxAttempts: null, suspended: !!a?.suspended, lockedAt: a?.locked ? p.invited_at : null, reopenedUntil: null,
      account: a ? { respondentId: a.respondentId, status: "invited", scope: "persistent", hasPassword: false, invitePending: a.invitePending, lastLoginAt: null } : null,
    };
  });
  return { ok: true, available: true, rows, total: all.length, mail: mailConfig().configured, lists: summariseLists(live().map((p) => ({ list: p.list_name, hasAccount: accounts().has(p.id) }))), canManage: true, canIndividual: false };
}

export function sandboxEveryone(e: PortalEveryone): string[] { return inScope(e).map((p) => p.id); }

export function sandboxPortalAct(req: PortalRequest): PortalActResult | { error: string; status: number } {
  const rows = live().filter((p) => req.ids.includes(p.id));
  if (!rows.length) return { error: "Those respondents are not on this survey's live list.", status: 404 };
  const result: PortalActResult = { ok: true, changed: 0, skipped: [], handOver: [] };
  const mail = mailConfig().configured;
  const invite = (ids: string[]) => {
    result.emailed ??= 0;
    for (const id of ids) {
      const a = accounts().get(id); const p = rows.find((r) => r.id === id)!;
      if (!a) { result.skipped.push({ id, why: "no portal account yet" }); continue; }
      const route = credentialRoute({ email: a.email, createdCustomerId: WORKSPACE }, WORKSPACE, mail, "link");
      if (route.how === "refuse") { result.skipped.push({ id, why: route.why }); continue; }
      a.invitePending = true;
      /* the sandbox sends no email: where the rule says "email", it says so and counts nothing as sent */
      if (route.how === "email") { result.skipped.push({ id, why: "the sandbox does not send email" }); continue; }
      result.handOver.push({ id, respondentId: a.respondentId, name: p.name, link: `${runtimeBaseUrl()}/portal/invitation#token=${mintToken()}` });
      result.changed++;
    }
  };
  switch (req.action) {
    case "create_accounts": {
      const byEmail = new Map<string, string>();
      const plan = planAccounts(rows.map((r) => ({ id: r.id, email: r.email, name: r.name, accountId: accounts().has(r.id) ? r.id : null })), byEmail, new Set(), req.identity);
      result.created = 0; result.linked = 0;
      const made: string[] = [];
      for (const p of plan) {
        if (p.do === "already") continue;
        if (p.do === "skip") { result.skipped.push({ id: p.row, why: p.why }); continue; }
        if (p.do === "link") continue;
        accounts().set(p.row, { respondentId: newRespondentId(), email: p.email, invitePending: false, suspended: false, locked: false });
        made.push(p.row); result.created++; result.changed++;
      }
      if (req.sendEmail && made.length) { const before = result.changed; invite(made); result.changed = before; }
      return result;
    }
    case "invite": invite(rows.map((r) => r.id)); return result;
    case "suspend": case "reactivate": case "lock": case "unlock":
      for (const r of rows) { const a = accounts().get(r.id); if (!a) continue; if (req.action === "suspend") a.suspended = true; if (req.action === "reactivate") a.suspended = false; if (req.action === "lock") a.locked = true; if (req.action === "unlock") a.locked = false; result.changed++; }
      return result;
    default:
      return { error: "This action needs the database and is not available in the sandbox.", status: 501 };
  }
}
