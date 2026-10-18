import { REPORT_THEMES, interpretThemeRequest, describeReportTheme, type ThemeReading, type ThemeSpec } from "@rescript/analytics";
import type { ThemeRequest } from "@rescript/engine";
import { brandOf } from "../reportThemesStore.ts";
import { sandboxTheme, setSandboxTheme, sandboxSaveTheme } from "../artifacts/sandboxStore.ts";

/**
 * A REPORT THEME TURN IN THE COPILOT (2026-10-18). The engine classified the
 * sentence (`kind: "theme"`); this reads it into a theme and a preview — the
 * project's route for a saved project (which may, when asked, put the leftover
 * words to a model), the same deterministic reader in the page for the sandbox
 * — and, on the researcher's approval, applies it or saves it under a name.
 * Nothing changes until Apply: the card is a preview.
 *
 * The sandbox keeps its theme in the tab (sessionStorage, sandbox only).
 */
export interface ThemeCard {
  op: ThemeRequest["op"];
  status: "preview" | "applied" | "saved" | "listed" | "asked" | "failed";
  reading: ThemeReading | null;
  /** list: the themes there are */
  themes?: { name: string; description?: string; kind: "built-in" | "organisation" | "yours" | "this tab"; version?: number }[];
  appliedName?: string;
  savedAs?: { name: string; version: number; scope: "user" | "org" | "tab" };
  model?: { status: string; detail?: string };
  canApply?: boolean; canSaveOrg?: boolean;
  error?: string;
}
export interface ThemeTurnCtx { surveyId: string; def: unknown; store: Storage | null; fetcher?: typeof fetch }
const sandboxOf = (c: ThemeTurnCtx) => c.surveyId === "sandbox";
type Res = { card: ThemeCard; said: string };

const listSaid = (themes: NonNullable<ThemeCard["themes"]>) => `Report themes: ${themes.map((t) => `${t.name} (${t.kind}${t.version && t.kind !== "built-in" ? `, v${t.version}` : ""})`).join("; ")}. Say “apply the <name> theme”, or describe a look.`;

/** what the card says about a reading */
export function readingSaid(r: ThemeReading): string {
  const u = r.understood.length ? ` Understood: ${r.understood.join("; ")}.` : "";
  const adj = r.adjustments.length ? ` Adjusted for legibility: ${r.adjustments.map((a) => `${a.token} → ${a.to}`).join(", ")}.` : "";
  switch (r.intent) {
    case "apply_named": return `Preview of the ${r.preview!.name} theme: ${describeReportTheme(r.preview!)}. Apply it to style the documents and decks — their content does not change.${adj}`;
    case "modify": case "create": return `Preview${r.proposedName ? ` of “${r.proposedName}”` : ""}: ${describeReportTheme(r.preview!)}.${u}${adj} Apply it, or save it under a name; the documents' words and numbers stay exactly as they are.`;
    case "structure": return `${r.structure!.understood[0].toUpperCase()}${r.structure!.understood.slice(1)} — the findings report's sections are reordered, nothing is added, removed or reworded. Apply to use this order.`;
    case "save_as": return r.preview ? `Save the current theme (${r.preview.name}) as “${r.saveAs}”?` : `There is no theme applied yet to save as “${r.saveAs}” — apply or describe one first.`;
    case "unknown_name": return r.question!;
    default: return r.question ?? "No look could be read from this. Name colours by role (navy headings, cyan accents, white backgrounds), fonts, tables (striped, minimal), spacing — or a theme: Executive Research, Healthcare Analytics, Brand Performance, Consumer Insights, Academic Research.";
  }
}

