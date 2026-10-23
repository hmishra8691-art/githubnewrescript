import type { AlertChannelRef, AlertRule, AlertSettings, FlowNode, PanelConfig, PanelOutcome, PanelPresetId, PanelSigning, PanelTarget, SurveyDefinition } from "@rescript/schema";
import { AlertSettings as AlertSettingsSchema, PanelConfig as PanelConfigSchema, PANEL_OUTCOMES, PANEL_TARGETS, PANEL_SIGNING_ALGORITHMS } from "@rescript/schema";
import { PANEL_PRESETS, PANEL_OUTCOME_LABELS, panelConfigProblems, panelFromPreset } from "./panels.js";
import { NOTIFY_EVENTS, NOTIFY_EVENT_TYPES, CHANNEL_KIND_LABELS } from "./notifyEvents.js";

/**
 * PANELS AND ALERTS AS INTELLIGENT-MODE ACTIONS (2026-10-22, engineer G3).
 *
 *   connect_panel     "connect this study to Prolific with completion code ABC123" → a panel config on
 *                     `def.panels` from the preset (links, parameters, codes, signing scheme), patched by key.
 *                     When the survey link is a target, the panel's id and kept parameters are captured as
 *                     URL embedded data and the survey's ends that have NO redirect get the panel's unsigned end
 *                     link (a signing panel's survey ends are left alone: the signed exit is set from the Panels tab).
 *   disconnect_panel  removes one (destructive: it is confirmed)
 *   configure_alerts  "send distress alerts to #research-ops on Slack and to me by email" → a rule on
 *                     `def.alerts`: events → channels (Slack / Teams / webhook BY NAME, e-mail "@me" / "@team" /
 *                     an address, in-app), digest, quiet hours, the hourly cap
 *
 * SECRETS NEVER COME THROUGH HERE. A webhook URL or a signing secret in the request is refused, with where to
 * put it instead (Settings → Alerts, the Panels tab): the model's input and output are logged, and a definition
 * is exported and cloned. Writes `def.panels` / `def.alerts` (and, for the survey link, embedded data and empty
 * end redirects) and nothing else; deterministic, so the server's preview is the browser's replay. It never
 * starts anything — links go live from their own tabs.
 */

export const INTEGRATION_ACTION_OPS = ["connect_panel", "disconnect_panel", "configure_alerts"] as const;
export const isIntegrationOp = (op: string): boolean => (INTEGRATION_ACTION_OPS as readonly string[]).includes(op);

export interface ConnectPanelAction {
  op: "connect_panel";
  preset: PanelPresetId;
  key?: string;
  label?: string;
  completionCode?: string;
  codes?: Partial<Record<PanelOutcome, string>>;
  redirects?: Partial<Record<PanelOutcome, string>>;
  idParam?: string;
  params?: string[];
  signing?: Partial<PanelSigning>;
  targets?: PanelTarget[];
  completesTarget?: number | null;
  dedupe?: boolean;
  showCode?: boolean;
  enabled?: boolean;
}
export interface DisconnectPanelAction { op: "disconnect_panel"; key: string }
export interface ConfigureAlertsAction {
  op: "configure_alerts";
  events?: string[];
  channels?: AlertChannelRef[];
  digest?: "immediate" | "hourly" | "daily";
  quietHours?: { start: string; end: string; timeZone?: string; bypassCritical?: boolean } | null;
  maxPerHour?: number;
  dedupeMinutes?: number;
  /** drop the study's existing rules first */
  replace?: boolean;
  /** remove the rules for these events (or every rule, with no events) */
  remove?: boolean;
}
export type IntegrationAction = ConnectPanelAction | DisconnectPanelAction | ConfigureAlertsAction;

const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : undefined);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown, max = 20): string[] => (Array.isArray(v) ? v.map((x) => str(x, 200)).filter((x): x is string => !!x).slice(0, max) : typeof v === "string" && v.trim() ? v.split(/\s*,\s*|\s+and\s+|\s*&\s*/).map((x) => x.trim()).filter(Boolean).slice(0, max) : []);

