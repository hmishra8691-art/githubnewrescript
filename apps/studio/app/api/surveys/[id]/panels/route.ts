import { NextRequest, NextResponse } from "next/server";
import { PanelConfig, PANEL_OUTCOMES, type PanelOutcome, type PanelTarget } from "@rescript/schema";
import { panelRedirect, panelReconciliationCsv, panelOutcomeCounts, panelConfigProblems } from "@rescript/engine";
import { attachPanelSession, enterPanel, exitPanel } from "@rescript/analytics";
import { audit, isFailure, requireProjectFor, requireUser } from "@/lib/guard";
import { supabaseService } from "@/lib/authServer";
import { noStore } from "@/lib/notify/access";
import { maskSecretUrl, notifySandbox, panelAad, panelHasher, panelStore, persistSandbox, sandboxPanelState, sealSecret, secretsStatus } from "@/lib/notify/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A STUDY'S PANELS (2026-10-22, G3) — Research Tools → Qualitative → Alerts & panels. The panel settings (presets,
 * end links, signing scheme) are on the definition (`definition.panels`); what is secret or produced is here:
 *
 *   GET                                   per panel: whether a signing secret is set (masked), entries by outcome,
 *                                         the latest entries (panel id, link, outcome, when); problems in the settings
 *   GET ?export=reconciliation            the CSV a panel asks for: panel ids by outcome (formula-safe)
 *   POST { action: "secret", key, secret }   store a panel's signing secret, SEALED (INTEGRATIONS_SECRET_KEY) — never
 *                                         returned; { action: "clear-secret", key }
 *   POST { action: "test-link", key, outcome, pid? }   the end link a participant would get, signed with the stored
 *                                         secret — nothing recorded (the "test links" of the tab)
 *   THE SANDBOX only (no database, fake provider): { action: "sync", panels } — the definition lives in the browser;
 *   and { role: "runtime", op: enter | exit | attach } — the respondent runtime's panel calls, forwarded server to
 *   server as it forwards group-session participants
 *
 * Reading: the project's responses.read (entries are panel ids); changing secrets: deploy.manage (shipping links).
 */
