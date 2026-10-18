import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ThemeSpec, StructureRequest, DatasetSpec } from "@rescript/analytics";
import { logoFromBytes, type DocLogo } from "@rescript/analytics/export";
import { mediaIdFromUrl } from "@rescript/media";
import { mediaDb } from "../mediaRoute";
import { datasetStamp, latestRun } from "../analytics";
import { savedThemes, loadSelection, resolveTheme, themeStamp } from "../reportThemesStore";
import { DESIGN_ONLY, GENERATOR_VERSION, definitionHash, editionOf, type ArtifactType, type FingerprintInputs } from "./core";
import type { ArtifactDeps } from "./service";

/**
 * THE ARTIFACT SERVICE BOUND TO THE STUDIO (2026-10-18): the service-role
 * database and the media store's primary (Cloudflare R2 when configured, else
 * Supabase Storage — the bucket `rescript-reports`, private), the theme a
 * project's documents use, the uploaded logo a theme places, and the
 * fingerprint inputs — ONE function for the output route and the list route,
 * so "is there a new version?" is asked exactly as the document is made.
 */
export function artifactDeps(): ArtifactDeps {
  const m = mediaDb();
  return { db: m as unknown as ArtifactDeps["db"], store: m.stores.primary };
}

export interface DocumentLook { theme: ThemeSpec | null; structure: StructureRequest | null; logo: DocLogo | null; named?: { name: string; found: boolean } }

/** the project's applied theme (and structure request), or a theme named in the sentence ("… in the Healthcare Analytics theme") */
export async function documentLook(db: SupabaseClient, p: { surveyId: string; customerId: string | null; userId: string | null; themeName?: string | null }): Promise<DocumentLook> {
  const sel = await loadSelection(db as never, p.surveyId);
  let theme = sel?.theme ?? null;
  let named: DocumentLook["named"];
  if (p.themeName) {
    const t = resolveTheme(p.themeName, await savedThemes(db as never, { customerId: p.customerId, userId: p.userId }));
    named = { name: p.themeName, found: !!t };
    if (t) theme = t;
  }
  const url = theme && theme.branding.logo.placement !== "none" ? theme.branding.logo.url : undefined;
  const logo = url ? await readLogo(url, { surveyId: p.surveyId, customerId: p.customerId }) : null;
  return { theme, structure: sel?.structure ?? null, logo, ...(named ? { named } : {}) };
}

/**
 * An uploaded logo's bytes for a Word document: a data: URL, or one of OUR
 * media URLs (`/api/media/<id>`) whose object belongs to this project (or is a
 * shared library asset of this organisation). Nothing is fetched from an
 * arbitrary address. PNG and JPEG only, up to 2 MB.
 */
export async function readLogo(url: string, scope: { surveyId: string; customerId: string | null }): Promise<DocLogo | null> {
  try {
    if (url.startsWith("data:")) {
      const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/i.exec(url);
      if (!m) return null;
      const b = Buffer.from(m[2], "base64");
      return b.length <= 2_000_000 ? logoFromBytes(b) : null;
    }
    const id = mediaIdFromUrl(url);
    if (!id) return null;
    const md = mediaDb();
    const { data: row } = await (md as unknown as SupabaseClient).from("media_objects").select("survey_id, customer_id, shared, bucket, path, storage_provider, status, bytes").eq("id", id).maybeSingle();
    if (!row || row.status !== "stored") return null;
    if (row.survey_id !== scope.surveyId && !(row.shared && scope.customerId && row.customer_id === scope.customerId)) return null;
    if (Number(row.bytes ?? 0) > 2_000_000) return null;
    const store = md.stores.byName(row.storage_provider as string | null);
    return store ? logoFromBytes(await store.read(String(row.bucket), String(row.path))) : null;
  } catch { return null; }
}

/**
 * What a document is made from, for its fingerprint. The design documents: the
 * definition, the theme, the client on the cover. The findings outputs add the
 * data stamp (count and last change of the responses in the dataset), the latest
 * stored run ("since the last wave"), the edition, the narrative mode, and — for
 * the Word report — a structure request.
 */
export async function fingerprintInputs(db: SupabaseClient, p: {
  surveyId: string; type: ArtifactType; audience?: string | null; def: unknown; client?: string | null; look: DocumentLook;
  narrative?: "auto" | "engine"; environment?: DatasetSpec["environment"]; dataset?: "all" | "clean";
}): Promise<FingerprintInputs> {
  const findings = !DESIGN_ONLY.has(p.type);
  const environment = p.environment ?? "LIVE";
  const dataset = p.dataset ?? "clean";
  const data = findings ? { stamp: await datasetStamp(db, p.surveyId, { environment, dataset }), environment, dataset, latestRunId: (await latestRun(db, p.surveyId, environment).catch(() => null))?.id ?? null } : null;
  return {
    type: p.type, edition: editionOf(p.type, p.audience), definition: { hash: definitionHash(p.def) }, data,
    theme: themeStamp(p.look.theme), structure: p.type === "findings_docx" ? p.look.structure?.order ?? null : null,
    client: p.client ?? null, narrative: findings ? p.narrative ?? "auto" : null, generator: GENERATOR_VERSION,
  };
}
