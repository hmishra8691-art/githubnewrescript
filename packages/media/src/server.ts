/**
 * THE ONE PLACE THE SURVEY PRODUCT LEARNS WHERE OBJECTS LIVE.
 *
 * Node-only, like `delivery.ts`: it reaches the R2 client, which signs with
 * `node:crypto`. Reached at `@rescript/media/server`; never from the barrel
 * the renderer bundles.
 *
 * ## The choice
 *
 *   R2 configured (`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
 *   `R2_SECRET_ACCESS_KEY`)  → primary: Cloudflare R2; legacy: Supabase
 *   `MEDIA_STORAGE=memory`   → primary: the in-memory double (tests, local
 *                              development with no Cloudflare account)
 *   nothing                  → primary: Supabase Storage, as before
 *
 * The last line is the no-regression clause. An installation that has not
 * set the R2 variables yet keeps working exactly as it did, on Supabase, and
 * `mediaStorageNotice()` says so in the log once so nobody thinks the switch
 * has happened when it has not. The legacy store is ALWAYS present, because
 * rows from before the switch name it and must stay readable and deletable.
 *
 * ## Why the apps do not read `R2_*` themselves
 *
 * `apps/interviews/lib/storage.ts` made the point already: moving to another
 * provider is editing one file, and that return is lost the first time a
 * route constructs its own client. The Studio and the runtime call
 * `buildMediaStores(supabase.storage)` and know nothing else.
 */
import {
  MemoryStorageProvider, r2FromEnv, r2MissingSettings, type MediaStorageProvider,
} from "@rescript/storage";
import {
  mediaStores, providerObjectStore, supabaseObjectStore,
  type MediaStores, type ObjectStore, type SupabaseStorageLike,
} from "./objectStore.js";

let cachedProvider: MediaStorageProvider | null | undefined;
let cachedKey = "";

function keyOf(env: NodeJS.ProcessEnv): string {
  return [
    env.MEDIA_STORAGE ?? "", env.R2_ACCOUNT_ID ?? "", env.R2_ENDPOINT ?? "", env.R2_BUCKET ?? "",
    /* the key IDENTITY, never the secret — this string can end up in a log */
    (env.R2_ACCESS_KEY_ID ?? "").slice(0, 6),
  ].join("|");
}

/** The primary provider from the environment, or null when only Supabase is available. Throws on an unsafe choice. */
export function primaryProvider(env: NodeJS.ProcessEnv = process.env): MediaStorageProvider | null {
  const key = keyOf(env);
  if (cachedProvider !== undefined && cachedKey === key) return cachedProvider;

  if (env.MEDIA_STORAGE === "memory") {
    if (env.NODE_ENV === "production" && env.MEDIA_ALLOW_MEMORY_STORAGE !== "1") {
      throw new Error(
        "MEDIA_STORAGE=memory is a test double and would lose every recording on the next deploy. "
        + "Configure R2, or set MEDIA_ALLOW_MEMORY_STORAGE=1 if you genuinely mean it.",
      );
    }
    cachedProvider = new MemoryStorageProvider({ baseUrl: env.MEDIA_STORAGE_URL ?? "http://127.0.0.1:4598" });
    cachedKey = key;
    return cachedProvider;
  }

  cachedProvider = r2FromEnv(env);
  cachedKey = key;
  return cachedProvider;
}

/** Which store is primary, in words a log line can carry. */
export function mediaStorageNotice(env: NodeJS.ProcessEnv = process.env): string {
  const p = primaryProvider(env);
  if (p) return `media storage: ${p.name} is primary; Supabase Storage holds objects stored before the switch`;
  return `media storage: Supabase Storage is primary — R2 is not configured (missing ${r2MissingSettings(env).join(", ")})`;
}

let noticed = false;

/**
 * The stores for one request. Cheap: the provider is cached; the Supabase
 * adapter is a thin wrapper over the client the caller already has.
 */
export function buildMediaStores(supabaseStorage: SupabaseStorageLike, env: NodeJS.ProcessEnv = process.env): MediaStores {
  const legacy: ObjectStore = supabaseObjectStore(supabaseStorage);
  const provider = primaryProvider(env);
  if (!noticed && env.NODE_ENV !== "test") {
    noticed = true;
    console.info(`[rescript:media] ${mediaStorageNotice(env)}`);
  }
  if (!provider) return mediaStores(legacy);
  return mediaStores(providerObjectStore(provider), legacy);
}

export { r2MissingSettings };
