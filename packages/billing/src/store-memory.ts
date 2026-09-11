import { randomUUID } from "node:crypto";
import type { BillingConfig } from "./config.js";
import { money6 } from "./money.js";
import type { BillableEventDef, Rate } from "./registry.js";
import type { MeterStore, TransferFilter, UsageEventInput, UsageFilter } from "./meter.js";
import { walletKind, walletStateFor, type CreditRequest, type CreditTransfer, type LedgerEntry, type LedgerKind, type Reservation, type UsageEvent, type Wallet } from "./wallet.js";
import { billingConfig } from "./config.js";

/**
 * THE IN-MEMORY STORE.
 *
 * Used by the unit tests, by the `/sandbox` Studio (which has no database
 * row to bill), and by an installation without Supabase. It implements
 * exactly the contract the SQL functions implement — the same floor check,
 * the same state recomputation — so the engine's behaviour is proven here
 * and then merely persisted there. Single-threaded, so "atomic" is free.
 */
export class MemoryMeterStore implements MeterStore {
  config: unknown | null = null;
  rates: Rate[] | null = null;
  events: BillableEventDef[] | null = null;
  wallets = new Map<string, Wallet>();
  ledger: LedgerEntry[] = [];
  usage: UsageEvent[] = [];
  reservations = new Map<string, Reservation>();
  requests: CreditRequest[] = [];
  transfers: CreditTransfer[] = [];

  async loadConfig() { return this.config; }
  async saveConfig(cfg: BillingConfig) { this.config = cfg; }
  async loadRates() { return this.rates; }
  async saveRate(rate: Rate) { const list = this.rates ?? []; const i = list.findIndex((r) => r.id === rate.id); if (i < 0) list.push(rate); else list[i] = rate; this.rates = list; }
  async deleteRate(id: string) { this.rates = (this.rates ?? []).filter((r) => r.id !== id); }
  async loadEvents() { return this.events; }
  async saveEvent(def: BillableEventDef) { const list = this.events ?? []; const i = list.findIndex((e) => e.type === def.type); if (i < 0) list.push(def); else list[i] = def; this.events = list; }

  private cfg(): BillingConfig { return billingConfig(this.config); }
  private now() { return new Date().toISOString(); }
  private touch(w: Wallet, readOnlyThreshold: number) {
    w.updatedAt = this.now();
    if (w.state !== "suspended") w.state = w.balance <= readOnlyThreshold ? "read_only" : "active";
    return w;
  }

  async walletFor(customerId: string, surveyId: string | null, opts: { create: boolean; seedBalance?: number }) {
    for (const w of this.wallets.values()) if (w.customerId === customerId && w.surveyId === surveyId && !w.userId) return w;
    if (!opts.create) return null;
    const w: Wallet = {
      id: randomUUID(), customerId, surveyId, userId: null, sharedWalletId: null, currency: this.cfg().currency,
      balance: 0, reserved: 0, totalAdded: 0, totalUsed: 0, state: "active", overdraftEnabled: null, overdraftLimit: null,
      createdAt: this.now(), updatedAt: this.now(),
    };
    this.wallets.set(w.id, w);
    if (opts.seedBalance && opts.seedBalance > 0) await this.credit({ walletId: w.id, amount: opts.seedBalance, kind: "credit", reason: "starting_credits", note: "Starting balance", by: null, expiresAt: null }, this.cfg().readOnlyThreshold);
    return this.wallets.get(w.id)!;
  }
  async walletForUser(customerId: string, userId: string, opts: { create: boolean }) {
    for (const w of this.wallets.values()) if (w.userId === userId) return w;
    if (!opts.create) return null;
    const w: Wallet = { id: randomUUID(), customerId, surveyId: null, userId, sharedWalletId: null, currency: this.cfg().currency, balance: 0, reserved: 0, totalAdded: 0, totalUsed: 0, state: "active", overdraftEnabled: null, overdraftLimit: null, createdAt: this.now(), updatedAt: this.now() };
    this.wallets.set(w.id, w);
    return w;
  }
  async getWallet(id: string) { return this.wallets.get(id) ?? null; }
  async listWallets(filter: { customerId?: string }) { return [...this.wallets.values()].filter((w) => !filter.customerId || w.customerId === filter.customerId); }
  async setWallet(id: string, patch: Partial<Pick<Wallet, "state" | "sharedWalletId" | "overdraftEnabled" | "overdraftLimit">>) {
    const w = this.wallets.get(id); if (!w) throw new Error("unknown wallet");
    Object.assign(w, patch); w.updatedAt = this.now();
    if (patch.state === "active") w.state = walletStateFor(w.balance, this.cfg(), "active");
    return w;
  }

