import type { SupabaseClient } from "@supabase/supabase-js";
import type { AlertSettings } from "@rescript/schema";
import { parseAlertSettings } from "@rescript/engine";
import { loadDefinition } from "@/lib/analytics";
import type { ChannelRec, DeliveryRec, EventRec, InAppRec, NotifyStore, ProjectInfo } from "./types.ts";

/**
 * THE NOTIFICATION STORE ON THE DATABASE (migration 0072, service role). The routes check access before they get
 * here. In-app alerts are rows of 0008's `notifications` (action `alert.<type>`, the words in `detail`), so the
 * existing bell / count reads them too.
 */

const READ_ROLES = ["owner", "project_admin", "editor", "programmer", "reviewer", "viewer", "viewer_data", "deployment_manager"];

type Row = Record<string, unknown>;
const channelOf = (r: Row): ChannelRec => ({ id: String(r.id), customerId: String(r.customer_id), kind: r.kind as ChannelRec["kind"], name: String(r.name), config: (r.config as ChannelRec["config"]) ?? {}, sealed: (r.secret_sealed as string) ?? null, keyId: (r.secret_key_id as string) ?? null, hint: (r.hint as string) ?? null, enabled: r.enabled !== false, lastTestAt: (r.last_test_at as string) ?? null, lastStatus: (r.last_status as string) ?? null, createdBy: (r.created_by as string) ?? null, createdAt: String(r.created_at) });
const eventOf = (r: Row): EventRec => ({ id: String(r.id), idempotencyKey: String(r.idempotency_key), customerId: (r.customer_id as string) ?? null, surveyId: (r.survey_id as string) ?? null, type: r.type as EventRec["type"], ref: (r.ref as string) ?? null, payload: (r.payload as EventRec["payload"]) ?? { at: String(r.created_at) }, source: r.source as EventRec["source"], isTest: !!r.is_test, status: r.status as EventRec["status"], attempts: Number(r.attempts ?? 0), createdAt: String(r.created_at) });
const deliveryOf = (r: Row): DeliveryRec => ({ id: String(r.id), eventId: (r.event_id as string) ?? null, customerId: (r.customer_id as string) ?? null, surveyId: (r.survey_id as string) ?? null, eventType: String(r.event_type), channelKind: r.channel_kind as DeliveryRec["channelKind"], channelId: (r.channel_id as string) ?? null, destination: String(r.destination), dedupeKey: (r.dedupe_key as string) ?? null, idempotencyKey: String(r.idempotency_key), status: r.status as DeliveryRec["status"], reason: (r.reason as string) ?? null, digest: (r.digest as DeliveryRec["digest"]) ?? null, attempts: Number(r.attempts ?? 0), nextAttemptAt: (r.next_attempt_at as string) ?? null, responseStatus: (r.response_status as number) ?? null, lastError: (r.last_error as string) ?? null, isTest: !!r.is_test, createdAt: String(r.created_at), sentAt: (r.sent_at as string) ?? null });
const fail = (what: string, e: { message?: string } | null) => { if (e) throw Object.assign(new Error(`${what}: ${e.message ?? "failed"}`), { db: true }); };

const DELIVERY_COLS: Record<keyof Omit<DeliveryRec, "id" | "createdAt">, string> = { eventId: "event_id", customerId: "customer_id", surveyId: "survey_id", eventType: "event_type", channelKind: "channel_kind", channelId: "channel_id", destination: "destination", dedupeKey: "dedupe_key", idempotencyKey: "idempotency_key", status: "status", reason: "reason", digest: "digest", attempts: "attempts", nextAttemptAt: "next_attempt_at", responseStatus: "response_status", lastError: "last_error", isTest: "is_test", sentAt: "sent_at" };
const toCols = (p: Partial<DeliveryRec>) => Object.fromEntries(Object.entries(p).filter(([k]) => k in DELIVERY_COLS).map(([k, v]) => [DELIVERY_COLS[k as keyof typeof DELIVERY_COLS], typeof v === "string" ? v.slice(0, 1000) : v]));

