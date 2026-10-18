import type { ThemeSpec, StructureRequest } from "@rescript/analytics";
import { readThemeSpec } from "@rescript/analytics";
import { readStructure } from "../reportThemesStore.ts";
import { KEEP_VERSIONS, type ArtifactType } from "./core.ts";

/**
 * SANDBOX ONLY — the sandbox has no database and no Storage, so its documents
 * and its report theme live in THIS TAB's sessionStorage (2026-10-18). It
 * exists so the reload behaviour — a document made once, offered again after a
 * reload, downloaded without generating, "a new version is available" when the
 * design changes — can be seen and tested where there is no server state. It is
 * never used for a saved project (those are `artifacts` rows and Storage
 * objects), it is lost with the tab, and it keeps at most two versions per
 * document (a browser gives a tab a few megabytes).
 */
export const SANDBOX_ARTIFACTS_KEY = "rescript.sandboxArtifacts.v1";
export const SANDBOX_THEME_KEY = "rescript.sandboxReportTheme.v1";
const SANDBOX_KEEP = Math.min(2, KEEP_VERSIONS);

export interface SandboxArtifact {
  id: string; type: ArtifactType; edition: string; version: number; fingerprint: string;
  name: string; size: number; mime: string; createdAt: string; summary: string | null; narrative: string | null; base64: string;
}

const read = (store: Storage | null): SandboxArtifact[] => {
  try { const raw = store?.getItem(SANDBOX_ARTIFACTS_KEY); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; } catch { return []; }
};
const write = (store: Storage | null, all: SandboxArtifact[]): boolean => {
  if (!store) return false;
  /* a full tab: drop the oldest documents until it fits (never the one just made) */
  for (let list = all; list.length; list = list.slice(1)) {
    try { store.setItem(SANDBOX_ARTIFACTS_KEY, JSON.stringify(list)); return true; } catch { if (list.length === 1) return false; }
  }
  return false;
};

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const sandboxList = (store: Storage | null): SandboxArtifact[] => read(store);
export const sandboxFind = (store: Storage | null, type: ArtifactType, edition: string, fingerprint: string): SandboxArtifact | null =>
  read(store).filter((a) => a.type === type && a.edition === edition && a.fingerprint === fingerprint).sort((a, b) => b.version - a.version)[0] ?? null;
export const sandboxGet = (store: Storage | null, id: string): SandboxArtifact | null => read(store).find((a) => a.id === id) ?? null;

/** keep a document the sandbox made; the same inputs again are the same document (no second copy), new inputs the next version */
export function sandboxPut(store: Storage | null, a: { type: ArtifactType; edition: string; fingerprint: string; name: string; mime: string; summary?: string | null; narrative?: string | null; regenerate?: boolean }, bytes: Uint8Array, now = new Date()): SandboxArtifact | null {
  const all = read(store);
  const same = all.find((x) => x.type === a.type && x.edition === a.edition && x.fingerprint === a.fingerprint);
  if (same && !a.regenerate) return same;
  const line = all.filter((x) => x.type === a.type && x.edition === a.edition);
  const version = line.reduce((m, x) => Math.max(m, x.version), 0) + 1;
  const item: SandboxArtifact = { id: `sbx-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, type: a.type, edition: a.edition, version, fingerprint: a.fingerprint, name: a.name, size: bytes.length, mime: a.mime, createdAt: now.toISOString(), summary: a.summary ?? null, narrative: a.narrative ?? null, base64: toBase64(bytes) };
  const keptLine = [item, ...line.sort((x, y) => y.version - x.version)].slice(0, SANDBOX_KEEP);
  const next = [...all.filter((x) => !(x.type === a.type && x.edition === a.edition)), ...keptLine.reverse()];
  return write(store, next) ? item : null;
}

export interface SandboxLine { type: ArtifactType; edition: string; latest: SandboxArtifact; versions: SandboxArtifact[] }
export function sandboxLines(store: Storage | null): SandboxLine[] {
  const by = new Map<string, SandboxArtifact[]>();
  for (const a of read(store)) { const k = `${a.type}:${a.edition}`; by.set(k, [...(by.get(k) ?? []), a]); }
  return [...by.values()].map((vs) => { const versions = vs.sort((x, y) => y.version - x.version); return { type: versions[0].type, edition: versions[0].edition, latest: versions[0], versions }; });
}

/* ------------------------------------------------------------ the sandbox's report theme (and its "saved" themes) */

export interface SandboxThemeState { theme: ThemeSpec | null; structure: StructureRequest | null; saved: ThemeSpec[] }
export function sandboxTheme(store: Storage | null): SandboxThemeState {
  try {
    const v = JSON.parse(store?.getItem(SANDBOX_THEME_KEY) ?? "null") as { theme?: unknown; structure?: unknown; saved?: unknown[] } | null;
    return { theme: readThemeSpec(v?.theme), structure: readStructure(v?.structure), saved: (Array.isArray(v?.saved) ? v!.saved : []).map(readThemeSpec).filter((t): t is ThemeSpec => !!t) };
  } catch { return { theme: null, structure: null, saved: [] }; }
}
export function setSandboxTheme(store: Storage | null, next: Partial<SandboxThemeState>): SandboxThemeState {
  const cur = sandboxTheme(store);
  const merged = { ...cur, ...next };
  try { store?.setItem(SANDBOX_THEME_KEY, JSON.stringify(merged)); } catch { /* a private window: kept for this page only */ }
  return merged;
}
/** "save as": the sandbox keeps named themes for the tab; the same name again is its next version */
export function sandboxSaveTheme(store: Storage | null, theme: ThemeSpec, name: string): ThemeSpec {
  const cur = sandboxTheme(store);
  const key = name.trim().toLowerCase();
  const prev = cur.saved.find((t) => t.name.trim().toLowerCase() === key);
  const saved: ThemeSpec = { ...theme, name: prev?.name ?? name.trim(), id: prev?.id ?? `sbx-theme-${Math.random().toString(36).slice(2, 10)}`, version: (prev?.version ?? 0) + 1 };
  setSandboxTheme(store, { saved: [...cur.saved.filter((t) => t !== prev), saved] });
  return saved;
}
