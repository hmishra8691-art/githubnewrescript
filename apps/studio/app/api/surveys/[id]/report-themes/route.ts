import { NextRequest, NextResponse } from "next/server";
import { can } from "@rescript/access";
import { aiProviderName, completeJson } from "@rescript/ai";
import {
  REPORT_THEMES, interpretThemeRequest, enforceTheme, mergeTheme, readThemeSpec, sanitizeThemePatch, describeReportTheme, THEME_PATCH_INSTRUCTIONS,
  DEFAULT_REPORT_THEME, type ThemeSpec,
} from "@rescript/analytics";
import type { SurveyDefinition } from "@rescript/schema";
import { audit, isFailure, requireProject, type ProjectContext } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { loadDefinition } from "@/lib/analytics";
import { aiAllowed } from "@/lib/aiPolicy";
import { aiReadyFor } from "@/lib/byok/connect";
import { getMeter, meteredAi } from "@/lib/metering";
import { savedThemes, saveTheme, loadSelection, applySelection, resolveTheme, readStructure, brandOf } from "@/lib/reportThemesStore";

export const dynamic = "force-dynamic";

/**
 * REPORT THEMES (2026-10-18, docs/ARTIFACTS-AND-REPORT-THEMES-2026-10-18.md) —
 * the look of a project's documents and decks, in words or by name.
 *
 *   GET                                       → { builtins, saved, applied, brand, can }
 *   POST { op: "preview", text, useModel? }   → the reading: intent, preview theme, what was understood,
 *                                               adjustments, structure request — nothing saved
 *   POST { op: "apply", theme | ref, structure? }  apply to this project (Data Analytics & Reports: Edit)
 *   POST { op: "save", name, theme, scope }   save as a named theme: "user" (yours) or "org" (Edit);
 *                                               the same name again is its next version
 *   POST { op: "clear", what: "theme"|"structure" }
 *
 * The reading is deterministic (`interpretThemeRequest`). Only when it placed
 * nothing and the person asks (`useModel`) are the WORDS — the look, never the
 * data — put to a model, through the project's AI switch, the person's
 * connection and the meter; its answer is kept to the theme vocabulary
 * (`sanitizeThemePatch`) and shown as a preview like any other. A theme changes
 * styling only: applying one makes every document's next version look
 * different and read exactly the same.
 */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

