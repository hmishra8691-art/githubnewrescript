import "server-only";
import { aiProviderName } from "@rescript/ai";
import { runtimeBaseUrl } from "@/lib/runtime-url";

/**
 * THE SANDBOX'S AI INTERVIEWS live in the runtime's memory (no database, fake provider): the Studio
 * forwards the sandbox's requests there, server to server, only when its own provider is the fake one.
 * A real installation never reaches this — its studies are in migration 0069 and read with the member's
 * access checked.
 */
export async function sandboxCall(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  /* the sandbox (unsaved project) exists only on the fake provider; anywhere else it is refused whoever asks */
  if (aiProviderName() !== "fake") return { status: 403, body: { error: "the sandbox runs AI interviews only against the fake provider — save the project to launch real ones" } };
  try {
    const r = await fetch(`${runtimeBaseUrl()}/api/ai-interview/sandbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch (e) {
    return { status: 502, body: { error: `the respondent runtime could not be reached (${(e as Error).message})` } };
  }
}
