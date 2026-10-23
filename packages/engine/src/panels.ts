import type { PanelConfig, PanelOutcome, PanelPresetId, PanelSigning, PanelTarget } from "@rescript/schema";
import { PanelConfig as PanelConfigSchema, PANEL_OUTCOMES } from "@rescript/schema";

/**
 * PANEL RECRUITMENT — THE PURE HALF (2026-10-22, engineer G3).
 *
 * Most sample providers integrate by REDIRECT: they send a person to the study link with their own id for the
 * person in a URL parameter (`?PROLIFIC_PID=…`, `?RID=…`, `?psid=…`), and expect the person back at one of their
 * end links — complete, screen-out, quota full, terminate / quality, over quota — with the id, sometimes a
 * completion code, sometimes a SIGNATURE that proves the redirect came from the study and not from a participant
 * who typed the complete link by hand. This file is that contract, with no I/O:
 *
 *   PANEL_PRESETS        Prolific, Cint/Lucid, PureSpectrum, Dynata, Toluna, CloudResearch Connect, MTurk-style
 *                        codes, custom — each from the panel's public integration material as known in 2026; every
 *                        preset says "verify with the panel's current docs" because panels change their end links
 *   panelFromPreset      a config from a preset + the study's codes / overrides
 *   panelEntryLink       the link to give the panel, with the panel's own macros for the id and kept parameters
 *   capturePanelEntry    an arrival's URL parameters → which panel, the panel id, the kept parameters (or why not)
 *   panelRedirect        an outcome → the end link: template variables filled (URL-encoded), https enforced,
 *                        SIGNED when the panel uses a signature (HMAC-SHA256 / HMAC-SHA1 / salted SHA-256 / SHA-1,
 *                        over the URL, the query or chosen parameters; hex / base64 / base64url)
 *   verifyPanelSignature the receiving side's check (used by the test links and the docs' example)
 *   outcomeFor*          the platform's statuses → the panel's outcome vocabulary
 *   panelReconciliationCsv  panel ids by outcome, the file a panel asks for when it invoices
 *
 * Hashing is INJECTED (`PanelHasher`): the engine also runs in the browser, and the secret never does — the
 * runtime and the Studio pass node:crypto. Tests pin the signer with the RFC 2202 / RFC 4231 vectors.
 */

export type PanelHashAlgorithm = "hmac-sha256" | "hmac-sha1" | "sha256" | "sha1";
/** raw digest bytes of `data` under `algorithm` (HMAC keyed by `secret`; plain hashes get `data + secret`) */
export type PanelHasher = (algorithm: PanelHashAlgorithm, data: string, secret: string) => Uint8Array;

export const PANEL_OUTCOME_LABELS: Record<PanelOutcome, string> = {
  complete: "Complete", screenout: "Screen-out", quota_full: "Quota full", terminate: "Terminate / quality", over_quota: "Over quota",
};

/* ------------------------------------------------------------ presets */

export interface PanelPreset {
  id: PanelPresetId;
  label: string;
  /** what the panel substitutes into the link we give them, per parameter */
  macros: Record<string, string>;
  /** a sentence for the setup screen */
  how: string;
  /** every preset: the panel's own docs are the authority */
  verify: string;
  /** what the researcher must supply (codes, a secret, an account-specific value) */
  needs: string[];
  base: Omit<PanelConfig, "key" | "label" | "enabled" | "dedupe" | "targets" | "requireId"> & Partial<Pick<PanelConfig, "requireId">>;
}

const VERIFY = "Verify with the panel's current integration docs before fielding: end links, parameter names and hashing change.";
const sign = (s: Partial<PanelSigning>): PanelSigning => ({ algorithm: "none", param: "hash", scope: "url", params: [], separator: "", encoding: "hex", uppercase: false, ...s });

