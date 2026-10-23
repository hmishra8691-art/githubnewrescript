import {
  REPORT_THEMES, findReportTheme, readThemeSpec, themeNameKey, reportThemeHash, STRUCTURE_SECTIONS, readSectionOrders,
  type ThemeSpec, type StructureRequest, type StructureSection,
} from "@rescript/analytics";

/**
 * NAMED REPORT THEMES AND THE THEME A PROJECT'S DOCUMENTS USE (2026-10-18,
 * migration 0064). The database is injected (the Studio's service client, or
 * the tests' in-memory one).
 *
 *   savedThemes      the organisation's themes and the person's own (never global)
 *   saveTheme        save under a name: a new theme, or the next version of that name
 *   loadSelection    the theme (and a structure request) applied to a project
 *   applySelection   apply one — kept as applied: a frozen copy with its ref and version
 *   resolveTheme     a theme by name or ref among the built-ins and the saved ones
 *
 * The five built-ins are code (`REPORT_THEMES`), not rows.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Db = { from(table: string): any };
export type Fail = { ok: false; status: number; error: string; code: string };
const fail = (status: number, error: string, code: string): Fail => ({ ok: false, status, error, code });
const missing = (e: { message?: string; code?: string } | null | undefined) => !!e && (e.code === "42P01" || /relation .*report_theme.* does not exist|could not find the table/i.test(e.message ?? ""));
const UNAVAILABLE = "Saved report themes are not available on this installation yet (migration 0064). The built-in themes still apply.";

export interface SavedTheme extends ThemeSpec { scope: "org" | "user" }

function fromRow(r: Record<string, any>): SavedTheme | null {
  const t = readThemeSpec({ ...(r.theme as object), name: r.name, id: r.id, version: r.version, ...(r.description ? { description: r.description } : {}) });
  return t ? { ...t, id: String(r.id), version: Number(r.version), scope: r.scope === "user" ? "user" : "org" } : null;
}

/** the organisation's themes and the person's own, person's first (a personal theme may shadow an organisation's name for that person) */
export async function savedThemes(db: Db, who: { customerId: string | null; userId: string | null }): Promise<SavedTheme[]> {
  const out: SavedTheme[] = [];
  if (who.userId) {
    const { data, error } = await db.from("report_themes").select("*").eq("scope", "user").eq("owner_id", who.userId).is("deleted_at", null).order("name", { ascending: true });
    if (!error) for (const r of data ?? []) { const t = fromRow(r); if (t) out.push(t); }
  }
  if (who.customerId) {
    const { data, error } = await db.from("report_themes").select("*").eq("scope", "org").eq("customer_id", who.customerId).is("deleted_at", null).order("name", { ascending: true });
    if (!error) for (const r of data ?? []) { const t = fromRow(r); if (t) out.push(t); }
  }
  return out;
}

/**
 * Save a theme under a name, for the organisation or for the person. The same
 * name again (case and punctuation folded) is the next VERSION of that theme —
 * the earlier versions are kept in `report_theme_versions`; a project that
 * applied an earlier version keeps it until someone applies the new one.
 */
export async function saveTheme(db: Db, p: { scope: "org" | "user"; name: string; theme: ThemeSpec; customerId: string | null; userId: string | null }): Promise<{ ok: true; theme: SavedTheme; created: boolean } | Fail> {
  const name = p.name.replace(/\s+/g, " ").trim().slice(0, 80);
  const key = themeNameKey(name);
  if (!key) return fail(400, "A theme needs a name.", "theme_name_required");
  if (p.scope === "org" && !p.customerId) return fail(400, "Your account has no organisation to save a theme to — save it for yourself instead.", "theme_no_org");
  if (p.scope === "user" && !p.userId) return fail(401, "Sign in to save a theme.", "theme_no_user");
  const clean = readThemeSpec({ ...p.theme, name });
  if (!clean) return fail(400, "That is not a theme.", "theme_invalid");
  const { id: _i, version: _v, ...body } = clean; void _i; void _v;
  let q = db.from("report_themes").select("*").eq("scope", p.scope).eq("name_key", key).is("deleted_at", null);
  q = p.scope === "org" ? q.eq("customer_id", p.customerId) : q.eq("owner_id", p.userId);
  const { data: existing, error: e1 } = await q.maybeSingle();
  if (e1) return fail(missing(e1) ? 501 : 500, missing(e1) ? UNAVAILABLE : e1.message, missing(e1) ? "themes_unavailable" : "theme_save_failed");
  if (existing) {
    const version = Number(existing.version) + 1;
    const { error: ev } = await db.from("report_theme_versions").insert({ theme_id: existing.id, version, theme: body, created_by: p.userId });
    if (ev) return fail(500, ev.message, "theme_save_failed");
    const { data: row, error: eu } = await db.from("report_themes").update({ version, theme: { ...body, name: existing.name }, description: clean.description ?? null, updated_by: p.userId }).eq("id", existing.id).select("*").single();
    if (eu || !row) return fail(500, eu?.message ?? "no row", "theme_save_failed");
    return { ok: true, theme: fromRow(row)!, created: false };
  }
  const { data: row, error: ei } = await db.from("report_themes").insert({ scope: p.scope, customer_id: p.customerId, owner_id: p.scope === "user" ? p.userId : null, name, name_key: key, version: 1, theme: body, description: clean.description ?? null, created_by: p.userId, updated_by: p.userId }).select("*").single();
  if (ei || !row) {
    if (ei?.code === "23505") return saveTheme(db, p); /* saved under the same name a moment ago: this becomes its next version */
    return fail(missing(ei) ? 501 : 500, missing(ei) ? UNAVAILABLE : ei?.message ?? "no row", missing(ei) ? "themes_unavailable" : "theme_save_failed");
  }
  await db.from("report_theme_versions").insert({ theme_id: row.id, version: 1, theme: body, created_by: p.userId });
  return { ok: true, theme: fromRow(row)!, created: true };
}