  async reserve(input: { walletId: string; customerId: string; surveyId: string | null; userId: string | null; eventType: string; environment: "TEST" | "LIVE"; estimatedCost: number; amount: number; floor: number; ttlMinutes: number }) {
    const w = this.wallets.get(input.walletId); if (!w) throw new Error("unknown wallet");
    if (money6(w.balance - w.reserved - input.amount) < input.floor) return { ok: false as const, wallet: w };
    const r: Reservation = {
      id: randomUUID(), walletId: w.id, customerId: input.customerId, surveyId: input.surveyId, userId: input.userId, eventType: input.eventType, environment: input.environment,
      estimatedCost: input.estimatedCost, reservedAmount: money6(input.amount), status: "held", actualCharge: null,
      createdAt: this.now(), expiresAt: new Date(Date.now() + input.ttlMinutes * 60_000).toISOString(), settledAt: null,
    };
    w.reserved = money6(w.reserved + r.reservedAmount); w.updatedAt = this.now();
    this.reservations.set(r.id, r);
    return { ok: true as const, reservation: r, wallet: w };
  }

  async settle(reservationId: string, event: UsageEventInput, readOnlyThreshold: number) {
    const r = this.reservations.get(reservationId); if (!r) throw new Error("unknown reservation");
    if (r.status !== "held") throw new Error(`reservation already ${r.status}`);
    const w = this.wallets.get(r.walletId); if (!w) throw new Error("unknown wallet");
    w.reserved = money6(Math.max(0, w.reserved - r.reservedAmount));
    r.status = "settled"; r.actualCharge = event.customerCharge; r.settledAt = this.now();
    const ev = this.push(event);
    if (event.customerCharge !== 0) {
      w.balance = money6(w.balance - event.customerCharge); w.totalUsed = money6(w.totalUsed + event.customerCharge);
      this.ledger.push({ id: randomUUID(), walletId: w.id, customerId: w.customerId, surveyId: w.surveyId, kind: "debit", amount: money6(-event.customerCharge), balanceAfter: w.balance, reason: event.eventType, note: null, usageEventId: ev.id, referenceId: null, transferId: null, createdBy: event.userId, createdAt: this.now(), expiresAt: null });
    }
    this.touch(w, readOnlyThreshold);
    return { event: ev, wallet: w };
  }

  async release(reservationId: string, status: "released" | "expired" = "released") {
    const r = this.reservations.get(reservationId); if (!r || r.status !== "held") return;
    const w = this.wallets.get(r.walletId);
    if (w) { w.reserved = money6(Math.max(0, w.reserved - r.reservedAmount)); w.updatedAt = this.now(); }
    r.status = status;
  }

  async record(event: UsageEventInput, readOnlyThreshold: number) {
    const ev = this.push(event);
    const w = event.walletId ? this.wallets.get(event.walletId) ?? null : null;
    if (w && event.customerCharge !== 0 && !event.adjustsEventId) {
      w.balance = money6(w.balance - event.customerCharge); w.totalUsed = money6(w.totalUsed + event.customerCharge);
      this.ledger.push({ id: randomUUID(), walletId: w.id, customerId: w.customerId, surveyId: w.surveyId, kind: "debit", amount: money6(-event.customerCharge), balanceAfter: w.balance, reason: event.eventType, note: null, usageEventId: ev.id, referenceId: null, transferId: null, createdBy: event.userId, createdAt: this.now(), expiresAt: null });
      this.touch(w, readOnlyThreshold);
    }
    return { event: ev, wallet: w };
  }