export async function themeTurn(text: string, req: ThemeRequest, c: ThemeTurnCtx): Promise<Res> {
  const f = c.fetcher ?? fetch;
  if (sandboxOf(c)) {
    const st = sandboxTheme(c.store);
    if (req.op === "list") {
      const themes: NonNullable<ThemeCard["themes"]> = [...REPORT_THEMES.map((t) => ({ name: t.name, description: t.description, kind: "built-in" as const })), ...st.saved.map((t) => ({ name: t.name, kind: "this tab" as const, version: t.version }))];
      return { card: { op: "list", status: "listed", reading: null, themes }, said: listSaid(themes) };
    }
    const reading = interpretThemeRequest(text, { current: st.theme, saved: st.saved, brand: brandOf(c.def as never) });
    return { card: { op: req.op, status: reading.intent === "unknown_name" || reading.intent === "none" ? "asked" : "preview", reading, canApply: true, canSaveOrg: false }, said: readingSaid(reading) };
  }
  try {
    if (req.op === "list") {
      const r = await f(`/api/surveys/${c.surveyId}/report-themes`, { cache: "no-store" });
      const d = await r.json().catch(() => null) as { builtins?: ThemeSpec[]; saved?: (ThemeSpec & { scope: "org" | "user" })[]; error?: string } | null;
      if (!r.ok || !d) return { card: { op: "list", status: "failed", reading: null, error: d?.error ?? `HTTP ${r.status}` }, said: d?.error ?? `The themes could not be listed (HTTP ${r.status}).` };
      const themes: NonNullable<ThemeCard["themes"]> = [...(d.builtins ?? []).map((t) => ({ name: t.name, description: t.description, kind: "built-in" as const })), ...(d.saved ?? []).map((t) => ({ name: t.name, kind: t.scope === "user" ? "yours" as const : "organisation" as const, version: t.version }))];
      return { card: { op: "list", status: "listed", reading: null, themes }, said: listSaid(themes) };
    }
    const r = await f(`/api/surveys/${c.surveyId}/report-themes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "preview", text }) });
    const d = await r.json().catch(() => null) as { reading?: ThemeReading; model?: ThemeCard["model"]; error?: string } | null;
    if (!r.ok || !d?.reading) return { card: { op: req.op, status: "failed", reading: null, error: d?.error ?? `HTTP ${r.status}` }, said: d?.error ?? (r.status === 401 ? "Sign in to change the report theme." : `The theme could not be read (HTTP ${r.status}).`) };
    const access = await f(`/api/surveys/${c.surveyId}/report-themes`, { cache: "no-store" }).then((x) => x.json()).catch(() => null) as { can?: { apply?: boolean; saveOrg?: boolean } } | null;
    return { card: { op: req.op, status: d.reading.intent === "unknown_name" || d.reading.intent === "none" ? "asked" : "preview", reading: d.reading, ...(d.model ? { model: d.model } : {}), canApply: access?.can?.apply !== false, canSaveOrg: !!access?.can?.saveOrg }, said: readingSaid(d.reading) };
  } catch (e) {
    return { card: { op: req.op, status: "failed", reading: null, error: (e as Error).message }, said: `The theme could not be read: ${(e as Error).message || "the network request failed"}.` };
  }
}

/** ask the model for the words the reader could not place (a saved project, on request only) */
export async function themeWithModel(text: string, card: ThemeCard, c: ThemeTurnCtx): Promise<Res> {
  if (sandboxOf(c)) return { card: { ...card, model: { status: "unavailable", detail: "The sandbox reads themes without a model." } }, said: "The sandbox reads themes without a model — describe the look with colours, fonts, tables and spacing." };
  const f = c.fetcher ?? fetch;
  const r = await f(`/api/surveys/${c.surveyId}/report-themes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "preview", text, useModel: true }) });
  const d = await r.json().catch(() => null) as { reading?: ThemeReading; model?: ThemeCard["model"]; error?: string } | null;
  if (!r.ok || !d?.reading) return { card: { ...card, status: "failed", error: d?.error ?? `HTTP ${r.status}` }, said: d?.error ?? `The theme could not be read (HTTP ${r.status}).` };
  return { card: { ...card, reading: d.reading, status: d.reading.preview ? "preview" : "asked", ...(d.model ? { model: d.model } : {}) }, said: d.model?.status === "used" ? readingSaid(d.reading) : `${d.model?.detail ?? "The model was not used."} ${readingSaid(d.reading)}` };
}