/** "Prolific" / "Lucid" / "Pure Spectrum" / "Mechanical Turk" → a preset id */
export function panelPresetOf(v: unknown): PanelPresetId | null {
  const t = String(v ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!t) return null;
  if (/prolific/.test(t)) return "prolific";
  if (/^(cint|lucid|lucidmarketplace|cintlucid|lucidcint|cintexchange)/.test(t)) return "cint";
  if (/purespectrum|spectrum/.test(t)) return "purespectrum";
  if (/dynata|ssi|researchnow|samplify/.test(t)) return "dynata";
  if (/toluna/.test(t)) return "toluna";
  if (/cloudresearch|connect|primepanels/.test(t)) return "cloudresearch";
  if (/mturk|mechanicalturk|amazonturk|turk/.test(t)) return "mturk";
  if (/custom|other|own|generic/.test(t)) return "custom";
  return null;
}
const targetOf = (v: string): PanelTarget | null => {
  const t = v.toLowerCase();
  if (/ai.?interview|interview|\/i\b/.test(t)) return "ai_interview";
  if (/group/.test(t)) return "group_session";
  if (/live/.test(t)) return "live_session";
  if (/survey|questionnaire/.test(t)) return "survey";
  return (PANEL_TARGETS as readonly string[]).includes(t) ? (t as PanelTarget) : null;
};
const outcomeOf = (k: string): PanelOutcome | null => {
  const t = k.toLowerCase().replace(/[^a-z]/g, "");
  if (/^(complete|completed|completion|success)$/.test(t)) return "complete";
  if (/^(screenout|screenedout|screened|screen|disqualified|dq)$/.test(t)) return "screenout";
  if (/^(quotafull|quota|full)$/.test(t)) return "quota_full";
  if (/^(terminate|terminated|term|quality|qualityterm|fraud)$/.test(t)) return "terminate";
  if (/^(overquota|over)$/.test(t)) return "over_quota";
  return null;
};
const SECRETISH = /hooks\.slack\.com|webhook\.office\.com|logic\.azure\.com|\/webhook|https?:\/\//i;

function outcomeMap(v: unknown, what: string, max: number): Partial<Record<PanelOutcome, string>> | string | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const out: Partial<Record<PanelOutcome, string>> = {};
  for (const [k, x] of Object.entries(o)) {
    const oc = outcomeOf(k);
    if (!oc) return `${what}: “${k}” is not an outcome (${PANEL_OUTCOMES.join(", ")})`;
    const s = str(x, max);
    if (s) out[oc] = s;
  }
  return out;
}

