import type { AlertSettings, AlertChannelKind } from "@rescript/schema";
import type { NotifyEventType } from "@rescript/engine";

/**
 * THE NOTIFICATION SERVICE'S RECORDS (2026-10-22, G3) — behind one interface with two implementations: the
 * database (migration 0072, service role: `dbStore.ts`) and memory (`memoryStore.ts`, only on a Studio with no
 * database AND the fake provider — the sandbox the browser suites and a laptop use).
 */

export type ChannelKind = "slack" | "teams" | "webhook" | "email";

export interface ChannelRec {
  id: string;
  customerId: string;
  kind: ChannelKind;
  name: string;
  /** e-mail channels: { to: [addresses] }; never a secret */
  config: { to?: string[] };
  /** the sealed { url, signingSecret? } — never leaves the server */
  sealed: string | null;
  keyId: string | null;
  /** the masked URL a screen may show */
  hint: string | null;
  enabled: boolean;
  lastTestAt: string | null;
  lastStatus: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** what a browser is told about a channel: no secret, ever */
export interface ChannelView { id: string; kind: ChannelKind; name: string; hint: string | null; to?: string[]; enabled: boolean; lastTestAt: string | null; lastStatus: string | null; createdAt: string }
export const channelView = (c: ChannelRec): ChannelView => ({ id: c.id, kind: c.kind, name: c.name, hint: c.hint, ...(c.kind === "email" ? { to: c.config.to ?? [] } : {}), enabled: c.enabled, lastTestAt: c.lastTestAt, lastStatus: c.lastStatus, createdAt: c.createdAt });

/** the event as stored in the outbox — the excerpt already REDACTED */
export interface EventPayload {
  studyTitle?: string | null;
  participant?: string | null;
  excerpt?: string | null;
  link?: string | null;
  detail?: Record<string, string | number | boolean | null>;
  at: string;
}
export interface EventRec {
  id: string;
  idempotencyKey: string;
  customerId: string | null;
  surveyId: string | null;
  type: NotifyEventType;
  ref: string | null;
  payload: EventPayload;
  source: "studio" | "runtime" | "cron";
  isTest: boolean;
  status: "pending" | "processing" | "processed" | "failed";
  attempts: number;
  createdAt: string;
}

export type DeliveryStatus = "queued" | "sent" | "failed" | "retrying" | "skipped" | "digest_pending" | "digested" | "not_configured";
export interface DeliveryRec {
  id: string;
  eventId: string | null;
  customerId: string | null;
  surveyId: string | null;
  eventType: string;
  channelKind: AlertChannelKind;
  channelId: string | null;
  /** an address, "user:<id>", "#research-ops" — never a URL */
  destination: string;
  dedupeKey: string | null;
  idempotencyKey: string;
  status: DeliveryStatus;
  reason: string | null;
  digest: "hourly" | "daily" | null;
  attempts: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  lastError: string | null;
  isTest: boolean;
  createdAt: string;
  sentAt: string | null;
}

export interface InAppRec { id: string; userId: string; surveyId: string | null; eventId: string | null; title: string; text: string; link: string | null; severity: string; createdAt: string; readAt: string | null }

export interface ProjectInfo {
  surveyId: string;
  customerId: string | null;
  title: string;
  ownerId: string | null;
  /** the study's own rules (definition.alerts) */
  alerts: AlertSettings | null;
  /** people who read the project's responses: for "@team" */
  team: { userId: string; email: string | null }[];
}

export interface NotifyStore {
  kind: "db" | "memory";
  /* channels (an organisation's) */
  listChannels(customerId: string): Promise<ChannelRec[]>;
  getChannel(id: string): Promise<ChannelRec | null>;
  insertChannel(c: ChannelRec): Promise<void>;
  updateChannel(id: string, patch: Partial<ChannelRec>): Promise<void>;
  deleteChannel(id: string): Promise<void>;
  /* the organisation's rules */
  orgSettings(customerId: string): Promise<AlertSettings | null>;
  saveOrgSettings(customerId: string, settings: AlertSettings, userId: string | null): Promise<void>;
  /* a project as the dispatcher needs it */
  project(surveyId: string): Promise<ProjectInfo | null>;
  userEmail(userId: string): Promise<string | null>;
  /* the outbox */
  insertEvent(e: Omit<EventRec, "id" | "status" | "attempts" | "createdAt">): Promise<{ event: EventRec; inserted: boolean }>;
  claimEvents(limit: number, eventId?: string | null): Promise<EventRec[]>;
  finishEvent(id: string, status: "processed" | "failed"): Promise<void>;
  eventsByIds(ids: string[]): Promise<EventRec[]>;
  /* the delivery log */
  insertDelivery(d: Omit<DeliveryRec, "id" | "createdAt">): Promise<{ delivery: DeliveryRec; inserted: boolean }>;
  updateDelivery(id: string, patch: Partial<DeliveryRec>): Promise<void>;
  /** when the same dedupe key last went (or was held) to this destination since `sinceIso` */
  lastSame(dedupeKey: string, destination: string, sinceIso: string, exceptEventId?: string | null): Promise<string | null>;
  /** immediate messages sent to this destination since `sinceIso` */
  countSent(destination: string, sinceIso: string): Promise<number>;
  dueDeliveries(nowIso: string, limit: number): Promise<DeliveryRec[]>;
  listDeliveries(filter: { customerId?: string | null; surveyId?: string | null; limit: number }): Promise<DeliveryRec[]>;
  /* the in-app bell */
  insertInApp(rows: Omit<InAppRec, "id" | "createdAt" | "readAt">[]): Promise<void>;
  listInApp(userId: string, limit: number): Promise<InAppRec[]>;
  markInAppRead(userId: string, ids?: string[]): Promise<void>;
}