export const PANEL_PRESETS: Record<PanelPresetId, PanelPreset> = {
  prolific: {
    id: "prolific", label: "Prolific",
    macros: { PROLIFIC_PID: "{{%PROLIFIC_PID%}}", STUDY_ID: "{{%STUDY_ID%}}", SESSION_ID: "{{%SESSION_ID%}}" },
    how: "Paste the study link into Prolific with “URL parameters” on; participants return to Prolific with your completion code (a separate code for screen-outs if your study uses them).",
    verify: VERIFY, needs: ["completion code (Prolific → Study → Completion paths)"],
    base: {
      preset: "prolific", idParam: "PROLIFIC_PID", params: [{ param: "STUDY_ID" }, { param: "SESSION_ID" }],
      redirects: { complete: "https://app.prolific.com/submissions/complete?cc={{code}}", screenout: "https://app.prolific.com/submissions/complete?cc={{code}}", quota_full: "https://app.prolific.com/submissions/complete?cc={{code}}", terminate: "https://app.prolific.com/submissions/complete?cc={{code}}", over_quota: "https://app.prolific.com/submissions/complete?cc={{code}}" },
      codes: {}, showCode: true, signing: sign({}),
    },
  },
  cint: {
    id: "cint", label: "Cint / Lucid Marketplace",
    macros: { RID: "[%RID%]" },
    how: "Give Cint the link with RID=[%RID%]. End links return the RID with a status (RIS); Cint can require a hashed end link (HMAC-SHA1 of the URL, base64, appended as &hash=) — set the secret key from your Cint account.",
    verify: VERIFY, needs: ["the hashing secret, if your account enforces hashed end links"],
    base: {
      preset: "cint", idParam: "RID", params: [],
      redirects: {
        complete: "https://samplicio.us/router/ClientCallBack.aspx?RIS=10&RID={{pid}}",
        screenout: "https://samplicio.us/router/ClientCallBack.aspx?RIS=20&RID={{pid}}",
        terminate: "https://samplicio.us/router/ClientCallBack.aspx?RIS=30&RID={{pid}}",
        quota_full: "https://samplicio.us/router/ClientCallBack.aspx?RIS=40&RID={{pid}}",
        over_quota: "https://samplicio.us/router/ClientCallBack.aspx?RIS=40&RID={{pid}}",
      },
      codes: {}, showCode: false, signing: sign({ algorithm: "hmac-sha1", param: "hash", scope: "url", encoding: "base64url" }),
    },
  },
  purespectrum: {
    id: "purespectrum", label: "PureSpectrum",
    macros: { transaction_id: "{{transaction_id}}" },
    how: "PureSpectrum appends transaction_id; end links report the status (st=21 complete, 18 terminate, 17 over quota, 20 quality).",
    verify: VERIFY, needs: ["a hashing key, only if your buyer account uses signed redirects"],
    base: {
      preset: "purespectrum", idParam: "transaction_id", params: [],
      redirects: {
        complete: "https://spectrumsurveys.com/surveydone?st=21&transaction_id={{pid}}",
        screenout: "https://spectrumsurveys.com/surveydone?st=18&transaction_id={{pid}}",
        quota_full: "https://spectrumsurveys.com/surveydone?st=17&transaction_id={{pid}}",
        over_quota: "https://spectrumsurveys.com/surveydone?st=17&transaction_id={{pid}}",
        terminate: "https://spectrumsurveys.com/surveydone?st=20&transaction_id={{pid}}",
      },
      codes: {}, showCode: false, signing: sign({}),
    },
  },
  dynata: {
    id: "dynata", label: "Dynata",
    macros: { psid: "[%psid%]" },
    how: "Dynata passes psid; end links carry rst (1 complete, 2 screen-out, 3 over quota / quota full, 4 quality). Accounts that enforce hashed end links need the algorithm and key from your Dynata project manager.",
    verify: VERIFY, needs: ["the end-link hashing scheme and key, if your project enforces it"],
    base: {
      preset: "dynata", idParam: "psid", params: [],
      redirects: {
        complete: "https://dkr1.ssisurveys.com/projects/end?rst=1&psid={{pid}}",
        screenout: "https://dkr1.ssisurveys.com/projects/end?rst=2&psid={{pid}}",
        quota_full: "https://dkr1.ssisurveys.com/projects/end?rst=3&psid={{pid}}",
        over_quota: "https://dkr1.ssisurveys.com/projects/end?rst=3&psid={{pid}}",
        terminate: "https://dkr1.ssisurveys.com/projects/end?rst=4&psid={{pid}}",
      },
      codes: {}, showCode: false, signing: sign({}),
    },
  },
  toluna: {
    id: "toluna", label: "Toluna",
    macros: { gid: "[GID]", sname: "[SNAME]" },
    how: "Toluna passes the respondent guid (gid) and the survey name (sname); each outcome has its own end page (SOQualified / SOTerminated / SOQuotaFull).",
    verify: VERIFY, needs: ["the end-page host for your Toluna region"],
    base: {
      preset: "toluna", idParam: "gid", params: [{ param: "sname" }],
      redirects: {
        complete: "https://ups.surveyrouter.com/trafficui/mscui/SOQualified.aspx?sname={{sname}}&gid={{pid}}",
        screenout: "https://ups.surveyrouter.com/trafficui/mscui/SOTerminated.aspx?sname={{sname}}&gid={{pid}}",
        terminate: "https://ups.surveyrouter.com/trafficui/mscui/SOTerminated.aspx?sname={{sname}}&gid={{pid}}",
        quota_full: "https://ups.surveyrouter.com/trafficui/mscui/SOQuotaFull.aspx?sname={{sname}}&gid={{pid}}",
        over_quota: "https://ups.surveyrouter.com/trafficui/mscui/SOQuotaFull.aspx?sname={{sname}}&gid={{pid}}",
      },
      codes: {}, showCode: false, signing: sign({}),
    },
  },
  cloudresearch: {
    id: "cloudresearch", label: "CloudResearch Connect",
    macros: { participantId: "{%PARTICIPANT_ID%}", assignmentId: "{%ASSIGNMENT_ID%}", projectId: "{%PROJECT_ID%}" },
    how: "Connect passes participantId, assignmentId and projectId; participants finish by entering your completion code (shown on the thank-you page). Add the redirect your project page gives you, if you use one.",
    verify: VERIFY, needs: ["completion code"],
    base: {
      preset: "cloudresearch", idParam: "participantId", params: [{ param: "assignmentId" }, { param: "projectId" }],
      redirects: {}, codes: {}, showCode: true, signing: sign({}),
    },
  },
  mturk: {
    id: "mturk", label: "MTurk-style completion code",
    macros: { workerId: "${workerId}", assignmentId: "${assignmentId}", hitId: "${hitId}" },
    how: "No redirect: the thank-you page shows a completion code that the worker pastes back into the task.",
    verify: VERIFY, needs: ["completion code"],
    base: {
      preset: "mturk", idParam: "workerId", params: [{ param: "assignmentId" }, { param: "hitId" }],
      redirects: {}, codes: {}, showCode: true, signing: sign({}),
    },
  },
  custom: {
    id: "custom", label: "Custom panel",
    macros: {},
    how: "Name the id parameter your panel sends, and paste its end links (https) per outcome; {{pid}}, {{code}}, {{outcome}} and any kept parameter can be piped.",
    verify: VERIFY, needs: ["the panel's end links"],
    base: { preset: "custom", idParam: "pid", params: [], redirects: {}, codes: {}, showCode: false, signing: sign({}) },
  },
};

