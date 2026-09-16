import "server-only";
import { NextResponse } from "next/server";
import {
  MemoryStorageProvider, r2FromEnv, r2MissingSettings,
  type MediaStorageProvider,
} from "@rescript/storage";

/**
 * THE ONE PLACE THIS APPLICATION LEARNS WHERE OBJECTS LIVE.
 *
 * Nothing else imports `@rescript/storage`'s R2 class, and nothing else reads
 * an `R2_*` variable. Moving to another provider is editing this file; that is
 * the whole return on the abstraction, and it is lost the first time a route
 * constructs its own client.
 *
 * ## When nothing is configured
 *
 * A deployment with no R2 credentials answers **501** on the routes that need
 * storage and runs normally everywhere else — the same shape `aiConfigured()`
 * already uses for the AI provider, and for the same reason: a product that
 * crashes on boot because an optional integration is unset is a product
 * nobody can stand up incrementally. The 501 body NAMES the missing settings,
 * because "media storage is not configured" without saying which of four
 * variables is missing is an hour of somebody's afternoon.
 *
 * ## The in-memory provider
 *
 * `INTERVIEWS_STORAGE=memory` selects the double from `@rescript/storage`,
 * which speaks enough of the S3 API over HTTP that a real browser can upload
 * to it. It exists so the candidate runtime — the multipart upload, the
 * resume, the verification — can be driven end to end in a test with no
 * Cloudflare account and no network. It is refused in production, loudly,
 * because a deployment that silently kept every recording in a process's heap
 * would lose them all on the next deploy and nobody would find out until a
 * candidate asked.
 */

let cached: MediaStorageProvider | null = null;
let cachedKey = "";

function keyOf(): string {
  return [
    process.env.INTERVIEWS_STORAGE ?? "",
    process.env.R2_ACCOUNT_ID ?? "",
    process.env.R2_ENDPOINT ?? "",
    process.env.R2_BUCKET ?? "",
    /* the key IDENTITY, never the secret — this string can end up in a log */
    (process.env.R2_ACCESS_KEY_ID ?? "").slice(0, 6),
  ].join("|");
}

export function storageProvider(): MediaStorageProvider | null {
  const key = keyOf();
  if (cached && cachedKey === key) return cached;

  if (process.env.INTERVIEWS_STORAGE === "memory") {
    if (process.env.NODE_ENV === "production" && process.env.INTERVIEWS_ALLOW_MEMORY_STORAGE !== "1") {
      throw new Error(
        "INTERVIEWS_STORAGE=memory is a test double and would lose every recording on the next deploy. "
        + "Configure R2, or set INTERVIEWS_ALLOW_MEMORY_STORAGE=1 if you genuinely mean it.",
      );
    }
    cached = new MemoryStorageProvider({
      baseUrl: process.env.INTERVIEWS_STORAGE_URL ?? "http://127.0.0.1:4599",
    });
    cachedKey = key;
    return cached;
  }

  const r2 = r2FromEnv();
  cached = r2;
  cachedKey = key;
  return r2;
}

/** The provider, or a 501 that says exactly which setting is missing. */
export function storageOrResponse(): { storage: MediaStorageProvider } | { response: NextResponse } {
  let storage: MediaStorageProvider | null;
  try {
    storage = storageProvider();
  } catch (e) {
    return { response: NextResponse.json({ error: (e as Error).message }, { status: 500 }) };
  }
  if (!storage) {
    const missing = r2MissingSettings();
    return {
      response: NextResponse.json({
        error: "Media storage is not configured on this deployment, so recordings cannot be saved.",
        missing,
        hint: `Set ${missing.join(", ")} and redeploy.`,
      }, { status: 501 }),
    };
  }
  return { storage };
}

/**
 * The public origin the CANDIDATE's browser will PUT to.
 *
 * Only needed by the in-memory double, whose signed URLs point at a local
 * server rather than at Cloudflare. R2's own URLs carry their host already.
 */
export function storageOrigin(): string | null {
  return process.env.INTERVIEWS_STORAGE === "memory"
    ? (process.env.INTERVIEWS_STORAGE_URL ?? "http://127.0.0.1:4599")
    : null;
}

/** For tests that swap the provider between cases. */
export function resetStorageCache(): void {
  cached = null;
  cachedKey = "";
}
