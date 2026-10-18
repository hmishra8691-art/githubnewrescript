import { canonicalJson, hash64, type ThemeSpec, type StructureRequest } from "@rescript/analytics";
import { artifactFingerprint, definitionHash, editionOf, GENERATOR_VERSION, type ArtifactLink, type ArtifactType, type ArtifactView, type ArtifactState } from "./core.ts";
import { themeStamp } from "../reportThemesStore.ts";

/**
 * THE BROWSER'S SIDE OF KEPT DOCUMENTS (2026-10-18): list a project's
 * documents, fetch a fresh download link for one (an access-checked, two-minute
 * signed URL — asked for again whenever it is needed, so an expired link is
 * never a dead end), save bytes or a URL through an anchor, and the sandbox's
 * fingerprint (the same function the server uses, over the definition on
 * screen) for its sessionStorage store.
 */
export interface ArtifactLineView { type: ArtifactType; edition: string; label: string; latest: ArtifactView; versions: ArtifactView[]; state: ArtifactState; current: string | null }

export const sessionStore = (): Storage | null => { try { return window.sessionStorage; } catch { return null; } };

export async function fetchArtifactLines(surveyId: string): Promise<{ ok: true; lines: ArtifactLineView[]; theme: { name: string } | null } | { ok: false; error: string; status: number }> {
  try {
    const r = await fetch(`/api/surveys/${surveyId}/artifacts`, { cache: "no-store" });
    const d = await r.json().catch(() => null) as { lines?: ArtifactLineView[]; theme?: { name: string } | null; error?: string } | null;
    if (!r.ok || !d) return { ok: false, error: d?.error ?? `The documents could not be listed (HTTP ${r.status}).`, status: r.status };
    return { ok: true, lines: d.lines ?? [], theme: d.theme ?? null };
  } catch (e) { return { ok: false, error: `The documents could not be listed: ${(e as Error).message || "the network request failed"}.`, status: 0 }; }
}

export async function fetchArtifactLink(surveyId: string, artifactId: string): Promise<{ ok: true; link: ArtifactLink } | { ok: false; error: string; status: number; code?: string }> {
  try {
    const r = await fetch(`/api/surveys/${surveyId}/artifacts/${artifactId}`, { cache: "no-store" });
    const d = await r.json().catch(() => null) as (ArtifactLink & { error?: string; code?: string }) | null;
    if (!r.ok || !d?.url) return { ok: false, error: d?.error ?? (r.status === 401 ? "Sign in to download this document." : r.status === 403 ? "You do not have access to this document." : `The document could not be downloaded (HTTP ${r.status}).`), status: r.status, ...(d?.code ? { code: d.code } : {}) };
    return { ok: true, link: d };
  } catch (e) { return { ok: false, error: `The document could not be downloaded: ${(e as Error).message || "the network request failed"}.`, status: 0 }; }
}

/** follow a (signed, attachment) URL as a download */
export function saveUrl(url: string, name: string): void {
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
}
/** save bytes the page holds; the object URL is revoked well after the browser has started the save */
export function saveBytes(bytes: Uint8Array, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  saveUrl(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** the sandbox's fingerprint for a document made from the definition on screen (and, for the findings outputs, the rows a test put on the page) */
export function sandboxFingerprint(p: { type: ArtifactType; audience?: string | null; def: unknown; theme?: ThemeSpec | null; structure?: StructureRequest | null; rows?: unknown[] | null }): string {
  const findings = p.type === "findings_docx" || p.type === "findings_pptx";
  const client = (p.def as { research?: { brief?: { client?: string } } } | null)?.research?.brief?.client ?? null;
  return artifactFingerprint({
    type: p.type, edition: editionOf(p.type, p.audience), definition: { hash: definitionHash(p.def) },
    data: findings ? { stamp: `${p.rows?.length ?? 0}:${hash64(canonicalJson(p.rows ?? []))}`, environment: "ALL", dataset: "all" } : null,
    theme: themeStamp(p.theme ?? null), structure: p.type === "findings_docx" ? p.structure?.order ?? null : null, client, narrative: findings ? "auto" : null, generator: GENERATOR_VERSION,
  });
}