  async expireReservations(now: Date) {
    let n = 0;
    for (const r of this.reservations.values()) if (r.status === "held" && Date.parse(r.expiresAt) <= now.getTime()) { await this.release(r.id, "expired"); n++; }
    return n;
  }

  async credit(input: { walletId: string; amount: number; kind: LedgerKind; reason: string; note: string | null; by: string | null; expiresAt: string | null; referenceId?: string | null; usageEventId?: string | null }, readOnlyThreshold: number) {
    const w = this.wallets.get(input.walletId); if (!w) throw new Error("unknown wallet");
    w.balance = money6(w.balance + input.amount);
    if (input.amount > 0 && input.kind !== "reversal") w.totalAdded = money6(w.totalAdded + input.amount);
    if (input.kind === "reversal") w.totalUsed = money6(w.totalUsed - input.amount);
    const entry: LedgerEntry = { id: randomUUID(), walletId: w.id, customerId: w.customerId, surveyId: w.surveyId, kind: input.kind, amount: money6(input.amount), balanceAfter: w.balance, reason: input.reason, note: input.note, usageEventId: input.usageEventId ?? null, referenceId: input.referenceId ?? null, transferId: null, createdBy: input.by, createdAt: this.now(), expiresAt: input.expiresAt };
    this.ledger.push(entry);
    this.touch(w, readOnlyThreshold);
    return { entry, wallet: w };
  }
  async listLedger(walletId: string, limit = 200) { return this.ledger.filter((l) => l.walletId === walletId).slice(-limit).reverse(); }
  async listUsage(f: UsageFilter) {
    return this.usage.filter((e) =>
      (!f.customerId || e.customerId === f.customerId) && (f.surveyId === undefined || e.surveyId === f.surveyId) && (!f.walletId || e.walletId === f.walletId)
      && (!f.userId || e.userId === f.userId) && (!f.environment || e.environment === f.environment)
      && (!f.since || e.createdAt >= f.since) && (!f.until || e.createdAt < f.until)).slice(-(f.limit ?? 1000)).reverse();
  }
  async getUsage(id: string) { return this.usage.find((e) => e.id === id) ?? null; }

