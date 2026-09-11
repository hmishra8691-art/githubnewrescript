import type { BillingConfig } from "./config.js";
import type { BillableEventDef, Rate } from "./registry.js";
import { BillableEventDef as BillableEventSchema, Rate as RateSchema } from "./registry.js";
import type { MeterStore, TransferFilter, UsageEventInput, UsageFilter } from "./meter.js";
import type { CreditRequest, CreditTransfer, LedgerEntry, LedgerKind, Reservation, UsageEvent, Wallet } from "./wallet.js";

/**
 * THE DATABASE STORE — migration 0023.
 *
 * Every balance-changing step is one SQL function that locks the wallet row
 * (`select … for update`) before it compares and writes, so two requests
 * racing for the last dollar cannot both get it: `rescript_billing_reserve`,
 * `_settle`, `_release`, `_record`, `_credit`. The store here only maps rows
 * to the package's camelCase records and never does arithmetic of its own.
 *
 * The client is typed structurally (`from` / `rpc`) so this package does not
 * depend on `@supabase/supabase-js`; the apps hand in their service-role
 * client. Everything runs with the service role behind the apps' own
 * guards — RLS on these tables is the second line, as everywhere else.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface SupabaseLike {
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string; code?: string } | null }>;
}

const num = (v: unknown): number => (v == null ? 0 : typeof v === "number" ? v : Number(v));
const numOrNull = (v: unknown): number | null => (v == null ? null : num(v));

export function walletFromRow(r: any): Wallet {
  return {
    id: r.id, customerId: r.customer_id, surveyId: r.survey_id ?? null, userId: r.user_id ?? null, sharedWalletId: r.shared_wallet_id ?? null, currency: r.currency ?? "USD",
    balance: num(r.balance), reserved: num(r.reserved), totalAdded: num(r.total_added), totalUsed: num(r.total_used), state: r.state,
    overdraftEnabled: r.overdraft_enabled ?? null, overdraftLimit: numOrNull(r.overdraft_limit), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
export function ledgerFromRow(r: any): LedgerEntry {
  return {
    id: String(r.id), walletId: r.wallet_id, customerId: r.customer_id, surveyId: r.survey_id ?? null, kind: r.kind, amount: num(r.amount), balanceAfter: num(r.balance_after),
    reason: r.reason, note: r.note ?? null, usageEventId: r.usage_event_id ?? null, referenceId: r.reference_id == null ? null : String(r.reference_id), transferId: r.transfer_id ?? null, createdBy: r.created_by ?? null, createdAt: r.created_at, expiresAt: r.expires_at ?? null,
  };
}
export function usageFromRow(r: any): UsageEvent {
  return {
    id: r.id, customerId: r.customer_id, surveyId: r.survey_id ?? null, userId: r.user_id ?? null, walletId: r.wallet_id ?? null,
    eventType: r.event_type, category: r.category, environment: r.environment, provider: r.provider ?? null, service: r.service ?? null, model: r.model ?? null,
    quantity: num(r.quantity), unit: r.unit, inputUnits: numOrNull(r.input_units), outputUnits: numOrNull(r.output_units),
    providerCost: num(r.provider_cost), infraCost: num(r.infra_cost), paymentFee: num(r.payment_fee), taxReserve: num(r.tax_reserve),
    customerCharge: num(r.customer_charge), grossProfit: num(r.gross_profit), netProfit: num(r.net_profit), marginPct: num(r.margin_pct),
    reservationId: r.reservation_id ?? null, adjustsEventId: r.adjusts_event_id ?? null, metadata: r.metadata ?? {}, createdAt: r.created_at,
  };
}
export function reservationFromRow(r: any): Reservation {
  return {
    id: r.id, walletId: r.wallet_id, customerId: r.customer_id, surveyId: r.survey_id ?? null, userId: r.user_id ?? null, eventType: r.event_type, environment: r.environment,
    estimatedCost: num(r.estimated_cost), reservedAmount: num(r.reserved_amount), status: r.status, actualCharge: numOrNull(r.actual_charge),
    createdAt: r.created_at, expiresAt: r.expires_at, settledAt: r.settled_at ?? null,
  };
}
export function requestFromRow(r: any): CreditRequest {
  return {
    id: r.id, customerId: r.customer_id, surveyId: r.survey_id ?? null, walletId: r.wallet_id ?? null, userId: r.user_id, requestedAmount: num(r.requested_amount), reason: r.reason, message: r.message ?? null,
    status: r.status, decidedBy: r.decided_by ?? null, decidedAt: r.decided_at ?? null, decidedAmount: numOrNull(r.decided_amount), adminNote: r.admin_note ?? null, createdAt: r.created_at,
  };
}
export function transferFromRow(r: any): CreditTransfer {
  return {
    id: r.id, code: r.code, customerId: r.customer_id, sourceWalletId: r.source_wallet_id, destinationWalletId: r.destination_wallet_id,
    sourceKind: r.source_kind, destinationKind: r.destination_kind, sourceRef: r.source_ref ?? null, destinationRef: r.destination_ref ?? null,
    amount: num(r.amount), currency: r.currency ?? "USD", reason: r.reason ?? null, note: r.note ?? null, transferredBy: r.transferred_by ?? null,
    status: r.status, reversalOf: r.reversal_of ?? null, reversedBy: r.reversed_by ?? null, createdAt: r.created_at,
  };
}
export function rateFromRow(r: any): Rate {
  return RateSchema.parse({
    id: r.id, provider: r.provider, service: r.service, model: r.model ?? null, side: r.side ?? null, unit: r.unit, providerCost: num(r.provider_cost), unitSize: num(r.unit_size) || 1,
    markupPct: num(r.markup_pct), customerRate: numOrNull(r.customer_rate), currency: r.currency ?? "USD", effectiveFrom: r.effective_from ?? null, effectiveUntil: r.effective_until ?? null,
    active: !!r.active, estimated: !!r.estimated, note: r.note ?? "",
  });
}
export function rateToRow(r: Rate) {
  return { id: r.id, provider: r.provider, service: r.service, model: r.model, side: r.side, unit: r.unit, provider_cost: r.providerCost, unit_size: r.unitSize, markup_pct: r.markupPct, customer_rate: r.customerRate, currency: r.currency, effective_from: r.effectiveFrom, effective_until: r.effectiveUntil, active: r.active, estimated: r.estimated, note: r.note, updated_at: new Date().toISOString() };
}
export function eventDefFromRow(r: any): BillableEventDef {
  return BillableEventSchema.parse({ type: r.type, label: r.label, category: r.category, unit: r.unit, billable: !!r.billable, rate: r.rate ?? null, description: r.description ?? "", active: !!r.active });
}

const fail = (what: string, error: { message: string } | null): never => { throw new Error(`${what}: ${error?.message ?? "unknown error"}`); };

export class SupabaseMeterStore implements MeterStore {
  constructor(private readonly db: SupabaseLike) {}

  async loadConfig() {
    const { data, error } = await this.db.from("billing_config").select("config").eq("id", 1).maybeSingle();
    if (error) fail("billing_config read", error);
    return data?.config ?? null;
  }
  async saveConfig(cfg: BillingConfig, by: string | null) {
    const { error } = await this.db.from("billing_config").upsert({ id: 1, config: cfg, updated_at: new Date().toISOString(), updated_by: by }, { onConflict: "id" });
    if (error) fail("billing_config write", error);
  }
  async loadRates() {
    const { data, error } = await this.db.from("billing_rates").select("*").order("id");
    if (error) fail("billing_rates read", error);
    return (data ?? []).map(rateFromRow);
  }
  async saveRate(rate: Rate) {
    const { error } = await this.db.from("billing_rates").upsert(rateToRow(rate), { onConflict: "id" });
    if (error) fail("billing_rates write", error);
  }
  async deleteRate(id: string) {
    const { error } = await this.db.from("billing_rates").delete().eq("id", id);
    if (error) fail("billing_rates delete", error);
  }
  async loadEvents() {
    const { data, error } = await this.db.from("billing_events").select("*").order("type");
    if (error) fail("billing_events read", error);
    return (data ?? []).map(eventDefFromRow);
  }
  async saveEvent(def: BillableEventDef) {
    const { error } = await this.db.from("billing_events").upsert({ type: def.type, label: def.label, category: def.category, unit: def.unit, billable: def.billable, rate: def.rate ?? null, description: def.description, active: def.active, updated_at: new Date().toISOString() }, { onConflict: "type" });
    if (error) fail("billing_events write", error);
  }

  async walletFor(customerId: string, surveyId: string | null, opts: { create: boolean; seedBalance?: number }) {
    const { data, error } = await this.db.rpc("rescript_billing_wallet_for", { p_customer: customerId, p_survey: surveyId, p_create: opts.create, p_seed: opts.seedBalance ?? 0 });
    if (error) fail("wallet_for", error);
    return data ? walletFromRow(data) : null;
  }
  async walletForUser(customerId: string, userId: string, opts: { create: boolean }) {
    const { data, error } = await this.db.rpc("rescript_billing_user_wallet_for", { p_customer: customerId, p_user: userId, p_create: opts.create });
    if (error) fail("user_wallet_for", error);
    return data ? walletFromRow(data) : null;
  }
  async getWallet(id: string) {
    const { data, error } = await this.db.from("project_wallets").select("*").eq("id", id).maybeSingle();
    if (error) fail("wallet read", error);
    return data ? walletFromRow(data) : null;
  }
  async listWallets(filter: { customerId?: string }) {
    let q = this.db.from("project_wallets").select("*").order("created_at", { ascending: false });
    if (filter.customerId) q = q.eq("customer_id", filter.customerId);
    const { data, error } = await q;
    if (error) fail("wallets read", error);
    return (data ?? []).map(walletFromRow);
  }
  async setWallet(id: string, patch: Partial<Pick<Wallet, "state" | "sharedWalletId" | "overdraftEnabled" | "overdraftLimit">>) {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.state !== undefined) row.state = patch.state;
    if (patch.sharedWalletId !== undefined) row.shared_wallet_id = patch.sharedWalletId;
    if (patch.overdraftEnabled !== undefined) row.overdraft_enabled = patch.overdraftEnabled;
    if (patch.overdraftLimit !== undefined) row.overdraft_limit = patch.overdraftLimit;
    const { data, error } = await this.db.from("project_wallets").update(row).eq("id", id).select("*").single();
    if (error) fail("wallet update", error);
    return walletFromRow(data);
  }

  async reserve(input: { walletId: string; customerId: string; surveyId: string | null; userId: string | null; eventType: string; environment: "TEST" | "LIVE"; estimatedCost: number; amount: number; floor: number; ttlMinutes: number }) {
    const { data, error } = await this.db.rpc("rescript_billing_reserve", {
      p_wallet: input.walletId, p_customer: input.customerId, p_survey: input.surveyId, p_user: input.userId, p_event_type: input.eventType, p_environment: input.environment,
      p_estimated: input.estimatedCost, p_amount: input.amount, p_floor: input.floor, p_ttl_minutes: input.ttlMinutes,
    });
    if (error) fail("reserve", error);
    if (!data?.ok) return { ok: false as const, wallet: walletFromRow(data.wallet) };
    return { ok: true as const, reservation: reservationFromRow(data.reservation), wallet: walletFromRow(data.wallet) };
  }
  async settle(reservationId: string, event: UsageEventInput, readOnlyThreshold: number) {
    const { data, error } = await this.db.rpc("rescript_billing_settle", { p_reservation: reservationId, p_event: event, p_read_only_threshold: readOnlyThreshold });
    if (error) fail("settle", error);
    return { event: usageFromRow(data.event), wallet: walletFromRow(data.wallet) };
  }
  async release(reservationId: string, status: "released" | "expired" = "released") {
    const { error } = await this.db.rpc("rescript_billing_release", { p_reservation: reservationId, p_status: status });
    if (error) fail("release", error);
  }
  async record(event: UsageEventInput, readOnlyThreshold: number) {
    const { data, error } = await this.db.rpc("rescript_billing_record", { p_event: event, p_read_only_threshold: readOnlyThreshold });
    if (error) fail("record", error);
    return { event: usageFromRow(data.event), wallet: data.wallet ? walletFromRow(data.wallet) : null };
  }
  async expireReservations(now: Date) {
    const { data, error } = await this.db.rpc("rescript_billing_expire_reservations", { p_now: now.toISOString() });
    if (error) fail("expire", error);
    return num(data);
  }

  async credit(input: { walletId: string; amount: number; kind: LedgerKind; reason: string; note: string | null; by: string | null; expiresAt: string | null; referenceId?: string | null; usageEventId?: string | null }, readOnlyThreshold: number) {
    const { data, error } = await this.db.rpc("rescript_billing_credit", {
      p_wallet: input.walletId, p_amount: input.amount, p_kind: input.kind, p_reason: input.reason, p_note: input.note, p_by: input.by, p_expires: input.expiresAt,
      p_reference: input.referenceId ?? null, p_usage_event: input.usageEventId ?? null, p_read_only_threshold: readOnlyThreshold,
    });
    if (error) fail("credit", error);
    return { entry: ledgerFromRow(data.entry), wallet: walletFromRow(data.wallet) };
  }
  async listLedger(walletId: string, limit = 200) {
    const { data, error } = await this.db.from("wallet_ledger").select("*").eq("wallet_id", walletId).order("created_at", { ascending: false }).limit(limit);
    if (error) fail("ledger read", error);
    return (data ?? []).map(ledgerFromRow);
  }
  async listUsage(f: UsageFilter) {
    let q = this.db.from("usage_events").select("*").order("created_at", { ascending: false }).limit(f.limit ?? 1000);
    if (f.customerId) q = q.eq("customer_id", f.customerId);
    if (f.surveyId !== undefined) q = f.surveyId === null ? q.is("survey_id", null) : q.eq("survey_id", f.surveyId);
    if (f.walletId) q = q.eq("wallet_id", f.walletId);
    if (f.userId) q = q.eq("user_id", f.userId);
    if (f.environment) q = q.eq("environment", f.environment);
    if (f.since) q = q.gte("created_at", f.since);
    if (f.until) q = q.lt("created_at", f.until);
    const { data, error } = await q;
    if (error) fail("usage read", error);
    return (data ?? []).map(usageFromRow);
  }
  async getUsage(id: string) {
    const { data, error } = await this.db.from("usage_events").select("*").eq("id", id).maybeSingle();
    if (error) fail("usage read", error);
    return data ? usageFromRow(data) : null;
  }

  async transfer(input: { sourceWalletId: string; destinationWalletId: string; amount: number; reason: string | null; note: string | null; by: string | null; reversalOf?: string | null }, readOnlyThreshold: number) {
    const { data, error } = await this.db.rpc("rescript_billing_transfer", {
      p_source: input.sourceWalletId, p_destination: input.destinationWalletId, p_amount: input.amount, p_reason: input.reason, p_note: input.note, p_by: input.by,
      p_reversal_of: input.reversalOf ?? null, p_read_only_threshold: readOnlyThreshold,
    });
    if (error) fail("transfer", error);
    if (!data?.ok) return { ok: false as const, reason: data?.reason ?? "unknown_wallet", available: data?.available == null ? undefined : num(data.available) };
    return { ok: true as const, transfer: transferFromRow(data.transfer), source: walletFromRow(data.source), destination: walletFromRow(data.destination) };
  }
  async listTransfers(f: TransferFilter) {
    let q = this.db.from("credit_transfers").select("*").order("created_at", { ascending: false }).limit(f.limit ?? 500);
    if (f.customerId) q = q.eq("customer_id", f.customerId);
    if (f.walletId) q = q.or(`source_wallet_id.eq.${f.walletId},destination_wallet_id.eq.${f.walletId}`);
    if (f.ref) q = q.or(`source_ref.eq.${f.ref},destination_ref.eq.${f.ref}`);
    if (f.adminId) q = q.eq("transferred_by", f.adminId);
    if (f.status) q = q.eq("status", f.status);
    if (f.since) q = q.gte("created_at", f.since);
    if (f.until) q = q.lt("created_at", f.until);
    if (f.minAmount != null) q = q.gte("amount", f.minAmount);
    if (f.maxAmount != null) q = q.lte("amount", f.maxAmount);
    const { data, error } = await q;
    if (error) fail("transfers read", error);
    return (data ?? []).map(transferFromRow);
  }
  async getTransfer(id: string) {
    const { data, error } = await this.db.from("credit_transfers").select("*").eq("id", id).maybeSingle();
    if (error) fail("transfer read", error);
    return data ? transferFromRow(data) : null;
  }

  async createCreditRequest(input: Omit<CreditRequest, "id" | "status" | "decidedBy" | "decidedAt" | "decidedAmount" | "adminNote" | "createdAt">) {
    const { data, error } = await this.db.from("credit_requests").insert({ customer_id: input.customerId, survey_id: input.surveyId, wallet_id: input.walletId, user_id: input.userId, requested_amount: input.requestedAmount, reason: input.reason, message: input.message }).select("*").single();
    if (error) fail("credit request", error);
    return requestFromRow(data);
  }
  async listCreditRequests(f: { customerId?: string; surveyId?: string; userId?: string; status?: CreditRequest["status"] }) {
    let q = this.db.from("credit_requests").select("*").order("created_at", { ascending: false }).limit(500);
    if (f.customerId) q = q.eq("customer_id", f.customerId);
    if (f.surveyId) q = q.eq("survey_id", f.surveyId);
    if (f.userId) q = q.eq("user_id", f.userId);
    if (f.status) q = q.eq("status", f.status);
    const { data, error } = await q;
    if (error) fail("credit requests read", error);
    return (data ?? []).map(requestFromRow);
  }
  async decideCreditRequest(id: string, d: { status: "approved" | "rejected"; by: string; amount: number | null; note: string | null }) {
    const { data, error } = await this.db.from("credit_requests").update({ status: d.status, decided_by: d.by, decided_at: new Date().toISOString(), decided_amount: d.amount, admin_note: d.note }).eq("id", id).eq("status", "pending").select("*").maybeSingle();
    if (error) fail("credit request decide", error);
    if (!data) throw new Error("already decided");
    return requestFromRow(data);
  }
}
