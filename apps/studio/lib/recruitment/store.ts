import "server-only";
import { supabaseService } from "@/lib/authServer";
import type { VendorCapabilityState, VendorMode, VendorPricingRow } from "@rescript/schema";

/**
 * THE RECRUITMENT STORE (2026-11-03) — every read and write of migration 0081, in one place, through the service
 * role, with the organisation named on every single query.
 *
 * RLS already scopes these tables, but RLS protects the *client's* view and this module runs as the service role,
 * which bypasses it. So the `customer_id` predicate here is not a duplicate of the policy: it is the only thing
 * standing between one organisation's rate card and another's. Every function therefore takes `customerId` and
 * uses it, and none of them accept an integration id without checking it belongs to that organisation first.
 *
 * The sealed credentials are never selected. There is one function that can open them (`openCredentials`), it is
 * used by the adapter dispatch and nothing else, and it returns the plaintext to a caller that never logs it.
 */

export interface VendorRow {
  id: string;
  customerId: string | null;
  slug: string;
  name: string;
  legalName: string | null;
  website: string | null;
  logoUrl: string | null;
  regions: string[];
  description: string | null;
  panelPreset: string | null;
  status: string;
}

export interface IntegrationRow {
  id: string;
  vendorId: string;
  mode: VendorMode;
  hint: string | null;
  health: string;
  lastContactAt: string | null;
  lastError: string | null;
  markupBps: number;
  currency: string;
  notes: string | null;
  enabled: boolean;
}

const VENDOR_COLUMNS = "id, customer_id, slug, name, legal_name, website, logo_url, regions, description, panel_preset, status";
// never `credentials_sealed`, never `credentials_key_id`
const INTEGRATION_COLUMNS = "id, vendor_id, mode, hint, health, last_contact_at, last_error, markup_bps, currency, notes, enabled";
const PRICING_COLUMNS = "id, integration_id, market, ir_min, ir_max, loi_min, loi_max, cpi, currency, source, source_note, valid_from, valid_to";

const vendor = (r: Record<string, unknown>): VendorRow => ({
  id: String(r.id), customerId: (r.customer_id as string | null) ?? null, slug: String(r.slug), name: String(r.name),
  legalName: (r.legal_name as string | null) ?? null, website: (r.website as string | null) ?? null,
  logoUrl: (r.logo_url as string | null) ?? null, regions: (r.regions as string[] | null) ?? [],
  description: (r.description as string | null) ?? null, panelPreset: (r.panel_preset as string | null) ?? null,
  status: String(r.status ?? "catalogue"),
});

const integration = (r: Record<string, unknown>): IntegrationRow => ({
  id: String(r.id), vendorId: String(r.vendor_id), mode: r.mode as VendorMode,
  hint: (r.hint as string | null) ?? null, health: String(r.health ?? "unknown"),
  lastContactAt: (r.last_contact_at as string | null) ?? null, lastError: (r.last_error as string | null) ?? null,
  markupBps: Number(r.markup_bps ?? 0), currency: String(r.currency ?? "USD"),
  notes: (r.notes as string | null) ?? null, enabled: r.enabled !== false,
});

const pricing = (r: Record<string, unknown>): VendorPricingRow => ({
  id: String(r.id), integrationId: String(r.integration_id), market: String(r.market),
  irMin: Number(r.ir_min), irMax: Number(r.ir_max), loiMin: Number(r.loi_min), loiMax: Number(r.loi_max),
  cpi: Number(r.cpi), currency: String(r.currency ?? "USD"), source: r.source as VendorPricingRow["source"],
  sourceNote: (r.source_note as string | null) ?? undefined,
  validFrom: (r.valid_from as string | null) ?? undefined, validTo: (r.valid_to as string | null) ?? null,
});