/** Apply: the previewed theme (or the structure request) becomes the project's — every document's NEXT version uses it */
export async function applyThemeTurn(card: ThemeCard, c: ThemeTurnCtx): Promise<Res> {
  const r0 = card.reading;
  if (!r0) return { card, said: "Nothing to apply." };
  const structureOnly = r0.intent === "structure";
  if (sandboxOf(c)) {
    if (structureOnly) setSandboxTheme(c.store, { structure: r0.structure ?? null });
    else setSandboxTheme(c.store, { theme: r0.preview });
    return { card: { ...card, status: "applied", appliedName: structureOnly ? undefined : r0.preview?.name }, said: structureOnly ? "Applied: the findings report's next version uses this section order." : `Applied the ${r0.preview?.name} theme. The documents made from now on use it; the ones already made say “a new version is available”.` };
  }
  const f = c.fetcher ?? fetch;
  const body = structureOnly ? { op: "apply", structure: r0.structure } : r0.intent === "apply_named" && r0.named?.id ? { op: "apply", ref: r0.named.id } : { op: "apply", theme: r0.preview };
  const r = await f(`/api/surveys/${c.surveyId}/report-themes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => null) as { error?: string } | null;
  if (!r.ok) return { card: { ...card, error: d?.error ?? `HTTP ${r.status}` }, said: d?.error ?? (r.status === 403 ? "Applying a report theme needs Data Analytics & Reports: Edit on this project." : `The theme could not be applied (HTTP ${r.status}).`) };
  return { card: { ...card, status: "applied", error: undefined, appliedName: structureOnly ? undefined : r0.preview?.name }, said: structureOnly ? "Applied: the findings report's next version uses this section order." : `Applied the ${r0.preview?.name} theme to this project's documents. Documents made from now on use it; the ones already made say “a new version is available”.` };
}

/** Save as: a named theme (yours, or the organisation's), its next version if the name exists — and applied */
export async function saveThemeTurn(card: ThemeCard, name: string, scope: "user" | "org", c: ThemeTurnCtx): Promise<Res> {
  const theme = card.reading?.preview;
  if (!theme || !name.trim()) return { card, said: "Name the theme to save it." };
  if (sandboxOf(c)) {
    const saved = sandboxSaveTheme(c.store, theme, name);
    setSandboxTheme(c.store, { theme: saved });
    return { card: { ...card, status: "saved", savedAs: { name: saved.name, version: saved.version ?? 1, scope: "tab" }, appliedName: saved.name }, said: `Saved “${saved.name}” (version ${saved.version}) for this tab and applied it. Say “apply the ${saved.name} theme” to use it again.` };
  }
  const f = c.fetcher ?? fetch;
  const r = await f(`/api/surveys/${c.surveyId}/report-themes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "save", name: name.trim(), theme: { ...theme, name: name.trim() }, scope, apply: true }) });
  const d = await r.json().catch(() => null) as { theme?: ThemeSpec; error?: string } | null;
  if (!r.ok || !d?.theme) return { card: { ...card, error: d?.error ?? `HTTP ${r.status}` }, said: d?.error ?? `The theme could not be saved (HTTP ${r.status}).` };
  return { card: { ...card, status: "saved", error: undefined, savedAs: { name: d.theme.name, version: d.theme.version ?? 1, scope }, appliedName: d.theme.name }, said: `Saved “${d.theme.name}” (version ${d.theme.version ?? 1}) ${scope === "org" ? "for your organisation" : "for you"} and applied it to this project. Say “apply the ${d.theme.name} theme” to use it anywhere.` };
}
