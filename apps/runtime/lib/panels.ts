import "server-only";
import { createHash, createHmac } from "node:crypto";
import type { PanelConfig, PanelOutcome, PanelTarget } from "@rescript/schema";
import { aiProviderName, openEnvelope } from "@rescript/ai";
import { attachPanelSession, enterPanel, exitPanel, supabasePanelStore, type PanelEntryResult, type PanelStore } from "@rescript/analytics";
import type { PanelHasher, PanelRedirect } from "@rescript/engine";
import { supabaseAdmin } from "@/lib/admin";

/**
 * PANEL RECRUITMENT AT THE RESPONDENT LINKS (2026-10-22, G3) — the AI-interview link (/i/), group sessions (/g/),
 * live-session join links and the survey link call these three:
 *
 *   enter   an arrival's URL parameters → admitted (an entry), refused (no id / a placeholder / paused), a
 *           duplicate (this panel id already took part), or over quota (the panel's completes target is met)
 *   attach  the entry becomes a session (interview, group participant, room member, response)
 *   exit    an outcome → the panel's end link, signed when the panel signs (its secret is opened here, for this
 *           call, with INTEGRATIONS_SECRET_KEY) — the first outcome stands
 *
 * The orchestration is `@rescript/analytics` panels/service.ts over the 0072 tables (service role). Without a
 * database (the fake-provider sandbox, never production) the calls go to the Studio's sandbox, server to server.
 * A panel failure never blocks a participant who came with no panel: anything unexpected degrades to "no panel".
 */

export type PanelExit = (PanelRedirect & { entryId: string; pid: string; panel: string }) | null;
export interface PanelPort {
  enter(a: { surveyId: string; target: PanelTarget; targetRef: string | null; params: Record<string, string>; isTest: boolean }): Promise<PanelEntryResult>;
  attach(entryId: string, sessionRef: string): Promise<void>;
  exit(a: { entryId?: string | null; sessionRef?: string | null; outcome: PanelOutcome; status?: string | null }): Promise<PanelExit>;
}

export const panelHasher: PanelHasher = (alg, data, secret) => (alg === "hmac-sha256" || alg === "hmac-sha1" ? createHmac(alg === "hmac-sha256" ? "sha256" : "sha1", secret).update(data, "utf8").digest() : createHash(alg).update(data + secret, "utf8").digest());

const dbConfigured = () => !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
const sandbox = () => !dbConfigured() && aiProviderName() === "fake" && process.env.NODE_ENV !== "production";

/** only the URL parameters a panel could send: short names, short values */
export function panelParams(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 30)) if (/^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/.test(k) && (typeof v === "string" || typeof v === "number")) out[k] = String(v).slice(0, 300);
  return out;
}

function dbPort(store: PanelStore): PanelPort {
  const sign = { hasher: panelHasher };
  return {
    async enter(a) {
      try { return await enterPanel(store, a, sign); }
      catch (e) { console.warn("[rescript:panels] entry not recorded", JSON.stringify({ error: (e as Error).message.slice(0, 160) })); return { kind: "none", pid: a.params.pid ?? null }; }
    },
    async attach(entryId, sessionRef) { await attachPanelSession(store, entryId, sessionRef).catch(() => {}); },
    async exit(a) { try { return await exitPanel(store, a, sign); } catch (e) { console.warn("[rescript:panels] exit failed", JSON.stringify({ error: (e as Error).message.slice(0, 160) })); return null; } },
  };
}

function sandboxPort(): PanelPort {
  const base = (process.env.STUDIO_SANDBOX_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  /* the Studio dev server compiles a route on its first call after a restart (6-9 s under load were seen), so the
     sandbox waits longer than a database call would — otherwise the arrival silently degrades to "no panel" */
  const call = async (body: Record<string, unknown>) => {
    const r = await fetch(`${base}/api/surveys/sandbox/panels`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, role: "runtime" }), cache: "no-store", signal: AbortSignal.timeout(30000) });
    return (await r.json()) as Record<string, unknown>;
  };
  return {
    async enter(a) { try { return (await call({ op: "enter", ...a })) as unknown as PanelEntryResult; } catch { return { kind: "none", pid: a.params.pid ?? null }; } },
    async attach(entryId, sessionRef) { await call({ op: "attach", entryId, sessionRef }).catch(() => null); },
    async exit(a) { try { return ((await call({ op: "exit", ...a })).redirect ?? null) as PanelExit; } catch { return null; } },
  };
}

/** `panels`: the survey link passes its DEPLOYED definition's panels (the AI-interview, group and live links read the saved definition) */
export function runtimePanels(opts: { panels?: PanelConfig[] | null } = {}): PanelPort | null {
  if (dbConfigured()) return dbPort(supabasePanelStore(supabaseAdmin() as never, { openPanelSecret: (sealed, aad) => openEnvelope(sealed, aad), ...(opts.panels ? { panelsOverride: async () => opts.panels ?? null } : {}) }));
  if (sandbox()) return sandboxPort();
  return null;
}
