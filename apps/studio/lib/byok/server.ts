import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/admin";
import type { AuthedUser } from "@/lib/guard";
import { memoryStore, type Deps } from "./service";
import { AiStoreUnavailable, SupabaseAiStore, type AiStore } from "./store";

/**
 * The server-side wiring of user-owned AI providers: which store, and what the
 * acting user's workspace allows. Everything below it (`service.ts`,
 * `resolve.ts`, `vault.ts`) is pure and tested without a database.
 */

declare global {
  // eslint-disable-next-line no-var
  var __rescriptAiDbStore: AiStore | undefined;
}

const dbConfigured = () => !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

export function aiStore(): AiStore {
  if (!dbConfigured()) return memoryStore();
  return (globalThis.__rescriptAiDbStore ??= new SupabaseAiStore(supabaseAdmin()));
}

/** the workspace's `ai_byok_allowed`; true when there is no workspace, no database, or the column is not there yet (migration 0054 not applied) */
export async function workspaceAllowsByok(customerId: string | null | undefined): Promise<boolean> {
  if (!customerId || !dbConfigured()) return true;
  try {
    const { data, error } = await supabaseAdmin().from("customers").select("ai_byok_allowed").eq("id", customerId).maybeSingle();
    if (error) return true;
    return (data as { ai_byok_allowed?: boolean } | null)?.ai_byok_allowed !== false;
  } catch { return true; }
}

export async function byokDeps(user: Pick<AuthedUser, "customerId">): Promise<Deps> {
  return { store: aiStore(), workspaceAllows: await workspaceAllowsByok(user.customerId) };
}

/** a JSON body, bounded: these routes carry a key, a configuration and a short list — never a document */
export async function readJson(req: NextRequest, maxBytes = 16_000): Promise<Record<string, unknown> | null> {
  const text = await req.text().catch(() => "");
  if (!text || text.length > maxBytes) return null;
  try { const v = JSON.parse(text); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}

/**
 * Run an account-AI handler so that a missing migration is an honest 501 with the
 * instruction to fix it, and any other storage fault is a 503 that says so —
 * never a bare 500 with nothing to act on. No message from the database is
 * returned to the browser; it is logged for the operator (it names no key).
 */
export async function storeSafe(run: () => Promise<NextResponse>): Promise<NextResponse> {
  try { return await run(); }
  catch (e) {
    if (e instanceof AiStoreUnavailable) {
      console.error("[byok]", e.message);
      return NextResponse.json({ error: "Using your own AI provider is not enabled on this installation yet: the database update for it (migration 0054) has not been applied. Ask your administrator.", code: "byok_unavailable" }, { status: 501, headers: { "cache-control": "no-store" } });
    }
    console.error("[byok] storage fault:", (e as Error)?.message);
    return NextResponse.json({ error: "Your AI settings could not be read or saved right now. Try again in a moment.", code: "byok_storage_error" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