function connectIn(o: Record<string, unknown>): ConnectPanelAction | string {
  const op = "connect_panel";
  if (o.secret !== undefined || o.signingSecret !== undefined || o.hashKey !== undefined || obj(o.signing)?.secret !== undefined) return `${op}: a signing secret is never set through chat — paste it in Research Tools → Qualitative → Alerts & panels (it is stored encrypted)`;
  const preset = panelPresetOf(o.preset ?? o.panel ?? o.provider ?? o.name ?? o.key);
  if (!preset) return `${op}: which panel — ${Object.values(PANEL_PRESETS).map((p) => p.label).join(", ")}`;
  const a: ConnectPanelAction = { op, preset };
  const key = str(o.key, 32)?.toLowerCase();
  if (key) { if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key)) return `${op}: key is lowercase letters, digits, - and _`; a.key = key; }
  const label = str(o.label, 80); if (label) a.label = label;
  const code = str(o.completionCode ?? o.completion_code ?? o.code, 80); if (code) { if (!/^[A-Za-z0-9_-]{1,80}$/.test(code)) return `${op}: a completion code is letters and digits`; a.completionCode = code; }
  const codes = outcomeMap(o.codes, "codes", 80); if (typeof codes === "string") return `${op}: ${codes}`; if (codes) a.codes = codes;
  const redirects = outcomeMap(o.redirects ?? o.endLinks, "redirects", 2000); if (typeof redirects === "string") return `${op}: ${redirects}`;
  if (redirects) { for (const [k, u] of Object.entries(redirects)) if (!/^https:\/\//i.test(u!)) return `${op}: the ${k} link must be an https address`; a.redirects = redirects; }
  const idp = str(o.idParam ?? o.idParameter, 60); if (idp) { if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/.test(idp)) return `${op}: idParam is a URL parameter name`; a.idParam = idp; }
  const params = list(o.params ?? o.keep, 10); if (params.length) { if (params.some((p) => !/^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/.test(p))) return `${op}: params are URL parameter names`; a.params = params; }
  const sg = obj(o.signing);
  const algRaw = str(sg?.algorithm ?? o.hashing ?? o.signature, 20)?.toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (sg || algRaw) {
    const alg = !algRaw ? undefined : algRaw === "hmacsha256" ? "hmac-sha256" : algRaw === "hmacsha1" ? "hmac-sha1" : algRaw === "sha-256" ? "sha256" : algRaw === "sha-1" ? "sha1" : algRaw === "off" || algRaw === "no" ? "none" : algRaw;
    if (alg && !(PANEL_SIGNING_ALGORITHMS as readonly string[]).includes(alg)) return `${op}: signing algorithm is ${PANEL_SIGNING_ALGORITHMS.join(", ")}`;
    const scope = str(sg?.scope, 10);
    const enc = str(sg?.encoding, 10);
    a.signing = { ...(alg ? { algorithm: alg as PanelSigning["algorithm"] } : {}), ...(str(sg?.param, 40) ? { param: str(sg?.param, 40) } : {}), ...(scope === "url" || scope === "query" || scope === "params" ? { scope } : {}), ...(enc === "hex" || enc === "base64" || enc === "base64url" ? { encoding: enc } : {}), ...(list(sg?.params, 10).length ? { params: list(sg?.params, 10) } : {}) };
  }
  const targets = list(o.targets ?? o.for ?? o.links, 4);
  if (targets.length) { const ts = targets.map(targetOf); if (ts.some((t) => !t)) return `${op}: targets are AI interviews, group sessions, live sessions, survey`; a.targets = [...new Set(ts as PanelTarget[])]; }
  const ct = o.completesTarget ?? o.completes ?? o.quota;
  if (ct === null) a.completesTarget = null; else if (ct !== undefined) { const n = Number(ct); if (!Number.isInteger(n) || n < 1) return `${op}: completesTarget is a number of completes`; a.completesTarget = n; }
  for (const k of ["dedupe", "showCode", "enabled"] as const) if (typeof o[k] === "boolean") a[k] = o[k] as boolean;
  return a;
}

/* ------------------------------------------------------------ alerts input */

const EVENT_WORDS: [RegExp, string[]][] = [
  [/^(?:\*|all|everything|any|every event|all events)$/, ["*"]],
  [/distress|self.?harm|suicid|upset|crisis/, ["ai_interview.distress"]],
  [/abuse|abusive|harass/, ["ai_interview.abuse"]],
  [/inject|manipulat|jailbreak/, ["ai_interview.injection"]],
  [/safety|flags?$|flagged/, ["ai_interview.distress", "ai_interview.abuse", "ai_interview.injection", "group_session.flag"]],
  [/complet|finish/, ["ai_interview.completed"]],
  [/quota/, ["ai_interview.quota_full", "survey.quota_full"]],
  [/target|goal|sample size/, ["study.target_reached", "panel.target_reached"]],
  [/cost|budget|spend|cap/, ["study.cost_cap"]],
  [/provider|fallback|outage|model fail/, ["ai.provider_fallback"]],
  [/group/, ["group_session.flag"]],
  [/no.?show|missed|absent/, ["live_session.no_show"]],
  [/milestone|progress|fieldwork/, ["survey.milestone"]],
  [/duplicate/, ["panel.duplicate_entry"]],
];
export function alertEventsOf(words: string[]): string[] | { error: string } {
  const out = new Set<string>();
  for (const w of words) {
    const t = w.toLowerCase().trim();
    if ((NOTIFY_EVENT_TYPES as string[]).includes(t) || /^[a-z_]+\.\*$/.test(t)) { out.add(t); continue; }
    const hit = EVENT_WORDS.find(([re]) => re.test(t));
    if (!hit) return { error: `“${w}” is not an alert event (e.g. distress, abuse, injection, completed, quota full, target reached, cost cap, provider fallback, group flags, no-shows, milestones)` };
    for (const e of hit[1]) out.add(e);
  }
  return [...out];
}

