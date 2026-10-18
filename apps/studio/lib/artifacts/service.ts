import { createHash } from "node:crypto";
import type { ObjectStore } from "@rescript/media";
import { checkOfficeFile } from "@rescript/analytics/export";
import {
  KEEP_VERSIONS, SIGNED_URL_SECONDS, artifactCapability, artifactView, isArtifactType, storageKey, versionsToPrune, visibleTo,
  type ArtifactLink, type ArtifactType, type ArtifactView,
} from "./core.ts";

/**
 * PERSISTENT DOCUMENT ARTIFACTS — the service over the database and the object
 * store (both injected, so the tests run it over the in-memory database and the
 * in-memory store; the Studio binds Supabase and the media store's primary —
 * Cloudflare R2 when configured, else Supabase Storage).
 *
 *   findArtifact      the stored document for a fingerprint (reuse, no generation)
 *   readArtifact      its bytes, checked again: size, SHA-256, the Office package
 *   persistArtifact   store a newly generated document as the line's next version
 *   listArtifacts     every line's versions, newest first, as the caller may see them
 *   artifactLink      an access check, the file checked, then a short-lived signed URL
 *
 * Nothing here generates a document, and nothing stores a URL.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = { from(table: string): any };
export interface ArtifactDeps { db: Db; store: ObjectStore; bucket?: string; now?: () => Date }
export const ARTIFACTS_BUCKET = "rescript-reports";
export type Fail = { ok: false; status: number; error: string; code: string };
const fail = (status: number, error: string, code: string): Fail => ({ ok: false, status, error, code });
export const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const COLS = "*";
/** the table is missing on a database without migration 0064: persistence then fails soft (the document is still made and sent) */
export const missingTable = (e: { message?: string; code?: string } | null | undefined): boolean => !!e && (e.code === "42P01" || /relation .*artifacts.* does not exist|could not find the table/i.test(e.message ?? ""));

export interface FindInput { surveyId: string; type: ArtifactType; edition: string; fingerprint: string; userId: string | null }

/** the live stored document made from exactly these inputs, if the caller may see it */
export async function findArtifact(deps: ArtifactDeps, q: FindInput): Promise<Record<string, any> | null> {
  const { data, error } = await deps.db.from("artifacts").select(COLS).eq("survey_id", q.surveyId).eq("type", q.type).eq("edition", q.edition).eq("fingerprint", q.fingerprint).is("deleted_at", null).order("version", { ascending: false }).limit(5);
  if (error) return null;
  return ((data ?? []) as Record<string, any>[]).find((r) => visibleTo(r, q.userId)) ?? null;
}

/**
 * The stored bytes, checked as if they had just been made: the object exists,
 * its size and SHA-256 are the row's, and it is still a Word / PowerPoint
 * package (`checkOfficeFile` — `checkDocx` for Word). A file that is missing,
 * unreadable or corrupt is a clear error, never a broken download.
 */
export async function readArtifact(deps: ArtifactDeps, row: Record<string, any>): Promise<{ ok: true; bytes: Uint8Array } | Fail> {
  let bytes: Uint8Array;
  try { bytes = await deps.store.read(String(row.bucket), String(row.storage_key)); }
  catch (e) {
    const msg = (e as Error).message ?? "";
    const status = Number((e as { status?: unknown; statusCode?: unknown }).status ?? (e as { statusCode?: unknown }).statusCode ?? 0);
    return status === 404 || /not.?found|no such|404|does not exist|not in the store/i.test(msg)
      ? fail(410, `The stored file for ${row.file_name} (version ${row.version}) is missing from storage. Generate it again — the earlier versions are unaffected.`, "artifact_missing")
      : fail(502, `The stored file for ${row.file_name} could not be read from storage right now. Try again in a moment.`, "artifact_unreadable");
  }
  if (bytes.length !== Number(row.size_bytes) || sha256(bytes) !== String(row.checksum)) return fail(422, `The stored file for ${row.file_name} (version ${row.version}) does not match what was saved (size or checksum) — it is not offered. Generate it again.`, "artifact_corrupt");
  const c = checkOfficeFile(Buffer.from(bytes), String(row.mime));
  if (!c.ok) return fail(422, `The stored file for ${row.file_name} (version ${row.version}) is damaged: ${c.problems.slice(0, 2).join("; ")}. It is not offered — generate it again.`, "artifact_corrupt");
  return { ok: true, bytes };
}