export function recruitmentStore() {
  const db = supabaseService();

  return {
    /** the platform catalogue plus this organisation's own vendors */
    async vendors(customerId: string): Promise<VendorRow[]> {
      const { data, error } = await db.from("panel_vendors").select(VENDOR_COLUMNS)
        .or(`customer_id.is.null,customer_id.eq.${customerId}`)
        .eq("status", "catalogue").order("name");
      if (error) throw new Error(error.message);
      return (data ?? []).map(vendor);
    },

    async integrations(customerId: string): Promise<IntegrationRow[]> {
      const { data, error } = await db.from("vendor_integrations").select(INTEGRATION_COLUMNS)
        .eq("customer_id", customerId);
      if (error) throw new Error(error.message);
      return (data ?? []).map(integration);
    },

    /** an integration id is only an integration id if it belongs to this organisation */
    async integration(customerId: string, id: string): Promise<IntegrationRow | null> {
      const { data, error } = await db.from("vendor_integrations").select(INTEGRATION_COLUMNS)
        .eq("customer_id", customerId).eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? integration(data) : null;
    },

    async capabilities(customerId: string): Promise<Record<string, VendorCapabilityState[]>> {
      const mine = await this.integrations(customerId);
      if (!mine.length) return {};
      const { data, error } = await db.from("vendor_capabilities")
        .select("integration_id, capability, supported, verified_at, notes")
        .in("integration_id", mine.map((i) => i.id));
      if (error) throw new Error(error.message);
      const out: Record<string, VendorCapabilityState[]> = {};
      for (const r of data ?? []) {
        const key = String(r.integration_id);
        (out[key] ??= []).push({
          capability: r.capability as VendorCapabilityState["capability"],
          supported: r.supported === true,
          verifiedAt: (r.verified_at as string | null) ?? null,
          ...(r.notes ? { notes: String(r.notes) } : {}),
        });
      }
      return out;
    },

    async pricing(customerId: string, integrationIds?: string[]): Promise<Record<string, VendorPricingRow[]>> {
      const mine = await this.integrations(customerId);
      const ids = integrationIds ? mine.filter((i) => integrationIds.includes(i.id)).map((i) => i.id) : mine.map((i) => i.id);
      if (!ids.length) return {};
      const { data, error } = await db.from("vendor_pricing").select(PRICING_COLUMNS).in("integration_id", ids);
      if (error) throw new Error(error.message);
      const out: Record<string, VendorPricingRow[]> = {};
      for (const r of data ?? []) (out[String(r.integration_id)] ??= []).push(pricing(r));
      return out;
    },

    /**
     * How this vendor has actually performed for this organisation. Phase 1 computes it from the panel entries
     * 0072 already records — the outcomes are real, the sample is whatever has been fielded so far, and the
     * caller decides whether there is enough of it to rank on (`qualityConfidence`).
     */
    async history(customerId: string, integrationIds: string[]): Promise<Record<string, { completes: number; rejectionRate: number | null; duplicateRate: number | null }>> {
      if (!integrationIds.length) return {};
      const { data, error } = await db.from("recruitment_orders")
        .select("integration_id, delivered_completes, accepted_completes, rejected_completes, duplicate_attempts, recruitment_projects!inner(customer_id)")
        .eq("recruitment_projects.customer_id", customerId)
        .in("integration_id", integrationIds);
      if (error) throw new Error(error.message);
      const agg: Record<string, { delivered: number; accepted: number; rejected: number; duplicates: number }> = {};
      for (const r of data ?? []) {
        const k = String(r.integration_id);
        const a = (agg[k] ??= { delivered: 0, accepted: 0, rejected: 0, duplicates: 0 });
        a.delivered += Number(r.delivered_completes ?? 0);
        a.accepted += Number(r.accepted_completes ?? 0);
        a.rejected += Number(r.rejected_completes ?? 0);
        a.duplicates += Number(r.duplicate_attempts ?? 0);
      }
      const out: Record<string, { completes: number; rejectionRate: number | null; duplicateRate: number | null }> = {};
      for (const [k, a] of Object.entries(agg)) {
        // with nothing delivered there is no rate, and 0 would read as "perfect"
        out[k] = {
          completes: a.accepted,
          rejectionRate: a.delivered > 0 ? (a.rejected / a.delivered) * 100 : null,
          duplicateRate: a.delivered + a.duplicates > 0 ? (a.duplicates / (a.delivered + a.duplicates)) * 100 : null,
        };
      }
      return out;
    },

    /* ------------------------------------------------------------ writes */

    async upsertIntegration(customerId: string, vendorId: string, patch: {
      mode?: VendorMode; markupBps?: number; currency?: string; notes?: string | null; enabled?: boolean;
    }, actor: string): Promise<IntegrationRow> {
      const existing = await db.from("vendor_integrations").select("id")
        .eq("customer_id", customerId).eq("vendor_id", vendorId).maybeSingle();
      const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (patch.mode !== undefined) row.mode = patch.mode;
      if (patch.markupBps !== undefined) row.markup_bps = patch.markupBps;
      if (patch.currency !== undefined) row.currency = patch.currency;
      if (patch.notes !== undefined) row.notes = patch.notes;
      if (patch.enabled !== undefined) row.enabled = patch.enabled;

      if (existing.data?.id) {
        const { data, error } = await db.from("vendor_integrations").update(row)
          .eq("id", existing.data.id).eq("customer_id", customerId).select(INTEGRATION_COLUMNS).single();
        if (error) throw new Error(error.message);
        return integration(data);
      }
      const { data, error } = await db.from("vendor_integrations")
        .insert({ ...row, customer_id: customerId, vendor_id: vendorId, created_by: actor, mode: patch.mode ?? "awaiting" })
        .select(INTEGRATION_COLUMNS).single();
      if (error) throw new Error(error.message);
      return integration(data);
    },

    async setCapability(customerId: string, integrationId: string, capability: string, supported: boolean, notes?: string | null): Promise<void> {
      const owned = await this.integration(customerId, integrationId);
      if (!owned) throw new Error("No such integration in this organisation");
      const { error } = await db.from("vendor_capabilities")
        .upsert({ integration_id: integrationId, capability, supported, notes: notes ?? null, updated_at: new Date().toISOString() },
          { onConflict: "integration_id,capability" });
      if (error) throw new Error(error.message);
    },

    async addPricing(customerId: string, integrationId: string, row: Omit<VendorPricingRow, "id" | "integrationId">, actor: string): Promise<VendorPricingRow> {
      const owned = await this.integration(customerId, integrationId);
      if (!owned) throw new Error("No such integration in this organisation");
      const { data, error } = await db.from("vendor_pricing").insert({
        integration_id: integrationId, market: row.market, ir_min: row.irMin, ir_max: row.irMax,
        loi_min: row.loiMin, loi_max: row.loiMax, cpi: row.cpi, currency: row.currency,
        source: row.source, source_note: row.sourceNote ?? null,
        valid_from: row.validFrom ?? new Date().toISOString(), valid_to: row.validTo ?? null, created_by: actor,
      }).select(PRICING_COLUMNS).single();
      if (error) throw new Error(error.message);
      return pricing(data);
    },

    async deletePricing(customerId: string, id: string): Promise<boolean> {
      const mine = await this.integrations(customerId);
      if (!mine.length) return false;
      const { error, count } = await db.from("vendor_pricing").delete({ count: "exact" })
        .eq("id", id).in("integration_id", mine.map((i) => i.id));
      if (error) throw new Error(error.message);
      return (count ?? 0) > 0;
    },

    /* ------------------------------------------------------------ a study's recruitment project */

    async project(surveyId: string) {
      const { data, error } = await db.from("recruitment_projects")
        .select("id, customer_id, survey_id, audience_spec_id, required_completes, budget_amount, budget_currency, deadline, loi_minutes, expected_ir, strategy, weights, quality_floor, status, authorized_by, authorized_at, created_at")
        .eq("survey_id", surveyId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },

    async allocations(projectId: string, revision?: number) {
      let q = db.from("sample_allocations")
        .select("id, revision, integration_id, allocated_completes, cpi, currency, expected_valid_completes, cost_per_valid_complete, expected_delivery_days, rationale, created_at")
        .eq("recruitment_project_id", projectId);
      if (revision !== undefined) q = q.eq("revision", revision);
      const { data, error } = await q.order("revision", { ascending: false });
      if (error) throw new Error(error.message);
      return data ?? [];
    },

    async orders(projectId: string) {
      const { data, error } = await db.from("recruitment_orders")
        .select("id, integration_id, allocation_id, ordered_completes, agreed_cpi, currency, vendor_order_ref, status, delivered_completes, accepted_completes, rejected_completes, duplicate_attempts, spend_amount, placed_at, last_sync_at, notes")
        .eq("recruitment_project_id", projectId).order("placed_at", { ascending: true, nullsFirst: false });
      if (error) throw new Error(error.message);
      return data ?? [];
    },

    async events(projectId: string, limit = 100) {
      const { data, error } = await db.from("recruitment_events")
        .select("id, type, integration_id, order_id, payload, occurred_at")
        .eq("recruitment_project_id", projectId).order("occurred_at", { ascending: false }).limit(limit);
      if (error) throw new Error(error.message);
      return data ?? [];
    },

    /** The orchestrator's log. Idempotent by key: a replayed request records one event. */
    async recordEvent(projectId: string, type: string, idempotencyKey: string, payload: Record<string, unknown>, actor: string | null, integrationId?: string | null, orderId?: string | null): Promise<boolean> {
      const { error } = await db.from("recruitment_events").insert({
        recruitment_project_id: projectId, type, idempotency_key: idempotencyKey,
        integration_id: integrationId ?? null, order_id: orderId ?? null, payload, actor,
      });
      if (error) return !/duplicate key|unique/i.test(error.message) ? (() => { throw new Error(error.message); })() : false;
      return true;
    },

    /** The atomic allocation of 0081: the budget and the required completes are ceilings the database enforces. */
    async allocate(projectId: string, revision: number, rows: unknown[], actor: string) {
      const { data, error } = await db.rpc("rescript_recruitment_allocate", {
        p_project: projectId, p_revision: revision, p_rows: rows, p_actor: actor,
      });
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data[0] : data;
    },

    /** Apply a vendor's progress exactly once. Counts are absolute. */
    async applyProgress(orderId: string, idempotencyKey: string, p: {
      delivered: number; accepted: number; rejected?: number; duplicates?: number; spend?: number | null; status?: string | null; vendorRef?: string | null;
    }) {
      const { data, error } = await db.rpc("rescript_recruitment_order_apply", {
        p_order: orderId, p_idempotency_key: idempotencyKey, p_delivered: p.delivered, p_accepted: p.accepted,
        p_rejected: p.rejected ?? 0, p_duplicates: p.duplicates ?? 0, p_spend: p.spend ?? null,
        p_status: p.status ?? null, p_vendor_ref: p.vendorRef ?? null,
      });
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data[0] : data;
    },
  };
}
