import { randomUUID } from "node:crypto";
import type { AlertSettings } from "@rescript/schema";
import type { ChannelRec, DeliveryRec, EventRec, InAppRec, NotifyStore, ProjectInfo } from "./types.ts";

/**
 * THE NOTIFICATION STORE IN MEMORY — the unit tests, and the sandbox (a Studio with no database on the fake
 * provider; `sandbox.ts` persists it to a file in the OS temp directory so a restarting dev server keeps a test's
 * channels). Follows the SQL's rules: unique idempotency keys for events and deliveries, leased claims.
 */
export interface MemoryNotifyState {
  channels: ChannelRec[];
  orgRules: Record<string, AlertSettings>;
  projects: Record<string, ProjectInfo>;
  emails: Record<string, string>;
  events: (EventRec & { leaseUntil?: number })[];
  deliveries: DeliveryRec[];
  inApp: InAppRec[];
}
export const emptyNotifyState = (): MemoryNotifyState => ({ channels: [], orgRules: {}, projects: {}, emails: {}, events: [], deliveries: [], inApp: [] });

export function memoryNotifyStore(state: MemoryNotifyState = emptyNotifyState(), opts: { now?: () => number; onChange?: () => void } = {}): NotifyStore & { state: MemoryNotifyState } {
  const now = opts.now ?? (() => Date.now());
  const iso = () => new Date(now()).toISOString();
  const changed = () => opts.onChange?.();
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  return {
    kind: "memory",
    state,
    async listChannels(customerId) { return clone(state.channels.filter((c) => c.customerId === customerId)); },
    async getChannel(id) { const c = state.channels.find((x) => x.id === id); return c ? clone(c) : null; },
    async insertChannel(c) {
      if (state.channels.some((x) => x.customerId === c.customerId && x.kind === c.kind && x.name.toLowerCase() === c.name.toLowerCase())) throw Object.assign(new Error(`There is already a ${c.kind} channel named “${c.name}”.`), { code: "duplicate" });
      state.channels.push(clone(c)); changed();
    },
    async updateChannel(id, patch) { const c = state.channels.find((x) => x.id === id); if (c) { Object.assign(c, clone(patch)); changed(); } },
    async deleteChannel(id) { state.channels = state.channels.filter((x) => x.id !== id); changed(); },
    async orgSettings(customerId) { return state.orgRules[customerId] ? clone(state.orgRules[customerId]) : null; },
    async saveOrgSettings(customerId, settings) { state.orgRules[customerId] = clone(settings); changed(); },
    async project(surveyId) { return state.projects[surveyId] ? clone(state.projects[surveyId]) : null; },
    async userEmail(userId) { return state.emails[userId] ?? null; },
    async insertEvent(e) {
      const hit = state.events.find((x) => x.idempotencyKey === e.idempotencyKey);
      if (hit) return { event: clone(hit), inserted: false };
      const ev: EventRec = { ...clone(e), id: randomUUID(), status: "pending", attempts: 0, createdAt: iso() };
      state.events.push(ev); changed();
      return { event: clone(ev), inserted: true };
    },
    async claimEvents(limit, eventId) {
      const t = now();
      const out = state.events.filter((x) => (!eventId || x.id === eventId) && (x.status === "pending" || (x.status === "processing" && (x.leaseUntil ?? 0) < t)) && x.attempts < 10).slice(0, limit);
      for (const x of out) { x.status = "processing"; x.attempts++; x.leaseUntil = t + 60_000; }
      if (out.length) changed();
      return clone(out).map(({ leaseUntil: _l, ...e }) => e as EventRec);
    },
    async finishEvent(id, status) { const e = state.events.find((x) => x.id === id); if (e) { e.status = status; changed(); } },
    async eventsByIds(ids) { return clone(state.events.filter((x) => ids.includes(x.id))); },
    async insertDelivery(d) {
      const hit = state.deliveries.find((x) => x.idempotencyKey === d.idempotencyKey);
      if (hit) return { delivery: clone(hit), inserted: false };
      const rec: DeliveryRec = { ...clone(d), id: randomUUID(), createdAt: iso() };
      state.deliveries.push(rec); changed();
      return { delivery: clone(rec), inserted: true };
    },
    async updateDelivery(id, patch) { const d = state.deliveries.find((x) => x.id === id); if (d) { Object.assign(d, clone(patch)); changed(); } },
    async lastSame(dedupeKey, destination, sinceIso, exceptEventId) {
      const hits = state.deliveries.filter((x) => x.dedupeKey === dedupeKey && x.destination === destination && x.createdAt >= sinceIso && x.eventId !== exceptEventId && ["queued", "sent", "retrying", "digest_pending", "digested"].includes(x.status));
      return hits.length ? hits.map((x) => x.createdAt).sort().at(-1)! : null;
    },
    async countSent(destination, sinceIso) { return state.deliveries.filter((x) => x.destination === destination && x.status === "sent" && !x.digest && (x.sentAt ?? "") >= sinceIso).length; },
    async dueDeliveries(nowIso, limit) { return clone(state.deliveries.filter((x) => (x.status === "retrying" || x.status === "digest_pending") && x.nextAttemptAt && x.nextAttemptAt <= nowIso).slice(0, limit)); },
    async listDeliveries(f) { return clone(state.deliveries.filter((x) => (!f.customerId || x.customerId === f.customerId) && (!f.surveyId || x.surveyId === f.surveyId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, f.limit)); },
    async insertInApp(rows) { for (const r of rows) state.inApp.push({ ...clone(r), id: randomUUID(), createdAt: iso(), readAt: null }); if (rows.length) changed(); },
    async listInApp(userId, limit) { return clone(state.inApp.filter((x) => x.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)); },
    async markInAppRead(userId, ids) { for (const x of state.inApp) if (x.userId === userId && !x.readAt && (!ids || ids.includes(x.id))) x.readAt = iso(); changed(); },
  };
}