type Body = Record<string, unknown>;
const KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const sandbox = params.id === "sandbox" && notifySandbox();
  if (!sandbox) {
    if (isFailure(authed)) return authed.response;
    const gate = await requireProjectFor(authed, params.id, "responses.read");
    if (isFailure(gate)) return gate.response;
  }
  const store = panelStore();
  const [panels, entries] = await Promise.all([store.panels(params.id).catch(() => []), store.list(params.id, 5000).catch(() => [])]);
  if (req.nextUrl.searchParams.get("export") === "reconciliation") {
    const live = req.nextUrl.searchParams.get("include") === "test" ? entries : entries.filter((e) => !e.isTest);
    const csv = panelReconciliationCsv(live.map((e) => ({ panel: e.panelKey, pid: e.pid, outcome: e.outcome, status: e.status ?? "", target: e.target, startedAt: e.startedAt, endedAt: e.endedAt, isTest: e.isTest })));
    return new NextResponse(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="panel-reconciliation-${params.id.slice(0, 8)}.csv"`, "cache-control": "no-store" } });
  }
  const secrets = await secretInfo(params.id, panels.map((p) => p.key), sandbox);
  return noStore({
    ok: true, sandbox, secretsReady: secretsStatus().ready,
    panels: panels.map((p) => {
      const mine = entries.filter((e) => e.panelKey === p.key && !e.isTest);
      return { key: p.key, label: p.label, preset: p.preset, signing: p.signing.algorithm, secret: secrets[p.key] ?? null, problems: panelConfigProblems(PanelConfig.parse(p)), counts: panelOutcomeCounts(mine.map((e) => ({ panel: e.panelKey, pid: e.pid, outcome: e.outcome, target: e.target }))), completesTarget: p.completesTarget ?? null };
    }),
    entries: entries.slice(0, 200).map((e) => ({ id: e.id, panel: e.panelKey, pid: e.pid, target: e.target, outcome: e.outcome, status: e.status, signed: e.signed, test: e.isTest, startedAt: e.startedAt, endedAt: e.endedAt, session: e.sessionRef ? e.sessionRef.slice(0, 12) : null })),
  });
}

async function secretInfo(surveyId: string, keys: string[], sandbox: boolean): Promise<Record<string, { set: boolean; hint: string | null }>> {
  const out: Record<string, { set: boolean; hint: string | null }> = {};
  if (sandbox) { const st = sandboxPanelState(); for (const k of keys) out[k] = { set: !!st.secrets[`${surveyId}|${k}`], hint: st.secrets[`${surveyId}|${k}`] ? "••••••••" : null }; return out; }
  const { data } = await supabaseService().from("panel_secrets").select("panel_key, hint").eq("survey_id", surveyId);
  for (const k of keys) { const r = (data ?? []).find((x) => x.panel_key === k); out[k] = { set: !!r, hint: (r?.hint as string) ?? null }; }
  return out;
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const authed = await requireUser(req);
  const sandbox = params.id === "sandbox" && notifySandbox();
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body) return isFailure(authed) && !sandbox ? authed.response : noStore({ error: "expected JSON" }, 400);
  let userId: string | null = null, customerId: string | null = null;
  if (!sandbox) {
    if (isFailure(authed)) return authed.response;
    const gate = await requireProjectFor(authed, params.id, "deploy.manage");
    if (isFailure(gate)) return gate.response;
    userId = authed.userId; customerId = authed.customerId;
  }
  const store = panelStore();

  /* ---------------------------------------------------- the sandbox: the runtime's calls and the browser's definition */
  if (sandbox && body.role === "runtime") {
    const sign = { hasher: panelHasher };
    if (body.op === "enter") return noStore(await enterPanel(store, { surveyId: "sandbox", target: String(body.target) as PanelTarget, targetRef: (body.targetRef as string) ?? null, params: (body.params as Record<string, string>) ?? {}, isTest: !!body.isTest }, sign));
    if (body.op === "attach") { await attachPanelSession(store, String(body.entryId), String(body.sessionRef)); return noStore({ ok: true }); }
    if (body.op === "exit") return noStore({ redirect: await exitPanel(store, { entryId: (body.entryId as string) ?? null, sessionRef: (body.sessionRef as string) ?? null, outcome: String(body.outcome) as PanelOutcome, status: (body.status as string) ?? null }, sign) });
    return noStore({ error: "op is enter, attach or exit" }, 400);
  }
  if (body.action === "sync") {
    if (!sandbox) return noStore({ error: "Saved projects read their panels from the saved definition." }, 400);
    const list = Array.isArray(body.panels) ? body.panels.map((p) => PanelConfig.safeParse(p)).filter((r) => r.success).map((r) => r.data!) : [];
    const st = sandboxPanelState();
    st.panels.sandbox = list;
    /* a suite starting clean: the sandbox's entries and secrets too */
    if (body.reset === true) { st.entries = st.entries.filter((e) => e.surveyId !== "sandbox"); for (const k of Object.keys(st.secrets)) if (k.startsWith("sandbox|")) delete st.secrets[k]; }
    persistSandbox();
    return noStore({ ok: true, panels: list.length });
  }

  const key = String(body.key ?? "");
  if (!KEY.test(key)) return noStore({ error: "which panel (its key)" }, 400);
  if (body.action === "secret" || body.action === "clear-secret") {
    const clear = body.action === "clear-secret";
    const secret = String(body.secret ?? "");
    if (!clear && (secret.length < 4 || secret.length > 500)) return noStore({ error: "A signing secret is 4–500 characters (as the panel gave it to you)." }, 400);
    if (!clear) { const st = secretsStatus(); if (!st.ready) return noStore({ error: `${st.reason} A panel's signing secret is never stored unencrypted.`, code: "secrets_not_configured" }, 503); }
    const sealed = clear ? null : sealSecret(secret, panelAad(params.id, key));
    const hint = clear ? null : maskSecretUrl(secret);
    if (sandbox) { const st = sandboxPanelState(); if (sealed) st.secrets[`sandbox|${key}`] = sealed.sealed; else delete st.secrets[`sandbox|${key}`]; persistSandbox(); }
    else {
      const db = supabaseService();
      const { error } = sealed ? await db.from("panel_secrets").upsert({ survey_id: params.id, panel_key: key, secret_sealed: sealed.sealed, secret_key_id: sealed.keyId, hint, updated_by: userId, updated_at: new Date().toISOString() }) : await db.from("panel_secrets").delete().eq("survey_id", params.id).eq("panel_key", key);
      if (error) return noStore({ error: /panel_secrets|does not exist|schema cache/i.test(error.message) ? "Panel secrets need migration 0072." : error.message }, /panel_secrets|does not exist|schema cache/i.test(error.message) ? 503 : 500);
      await audit({ action: "panel.secret_changed", userId, customerId, surveyId: params.id, entity: "panel", entityId: params.id, detail: { panel: key, cleared: clear } }).catch(() => {});
    }
    return noStore({ ok: true, secret: clear ? null : { set: true, hint } });
  }
  if (body.action === "test-link") {
    const panel = (await store.panels(params.id)).map((p) => PanelConfig.safeParse(p)).find((r) => r.success && r.data.key === key)?.data;
    if (!panel) return noStore({ error: `There is no panel “${key}” on the saved study.` }, 404);
    const outcome = String(body.outcome ?? "complete") as PanelOutcome;
    if (!(PANEL_OUTCOMES as readonly string[]).includes(outcome)) return noStore({ error: `outcome is ${PANEL_OUTCOMES.join(", ")}` }, 400);
    const secret = panel.signing.algorithm !== "none" ? await store.secret(params.id, key) : null;
    const r = panelRedirect(panel, outcome, { pid: String(body.pid ?? "TEST_PID").slice(0, 128), captured: Object.fromEntries(panel.params.map((p) => [p.as || p.param, `TEST_${p.param}`])) }, { secret, hasher: panelHasher });
    return noStore({ ok: true, ...r });
  }
  return noStore({ error: "action is secret, clear-secret or test-link" }, 400);
}
