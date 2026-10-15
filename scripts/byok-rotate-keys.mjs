/**
 * ROTATE THE CREDENTIAL VAULT'S MASTER KEY (operator tool).
 *
 *   1. generate a new key:           openssl rand -hex 32
 *   2. set  AI_CREDENTIAL_KEY=<new>  and  AI_CREDENTIAL_KEY_PREVIOUS=<old>
 *   3. node scripts/byok-rotate-keys.mjs --dry-run     (what would change)
 *      node scripts/byok-rotate-keys.mjs               (do it)
 *   4. when it reports 0 unreadable and the deployed servers run the new key,
 *      drop AI_CREDENTIAL_KEY_PREVIOUS.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Only each credential's data
 * key is re-wrapped; no secret is decrypted by this script, printed or logged.
 * Safe to re-run. A credential that cannot be opened by any key you gave is
 * counted and left untouched (the person re-enters it in Settings).
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const dryRun = process.argv.includes("--dry-run");
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."); process.exit(2); }
const req = createRequire(`${ROOT}apps/studio/package.json`);
const { createClient } = req("@supabase/supabase-js");
const { SupabaseAiStore } = await import(pathToFileURL(`${ROOT}apps/studio/lib/byok/store.ts`).href);
const { rotateCredentials } = await import(pathToFileURL(`${ROOT}apps/studio/lib/byok/rotate.ts`).href);

try {
  const r = await rotateCredentials(new SupabaseAiStore(createClient(url, key, { auth: { persistSession: false } })), process.env, { dryRun });
  console.log(`${dryRun ? "DRY RUN — " : ""}${r.total} credential(s): ${r.rewrapped} ${dryRun ? "would be re-wrapped" : "re-wrapped"}, ${r.alreadyCurrent} already on the active key, ${r.unreadable} unreadable.`);
  if (r.unreadable) console.log("Unreadable by key id:", JSON.stringify(r.remainingByKey), "- add the matching key to AI_CREDENTIAL_KEY_PREVIOUS and re-run.");
  else if (!dryRun) console.log("Every credential is on the active key: AI_CREDENTIAL_KEY_PREVIOUS can be dropped.");
  process.exit(r.unreadable ? 1 : 0);
} catch (e) { console.error("Rotation failed:", e instanceof Error ? e.message : String(e)); process.exit(2); }