async function context(ctx: ProjectContext) {
  const db = supabaseService();
  const saved = await savedThemes(db as never, { customerId: ctx.user.customerId ?? null, userId: ctx.user.userId });
  return { ctx, db, saved };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireProject(req, params.id, "project.read");
  if (isFailure(gate)) return gate.response;
  const c = await context(gate);
  const sel = await loadSelection(c.db as never, params.id);
  const loaded = await loadDefinition(c.db, params.id);
  const brand = !("error" in loaded) ? brandOf(loaded.def as SurveyDefinition) : null;
  return json({
    builtins: REPORT_THEMES, saved: c.saved, applied: sel, brand,
    can: { apply: can(c.ctx.grant, "analytics.edit"), saveOrg: can(c.ctx.grant, "analytics.edit") && !!c.ctx.user.customerId, saveUser: true },
  });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const gate0 = await requireProject(req, params.id, "project.read");
  if (isFailure(gate0)) return gate0.response;
  const c = await context(gate0);
  const { ctx, db, saved } = c;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const op = body.op;

  if (op === "preview") {
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 600) : "";
    if (!text) return json({ error: "Describe the look, or name a theme." }, 400);
    const sel = await loadSelection(db as never, params.id);
    const loaded = await loadDefinition(db, params.id);
    const brand = !("error" in loaded) ? brandOf(loaded.def as SurveyDefinition) : null;
    const reading = interpretThemeRequest(text, { current: sel?.theme ?? null, saved, brand });
    let model: { status: "not_needed" | "not_asked" | "off" | "unavailable" | "used" | "failed"; detail?: string } = { status: reading.needsModel ? "not_asked" : "not_needed" };
    if (reading.needsModel && body.useModel === true) {
      const allowed = await aiAllowed(params.id, "report_design");
      if (!allowed.allowed) model = { status: "off", detail: allowed.message ?? "AI is off for this project." };
      else if (!(await aiReadyFor(ctx.user, params.id, "report_design"))) model = { status: "unavailable", detail: "No AI provider is configured for you or this platform — describe the look with colours, fonts, tables and spacing instead." };
      else {
        /* the words and the current look only — no report content, no data */
        const user = `Current theme: ${describeReportTheme(sel?.theme ?? DEFAULT_REPORT_THEME)}\nRequest: ${text}`;
        const fake = aiProviderName() === "fake" && body.fake && typeof body.fake === "object" ? body.fake : null;
        let raw: unknown = fake;
        if (!raw) {
          const { data: s } = await db.from("surveys").select("customer_id").eq("id", params.id).maybeSingle();
          const m = await meteredAi(getMeter(), { customerId: (s?.customer_id as string | null) ?? ctx.user.customerId ?? "", surveyId: params.id, userId: ctx.user.userId, environment: "TEST" }, "AI_REQUEST", { estimateText: THEME_PATCH_INSTRUCTIONS + user, maxTokens: 400, operation: "report_design" }, () => completeJson(THEME_PATCH_INSTRUCTIONS, user, 400, { timeoutMs: 15_000 })).catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : "the model call failed" }));
          if (m.ok) raw = m.value; else model = { status: "failed", detail: m.message };
        }
        if (raw) {
          const patch = sanitizeThemePatch(raw);
          if (Object.keys(patch).length) {
            const { theme, adjustments } = enforceTheme(mergeTheme(sel?.theme ?? DEFAULT_REPORT_THEME, patch));
            reading.patch = patch; reading.preview = { ...theme, name: reading.proposedName ?? "Custom theme", description: text.slice(0, 240) }; delete reading.preview.id; delete reading.preview.version;
            reading.adjustments = adjustments; reading.intent = "create"; reading.needsModel = false; reading.proposedName = reading.preview.name;
            reading.understood = [...reading.understood, `the model read the look as: ${Object.keys(patch).join(", ")}`];
            model = { status: "used" };
          } else if (model.status === "not_asked") model = { status: "failed", detail: "The model's answer had nothing the theme vocabulary can use." };
        }
      }
    }
    return json({ reading, model, applied: sel });
  }

  if (op === "apply") {
    const gate = await requireProject(req, params.id, "analytics.edit");
    if (isFailure(gate)) return gate.response;
    let theme: ThemeSpec | null | undefined;
    if (typeof body.ref === "string" && body.ref) {
      theme = resolveTheme(body.ref, saved);
      if (!theme) return json({ error: `There is no report theme called “${body.ref}”. Describe it and it can be created under that name.`, code: "theme_unknown" }, 404);
    } else if (body.theme !== undefined) {
      theme = body.theme === null ? null : readThemeSpec(body.theme);
      if (body.theme !== null && !theme) return json({ error: "That is not a theme." }, 400);
    }
    const structure = body.structure === undefined ? undefined : readStructure(body.structure);
    const r = await applySelection(db as never, params.id, { theme: theme ?? null, structure: structure ?? null, keepTheme: theme === undefined, keepStructure: structure === undefined, userId: ctx.user.userId });
    if (!r.ok) return json({ error: r.error, code: r.code }, r.status);
    /* recorded as a report change: the project's documents will look different from their next version */
    await audit({ action: "analytics.report_modified", userId: gate.user.userId, sessionId: gate.user.sessionId, surveyId: params.id, customerId: gate.user.customerId, entity: "report_theme", entityId: params.id, detail: { reportTheme: r.selection.theme?.name ?? null, ref: r.selection.ref, version: r.selection.version, structure: r.selection.structure?.order ?? null } });
    return json({ applied: r.selection });
  }

  if (op === "save") {
    const scope = body.scope === "org" ? "org" : "user";
    if (scope === "org") { const gate = await requireProject(req, params.id, "analytics.edit"); if (isFailure(gate)) return gate.response; }
    const theme = readThemeSpec(body.theme);
    const name = typeof body.name === "string" ? body.name : theme?.name ?? "";
    if (!theme) return json({ error: "That is not a theme." }, 400);
    const r = await saveTheme(db as never, { scope, name, theme, customerId: ctx.user.customerId ?? null, userId: ctx.user.userId });
    if (!r.ok) return json({ error: r.error, code: r.code }, r.status);
    /* "save as … and use it": applying the saved version keeps its ref and version on the project */
    if (body.apply === true && can(ctx.grant, "analytics.edit")) await applySelection(db as never, params.id, { theme: r.theme, keepStructure: true, userId: ctx.user.userId });
    return json({ theme: r.theme, created: r.created, applied: body.apply === true ? await loadSelection(db as never, params.id) : undefined }, r.created ? 201 : 200);
  }

  if (op === "clear") {
    const gate = await requireProject(req, params.id, "analytics.edit");
    if (isFailure(gate)) return gate.response;
    const r = await applySelection(db as never, params.id, body.what === "structure" ? { structure: null, keepTheme: true, userId: ctx.user.userId } : { theme: null, keepStructure: true, userId: ctx.user.userId });
    if (!r.ok) return json({ error: r.error, code: r.code }, r.status);
    return json({ applied: r.selection });
  }
  return json({ error: "op must be preview, apply, save or clear" }, 400);
}
