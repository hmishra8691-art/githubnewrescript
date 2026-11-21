import "server-only";
import { getCachedVersionDefinition } from "@rescript/quality/server";
import { platformDb, router, surveyDb, type customerDb } from "@/lib/db";
import type { BenchmarkSnapshot, StoredScore } from "@rescript/analytics/benchmark";
import type { AccountRec, AttemptData, AttemptRec, CredentialRec, EnrolmentRec, MessageRec, NotificationRec, PortalStore, PrivacyRequestRec, SessionRec } from "./types";

/**
 * THE PORTAL'S STORE ON THE DATABASE (phase 1, 2026-11-20).
 *
 * Accounts, credentials, sessions and the access log are PLATFORM data (one identity wherever a client's data
 * lives). Enrolments, attempts and definitions are CLIENT data: an account's enrolments are gathered from every
 * client database (`respondents.account_id`), and each is then read and written in the database it came from.
 */
type Db = ReturnType<typeof customerDb>;
type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : null);

const ACCOUNT = "id, respondent_id, email, name, scope, status, expires_at, last_login_at";
const toAccount = (r: Row): AccountRec => ({ id: String(r.id), respondentId: String(r.respondent_id), email: str(r.email), name: str(r.name), scope: r.scope === "assessment" ? "assessment" : "persistent", status: r.status as AccountRec["status"], expiresAt: str(r.expires_at), lastLoginAt: str(r.last_login_at) });
const CRED = "account_id, password_hash, must_change, failed_attempts, last_failed_at, invite_token_hash, invite_expires_at, reset_token_hash, reset_expires_at";
const toCred = (r: Row): CredentialRec => ({ accountId: String(r.account_id), passwordHash: str(r.password_hash), mustChange: r.must_change === true, failedAttempts: Number(r.failed_attempts ?? 0), lastFailedAt: str(r.last_failed_at), inviteTokenHash: str(r.invite_token_hash), inviteExpiresAt: str(r.invite_expires_at), resetTokenHash: str(r.reset_token_hash), resetExpiresAt: str(r.reset_expires_at) });
const SESSION = "id, account_id, token_hash, created_at, last_seen_at, revoked_at, device_label";
const toSession = (r: Row): SessionRec => ({ id: String(r.id), accountId: String(r.account_id), tokenHash: String(r.token_hash), createdAt: String(r.created_at), lastSeenAt: String(r.last_seen_at), revokedAt: str(r.revoked_at), deviceLabel: str(r.device_label) });
const ATTEMPT = "id, session_id, status, started_at, completed_at, revision, version_id";
const toAttempt = (r: Row): AttemptRec => ({ id: String(r.id), sessionId: String(r.session_id), status: String(r.status), startedAt: str(r.started_at), completedAt: str(r.completed_at), revision: Number(r.revision ?? 0), versionId: str(r.version_id) });
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const must = <T>(r: { data: T; error: { message: string } | null }, what: string): T => {
  if (r.error) throw new Error(`portal store (${what}): ${r.error.message}`);
  return r.data;
};