export interface PanelPresetOptions {
  key?: string;
  label?: string;
  /** the completion code (Prolific, CloudResearch, MTurk): the complete outcome's code */
  completionCode?: string;
  codes?: Partial<Record<PanelOutcome, string>>;
  redirects?: Partial<Record<PanelOutcome, string>>;
  idParam?: string;
  signing?: Partial<PanelSigning>;
  targets?: PanelTarget[];
  completesTarget?: number;
}

/** a usable config from a preset — the preset's links and the study's codes */
export function panelFromPreset(id: PanelPresetId, o: PanelPresetOptions = {}): PanelConfig {
  const p = PANEL_PRESETS[id] ?? PANEL_PRESETS.custom;
  const codes = { ...p.base.codes, ...(o.completionCode ? { complete: o.completionCode } : {}), ...(o.codes ?? {}) };
  return PanelConfigSchema.parse({
    ...p.base,
    key: o.key ?? p.id,
    label: o.label ?? p.label,
    ...(o.idParam ? { idParam: o.idParam } : {}),
    redirects: { ...p.base.redirects, ...(o.redirects ?? {}) },
    codes,
    signing: { ...p.base.signing, ...(o.signing ?? {}) },
    ...(o.targets ? { targets: o.targets } : {}),
    ...(o.completesTarget ? { completesTarget: o.completesTarget } : {}),
  });
}

/* ------------------------------------------------------------ the entry link */

/** the study link to give the panel: `?rp=<key>` (only when there is more than one panel) plus the panel's macros */
export function panelEntryLink(base: string, config: PanelConfig, opts: { many?: boolean } = {}): string {
  const preset = PANEL_PRESETS[config.preset] ?? PANEL_PRESETS.custom;
  const pairs: string[] = [];
  if (opts.many) pairs.push(`rp=${encodeURIComponent(config.key)}`);
  for (const name of [config.idParam, ...config.params.map((p) => p.param)]) pairs.push(`${encodeURIComponent(name)}=${preset.macros[name] ?? `{{${name}}}`}`);
  return `${base}${base.includes("?") ? "&" : "?"}${pairs.join("&")}`;
}