export interface PersistInput {
  surveyId: string; customerId: string | null; userId: string | null;
  type: ArtifactType; edition: string; fingerprint: string; inputs: Record<string, unknown>;
  bytes: Uint8Array; fileName: string; mime: string;
  summary?: string | null; narrative?: string | null;
  source?: "copilot" | "research_tab" | "workflow" | "api"; visibility?: "project" | "private";
  themeRef?: string | null; themeVersion?: number | null;
  /** an explicit regeneration of unchanged inputs: the earlier row keeps its place in the history under a marked fingerprint, so the new one can take it */
  replace?: boolean;
}

/**
 * Store a newly made document as its line's next version. The object first (a
 * unique key, never an overwrite), then the row; two requests racing on the
 * same inputs end with ONE row (the unique fingerprint index) and the loser's
 * object removed; racing on the same version number, the loser takes the next.
 * The previous versions are marked superseded and kept — the last
 * `KEEP_VERSIONS` stay downloadable, older objects are removed.
 */
export async function persistArtifact(deps: ArtifactDeps, p: PersistInput): Promise<{ ok: true; row: Record<string, any>; reused: boolean } | Fail> {
  const bucket = deps.bucket ?? ARTIFACTS_BUCKET;
  const checksum = sha256(p.bytes);
  const visibility = p.visibility ?? "project";
  if (p.replace) {
    const same = await findArtifact(deps, { surveyId: p.surveyId, type: p.type, edition: p.edition, fingerprint: p.fingerprint, userId: p.userId });
    if (same) await deps.db.from("artifacts").update({ fingerprint: `${p.fingerprint}~v${same.version}` }).eq("id", same.id);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: last, error: lastErr } = await deps.db.from("artifacts").select("version").eq("survey_id", p.surveyId).eq("type", p.type).eq("edition", p.edition).order("version", { ascending: false }).limit(1);
    if (lastErr) return fail(missingTable(lastErr) ? 501 : 500, missingTable(lastErr) ? "Documents are not kept on this installation yet (migration 0064)." : `The document could not be recorded: ${lastErr.message}`, missingTable(lastErr) ? "artifacts_unavailable" : "artifact_record_failed");
    const version = Number((last as { version: number }[] | null)?.[0]?.version ?? 0) + 1;
    const id = crypto.randomUUID();
    const key = storageKey(p.surveyId, p.type, p.edition, version, id);
    try { await deps.store.put(bucket, key, p.bytes, { contentType: p.mime }); }
    catch (e) { return fail(502, `The document was made but could not be stored: ${(e as Error).message}`, "artifact_store_failed"); }
    const row = {
      id, survey_id: p.surveyId, customer_id: p.customerId, owner_id: p.userId, created_by: p.userId, type: p.type, edition: p.edition, version, fingerprint: p.fingerprint, inputs: p.inputs,
      storage_provider: deps.store.name, bucket, storage_key: key, file_name: p.fileName, mime: p.mime, size_bytes: p.bytes.length, checksum,
      status: "ready", visibility, source: p.source ?? "copilot", summary: p.summary ?? null, narrative: p.narrative ?? null, theme_ref: p.themeRef ?? null, theme_version: p.themeVersion ?? null,
      verified_at: (deps.now?.() ?? new Date()).toISOString(),
    };
    const { data, error } = await deps.db.from("artifacts").insert(row).select(COLS).single();
    if (!error && data) {
      await supersedeAndPrune(deps, p.surveyId, p.type, p.edition, String(data.id));
      return { ok: true, row: data, reused: false };
    }
    /* the object is ours alone (its key carries this attempt's id): take it back before deciding */
    await deps.store.remove(bucket, [key]).catch(() => null);
    if (error?.code === "23505" && /fingerprint/.test(error.message ?? "")) {
      const other = await findArtifact(deps, { surveyId: p.surveyId, type: p.type, edition: p.edition, fingerprint: p.fingerprint, userId: p.userId });
      if (other) return { ok: true, row: other, reused: true };
    }
    if (error?.code === "23505") continue; /* the version was taken by a concurrent request: the next one */
    return fail(missingTable(error) ? 501 : 500, missingTable(error) ? "Documents are not kept on this installation yet (migration 0064)." : `The document could not be recorded: ${error?.message ?? "no row"}`, missingTable(error) ? "artifacts_unavailable" : "artifact_record_failed");
  }
  return fail(409, "The document could not be recorded: too many simultaneous versions. Try again.", "artifact_conflict");
}

