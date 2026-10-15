import { masterKeys, rewrap, VaultError } from "./vault.ts";
import type { AiStore } from "./store.ts";

/**
 * MASTER-KEY ROTATION — the operator's tool, not a route.
 *
 * Set the new master key as the active one, keep the old one among the retired keys
 * (the operator guide names the variables), run this. It re-wraps every credential's data key under the active master key
 * (`rewrap` — the secret itself is never decrypted and never leaves the vault
 * module), then reports how many credentials each retired key still protects, so
 * the operator knows when it is safe to drop the retired keys.
 *
 * Idempotent: a credential already under the active key is left alone, so it can
 * be re-run after an interruption. A credential its keys cannot open (a retired key
 * that was dropped too early) is counted and left untouched — it is never deleted
 * and never half-written; the person re-enters that key in Settings.
 */
export interface RotationReport { total: number; rewrapped: number; alreadyCurrent: number; unreadable: number; remainingByKey: Record<string, number>; activeKeyId: string }

export async function rotateCredentials(store: AiStore, env: Record<string, string | undefined> = process.env, opts: { pageSize?: number; dryRun?: boolean } = {}): Promise<RotationReport> {
  const { active, problem } = masterKeys(env);
  if (!active) throw new VaultError(problem ? "bad_master_key" : "not_configured", problem ?? "No credential encryption key is configured on this server.");
  const report: RotationReport = { total: 0, rewrapped: 0, alreadyCurrent: 0, unreadable: 0, remainingByKey: {}, activeKeyId: active.id };
  const size = Math.max(1, Math.min(opts.pageSize ?? 200, 1000));
  /* offsets are stable here: rotating changes a row's content, never its id or its place in the id order */
  for (let offset = 0; ; offset += size) {
    const page = await store.listCredentialsPage(offset, size);
    for (const c of page) {
      report.total += 1;
      try {
        const next = rewrap(c.sealed, { userId: c.userId, credentialId: c.id }, env);
        if (!next) { report.alreadyCurrent += 1; continue; }
        if (!opts.dryRun) await store.updateCredential(c.userId, c.id, { sealed: next.sealed, keyId: next.keyId });
        report.rewrapped += 1;
      } catch {
        report.unreadable += 1;
        report.remainingByKey[c.keyId] = (report.remainingByKey[c.keyId] ?? 0) + 1;
      }
    }
    if (page.length < size) break;
  }
  return report;
}