/* ------------------------------------------------------------ capturing an arrival */

export type PanelParams = Record<string, string | string[] | undefined | null>;
const first = (v: string | string[] | undefined | null): string | undefined => (Array.isArray(v) ? v[0] : v ?? undefined);
/** a panel id or a kept value: printable, no spaces or markup, bounded */
export function cleanPanelValue(v: unknown, max = 128): string | null {
  const s = String(v ?? "").trim();
  if (!s || s.length > max * 2) return null;
  const c = s.replace(/[^A-Za-z0-9._:@~+=-]/g, "").slice(0, max);
  return c || null;
}
/** a value still holding the panel's macro (the link was opened from the panel's setup page, not by a participant) */
const isMacro = (v: string) => /^(?:\[%|\{\{?%|\$\{|\[[A-Z_]+\]$|%%)/.test(v) || /%\]$|%\}\}?$/.test(v);

export type PanelCapture =
  | { ok: true; panel: PanelConfig; pid: string; captured: Record<string, string> }
  | { ok: true; panel: null; pid: string | null; captured: Record<string, string> }
  | { ok: false; panel: PanelConfig; reason: "missing_id" | "macro" | "disabled"; message: string };

/**
 * Which panel (if any) an arrival comes from, and what it carries. A panel is chosen by `rp=<key>`, else by its
 * id parameter being present, else — when the study has exactly one panel for this kind of link — that panel
 * (whose id is then required). No panel configured: the legacy `pid` is kept as before.
 */
export function capturePanelEntry(configs: PanelConfig[] | undefined | null, params: PanelParams, target: PanelTarget): PanelCapture {
  const usable = (configs ?? []).filter((c) => c.targets.includes(target));
  const rp = cleanPanelValue(first(params.rp), 32)?.toLowerCase();
  const panel = (rp ? usable.find((c) => c.key === rp) : undefined)
    ?? usable.find((c) => first(params[c.idParam]) !== undefined)
    ?? (usable.length === 1 ? usable[0] : undefined);
  if (!panel) {
    const legacy = cleanPanelValue(first(params.pid));
    return { ok: true, panel: null, pid: legacy, captured: {} };
  }
  if (!panel.enabled) return { ok: false, panel, reason: "disabled", message: "This study is not taking participants from this panel right now." };
  const rawId = first(params[panel.idParam]);
  if (rawId && isMacro(rawId.trim())) return { ok: false, panel, reason: "macro", message: `The link still holds the panel's placeholder for ${panel.idParam} — open it from the panel, not from the setup page.` };
  const pid = cleanPanelValue(rawId);
  if (!pid && panel.requireId) return { ok: false, panel, reason: "missing_id", message: `This link needs your ${panel.label} id (${panel.idParam}). Please start again from ${panel.label}.` };
  const captured: Record<string, string> = {};
  for (const p of panel.params) { const v = cleanPanelValue(first(params[p.param]), 200); if (v && !isMacro(v)) captured[p.as || p.param] = v; }
  return { ok: true, panel, pid: pid ?? "", captured };
}

/* ------------------------------------------------------------ outcomes */

/** an AI interview's status → the panel's outcome (null: no redirect yet — still in progress) */
export function outcomeForInterview(status: string, opts: { full?: boolean; overQuota?: boolean } = {}): PanelOutcome | null {
  if (opts.overQuota) return "over_quota";
  if (opts.full) return "quota_full";
  switch (status) {
    case "completed": return "complete";
    case "screened_out": return "screenout";
    case "flagged": case "ended": case "abandoned": return "terminate";
    default: return null;
  }
}
/** a survey's end status (flow.ts) → the panel's outcome */
export function outcomeForSurveyEnd(status: string | null | undefined): PanelOutcome | null {
  switch (status) {
    case "complete": return "complete";
    case "screened": return "screenout";
    case "quota_full": return "quota_full";
    case "terminated": return "terminate";
    default: return null;
  }
}

/* ------------------------------------------------------------ redirects */

const TOKEN = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;
const PRIVATE_HOST = /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$|172\.(?:1[6-9]|2\d|3[01])\.)/i;

/** the tokens a template uses */
export function panelTemplateTokens(template: string): string[] { return [...String(template ?? "").matchAll(TOKEN)].map((m) => m[1]); }