export function dbNotifyStore(db: SupabaseClient): NotifyStore {
  return {
    kind: "db",
    async listChannels(customerId) { const { data, error } = await db.from("notify_channels").select("*").eq("customer_id", customerId).order("created_at"); fail("channels", error); return (data ?? []).map(channelOf); },
    async getChannel(id) { const { data, error } = await db.from("notify_channels").select("*").eq("id", id).maybeSingle(); fail("channel", error); return data ? channelOf(data) : null; },
    async insertChannel(c) {
      const { error } = await db.from("notify_channels").insert({ id: c.id, customer_id: c.customerId, kind: c.kind, name: c.name, config: c.config, secret_sealed: c.sealed, secret_key_id: c.keyId, hint: c.hint, enabled: c.enabled, created_by: c.createdBy });
      if (error && /duplicate|unique/i.test(error.message)) throw Object.assign(new Error(`There is already a ${c.kind} channel named “${c.name}”.`), { code: "duplicate" });
      fail("channel", error);
    },
    async updateChannel(id, p) {
      const patch: Row = { updated_at: new Date().toISOString() };
      if (p.name !== undefined) patch.name = p.name; if (p.config !== undefined) patch.config = p.config; if (p.sealed !== undefined) patch.secret_sealed = p.sealed; if (p.keyId !== undefined) patch.secret_key_id = p.keyId;
      if (p.hint !== undefined) patch.hint = p.hint; if (p.enabled !== undefined) patch.enabled = p.enabled; if (p.lastTestAt !== undefined) patch.last_test_at = p.lastTestAt; if (p.lastStatus !== undefined) patch.last_status = p.lastStatus;
      const { error } = await db.from("notify_channels").update(patch).eq("id", id); fail("channel", error);
    },
    async deleteChannel(id) { const { error } = await db.from("notify_channels").delete().eq("id", id); fail("channel", error); },
    async orgSettings(customerId) { const { data, error } = await db.from("notify_rules").select("settings").eq("customer_id", customerId).is("survey_id", null).maybeSingle(); fail("rules", error); return data ? parseAlertSettings(data.settings) : null; },
    async saveOrgSettings(customerId, settings, userId) {
      const { data } = await db.from("notify_rules").select("id").eq("customer_id", customerId).is("survey_id", null).maybeSingle();
      const { error } = data ? await db.from("notify_rules").update({ settings, updated_by: userId, updated_at: new Date().toISOString() }).eq("id", data.id) : await db.from("notify_rules").insert({ customer_id: customerId, settings, updated_by: userId });
      fail("rules", error);
    },
    async project(surveyId): Promise<ProjectInfo | null> {
      const { data: s } = await db.from("surveys").select("id, customer_id, title, owner_id").eq("id", surveyId).maybeSingle();
      if (!s) return null;
      const loaded = await loadDefinition(db, surveyId).catch(() => null);
      const alerts: AlertSettings | null = loaded && !("error" in loaded) ? parseAlertSettings(loaded.def.alerts) : null;
      const { data: members } = await db.rpc("rescript_project_members", { p_survey: surveyId, p_present_within_seconds: 60 });
      const team = ((members ?? []) as { user_id: string; email: string | null; role: string; status?: string }[]).filter((m) => READ_ROLES.includes(m.role) && m.status !== "disabled").map((m) => ({ userId: m.user_id, email: m.email ?? null }));
      return { surveyId, customerId: (s.customer_id as string) ?? null, title: String(s.title ?? ""), ownerId: (s.owner_id as string) ?? null, alerts: loaded && !("error" in loaded) && loaded.def.alerts ? alerts : null, team };
    },
    async userEmail(userId) { const { data } = await db.from("profiles").select("email").eq("id", userId).maybeSingle(); return (data?.email as string) ?? null; },
    async insertEvent(e) {
      const { data, error } = await db.from("notify_events").insert({ idempotency_key: e.idempotencyKey, customer_id: e.customerId, survey_id: e.surveyId, type: e.type, ref: e.ref, payload: e.payload, source: e.source, is_test: e.isTest }).select("*").single();
      if (error && /duplicate|unique/i.test(error.message)) { const { data: hit } = await db.from("notify_events").select("*").eq("idempotency_key", e.idempotencyKey).maybeSingle(); if (hit) return { event: eventOf(hit), inserted: false }; }
      fail("event", error);
      return { event: eventOf(data!), inserted: true };
    },
    async claimEvents(limit, eventId) { const { data, error } = await db.rpc("rescript_notify_claim", { p_limit: limit, p_lease_seconds: 60, p_event: eventId ?? null }); fail("claim", error); return ((data ?? []) as Row[]).map(eventOf); },
    async finishEvent(id, status) { const { error } = await db.from("notify_events").update({ status, processed_at: new Date().toISOString(), lease_until: null }).eq("id", id); fail("event", error); },
    async eventsByIds(ids) { if (!ids.length) return []; const { data, error } = await db.from("notify_events").select("*").in("id", ids.slice(0, 200)); fail("events", error); return (data ?? []).map(eventOf); },
    async insertDelivery(d) {
      const { data, error } = await db.from("notify_deliveries").insert(toCols(d)).select("*").single();
      if (error && /duplicate|unique/i.test(error.message)) { const { data: hit } = await db.from("notify_deliveries").select("*").eq("idempotency_key", d.idempotencyKey).maybeSingle(); if (hit) return { delivery: deliveryOf(hit), inserted: false }; }
      fail("delivery", error);
      return { delivery: deliveryOf(data!), inserted: true };
    },
    async updateDelivery(id, p) { const { error } = await db.from("notify_deliveries").update(toCols(p)).eq("id", id); fail("delivery", error); },
    async lastSame(dedupeKey, destination, sinceIso, exceptEventId) {
      let q = db.from("notify_deliveries").select("created_at").eq("dedupe_key", dedupeKey).eq("destination", destination).gte("created_at", sinceIso).in("status", ["queued", "sent", "retrying", "digest_pending", "digested"]).order("created_at", { ascending: false }).limit(1);
      if (exceptEventId) q = q.neq("event_id", exceptEventId);
      const { data, error } = await q; fail("dedupe", error); return (data?.[0]?.created_at as string) ?? null;
    },
    async countSent(destination, sinceIso) { const { count, error } = await db.from("notify_deliveries").select("id", { count: "exact", head: true }).eq("destination", destination).eq("status", "sent").is("digest", null).gte("sent_at", sinceIso); fail("count", error); return count ?? 0; },
    async dueDeliveries(nowIso, limit) { const { data, error } = await db.from("notify_deliveries").select("*").in("status", ["retrying", "digest_pending"]).lte("next_attempt_at", nowIso).order("next_attempt_at").limit(limit); fail("due", error); return (data ?? []).map(deliveryOf); },
    async listDeliveries(f) {
      let q = db.from("notify_deliveries").select("*").order("created_at", { ascending: false }).limit(f.limit);
      if (f.surveyId) q = q.eq("survey_id", f.surveyId); if (f.customerId) q = q.eq("customer_id", f.customerId);
      const { data, error } = await q; fail("deliveries", error); return (data ?? []).map(deliveryOf);
    },
    async insertInApp(rows) {
      if (!rows.length) return;
      const { error } = await db.from("notifications").insert(rows.map((r) => ({ user_id: r.userId, survey_id: r.surveyId, action: `alert.${r.severity}`, detail: { title: r.title, text: r.text, link: r.link, severity: r.severity }, notify_event_id: r.eventId })));
      fail("in-app", error);
    },
    async listInApp(userId, limit): Promise<InAppRec[]> {
      const { data, error } = await db.from("notifications").select("id, survey_id, action, detail, created_at, read_at, notify_event_id").eq("user_id", userId).like("action", "alert.%").order("created_at", { ascending: false }).limit(limit);
      fail("in-app", error);
      return (data ?? []).map((n) => { const d = (n.detail ?? {}) as Record<string, string>; return { id: String(n.id), userId, surveyId: (n.survey_id as string) ?? null, eventId: (n.notify_event_id as string) ?? null, title: d.title ?? "Alert", text: d.text ?? "", link: d.link ?? null, severity: d.severity ?? "normal", createdAt: String(n.created_at), readAt: (n.read_at as string) ?? null }; });
    },
    async markInAppRead(userId, ids) {
      let q = db.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", userId).is("read_at", null).like("action", "alert.%");
      if (ids?.length) q = q.in("id", ids.slice(0, 200));
      const { error } = await q; fail("in-app", error);
    },
  };
}