export interface Selection { theme: ThemeSpec | null; ref: string | null; version: number | null; structure: StructureRequest | null; appliedAt: string | null; appliedBy: string | null }

export function readStructure(x: unknown): StructureRequest | null {
  const o = (x ?? null) as { order?: unknown; understood?: unknown; sections?: unknown } | null;
  if (!o) return null;
  const order = (Array.isArray(o.order) ? o.order : []).filter((k): k is StructureSection => typeof k === "string" && (STRUCTURE_SECTIONS as readonly string[]).includes(k));
  /* #18: an explicit section order per document family (drag and drop / keyboard in the Research tab) */
  const sections = readSectionOrders(o.sections);
  if (!order.length && !sections) return null;
  return {
    order: [...new Set(order)],
    understood: typeof o.understood === "string" ? o.understood.slice(0, 200) : order.length ? `sections reorganised around ${order.join(", ")}` : "section order set in the Research tab",
    ...(sections ? { sections } : {}),
  };
}

export async function loadSelection(db: Db, surveyId: string): Promise<Selection | null> {
  const { data, error } = await db.from("report_theme_selections").select("*").eq("survey_id", surveyId).maybeSingle();
  if (error || !data) return null;
  return { theme: readThemeSpec(data.theme), ref: (data.theme_ref as string | null) ?? null, version: (data.theme_version as number | null) ?? null, structure: readStructure(data.structure), appliedAt: (data.applied_at as string | null) ?? null, appliedBy: (data.applied_by as string | null) ?? null };
}

/** apply a theme (and/or a structure) to a project's documents; `theme: null` with `keepTheme` false clears it */
export async function applySelection(db: Db, surveyId: string, p: { theme?: ThemeSpec | null; structure?: StructureRequest | null; keepTheme?: boolean; keepStructure?: boolean; userId: string | null }): Promise<{ ok: true; selection: Selection } | Fail> {
  const cur = await loadSelection(db, surveyId);
  const theme = p.keepTheme ? cur?.theme ?? null : p.theme ?? null;
  const structure = p.keepStructure ? cur?.structure ?? null : p.structure ?? null;
  const row = { survey_id: surveyId, theme_ref: theme?.id ?? null, theme_version: theme?.version ?? null, theme: theme ?? null, structure: structure ?? null, applied_by: p.userId, applied_at: new Date().toISOString() };
  const { data: existing, error: e0 } = await db.from("report_theme_selections").select("survey_id").eq("survey_id", surveyId).maybeSingle();
  if (e0) return fail(missing(e0) ? 501 : 500, missing(e0) ? "Applying a report theme to a project needs migration 0064 on this installation." : e0.message, missing(e0) ? "themes_unavailable" : "theme_apply_failed");
  const { error } = existing ? await db.from("report_theme_selections").update(row).eq("survey_id", surveyId) : await db.from("report_theme_selections").insert(row);
  if (error) return fail(500, error.message, "theme_apply_failed");
  return { ok: true, selection: { theme, ref: row.theme_ref, version: row.theme_version, structure, appliedAt: row.applied_at, appliedBy: p.userId } };
}

/** a theme by its ref (a built-in's id or a saved theme's uuid) or by its name */
export function resolveTheme(refOrName: string, saved: readonly ThemeSpec[]): ThemeSpec | null {
  const byRef = [...saved, ...REPORT_THEMES].find((t) => t.id === refOrName);
  return byRef ?? findReportTheme(refOrName, saved);
}

/** what an artifact's fingerprint records about the look */
export const themeStamp = (t: ThemeSpec | null | undefined) => (t ? { ref: t.id ?? null, version: t.version ?? null, hash: reportThemeHash(t) } : null);

/** the brand assets on file for "use our logo and brand colours": the survey's Branding (its colours and uploaded logo), when it was set */
export function brandOf(def: { branding?: { logoUrl?: string; colors?: { primary?: string; secondary?: string } } } | null | undefined): { colors: string[]; logoUrl: string | null } | null {
  const b = def?.branding;
  if (!b) return null;
  const colors = [b.colors?.primary, b.colors?.secondary].filter((c): c is string => typeof c === "string" && /^#[0-9a-f]{3,6}$/i.test(c));
  /* the schema's defaults are not a brand: #2563eb / #0f172a mean nobody chose colours */
  const chosen = colors.filter((c) => !["#2563eb", "#0f172a"].includes(c.toLowerCase()));
  const logoUrl = typeof b.logoUrl === "string" && b.logoUrl.trim() ? b.logoUrl.trim() : null;
  if (!chosen.length && !logoUrl) return null;
  return { colors: chosen.length ? colors : [], logoUrl };
}