  async transfer(input: { sourceWalletId: string; destinationWalletId: string; amount: number; reason: string | null; note: string | null; by: string | null; reversalOf?: string | null }, readOnlyThreshold: number) {
    const src = this.wallets.get(input.sourceWalletId), dst = this.wallets.get(input.destinationWalletId);
    if (!src || !dst) return { ok: false as const, reason: "unknown_wallet" as const };
    if (src.id === dst.id) return { ok: false as const, reason: "same_wallet" as const };
    let original: CreditTransfer | undefined;
    if (input.reversalOf) {
      original = this.transfers.find((t) => t.id === input.reversalOf);
      if (!original || original.status === "reversed" || original.reversalOf) return { ok: false as const, reason: "already_reversed" as const };
    }
    const available = money6(Math.max(0, src.balance - src.reserved));
    if (input.amount > available) return { ok: false as const, reason: "insufficient_available" as const, available };
    const t: CreditTransfer = {
      id: randomUUID(), code: `TRX-${(this.transfers.length + 1).toString().padStart(5, "0")}`, customerId: src.customerId,
      sourceWalletId: src.id, destinationWalletId: dst.id, sourceKind: walletKind(src), destinationKind: walletKind(dst),
      sourceRef: src.surveyId ?? src.userId ?? null, destinationRef: dst.surveyId ?? dst.userId ?? null,
      amount: money6(input.amount), currency: src.currency, reason: input.reason, note: input.note, transferredBy: input.by,
      status: "completed", reversalOf: input.reversalOf ?? null, reversedBy: null, createdAt: this.now(),
    };
    // both sides in the same (single-threaded) step
    src.balance = money6(src.balance - t.amount); dst.balance = money6(dst.balance + t.amount);
    dst.totalAdded = money6(dst.totalAdded + t.amount);   // credits arrived; the source's history of what was added stands
    const kindOut: LedgerKind = input.reversalOf ? "transfer_reversal" : "transfer_out";
    const kindIn: LedgerKind = input.reversalOf ? "transfer_reversal" : "transfer_in";
    this.ledger.push({ id: randomUUID(), walletId: src.id, customerId: src.customerId, surveyId: src.surveyId, kind: kindOut, amount: money6(-t.amount), balanceAfter: src.balance, reason: input.reason ?? (input.reversalOf ? "transfer_reversal" : "credit_transfer"), note: input.note, usageEventId: null, referenceId: null, transferId: t.id, createdBy: input.by, createdAt: this.now(), expiresAt: null });
    this.ledger.push({ id: randomUUID(), walletId: dst.id, customerId: dst.customerId, surveyId: dst.surveyId, kind: kindIn, amount: t.amount, balanceAfter: dst.balance, reason: input.reason ?? (input.reversalOf ? "transfer_reversal" : "credit_transfer"), note: input.note, usageEventId: null, referenceId: null, transferId: t.id, createdBy: input.by, createdAt: this.now(), expiresAt: null });
    if (original) { original.status = "reversed"; original.reversedBy = t.id; }
    this.transfers.push(t);
    this.touch(src, readOnlyThreshold); this.touch(dst, readOnlyThreshold);
    return { ok: true as const, transfer: t, source: src, destination: dst };
  }
  async listTransfers(f: TransferFilter) {
    return this.transfers.filter((t) =>
      (!f.customerId || t.customerId === f.customerId) && (!f.walletId || t.sourceWalletId === f.walletId || t.destinationWalletId === f.walletId)
      && (!f.ref || t.sourceRef === f.ref || t.destinationRef === f.ref) && (!f.adminId || t.transferredBy === f.adminId) && (!f.status || t.status === f.status)
      && (!f.since || t.createdAt >= f.since) && (!f.until || t.createdAt < f.until) && (f.minAmount == null || t.amount >= f.minAmount) && (f.maxAmount == null || t.amount <= f.maxAmount))
      .slice(-(f.limit ?? 500)).reverse();
  }
  async getTransfer(id: string) { return this.transfers.find((t) => t.id === id) ?? null; }

  async createCreditRequest(input: Omit<CreditRequest, "id" | "status" | "decidedBy" | "decidedAt" | "decidedAmount" | "adminNote" | "createdAt">) {
    const r: CreditRequest = { ...input, id: randomUUID(), status: "pending", decidedBy: null, decidedAt: null, decidedAmount: null, adminNote: null, createdAt: this.now() };
    this.requests.push(r); return r;
  }
  async listCreditRequests(f: { customerId?: string; surveyId?: string; userId?: string; status?: CreditRequest["status"] }) {
    return this.requests.filter((r) => (!f.customerId || r.customerId === f.customerId) && (!f.surveyId || r.surveyId === f.surveyId) && (!f.userId || r.userId === f.userId) && (!f.status || r.status === f.status)).slice().reverse();
  }
  async decideCreditRequest(id: string, d: { status: "approved" | "rejected"; by: string; amount: number | null; note: string | null }) {
    const r = this.requests.find((x) => x.id === id); if (!r) throw new Error("unknown request");
    if (r.status !== "pending") throw new Error("already decided");
    r.status = d.status; r.decidedBy = d.by; r.decidedAt = this.now(); r.decidedAmount = d.amount; r.adminNote = d.note;
    return r;
  }

  private push(event: UsageEventInput): UsageEvent {
    const ev: UsageEvent = { ...event, id: randomUUID(), createdAt: this.now() };
    this.usage.push(ev);
    return ev;
  }
}
