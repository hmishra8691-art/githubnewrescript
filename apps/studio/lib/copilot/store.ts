import "server-only";
import type { ResearchChunk } from "@rescript/import/research";
import { supabaseAdmin } from "@/lib/admin";
import type { DocSummary } from "./research";

/**
 * THE RESEARCH STORE (migration 0045): documents and their passages, per
 * survey. With Supabase configured and the tables present, rows; otherwise —
 * the sandbox, a local developer, or an installation that has not applied
 * 0045 yet — the server's memory, for the life of the process, and the
 * response says so (`durable: false`) so the Research panel can tell the
 * researcher their documents will not outlive a restart.
 */

export interface StoredDoc {
  id: string;
  ref: string;
  surveyId: string;
  name: string;
  format: string;
  kind?: string;
  pages: number;
  chars: number;
  ocrPages: number;
  summary: DocSummary | null;
  warnings: string[];
  createdAt: string;
}
export interface StoredChunk extends ResearchChunk { embedding?: number[] }

interface MemorySlot { docs: StoredDoc[]; chunks: Map<string, StoredChunk[]> }
declare global {
  // eslint-disable-next-line no-var
  var __rescriptCopilotStore: Map<string, MemorySlot> | undefined;
}
const memory = (): Map<string, MemorySlot> => (globalThis.__rescriptCopilotStore ??= new Map<string, MemorySlot>());
const dbConfigured = () => !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const missing = (m: string) => /relation .* does not exist|does not exist|schema cache/i.test(m);

export function newRef(taken: Set<string>): string {
  for (;;) { const r = `d${Math.random().toString(36).slice(2, 6)}`; if (!taken.has(r)) return r; }
}

export interface ResearchStore {
  durable: boolean;
  list(surveyId: string): Promise<StoredDoc[]>;
  chunks(surveyId: string, docIds?: string[]): Promise<StoredChunk[]>;
  /** a citation name no document of this survey uses yet */
  nextRef(surveyId: string): Promise<string>;
  add(doc: Omit<StoredDoc, "id" | "createdAt">, chunks: StoredChunk[], meta: { customerId: string | null; userId: string | null }): Promise<StoredDoc>;
  remove(surveyId: string, id: string): Promise<boolean>;
}

class MemoryStore implements ResearchStore {
  durable = false;
  private slot(surveyId: string): MemorySlot { const m = memory(); if (!m.has(surveyId)) m.set(surveyId, { docs: [], chunks: new Map() }); return m.get(surveyId)!; }
  async list(surveyId: string) { return [...this.slot(surveyId).docs]; }
  async chunks(surveyId: string, docIds?: string[]) { const s = this.slot(surveyId); return s.docs.filter((d) => !docIds || docIds.includes(d.id)).flatMap((d) => s.chunks.get(d.id) ?? []); }
  async nextRef(surveyId: string) { return newRef(new Set(this.slot(surveyId).docs.map((d) => d.ref))); }
  async add(doc: Omit<StoredDoc, "id" | "createdAt">, chunks: StoredChunk[]) {
    const s = this.slot(doc.surveyId);
    const stored: StoredDoc = { ...doc, id: `mem_${doc.ref}_${Date.now().toString(36)}`, createdAt: new Date().toISOString() };
    s.docs.push(stored); s.chunks.set(stored.id, chunks);
    return stored;
  }
  async remove(surveyId: string, id: string) { const s = this.slot(surveyId); const n = s.docs.length; s.docs = s.docs.filter((d) => d.id !== id); s.chunks.delete(id); return s.docs.length < n; }
}

class SupabaseStore implements ResearchStore {
  durable = true;
  private db = supabaseAdmin();
  async list(surveyId: string): Promise<StoredDoc[]> {
    const { data, error } = await this.db.from("copilot_documents").select("id, ref, survey_id, name, format, kind, pages, chars, ocr_pages, summary, warnings, created_at").eq("survey_id", surveyId).order("created_at");
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({ id: r.id, ref: r.ref, surveyId: r.survey_id, name: r.name, format: r.format, kind: r.kind ?? undefined, pages: r.pages, chars: r.chars, ocrPages: r.ocr_pages, summary: r.summary, warnings: r.warnings ?? [], createdAt: r.created_at }));
  }
  async chunks(surveyId: string, docIds?: string[]): Promise<StoredChunk[]> {
    const docs = await this.list(surveyId);
    const refOf = new Map(docs.map((d) => [d.id, d.ref]));
    let q = this.db.from("copilot_chunks").select("document_id, seq, page, heading, kind, text, embedding").eq("survey_id", surveyId).order("seq").limit(5000);
    if (docIds?.length) q = q.in("document_id", docIds);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => ({ id: `${refOf.get(r.document_id) ?? "d"}#${r.seq}`, docId: refOf.get(r.document_id) ?? r.document_id, seq: r.seq, page: r.page, ...(r.heading ? { heading: r.heading } : {}), kind: r.kind === "table" ? "table" : "text", text: r.text, ...(Array.isArray(r.embedding) ? { embedding: r.embedding } : {}) }));
  }
  async nextRef(surveyId: string) { return newRef(new Set((await this.list(surveyId)).map((d) => d.ref))); }
  async add(doc: Omit<StoredDoc, "id" | "createdAt">, chunks: StoredChunk[], meta: { customerId: string | null; userId: string | null }): Promise<StoredDoc> {
    const ref = doc.ref;
    const { data, error } = await this.db.from("copilot_documents").insert({
      survey_id: doc.surveyId, customer_id: meta.customerId, ref, name: doc.name, format: doc.format, kind: doc.kind ?? null, pages: doc.pages, chars: doc.chars,
      ocr_pages: doc.ocrPages, summary: doc.summary, warnings: doc.warnings, created_by: meta.userId,
    }).select("id, created_at").single();
    if (error) throw new Error(error.message);
    const rows = chunks.map((c) => ({ document_id: data.id, survey_id: doc.surveyId, seq: c.seq, page: c.page, heading: c.heading ?? null, kind: c.kind, text: c.text, embedding: c.embedding ?? null }));
    for (let i = 0; i < rows.length; i += 200) {
      const { error: e2 } = await this.db.from("copilot_chunks").insert(rows.slice(i, i + 200));
      if (e2) { await this.db.from("copilot_documents").delete().eq("id", data.id); throw new Error(e2.message); }
    }
    return { ...doc, id: data.id, createdAt: data.created_at };
  }
  async remove(surveyId: string, id: string) {
    const { error, count } = await this.db.from("copilot_documents").delete({ count: "exact" }).eq("survey_id", surveyId).eq("id", id);
    if (error) throw new Error(error.message);
    return (count ?? 0) > 0;
  }
}

/**
 * The store for a project. The sandbox is always memory; a real project uses
 * the tables — unless they do not exist yet, in which case memory, said out
 * loud rather than failing the upload.
 */
export async function researchStoreFor(surveyId: string): Promise<ResearchStore> {
  if (surveyId === "sandbox" || !dbConfigured()) return new MemoryStore();
  const s = new SupabaseStore();
  try { await s.list(surveyId); return s; } catch (e) {
    if (missing((e as Error).message)) { console.warn("[rescript:copilot] research tables missing (apply migration 0045); keeping documents in memory"); return new MemoryStore(); }
    throw e;
  }
}
