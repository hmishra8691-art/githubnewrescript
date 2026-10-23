import {
  MemoryBalanceStore, claimRequestFor, writeAssignment,
  type BalanceSlot, type ResponseState,
} from "@rescript/engine";
import type { SurveyDefinition } from "@rescript/schema";

/**
 * THE RUNNER'S HALF OF EXACT BALANCE (engine item #15).
 *
 * LIVE / TEST: `/api/session/balance` claims on the server (0073). A request
 * that fails twice stores the seed-derived arm (the pre-#15 behaviour) so the
 * respondent is never left on a loading card and never sees the arm change
 * later; the trace says so.
 *
 * PREVIEW: there is no session and no sample, so the claim is the SAME
 * least-filled rule against a `MemoryBalanceStore` kept in this tab
 * (sessionStorage, read and written in try/catch — a private window simply
 * starts from empty counts). Restarting the preview gives the previous run's
 * claims back, finishing it completes them, so clicking through a preview a
 * few times shows the arms rotating exactly as the field will.
 */

const PREVIEW_KEY = (defId: string) => `rescript:preview-balance:${defId}`;

export function previewBalanceStore(defId: string): MemoryBalanceStore {
  try {
    const raw = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(PREVIEW_KEY(defId)) : null;
    return raw ? MemoryBalanceStore.from(JSON.parse(raw)) : new MemoryBalanceStore();
  } catch { return new MemoryBalanceStore(); }
}
function savePreview(defId: string, store: MemoryBalanceStore): void {
  try { sessionStorage.setItem(PREVIEW_KEY(defId), JSON.stringify(store)); } catch { /* storage blocked: the counts live for this page only */ }
}
const previewScope = (defId: string) => `preview:${defId}`;

/** a preview run ended: complete (finished) or release (screened out / restarted) its claims */
export function endPreviewBalance(defId: string, session: string, how: "complete" | "release"): void {
  const store = previewBalanceStore(defId);
  if (how === "complete") store.complete(previewScope(defId), session); else store.release(previewScope(defId), session);
  savePreview(defId, store);
}

export async function claimBalance(
  def: SurveyDefinition,
  state: ResponseState,
  due: BalanceSlot[],
  o: {
    mode: string;
    session?: { sessionId: string } | null;
    build?: { source: string; versionId: string; revision: number | null } | null;
    previewSession: string;
    onTrace?: (line: string) => void;
  },
): Promise<void> {
  if (!due.length) return;
  if (o.mode === "preview" || !o.session) {
    const store = previewBalanceStore(def.meta.id);
    for (const slot of due) {
      const arms = store.claim(claimRequestFor(slot, previewScope(def.meta.id), o.previewSession, state.seed));
      writeAssignment(state, slot, arms);
      o.onTrace?.(`[balance] ${slot.key}: ${arms.join(", ")} (least filled of ${slot.arms.length} in this preview)`);
    }
    savePreview(def.meta.id, store);
    return;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch("/api/session/balance", {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({
          sessionId: o.session.sessionId, keys: due.map((s) => s.key),
          answers: state.answers, calculated: state.calculated, embedded: state.embedded, flags: state.flags,
          build: o.build ? { source: o.build.source, versionId: o.build.versionId, revision: o.build.revision } : undefined,
        }),
      });
      const j = await r.json().catch(() => ({})) as { assignments?: { key: string; variable: string; arms: string[]; source: string }[]; error?: string };
      if (r.ok && Array.isArray(j.assignments)) {
        for (const a of j.assignments) {
          if (typeof a.variable === "string" && Array.isArray(a.arms) && a.arms.length) state.calculated[a.variable] = a.arms.join(",");
          o.onTrace?.(`[balance] ${a.key}: ${a.arms.join(", ")}${a.source === "fallback" ? " (seed-derived: the claim could not be made)" : ""}`);
        }
        break;
      }
      if (r.status >= 400 && r.status < 500) { o.onTrace?.(`[balance] not claimed — ${j.error ?? r.status}`); break; }
    } catch (e) {
      o.onTrace?.(`[balance] ${(e as Error).message || "network error"}${attempt ? "" : " — retrying"}`);
    }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 400));
  }
  /* never left unassigned: whatever was not answered keeps the seed-derived arm, for good */
  for (const slot of due) {
    const v = state.calculated[slot.variable];
    if (v == null || v === "") { writeAssignment(state, slot, slot.fallback); o.onTrace?.(`[balance] ${slot.key}: ${slot.fallback.join(", ")} (seed-derived — no claim)`); }
  }
}