async function supersedeAndPrune(deps: ArtifactDeps, surveyId: string, type: string, edition: string, keepId: string): Promise<void> {
  const { data } = await deps.db.from("artifacts").select("id, version, status, bucket, storage_key").eq("survey_id", surveyId).eq("type", type).eq("edition", edition).is("deleted_at", null).order("version", { ascending: false }).limit(200);
  const rows = (data ?? []) as { id: string; version: number; status: string; bucket: string; storage_key: string }[];
  for (const r of rows) if (r.id !== keepId && r.status === "ready") await deps.db.from("artifacts").update({ status: "superseded" }).eq("id", r.id);
  for (const r of versionsToPrune(rows, KEEP_VERSIONS)) {
    const rep = await deps.store.remove(r.bucket, [r.storage_key]).catch(() => null);
    if (rep && rep.failed.length) continue; /* kept as a row until its object is really gone */
    await deps.db.from("artifacts").update({ status: "deleted", deleted_at: (deps.now?.() ?? new Date()).toISOString() }).eq("id", r.id);
  }
}

export interface ArtifactLine { type: ArtifactType; edition: string; latest: ArtifactView; versions: ArtifactView[] }

/** every document line of a project the caller may see: the latest version and the kept history, newest first */
export async function listArtifacts(deps: ArtifactDeps, q: { surveyId: string; userId: string | null; may: (type: ArtifactType) => boolean }): Promise<{ ok: true; lines: ArtifactLine[] } | Fail> {
  const { data, error } = await deps.db.from("artifacts").select(COLS).eq("survey_id", q.surveyId).is("deleted_at", null).order("created_at", { ascending: false }).limit(300);
  if (error) return fail(missingTable(error) ? 501 : 500, missingTable(error) ? "Documents are not kept on this installation yet (migration 0064)." : error.message, missingTable(error) ? "artifacts_unavailable" : "artifact_list_failed");
  const lines = new Map<string, ArtifactLine>();
  for (const r of (data ?? []) as Record<string, any>[]) {
    if (!isArtifactType(r.type) || !q.may(r.type) || !visibleTo(r, q.userId)) continue;
    const v = artifactView(r);
    const k = `${v.type}:${v.edition}`;
    const line = lines.get(k) ?? { type: v.type, edition: v.edition, latest: v, versions: [] };
    line.versions.push(v);
    lines.set(k, line);
  }
  for (const l of lines.values()) { l.versions.sort((a, b) => b.version - a.version); l.latest = l.versions[0]; l.versions = l.versions.slice(0, KEEP_VERSIONS); }
  return { ok: true, lines: [...lines.values()] };
}

/**
 * A DOWNLOAD. The row must be this project's, visible to the caller (a private
 * artifact is its owner's — another member gets 403), and the caller must hold
 * the capability for its type. The stored file is checked; then a signed URL is
 * minted for `SIGNED_URL_SECONDS` and returned — not kept. An expired link is
 * simply asked for again: this function never generates anything.
 */
export async function artifactLink(deps: ArtifactDeps, q: { surveyId: string; artifactId: string; userId: string | null; can: (cap: string) => boolean }): Promise<{ ok: true; link: ArtifactLink; view: ArtifactView } | Fail> {
  if (!/^[0-9a-f-]{36}$/i.test(q.artifactId)) return fail(404, "Unknown document.", "artifact_unknown");
  const { data: row, error } = await deps.db.from("artifacts").select(COLS).eq("id", q.artifactId).maybeSingle();
  if (error) return fail(missingTable(error) ? 501 : 500, missingTable(error) ? "Documents are not kept on this installation yet (migration 0064)." : error.message, missingTable(error) ? "artifacts_unavailable" : "artifact_read_failed");
  /* another project's artifact is unknown here, whatever its id (no existence oracle across projects) */
  if (!row || row.survey_id !== q.surveyId || row.deleted_at || row.status === "deleted" || !isArtifactType(row.type)) return fail(404, "Unknown document.", "artifact_unknown");
  if (!visibleTo(row, q.userId)) return fail(403, "This document is private to the person who made it.", "artifact_private");
  if (!q.can(artifactCapability(row.type, "download"))) return fail(403, row.type === "findings_docx" || row.type === "findings_pptx" ? "You do not have permission to download reports in this project (Data Analytics & Reports: export)." : "You do not have access to this document.", "artifact_forbidden");
  const checked = await readArtifact(deps, row);
  if (!checked.ok) return checked;
  let url: string;
  try { url = await deps.store.signDownload(String(row.bucket), String(row.storage_key), { seconds: SIGNED_URL_SECONDS, downloadAs: String(row.file_name), contentType: String(row.mime) }); }
  catch (e) { return fail(502, `A download link could not be made right now: ${(e as Error).message}`, "artifact_sign_failed"); }
  const now = deps.now?.() ?? new Date();
  void deps.db.from("artifacts").update({ verified_at: now.toISOString() }).eq("id", row.id);
  return { ok: true, view: artifactView(row), link: { url, expiresAt: new Date(now.getTime() + SIGNED_URL_SECONDS * 1000).toISOString(), name: String(row.file_name), size: Number(row.size_bytes), version: Number(row.version), mime: String(row.mime) } };
}