export function supabasePortalStore(): PortalStore {
  const platform = platformDb();
  /* which client database each enrolment was found in — the same request reads and writes it there */
  const home = new Map<string, Db>();
  const dbOf = async (e: EnrolmentRec): Promise<Db> => home.get(e.id) ?? surveyDb(e.surveyId);

  const accountBy = async (column: string, value: string, extra?: [string, string]) => {
    let q = platform.from("portal_accounts").select(ACCOUNT).eq(column, value);
    if (extra) q = q.eq(extra[0], extra[1]);
    const row = must(await q.maybeSingle(), "account");
    return row ? toAccount(row as Row) : null;
  };
  const accountByCred = async (column: string, hash: string) => {
    const row = must(await platform.from("portal_credentials").select("account_id").eq(column, hash).maybeSingle(), "credential");
    return row ? accountBy("id", String((row as Row).account_id)) : null;
  };

  return {
    accountByLogin: (l) => (l.kind === "email" ? accountBy("email", l.value, ["scope", "persistent"]) : accountBy("respondent_id", l.value)),
    accountById: (id) => accountBy("id", id),
    accountByInviteHash: (h) => accountByCred("invite_token_hash", h),
    accountByResetHash: (h) => accountByCred("reset_token_hash", h),
    async saveAccount(id, patch) {
      const row: Row = { updated_at: new Date().toISOString() };
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.lastLoginAt !== undefined) row.last_login_at = patch.lastLoginAt;
      must(await platform.from("portal_accounts").update(row).eq("id", id), "save account");
    },
    async credential(accountId) {
      const row = must(await platform.from("portal_credentials").select(CRED).eq("account_id", accountId).maybeSingle(), "credential");
      return row ? toCred(row as Row) : null;
    },
    async saveCredential(accountId, p) {
      const row: Row = { updated_at: new Date().toISOString() };
      if (p.passwordHash !== undefined) { row.password_hash = p.passwordHash; row.password_changed_at = new Date().toISOString(); }
      if (p.mustChange !== undefined) row.must_change = p.mustChange;
      if (p.failedAttempts !== undefined) row.failed_attempts = p.failedAttempts;
      if (p.lastFailedAt !== undefined) row.last_failed_at = p.lastFailedAt;
      if (p.inviteTokenHash !== undefined) row.invite_token_hash = p.inviteTokenHash;
      if (p.inviteExpiresAt !== undefined) row.invite_expires_at = p.inviteExpiresAt;
      if (p.resetTokenHash !== undefined) row.reset_token_hash = p.resetTokenHash;
      if (p.resetExpiresAt !== undefined) row.reset_expires_at = p.resetExpiresAt;
      must(await platform.from("portal_credentials").update(row).eq("account_id", accountId), "save credential");
    },

    async createSession(s) {
      const row = must(await platform.from("portal_sessions").insert({ account_id: s.accountId, token_hash: s.tokenHash, device_label: s.deviceLabel, ip_hash: s.ipHash, created_at: s.now, last_seen_at: s.now }).select(SESSION).single(), "create session");
      return toSession(row as Row);
    },
    async sessionByHash(hash) {
      const row = must(await platform.from("portal_sessions").select(SESSION).eq("token_hash", hash).maybeSingle(), "session");
      return row ? toSession(row as Row) : null;
    },
    async touchSession(id, now) { await platform.from("portal_sessions").update({ last_seen_at: now }).eq("id", id).is("revoked_at", null); },
    async revokeSession(id, reason, now) { must(await platform.from("portal_sessions").update({ revoked_at: now, revoked_reason: reason }).eq("id", id).is("revoked_at", null), "revoke session"); },
    async revokeAllSessions(accountId, reason, now, exceptId) {
      let q = platform.from("portal_sessions").update({ revoked_at: now, revoked_reason: reason }).eq("account_id", accountId).is("revoked_at", null);
      if (exceptId) q = q.neq("id", exceptId);
      must(await q, "revoke sessions");
    },
    async sessions(accountId) {
      const rows = must(await platform.from("portal_sessions").select(SESSION).eq("account_id", accountId).is("revoked_at", null).order("created_at", { ascending: true }).limit(50), "sessions");
      return ((rows ?? []) as Row[]).map(toSession);
    },

    async enrolments(accountId) {
      const found: { row: Row; db: Db }[] = [];
      for (const t of router.everyDatabase()) {
        const rows = must(await t.db.from("respondents")
          .select("id, survey_id, token, access_from, access_until, max_attempts, portal_suspended, portal_locked_at, portal_reopened_until, surveys(id, title, status, customer_id)")
          .eq("account_id", accountId).eq("is_test", false).limit(500), "enrolments");
        for (const row of (rows ?? []) as Row[]) found.push({ row, db: t.db });
      }
      if (!found.length) return [];
      const surveyIds = [...new Set(found.map((f) => String(f.row.survey_id)))];
      const deps = must(await platform.from("deployments").select("survey_id, client_slug, study_slug, version_id").in("survey_id", surveyIds).eq("mode", "live").eq("active", true), "deployments");
      const linkOf = new Map(((deps ?? []) as Row[]).map((d) => [String(d.survey_id), { clientSlug: String(d.client_slug), studySlug: String(d.study_slug), versionId: String(d.version_id) }]));
      return found.map(({ row, db }) => {
        const s = (Array.isArray(row.surveys) ? row.surveys[0] : row.surveys) as Row | null;
        home.set(String(row.id), db);
        return {
          id: String(row.id), accountId, surveyId: String(row.survey_id), customerId: str(s?.customer_id), title: str(s?.title) ?? "Assessment", surveyStatus: str(s?.status) ?? "closed",
          token: String(row.token), accessFrom: str(row.access_from), accessUntil: str(row.access_until), maxAttempts: row.max_attempts == null ? null : Number(row.max_attempts),
          suspended: row.portal_suspended === true, lockedAt: str(row.portal_locked_at), reopenedUntil: str(row.portal_reopened_until), link: linkOf.get(String(row.survey_id)) ?? null,
        } satisfies EnrolmentRec;
      });
    },
    async attempts(e) {
      const rows = must(await (await dbOf(e)).from("responses").select(ATTEMPT).eq("respondent_id", e.id).eq("survey_id", e.surveyId).eq("is_test", false).is("deleted_at", null).order("started_at", { ascending: true }).limit(200), "attempts");
      return ((rows ?? []) as Row[]).map(toAttempt);
    },
    async attempt(e, responseId) {
      const row = must(await (await dbOf(e)).from("responses").select(`${ATTEMPT}, answers, calculated, embedded, flags, step_index, seed`).eq("id", responseId).eq("respondent_id", e.id).eq("survey_id", e.surveyId).eq("is_test", false).is("deleted_at", null).maybeSingle(), "attempt") as Row | null;
      if (!row) return null;
      return { ...toAttempt(row), answers: obj(row.answers), calculated: obj(row.calculated), embedded: obj(row.embedded), flags: Array.isArray(row.flags) ? row.flags : [], stepIndex: Number(row.step_index ?? 0), seed: row.seed == null ? null : Number(row.seed) } satisfies AttemptData;
    },
    async definition(e, versionId) { return getCachedVersionDefinition(await dbOf(e), versionId); },
    async writeEdit(e, w) {
      const { data, error } = await (await dbOf(e)).rpc("rescript_portal_edit_response", { p_id: w.responseId, p_expected_revision: w.expectedRevision, p_answers: w.answers, p_calculated: w.calculated, p_changes: w.changes, p_by: w.by });
      if (error) return { ok: false, conflict: /REVISION_CONFLICT/.test(error.message), error: error.message };
      const row = (Array.isArray(data) ? data[0] : data) as { new_revision?: number } | null;
      return { ok: true, revision: Number(row?.new_revision ?? w.expectedRevision + 1) };
    },

    /* phase 2. Before migration 0104 the tables are missing: writes are skipped and reads are empty, so the portal
       shows a person's own scores and says a comparison is not available yet. */
    async saveScorecard(e, sc) {
      const { error } = await (await dbOf(e)).from("portal_scorecards").upsert({ response_id: sc.responseId, survey_id: e.surveyId, respondent_id: e.id, is_test: false, fingerprint: sc.key, scores: sc.scores, cohort: sc.cohort, result: sc.result, completed_at: sc.completedAt, updated_at: new Date().toISOString() }, { onConflict: "response_id" });
      if (error) throw new Error(`portal store (save scorecard): ${error.message}`);
    },
    async scoreRows(e, key) {
      const out: StoredScore[] = [];
      const db = await dbOf(e);
      for (let from = 0; from < 50_000; from += 1000) {
        const rows = must(await db.from("portal_scorecards").select("respondent_id, completed_at, scores, cohort, responses!inner(status, deleted_at)")
          .eq("survey_id", e.surveyId).eq("is_test", false).eq("fingerprint", key).eq("responses.status", "complete").is("responses.deleted_at", null)
          .order("response_id", { ascending: true }).range(from, from + 999), "score rows") as unknown as Row[] | null;
        for (const r of rows ?? []) out.push({ person: str(r.respondent_id), at: str(r.completed_at), values: obj(r.scores) as Record<string, number | null>, cohort: obj(r.cohort) as Record<string, string | null> });
        if ((rows ?? []).length < 1000) break;
      }
      return out;
    },
    async benchmark(e) {
      const { data, error } = await (await dbOf(e)).from("portal_benchmarks").select("snapshot, computed_at").eq("survey_id", e.surveyId).maybeSingle();
      if (error || !data) return null;
      const row = data as Row;
      return { snapshot: row.snapshot as BenchmarkSnapshot, computedAt: String(row.computed_at) };
    },
    async saveBenchmark(e, snapshot, now) {
      const { error } = await (await dbOf(e)).from("portal_benchmarks").upsert({ survey_id: e.surveyId, fingerprint: snapshot.fingerprint, people: snapshot.n, snapshot, computed_at: now }, { onConflict: "survey_id" });
      if (error) console.warn("[rescript:portal] benchmark not stored", JSON.stringify({ surveyId: e.surveyId, error: error.message }));
    },

    /* phase 5 (migration 0105). Before it is applied `consent` cannot tell, and says so with null. */
    async consent(accountId, version) {
      const { data, error } = await platform.from("portal_consents").select("given_at, withdrawn_at").eq("account_id", accountId).eq("version", version).maybeSingle();
      if (error) return null;
      const row = data as Row | null;
      return row && !row.withdrawn_at ? { givenAt: String(row.given_at) } : "needed";
    },
    async saveConsent(accountId, version, now, ipHash) {
      must(await platform.from("portal_consents").upsert({ account_id: accountId, version, given_at: now, withdrawn_at: null, ip_hash: ipHash }, { onConflict: "account_id,version" }), "save consent");
    },
    async withdrawConsent(accountId, now) {
      must(await platform.from("portal_consents").update({ withdrawn_at: now }).eq("account_id", accountId).is("withdrawn_at", null), "withdraw consent");
    },
    async addRequest(r) {
      must(await platform.from("portal_requests").insert({ account_id: r.accountId, survey_id: r.surveyId, customer_id: r.customerId, enrolment_id: r.enrolmentId, kind: r.kind, message: r.message, created_at: r.now }), "add request");
    },
    async requests(accountId) {
      const { data, error } = await platform.from("portal_requests").select("id, enrolment_id, survey_id, kind, status, message, response_note, created_at, resolved_at").eq("account_id", accountId).order("created_at", { ascending: false }).limit(100);
      if (error) return [];
      return ((data ?? []) as Row[]).map((r) => ({ id: String(r.id), enrolmentId: String(r.enrolment_id), surveyId: String(r.survey_id), kind: r.kind as PrivacyRequestRec["kind"], status: r.status as PrivacyRequestRec["status"], message: str(r.message), responseNote: str(r.response_note), createdAt: String(r.created_at), resolvedAt: str(r.resolved_at) }));
    },
    async staffViews(accountId) {
      const { data, error } = await platform.from("portal_events").select("created_at, survey_id").eq("account_id", accountId).eq("event", "results_viewed_by_staff").order("created_at", { ascending: false }).limit(50);
      if (error) return [];
      return ((data ?? []) as Row[]).map((r) => ({ at: String(r.created_at), surveyId: str(r.survey_id) }));
    },

    /* phase 6 (migration 0106) */
    async notifications(accountId) {
      const { data, error } = await platform.from("portal_notifications").select("id, kind, title, body, enrolment_id, created_at, read_at").eq("account_id", accountId).order("created_at", { ascending: false }).limit(50);
      if (error) return [];
      return ((data ?? []) as Row[]).map((r) => ({ id: String(r.id), kind: r.kind as NotificationRec["kind"], title: String(r.title), body: str(r.body), enrolmentId: str(r.enrolment_id), createdAt: String(r.created_at), readAt: str(r.read_at) }));
    },
    async markNotificationsRead(accountId, now) { await platform.from("portal_notifications").update({ read_at: now }).eq("account_id", accountId).is("read_at", null); },
    async messages(accountId, enrolmentId) {
      const { data, error } = await platform.from("portal_messages").select("id, from_staff, body, created_at, read_by_respondent_at").eq("account_id", accountId).eq("enrolment_id", enrolmentId).order("created_at", { ascending: true }).limit(200);
      if (error) return [];
      return ((data ?? []) as Row[]).map((r) => ({ id: String(r.id), fromStaff: r.from_staff === true, body: String(r.body), createdAt: String(r.created_at), readByRespondentAt: str(r.read_by_respondent_at) } satisfies MessageRec));
    },
    async addMessage(m) {
      must(await platform.from("portal_messages").insert({ account_id: m.accountId, survey_id: m.surveyId, customer_id: m.customerId, enrolment_id: m.enrolmentId, from_staff: false, body: m.body, created_at: m.now, read_by_respondent_at: m.now }), "add message");
    },
    async markMessagesRead(accountId, enrolmentId, now) { await platform.from("portal_messages").update({ read_by_respondent_at: now }).eq("account_id", accountId).eq("enrolment_id", enrolmentId).eq("from_staff", true).is("read_by_respondent_at", null); },

    async log(ev) {
      try {
        await platform.from("portal_events").insert({ account_id: ev.accountId, event: ev.event.slice(0, 60), survey_id: ev.surveyId ?? null, customer_id: ev.customerId ?? null, detail: ev.detail ?? {}, ip_hash: ev.ipHash ?? null });
      } catch (e) {
        console.warn("[rescript:portal] event not logged", JSON.stringify({ event: ev.event, error: (e as Error).message }));
      }
    },
  };
}
