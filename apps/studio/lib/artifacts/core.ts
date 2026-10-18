import { canonicalJson, hash64 } from "@rescript/analytics";

/**
 * PERSISTENT DOCUMENT ARTIFACTS — the rules, with no I/O (2026-10-18,
 * docs/ARTIFACTS-AND-REPORT-THEMES-2026-10-18.md).
 *
 * A research document (the Word research plan, proposal, SAP, findings report,
 * the findings deck) is generated ONCE per content version and kept: a Storage
 * object plus an `artifacts` row (migration 0064). Its identity is the
 * FINGERPRINT of everything it is made from — the definition (hash and
 * revision), the edition, the data stamp and the latest stored run for the
 * findings outputs, the report theme (ref, version, hash of its look), a
 * structure request, the client named on it, the narrative mode and the
 * generator version. The same fingerprint is the same document: asking again,
 * or reloading the page, downloads the stored one; nothing is regenerated
 * unless asked for explicitly or the fingerprint changed ("a new version is
 * available"). The row keeps the storage KEY, never a signed URL — a download
 * signs a short-lived URL after an access check, every time.
 *
 * Pure, so the browser uses the same fingerprint for the sandbox's own store.
 */

export const ARTIFACT_TYPES = ["research_plan_docx", "proposal_docx", "sap_docx", "findings_docx", "findings_pptx"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export const isArtifactType = (t: unknown): t is ArtifactType => typeof t === "string" && (ARTIFACT_TYPES as readonly string[]).includes(t);
/** made from the survey and its research design alone */
export const DESIGN_ONLY: ReadonlySet<ArtifactType> = new Set(["research_plan_docx", "proposal_docx", "sap_docx"]);

/**
 * Bumped when an exporter's output changes in a way a stored document should
 * not survive (a new section, a fixed number): every fingerprint changes with
 * it, so every document line offers "a new version is available".
 */
export const GENERATOR_VERSION = "docs-2026-10-18.1";

/** a stored artifact's download link lives this long; minted per download, after the access check */
export const SIGNED_URL_SECONDS = 120;
/** versions of one document line kept downloadable; older ones are removed from storage */
export const KEEP_VERSIONS = 5;

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const extOf = (type: ArtifactType): "docx" | "pptx" => (type === "findings_pptx" ? "pptx" : "docx");
export const mimeOf = (type: ArtifactType): string => (type === "findings_pptx" ? PPTX_MIME : DOCX_MIME);

export const ARTIFACT_LABEL: Record<ArtifactType, string> = {
  research_plan_docx: "Research plan (.docx)", proposal_docx: "Research proposal (.docx)", sap_docx: "Statistical analysis plan (.docx)",
  findings_docx: "Findings report (.docx)", findings_pptx: "Findings deck (.pptx)",
};

/** the edition a document line is kept under: the audience for the findings outputs, one standard edition for the design documents */
export function editionOf(type: ArtifactType, audience?: string | null): string {
  if (DESIGN_ONLY.has(type)) return "standard";
  return audience === "executive" || audience === "researcher" ? audience : "client";
}

export interface FingerprintInputs {
  type: ArtifactType;
  edition: string;
  definition: { hash: string; revision?: number | null };
  /** the findings outputs: what the run reads (count and last change of the responses) and the stored run "since the last wave" compares with */
  data?: { stamp: string; environment: string; dataset: string; latestRunId?: string | null } | null;
  theme?: { ref: string | null; version: number | null; hash: string } | null;
  /** a structure request's section order, as asked */
  structure?: string[] | null;
  client?: string | null;
  /** findings outputs: whether a model narrative may be asked for ("auto") or the engine's words only */
  narrative?: "auto" | "engine" | null;
  generator: string;
}

/** a definition's content hash — key order and `undefined` do not change it */
export const definitionHash = (def: unknown): string => hash64(canonicalJson(def));

export function artifactFingerprint(inputs: FingerprintInputs): string {
  const { type, edition, definition, data, theme, structure, client, narrative, generator } = inputs;
  return `${type.slice(0, 4)}-${hash64(canonicalJson({ type, edition, definition, data: data ?? null, theme: theme ?? null, structure: structure?.length ? structure : null, client: client ?? null, narrative: narrative ?? null, generator }))}`;
}

/** where the bytes go: `<survey>/artifacts/<type>/<edition>/v<version>-<id>.<ext>` — unique, never overwritten */
export function storageKey(surveyId: string, type: ArtifactType, edition: string, version: number, artifactId: string): string {
  return `${surveyId}/artifacts/${type}/${edition.replace(/[^a-z]/g, "") || "standard"}/v${version}-${artifactId}.${extOf(type)}`;
}

/**
 * WHO MAY: the design documents are part of reading the project
 * (`project.read`); the findings documents are reports — listed with
 * `analytics.read` (Data Analytics & Reports: View) and downloaded or
 * generated with `analytics.export`, exactly as the output route has always
 * required to make them.
 */
export type ArtifactAction = "list" | "download" | "generate";
export function artifactCapability(type: ArtifactType, action: ArtifactAction): "project.read" | "analytics.read" | "analytics.export" {
  if (DESIGN_ONLY.has(type)) return "project.read";
  return action === "list" ? "analytics.read" : "analytics.export";
}

/** a private artifact is its owner's alone; a project artifact is every member's who holds the capability */
export function visibleTo(a: { visibility?: string | null; owner_id?: string | null }, userId: string | null | undefined): boolean {
  return a.visibility !== "private" || (!!userId && a.owner_id === userId);
}

export type ArtifactState = "current" | "stale";
/** the latest stored version against what the document would be made from now */
export const artifactState = (latestFingerprint: string, currentFingerprint: string | null | undefined): ArtifactState =>
  !currentFingerprint || latestFingerprint === currentFingerprint ? "current" : "stale";

/** the versions beyond the kept ones (rows newest first) */
export function versionsToPrune<T extends { version: number }>(rowsNewestFirst: T[], keep = KEEP_VERSIONS): T[] {
  return [...rowsNewestFirst].sort((a, b) => b.version - a.version).slice(keep);
}

/** a link the browser can follow to download — never stored */
export interface ArtifactLink { url: string; expiresAt: string; name: string; size: number; version: number; mime: string }

/** the public view of a row: what the list and the copilot card need, no storage internals */
export interface ArtifactView {
  id: string; type: ArtifactType; edition: string; version: number; name: string; size: number; mime: string;
  createdAt: string; createdBy: string | null; summary: string | null; narrative: string | null;
  visibility: "project" | "private"; themeRef: string | null; themeVersion: number | null; fingerprint: string; source: string;
  /** what it was made from (hashes, the data stamp, the narrative mode) — so "is there a new version?" compares like with like */
  inputs: Partial<FingerprintInputs>;
}
export function artifactView(r: Record<string, unknown>): ArtifactView {
  return {
    id: String(r.id), type: r.type as ArtifactType, edition: String(r.edition ?? "standard"), version: Number(r.version), name: String(r.file_name), size: Number(r.size_bytes), mime: String(r.mime),
    createdAt: String(r.created_at), createdBy: (r.created_by as string | null) ?? null, summary: (r.summary as string | null) ?? null, narrative: (r.narrative as string | null) ?? null,
    visibility: r.visibility === "private" ? "private" : "project", themeRef: (r.theme_ref as string | null) ?? null, themeVersion: (r.theme_version as number | null) ?? null, fingerprint: String(r.fingerprint), source: String(r.source ?? "copilot"),
    inputs: r.inputs && typeof r.inputs === "object" ? (r.inputs as Partial<FingerprintInputs>) : {},
  };
}