/** a stored file found damaged on reuse is retired (marked deleted, object removed) so the next request makes a fresh version */
export async function retireArtifact(deps: ArtifactDeps, row: Record<string, any>): Promise<void> {
  await deps.store.remove(String(row.bucket), [String(row.storage_key)]).catch(() => null);
  await deps.db.from("artifacts").update({ status: "deleted", deleted_at: (deps.now?.() ?? new Date()).toISOString() }).eq("id", row.id);
}

/* ------------------------------------------------------------ generate once, then reuse */

export interface Produced { bytes: Uint8Array; fileName: string; mime: string; summary?: string | null; narrative?: string | null }
export interface ObtainInput extends FindInput {
  customerId: string | null; inputs: Record<string, unknown>;
  /** make a new version even if one exists for these inputs ("update the Word document", Regenerate) */
  regenerate?: boolean;
  source?: PersistInput["source"]; visibility?: PersistInput["visibility"]; themeRef?: string | null; themeVersion?: number | null;
}
export type Obtained = {
  ok: true; bytes: Uint8Array; fileName: string; mime: string; summary: string | null; narrative: string | null;
  /** the stored row (null when it could not be stored — the document is still sent) */
  row: Record<string, any> | null;
  /** true: the stored document was sent and nothing was generated */
  reused: boolean;
  /** why a stored copy was not used or a new one not kept, in words */
  note?: string;
};

/**
 * THE ONE DOOR to a document: the stored one when its fingerprint matches
 * (checked again, never regenerated), else `generate()` once and keep it.
 * A stored copy found missing or damaged is retired and made again, and the
 * answer says so. A store or database that cannot keep the new document does
 * not cost the person their file: it is sent, and `note` says it was not kept.
 */
export async function obtainArtifact(deps: ArtifactDeps, q: ObtainInput, generate: () => Promise<Produced | Fail>): Promise<Obtained | Fail> {
  let note: string | undefined;
  if (!q.regenerate) {
    const hit = await findArtifact(deps, q);
    if (hit) {
      const r = await readArtifact(deps, hit);
      if (r.ok) return { ok: true, bytes: r.bytes, fileName: String(hit.file_name), mime: String(hit.mime), summary: (hit.summary as string | null) ?? null, narrative: (hit.narrative as string | null) ?? null, row: hit, reused: true };
      note = `${r.error.replace(/ Generate it again.*$/, "")} A new copy was made.`;
      await retireArtifact(deps, hit);
    }
  }
  const made = await generate();
  if ("ok" in made && made.ok === false) return made;
  const p = made as Produced;
  const saved = await persistArtifact(deps, { surveyId: q.surveyId, customerId: q.customerId, userId: q.userId, type: q.type, edition: q.edition, fingerprint: q.fingerprint, inputs: q.inputs, bytes: p.bytes, fileName: p.fileName, mime: p.mime, summary: p.summary ?? null, narrative: p.narrative ?? null, source: q.source, visibility: q.visibility, themeRef: q.themeRef ?? null, themeVersion: q.themeVersion ?? null, replace: !!q.regenerate });
  if (!saved.ok) return { ok: true, bytes: p.bytes, fileName: p.fileName, mime: p.mime, summary: p.summary ?? null, narrative: p.narrative ?? null, row: null, reused: false, note: saved.code === "artifacts_unavailable" ? undefined : `The document was made but not kept (${saved.error}); asking again will make it again.` };
  return { ok: true, bytes: p.bytes, fileName: p.fileName, mime: p.mime, summary: p.summary ?? null, narrative: p.narrative ?? null, row: saved.row, reused: false, ...(note ? { note } : {}) };
}