function channelsIn(o: Record<string, unknown>): AlertChannelRef[] | string {
  const out: AlertChannelRef[] = [];
  const person = (v: string) => { const t = v.trim().toLowerCase(); return /^(?:me|myself|i|@me|my email|my e-mail)$/.test(t) ? "@me" : /^(?:team|the team|everyone|@team|project team|all members)$/.test(t) ? "@team" : v.trim(); };
  const add = (kind: AlertChannelRef["kind"], v: string) => {
    if (SECRETISH.test(v)) return `a ${CHANNEL_KIND_LABELS[kind]} webhook address is a secret and is never set through chat — add the channel in Settings → Alerts (it is stored encrypted), then name it here`;
    const to = kind === "email" || kind === "in_app" ? person(v) : v.trim().replace(/^#?/, kind === "slack" ? "#" : "");
    if (kind === "email" && to !== "@me" && to !== "@team" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return `“${v}” is not an e-mail address (or “me” / “the team”)`;
    if (!to) return "a channel needs a name";
    out.push({ kind, to: to.slice(0, 200) });
    return null;
  };
  for (const [k, kind] of [["slack", "slack"], ["teams", "teams"], ["webhook", "webhook"], ["email", "email"], ["emails", "email"], ["inApp", "in_app"], ["in_app", "in_app"]] as const) {
    for (const v of list(o[k], 10)) { const e = add(kind, v); if (e) return e; }
  }
  if (Array.isArray(o.channels)) for (const c of o.channels) {
    const r = obj(c);
    const kind = String(r?.kind ?? r?.type ?? "").toLowerCase().replace(/[^a-z_]/g, "");
    const k = kind === "mail" ? "email" : kind === "inapp" || kind === "bell" ? "in_app" : kind === "msteams" ? "teams" : kind;
    if (!["email", "in_app", "slack", "teams", "webhook"].includes(k)) return `a channel kind is email, in_app, slack, teams or webhook (got “${kind}”)`;
    const e = add(k as AlertChannelRef["kind"], String(r?.to ?? r?.name ?? r?.channel ?? "")); if (e) return e;
  }
  return out;
}

function alertsIn(o: Record<string, unknown>): ConfigureAlertsAction | string {
  const op = "configure_alerts";
  const a: ConfigureAlertsAction = { op };
  const ev = list(o.events ?? o.event ?? o.on, 20);
  if (ev.length) { const e = alertEventsOf(ev); if ("error" in e) return `${op}: ${e.error}`; a.events = e; }
  const ch = channelsIn(o); if (typeof ch === "string") return `${op}: ${ch}`; if (ch.length) a.channels = ch;
  const dg = str(o.digest ?? o.frequency, 12)?.toLowerCase();
  if (dg) { a.digest = /^(?:immediate|instant|now|real.?time)$/.test(dg) ? "immediate" : /^(?:hourly|hour)$/.test(dg) ? "hourly" : /^(?:daily|day)$/.test(dg) ? "daily" : (undefined as never); if (!a.digest) return `${op}: digest is immediate, hourly or daily`; }
  const qh = o.quietHours === null ? null : obj(o.quietHours);
  if (o.quietHours === null) a.quietHours = null;
  else if (qh) { const s = str(qh.start, 5), e = str(qh.end, 5); if (!s || !e || !/^\d{2}:\d{2}$/.test(s) || !/^\d{2}:\d{2}$/.test(e)) return `${op}: quietHours is {start: "22:00", end: "07:00", timeZone?}`; a.quietHours = { start: s, end: e, ...(str(qh.timeZone ?? qh.tz, 60) ? { timeZone: str(qh.timeZone ?? qh.tz, 60) } : {}), ...(typeof qh.bypassCritical === "boolean" ? { bypassCritical: qh.bypassCritical } : {}) }; }
  if (o.maxPerHour !== undefined) { const n = Number(o.maxPerHour); if (!Number.isInteger(n) || n < 1 || n > 500) return `${op}: maxPerHour is 1–500`; a.maxPerHour = n; }
  if (o.dedupeMinutes !== undefined) { const n = Number(o.dedupeMinutes); if (!Number.isInteger(n) || n < 0 || n > 1440) return `${op}: dedupeMinutes is 0–1440`; a.dedupeMinutes = n; }
  if (o.replace === true) a.replace = true;
  if (o.remove === true || o.off === true) a.remove = true;
  if (!a.remove && !a.channels && (a.events || a.digest)) return `${op}: where should the alerts go — Slack / Teams / a webhook by its channel name, e-mail (an address, “me” or “the team”) or in-app`;
  if (!a.remove && a.channels && !a.events) a.events = ["ai_interview.distress"];
  if (Object.keys(a).length === 1) return `${op} names nothing to configure`;
  return a;
}

/** The gate: the model's JSON as a typed action, a reason, or null when the op is not one of these. */
export function coerceIntegrationAction(op: string, o: Record<string, unknown>): IntegrationAction | string | null {
  if (!isIntegrationOp(op)) return null;
  if (op === "connect_panel") return connectIn(o);
  if (op === "disconnect_panel") { const k = str(o.key ?? o.panel ?? o.preset, 40); if (!k) return `${op}: which panel`; return { op, key: k.toLowerCase().trim() }; }
  return alertsIn(o);
}

/* ------------------------------------------------------------ applying */

class IntegrationActionError extends Error {}
const fail = (m: string): never => { throw new IntegrationActionError(m); };

export interface IntegrationApplied { description: string; warnings: string[]; touched: string[]; destructive?: string }

function walkEnds(nodes: FlowNode[], fn: (n: Extract<FlowNode, { type: "end" }>) => void): void {
  for (const n of nodes) {
    if (n.type === "end") fn(n);
    const k = n as { children?: FlowNode[]; branches?: { children: FlowNode[] }[]; otherwise?: FlowNode[] };
    if (k.children) walkEnds(k.children, fn);
    if (k.branches) for (const b of k.branches) walkEnds(b.children, fn);
    if (k.otherwise) walkEnds(k.otherwise, fn);
  }
}
const SURVEY_END: Record<string, PanelOutcome> = { complete: "complete", screened: "screenout", quota_full: "quota_full", terminated: "terminate" };

/** the survey link: capture the panel's parameters as URL embedded data; fill ends that have no redirect (unsigned panels only) */
function wireSurvey(def: SurveyDefinition, p: PanelConfig, changes: string[], warnings: string[]): void {
  const names = [p.idParam, ...p.params.map((x) => x.param)];
  const declared = new Set<string>();
  const walk = (ns: FlowNode[]) => { for (const n of ns) { if (n.type === "embedded_data") for (const f of n.fields) declared.add(f.name); const k = n as { children?: FlowNode[] }; if (k.children) walk(k.children); } };
  walk(def.flow as FlowNode[]);
  const missing = names.filter((n) => !declared.has(n));
  if (missing.length) {
    const id = `ed_panel_${p.key.replace(/[^a-z0-9]/g, "_")}`;
    const existing = (def.flow as FlowNode[]).find((n) => n.id === id);
    if (existing && existing.type === "embedded_data") existing.fields.push(...missing.map((name) => ({ name, source: "url" as const })));
    else (def.flow as FlowNode[]).unshift({ type: "embedded_data", id, title: `${p.label} parameters`, fields: missing.map((name) => ({ name, source: "url" as const })) });
    changes.push(`survey link captures ${missing.join(", ")}`);
  }
  def.deployment = { ...def.deployment, sample: { ...(def.deployment?.sample ?? {}), respondentParam: p.idParam, ...(def.deployment?.sample?.sourceParam ? {} : {}) } } as SurveyDefinition["deployment"];
  if (p.signing.algorithm !== "none") { warnings.push(`${p.label} signs its end links: the survey's ends are not changed here — set them to the signed exit from Alerts & panels (the secret stays on the server).`); return; }
  let filled = 0;
  walkEnds(def.flow as FlowNode[], (n) => {
    if (n.redirectUrl?.trim()) return;
    const oc = SURVEY_END[n.status];
    const t = oc ? p.redirects[oc] ?? (oc === "quota_full" ? p.redirects.screenout : undefined) : undefined;
    if (!t) return;
    const code = p.codes[oc] ?? "";
    if (/\{\{\s*code\s*\}\}/.test(t) && !code) return;
    n.redirectUrl = t.replace(/\{\{\s*pid\s*\}\}/g, `{{ed.${p.idParam}}}`).replace(/\{\{\s*code\s*\}\}/g, encodeURIComponent(code)).replace(/\{\{\s*outcome\s*\}\}/g, oc)
      .replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (m, k: string) => (k.startsWith("ed.") ? m : `{{ed.${p.params.find((x) => x.as === k)?.param ?? k}}}`));
    filled++;
  });
  if (filled) changes.push(`${filled} survey end${filled === 1 ? "" : "s"} redirect${filled === 1 ? "s" : ""} to ${p.label}`);
}

export function applyIntegrationAction(def: SurveyDefinition, a: IntegrationAction): IntegrationApplied {
  if (a.op === "disconnect_panel") {
    const before = def.panels ?? [];
    const hit = before.find((p) => p.key === a.key) ?? before.find((p) => p.preset === panelPresetOf(a.key)) ?? fail(`there is no panel “${a.key}” on this study${before.length ? ` (connected: ${before.map((p) => p.key).join(", ")})` : ""}`);
    def.panels = before.filter((p) => p !== hit);
    if (!def.panels.length) delete def.panels;
    return { description: `Disconnect ${hit.label} (${hit.key})`, warnings: ["Entries already recorded stay in the reconciliation export. Survey ends that redirect to this panel are not changed."], touched: [], destructive: `removes the ${hit.label} panel settings (links already given to the panel will no longer be recognised)` };
  }
  if (a.op === "connect_panel") {
    const key = a.key ?? a.preset;
    const panels = [...(def.panels ?? [])];
    const i = panels.findIndex((p) => p.key === key);
    const cur = i >= 0 ? panels[i] : panelFromPreset(a.preset, { key });
    if (i >= 0 && cur.preset !== a.preset && a.preset !== "custom") fail(`the panel “${key}” is ${cur.label}; give the new one its own key`);
    const changes: string[] = [];
    const next: PanelConfig = JSON.parse(JSON.stringify(cur));
    if (a.label) { next.label = a.label; changes.push(`label “${a.label}”`); }
    if (a.idParam) { next.idParam = a.idParam; changes.push(`id parameter ${a.idParam}`); }
    if (a.params) { next.params = a.params.map((p) => ({ param: p })); changes.push(`keeps ${a.params.join(", ")}`); }
    if (a.completionCode) { next.codes.complete = a.completionCode; changes.push(`completion code ${a.completionCode}`); }
    for (const [k, v] of Object.entries(a.codes ?? {})) { next.codes[k as PanelOutcome] = v; changes.push(`${PANEL_OUTCOME_LABELS[k as PanelOutcome].toLowerCase()} code ${v}`); }
    for (const [k, v] of Object.entries(a.redirects ?? {})) { next.redirects[k as PanelOutcome] = v; changes.push(`${PANEL_OUTCOME_LABELS[k as PanelOutcome].toLowerCase()} link`); }
    if (a.signing) { next.signing = { ...next.signing, ...a.signing }; changes.push(`signing ${next.signing.algorithm}`); }
    if (a.targets) { next.targets = a.targets; changes.push(`for ${a.targets.join(", ")}`); }
    if (a.completesTarget === null) { delete next.completesTarget; changes.push("no completes target"); } else if (a.completesTarget) { next.completesTarget = a.completesTarget; changes.push(`${a.completesTarget} completes`); }
    if (a.dedupe !== undefined) { next.dedupe = a.dedupe; changes.push(a.dedupe ? "one entry per panel id" : "repeat entries allowed"); }
    if (a.showCode !== undefined) { next.showCode = a.showCode; changes.push(a.showCode ? "code shown on the thank-you page" : "code not shown"); }
    if (a.enabled !== undefined) { next.enabled = a.enabled; changes.push(a.enabled ? "on" : "paused"); }
    const parsed = PanelConfigSchema.safeParse(next);
    if (!parsed.success) fail(`the panel settings are not valid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message ?? ""}`);
    const p = parsed.data!;
    if (i >= 0) panels[i] = p; else panels.push(p);
    def.panels = panels;
    const warnings = panelConfigProblems(p).map((x) => `${p.label}: ${x}`);
    if (p.signing.algorithm !== "none") warnings.push(`${p.label} uses ${p.signing.algorithm} signed end links: set the signing secret in Research Tools → Qualitative → Alerts & panels (until then end links go unsigned).`);
    warnings.push(`${PANEL_PRESETS[p.preset].verify}`);
    if (p.targets.includes("survey") && def.flow.some((n) => n.type !== "end")) wireSurvey(def, p, changes, warnings);
    return { description: `${i >= 0 ? "Update" : "Connect"} ${p.label} (${p.key}): ${changes.join("; ") || "the preset's links and parameters"} — entry parameter ${p.idParam}; ${PANEL_OUTCOMES.filter((o) => p.redirects[o]).length} end links${p.showCode ? ", completion code shown" : ""}`, warnings, touched: [] };
  }
  /* configure_alerts */
  const cur: AlertSettings = AlertSettingsSchema.parse(def.alerts ?? {});
  const next: AlertSettings = JSON.parse(JSON.stringify(cur));
  const changes: string[] = [];
  let destructive: string | undefined;
  if (a.replace && next.rules.length) { destructive = `replaces ${next.rules.length} alert rule${next.rules.length === 1 ? "" : "s"}`; next.rules = []; changes.push("previous rules replaced"); }
  if (a.remove) {
    const before = next.rules.length;
    next.rules = a.events ? next.rules.map((r) => ({ ...r, events: r.events.filter((e) => !a.events!.includes(e)) })).filter((r) => r.events.length) : [];
    const n = before - next.rules.length;
    destructive = `removes alerts for ${a.events ? a.events.join(", ") : "every event"}`;
    changes.push(n ? `${n} rule${n === 1 ? "" : "s"} removed` : `stop alerting on ${a.events?.join(", ") ?? "anything"}`);
  } else if (a.channels && a.events) {
    const same = next.rules.find((r) => r.events.length === a.events!.length && r.events.every((e) => a.events!.includes(e)) && (a.digest ?? "immediate") === r.digest);
    if (same) { for (const c of a.channels) if (!same.channels.some((x) => x.kind === c.kind && x.to.toLowerCase() === c.to.toLowerCase())) same.channels.push(c); }
    else { let n = 1; while (next.rules.some((r) => r.id === `r${n}`)) n++; next.rules.push({ id: `r${n}`, events: a.events, channels: a.channels, digest: a.digest ?? "immediate", enabled: true } as AlertRule); }
    changes.push(`${a.events.map((e) => (e === "*" ? "every event" : NOTIFY_EVENTS[e as keyof typeof NOTIFY_EVENTS]?.label.toLowerCase() ?? e)).join(", ")} → ${a.channels.map((c) => `${CHANNEL_KIND_LABELS[c.kind]} ${c.to === "@me" ? "(you)" : c.to === "@team" ? "(the team)" : c.to}`).join(", ")}${a.digest && a.digest !== "immediate" ? ` (${a.digest} digest)` : ""}`);
  }
  if (a.quietHours === null) { delete next.quietHours; changes.push("no quiet hours"); } else if (a.quietHours) { next.quietHours = { bypassCritical: true, ...a.quietHours }; changes.push(`quiet hours ${a.quietHours.start}–${a.quietHours.end}${a.quietHours.timeZone ? ` ${a.quietHours.timeZone}` : " UTC"}`); }
  if (a.maxPerHour) { next.maxPerHour = a.maxPerHour; changes.push(`at most ${a.maxPerHour} an hour per channel`); }
  if (a.dedupeMinutes !== undefined) { next.dedupeMinutes = a.dedupeMinutes; changes.push(`repeats merged within ${a.dedupeMinutes} min`); }
  const parsed = AlertSettingsSchema.safeParse(next);
  if (!parsed.success) fail(`the alert settings are not valid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message ?? ""}`);
  def.alerts = parsed.data!;
  const warnings: string[] = [];
  for (const c of a.channels ?? []) if (c.kind === "slack" || c.kind === "teams" || c.kind === "webhook") warnings.push(`${CHANNEL_KIND_LABELS[c.kind]} “${c.to}” is matched by name to a channel added in Settings → Alerts; until one exists, these alerts are logged as “channel not connected”.`);
  if ((a.channels ?? []).some((c) => c.to === "@me")) warnings.push("“me” is the person who claims the rule in Alerts & panels (until then, the project owner).");
  return { description: `Alerts: ${changes.join("; ") || "no change"}`, warnings, touched: [], ...(destructive ? { destructive } : {}) };
}

export function describeIntegrationAction(a: IntegrationAction): string {
  if (a.op === "connect_panel") return `Connect ${PANEL_PRESETS[a.preset].label}${a.completionCode ? ` (completion code ${a.completionCode})` : ""}`;
  if (a.op === "disconnect_panel") return `Disconnect the panel ${a.key}`;
  return `Configure alerts${a.events ? ` for ${a.events.join(", ")}` : ""}`;
}

/** the review lines for a proposal: panels and alerts in words */
export function panelsWords(panels: PanelConfig[] | undefined): string {
  return (panels ?? []).map((p) => `${p.label} (${p.key}): id ${p.idParam}; ${PANEL_OUTCOMES.filter((o) => p.redirects[o]).map((o) => PANEL_OUTCOME_LABELS[o].toLowerCase()).join(", ") || "no end links"}${p.codes.complete ? `; code ${p.codes.complete}` : ""}${p.signing.algorithm !== "none" ? `; signed ${p.signing.algorithm}` : ""}${p.enabled ? "" : "; paused"}`).join(" | ");
}
export function alertsWords(s: AlertSettings | undefined): string {
  if (!s) return "";
  const rules = s.rules.map((r) => `${r.events.join(", ")} → ${r.channels.map((c) => `${c.kind}:${c.to}`).join(", ")}${r.digest !== "immediate" ? ` (${r.digest})` : ""}${r.enabled ? "" : " (off)"}`);
  return [...rules, s.quietHours ? `quiet ${s.quietHours.start}–${s.quietHours.end}` : "", `≤ ${s.maxPerHour}/h`].filter(Boolean).join(" | ");
}

export function integrationsDiff(before: SurveyDefinition, after: SurveyDefinition): string[] {
  const out: string[] = [];
  const bp = new Map((before.panels ?? []).map((p) => [p.key, JSON.stringify(p)]));
  for (const p of after.panels ?? []) { const was = bp.get(p.key); if (!was) out.push(`Connect the panel ${p.label}`); else if (was !== JSON.stringify(p)) out.push(`Change the panel ${p.label}`); bp.delete(p.key); }
  for (const k of bp.keys()) out.push(`Disconnect the panel ${k}`);
  if (JSON.stringify(before.alerts ?? null) !== JSON.stringify(after.alerts ?? null)) out.push(after.alerts ? `${before.alerts ? "Change" : "Set up"} the study's alerts` : "Remove the study's alert rules");
  return out;
}