/** what is wrong with a redirect template (https, a real host, known tokens) — [] when fine */
export function panelTemplateProblems(template: string, config?: Pick<PanelConfig, "params" | "signing">): string[] {
  const t = String(template ?? "").trim();
  if (!t) return [];
  const out: string[] = [];
  let u: URL | null = null;
  try { u = new URL(t.replace(TOKEN, "X")); } catch { out.push("not a valid web address"); }
  if (u) {
    if (u.protocol !== "https:") out.push("must start with https://");
    if (u.username || u.password) out.push("must not contain a user name or password");
    if (PRIVATE_HOST.test(u.hostname) || !u.hostname.includes(".")) out.push("must point at the panel's public address");
    if (config?.signing && config.signing.algorithm !== "none" && u.searchParams.has(config.signing.param)) out.push(`must not already contain the signature parameter “${config.signing.param}” (it is added when signed)`);
  }
  const known = new Set(["pid", "code", "outcome", ...(config?.params ?? []).flatMap((p) => [p.param, p.as].filter((x): x is string => !!x))]);
  for (const k of panelTemplateTokens(t)) if (!known.has(k)) out.push(`{{${k}}} is not a value this panel captures (use {{pid}}, {{code}}, {{outcome}}${config?.params.length ? ` or ${config.params.map((p) => `{{${p.as || p.param}}}`).join(", ")}` : ""})`);
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}
export function encodeDigest(bytes: Uint8Array, encoding: PanelSigning["encoding"], uppercase = false): string {
  const s = encoding === "hex" ? [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
    : encoding === "base64" ? base64(bytes)
    : base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return uppercase && encoding === "hex" ? s.toUpperCase() : s;
}

/** the exact string that is signed, for this URL (the signature parameter, if present, is left out) */
export function panelCanonicalString(url: string, signing: PanelSigning): string {
  const u = new URL(url);
  u.searchParams.delete(signing.param);
  const query = u.search.replace(/^\?/, "");
  if (signing.scope === "query") return query;
  if (signing.scope === "params") return signing.params.map((p) => u.searchParams.get(p) ?? "").join(signing.separator);
  return `${u.origin}${u.pathname}${query ? `?${query}` : ""}`;
}

/** sign a redirect URL: the signature is appended as the last parameter */
export function signPanelUrl(url: string, signing: PanelSigning, secret: string, hasher: PanelHasher): string {
  if (signing.algorithm === "none") return url;
  const canonical = panelCanonicalString(url, signing);
  const sig = encodeDigest(hasher(signing.algorithm, canonical, secret), signing.encoding, signing.uppercase);
  const u = new URL(url);
  u.searchParams.delete(signing.param);
  const q = u.search.replace(/^\?/, "");
  return `${u.origin}${u.pathname}?${q ? `${q}&` : ""}${encodeURIComponent(signing.param)}=${encodeURIComponent(sig)}`;
}

/** the receiving side: does this URL carry a valid signature? (constant-time-ish compare; for the test links and docs) */
export function verifyPanelSignature(url: string, signing: PanelSigning, secret: string, hasher: PanelHasher): boolean {
  if (signing.algorithm === "none") return true;
  let got: string | null;
  try { got = new URL(url).searchParams.get(signing.param); } catch { return false; }
  if (!got) return false;
  const want = encodeDigest(hasher(signing.algorithm, panelCanonicalString(url, signing), secret), signing.encoding, signing.uppercase);
  if (want.length !== got.length) return false;
  let d = 0;
  for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return d === 0;
}

export interface PanelRedirectVars { pid: string | null; captured?: Record<string, string> }
export interface PanelRedirect {
  outcome: PanelOutcome;
  /** where to send the person; null when the panel has no end link for this outcome (or it is unusable) */
  url: string | null;
  /** the outcome's completion code, to show when `showCode` */
  code: string | null;
  showCode: boolean;
  signed: boolean;
  problems: string[];
}

/**
 * The end link for an outcome. Over quota falls back to quota full (and then to screen-out) when the panel has no
 * separate link. Values are URL-encoded; a template needing {{code}} without a code for the outcome gives no link
 * (the page then asks the person to return to the panel). A signing panel without its secret gives the UNSIGNED
 * link and says so — the panel will reject it, which is visible in the live view, rather than silently stranded.
 */
export function panelRedirect(config: PanelConfig, outcome: PanelOutcome, vars: PanelRedirectVars, sign: { secret: string | null; hasher: PanelHasher | null } = { secret: null, hasher: null }): PanelRedirect {
  const order: PanelOutcome[] = outcome === "over_quota" ? ["over_quota", "quota_full", "screenout"] : outcome === "quota_full" ? ["quota_full", "screenout"] : [outcome];
  const which = order.find((o) => config.redirects[o]?.trim()) ?? null;
  const codeFor = (o: PanelOutcome) => config.codes[o]?.trim() || null;
  const code = codeFor(which ?? outcome) ?? codeFor(outcome);
  const problems: string[] = [];
  const base = { outcome, code, showCode: config.showCode && !!code, signed: false };
  if (!which) return { ...base, url: null, problems };
  const template = config.redirects[which]!.trim();
  const tplProblems = panelTemplateProblems(template, config);
  if (tplProblems.length) return { ...base, url: null, problems: tplProblems.map((p) => `${PANEL_OUTCOME_LABELS[which]} link ${p}`) };
  const values: Record<string, string> = { pid: vars.pid ?? "", code: code ?? "", outcome };
  for (const p of config.params) { const v = vars.captured?.[p.as || p.param] ?? vars.captured?.[p.param]; if (v != null) { values[p.param] = v; if (p.as) values[p.as] = v; } }
  if (panelTemplateTokens(template).includes("code") && !code) return { ...base, url: null, problems: [`no completion code for “${PANEL_OUTCOME_LABELS[which]}”`] };
  let url = template.replace(TOKEN, (_m, k: string) => encodeURIComponent(values[k] ?? ""));
  try { url = new URL(url).toString(); } catch { return { ...base, url: null, problems: ["the end link is not a valid address once filled in"] }; }
  if (config.signing.algorithm !== "none") {
    if (!sign.secret || !sign.hasher) problems.push("the signing secret is not set — the link is sent unsigned and the panel may reject it");
    else return { ...base, url: signPanelUrl(url, config.signing, sign.secret, sign.hasher), signed: true, problems };
  }
  return { ...base, url, problems };
}

/** every problem with a config, for the setup screen and the gate — [] when it can be used */
export function panelConfigProblems(config: PanelConfig): string[] {
  const out: string[] = [];
  for (const o of PANEL_OUTCOMES) { const t = config.redirects[o]; if (t) out.push(...panelTemplateProblems(t, config).map((p) => `${PANEL_OUTCOME_LABELS[o]} link ${p}`)); }
  if (config.preset === "prolific" && !config.codes.complete) out.push("Prolific needs your completion code (Study → Completion paths)");
  if ((config.preset === "mturk" || config.preset === "cloudresearch") && !config.codes.complete) out.push(`${PANEL_PRESETS[config.preset].label} needs a completion code`);
  if (!config.showCode && !config.redirects.complete) out.push("there is no complete link and no code is shown — participants could not prove they finished");
  if (config.signing.algorithm !== "none" && config.signing.scope === "params" && !config.signing.params.length) out.push("signing over chosen parameters needs at least one parameter");
  return out;
}

/* ------------------------------------------------------------ reconciliation */

export interface PanelEntryRow { panel: string; pid: string; outcome: PanelOutcome | null; status?: string; target: string; startedAt?: string | null; endedAt?: string | null; isTest?: boolean; duplicateOf?: string | null }

const csvCell = (v: unknown) => { const s = v == null ? "" : String(v); const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
/** the file a panel asks for: one row per panel id with its outcome (formula-injection safe) */
export function panelReconciliationCsv(rows: PanelEntryRow[]): string {
  const head = ["panel", "panel_id", "outcome", "status", "link", "started_at", "ended_at", "test"];
  const sorted = [...rows].sort((a, b) => a.panel.localeCompare(b.panel) || String(a.outcome ?? "~").localeCompare(String(b.outcome ?? "~")) || a.pid.localeCompare(b.pid));
  return [head.join(","), ...sorted.map((r) => [r.panel, r.pid, r.outcome ?? "in_progress", r.status ?? "", r.target, r.startedAt ?? "", r.endedAt ?? "", r.isTest ? "yes" : ""].map(csvCell).join(","))].join("\r\n") + "\r\n";
}

/** counts by outcome — the reconciliation summary line */
export function panelOutcomeCounts(rows: PanelEntryRow[]): Record<PanelOutcome | "in_progress", number> {
  const out = { complete: 0, screenout: 0, quota_full: 0, terminate: 0, over_quota: 0, in_progress: 0 };
  for (const r of rows) out[r.outcome ?? "in_progress"]++;
  return out;
}
