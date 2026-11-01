import type { SurveyDefinition } from "@rescript/schema";
import { QualityConfig, QUALITY_RULE_PARAMS, TELEMETRY_CATEGORIES } from "@rescript/schema";

/**
 * set_quality_settings — THE RESPONSE-QUALITY SETTINGS FROM INTELLIGENT MODE (S5b item 5; audit TE-13).
 *
 *   enabled        quality checks on / off for the survey
 *   strictness     relaxed | standard | strict | very_strict | custom
 *   telemetry      the collector's switches {timing, focus, clipboard, navigation, interaction, device, network,
 *                  visibility, answerHistory, idle: boolean} and its settings {idleSeconds 10–3600,
 *                  idlePrompt boolean, idlePromptText (null removes), disclosure (null removes)}
 *   rules          per rule id {enabled, severity low|medium|high|critical, params {threshold key: number|string|boolean}}
 *                  — only the built-in rule ids and the threshold keys each declares (QUALITY_RULE_PARAMS)
 *
 * Merged into `def.quality` and checked by the schema (`QualityConfig`). Changing a rule's thresholds while the
 * strictness is a preset moves it to `custom` (the preset would otherwise ignore them) and says so. Switching a
 * telemetry category off is reported as destructive: the rules that need it stop running.
 */
export type QualityTelemetryPatch = Partial<Record<(typeof TELEMETRY_CATEGORIES)[number], boolean>> & {
  idleSeconds?: number; idlePrompt?: boolean; idlePromptText?: string | null; disclosure?: string | null;
};
export interface QualityRulePatch { enabled?: boolean; severity?: "low" | "medium" | "high" | "critical"; params?: Record<string, number | string | boolean> }
export type QualitySettingsAction = {
  op: "set_quality_settings";
  enabled?: boolean;
  strictness?: "relaxed" | "standard" | "strict" | "very_strict" | "custom";
  telemetry?: QualityTelemetryPatch;
  rules?: Record<string, QualityRulePatch>;
};
export const QUALITY_ACTION_OPS = ["set_quality_settings"] as const;

const STRICTNESS = ["relaxed", "standard", "strict", "very_strict", "custom"] as const;
const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);

export function coerceQualityAction(o: Record<string, unknown>): QualitySettingsAction | string {
  const a: QualitySettingsAction = { op: "set_quality_settings" };
  if (typeof o.enabled === "boolean") a.enabled = o.enabled;
  if (o.strictness !== undefined) {
    if (!(STRICTNESS as readonly string[]).includes(String(o.strictness))) return `set_quality_settings strictness must be ${STRICTNESS.join(" | ")}`;
    a.strictness = o.strictness as QualitySettingsAction["strictness"];
  }
  if (o.telemetry !== undefined) {
    if (!o.telemetry || typeof o.telemetry !== "object" || Array.isArray(o.telemetry)) return "set_quality_settings telemetry is an object of switches";
    const t = o.telemetry as Record<string, unknown>;
    const p: QualityTelemetryPatch = {};
    for (const [k, v] of Object.entries(t)) {
      if ((TELEMETRY_CATEGORIES as readonly string[]).includes(k)) {
        if (typeof v !== "boolean") return `set_quality_settings telemetry.${k} must be true or false`;
        (p as Record<string, boolean>)[k] = v;
      } else if (k === "idleSeconds") {
        const n = num(v);
        if (n === undefined || n < 10 || n > 3600) return "set_quality_settings telemetry.idleSeconds must be 10–3600";
        p.idleSeconds = Math.round(n);
      } else if (k === "idlePrompt") {
        if (typeof v !== "boolean") return "set_quality_settings telemetry.idlePrompt must be true or false";
        p.idlePrompt = v;
      } else if (k === "idlePromptText" || k === "disclosure") {
        if (v === null || v === "") p[k] = null;
        else if (typeof v === "string") p[k] = v.trim().slice(0, k === "idlePromptText" ? 300 : 500);
        else return `set_quality_settings telemetry.${k} must be text (or null to remove it)`;
      } else return `set_quality_settings telemetry.${k} is not a setting — switches ${TELEMETRY_CATEGORIES.join(", ")}; idleSeconds, idlePrompt, idlePromptText, disclosure`;
    }
    a.telemetry = p;
  }
  if (o.rules !== undefined) {
    if (!o.rules || typeof o.rules !== "object" || Array.isArray(o.rules)) return "set_quality_settings rules is {ruleId: {enabled, severity, params}}";
    const out: Record<string, QualityRulePatch> = {};
    for (const [id, raw] of Object.entries(o.rules as Record<string, unknown>).slice(0, 80)) {
      const keys = QUALITY_RULE_PARAMS[id];
      if (!keys) {
        const near = Object.keys(QUALITY_RULE_PARAMS).filter((r) => r.endsWith(`.${id.split(".").pop()}`) || r.startsWith(`${id.split(".")[0]}.`)).slice(0, 6);
        return `set_quality_settings: no quality rule "${id}"${near.length ? ` — did you mean ${near.join(", ")}?` : ""}`;
      }
      const r = (raw ?? {}) as Record<string, unknown>;
      const p: QualityRulePatch = {};
      if (typeof raw === "boolean") { out[id] = { enabled: raw }; continue; }
      if (typeof r.enabled === "boolean") p.enabled = r.enabled;
      if (r.severity !== undefined) {
        if (!(SEVERITIES as readonly string[]).includes(String(r.severity))) return `set_quality_settings ${id}.severity must be ${SEVERITIES.join(" | ")}`;
        p.severity = r.severity as QualityRulePatch["severity"];
      }
      if (r.params !== undefined) {
        if (!r.params || typeof r.params !== "object" || Array.isArray(r.params)) return `set_quality_settings ${id}.params is {key: value}`;
        const params: Record<string, number | string | boolean> = {};
        for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) {
          if (!keys.includes(k)) return `set_quality_settings ${id} has no threshold "${k}"${keys.length ? ` — it takes ${keys.join(", ")}` : " — it has no thresholds"}`;
          const n = num(v);
          if (n !== undefined) params[k] = n;
          else if (typeof v === "boolean") params[k] = v;
          else if (typeof v === "string" && v.trim()) params[k] = v.trim().slice(0, 80);
          else return `set_quality_settings ${id}.${k} must be a number`;
        }
        p.params = params;
      }
      if (!Object.keys(p).length) return `set_quality_settings ${id}: give enabled, severity or params`;
      out[id] = p;
    }
    a.rules = out;
  }
  return Object.keys(a).length > 1 ? a : "set_quality_settings changes nothing — give enabled, strictness, telemetry or rules";
}

class QualityActionError extends Error {}
const fail = (m: string): never => { throw new QualityActionError(m); };

export function applyQualityAction(def: SurveyDefinition, a: QualitySettingsAction): { description: string; destructive?: string; warnings: string[]; touched: string[] } {
  const cur = QualityConfig.parse(def.quality ?? {});
  const next: Record<string, any> = JSON.parse(JSON.stringify(cur));
  const done: string[] = [];
  const lossy: string[] = [];
  const warnings: string[] = [];
  if (a.enabled !== undefined) { next.enabled = a.enabled; done.push(a.enabled ? "checks on" : "checks off"); }
  if (a.strictness) { next.strictness = a.strictness; done.push(`strictness ${a.strictness}`); }
  if (a.telemetry) {
    const t = next.telemetry as Record<string, unknown>;
    for (const [k, v] of Object.entries(a.telemetry)) {
      if (v === null) { delete t[k]; done.push(`no ${k}`); continue; }
      if ((TELEMETRY_CATEGORIES as readonly string[]).includes(k)) {
        if (t[k] !== false && v === false) lossy.push(`stops recording ${k} (rules that need it are skipped)`);
        t[k] = v; done.push(`${k} ${v ? "on" : "off"}`);
      } else { t[k] = v; done.push(`${k} ${String(v).slice(0, 40)}`); }
    }
    if (a.telemetry.idlePrompt === true && (t.idle === false)) warnings.push("the idle prompt needs the idle switch on — it will not appear while idle is off");
  }
  if (a.rules) {
    const rules = next.rules as Record<string, Record<string, unknown>>;
    let thresholds = false;
    for (const [id, p] of Object.entries(a.rules)) {
      const r = (rules[id] ??= {});
      if (p.enabled !== undefined) r.enabled = p.enabled;
      if (p.severity) r.severity = p.severity;
      if (p.params) { r.params = { ...((r.params as object) ?? {}), ...p.params }; thresholds = true; }
      done.push(`${id}${p.enabled === false ? " off" : p.enabled ? " on" : ""}${p.severity ? ` ${p.severity}` : ""}${p.params ? ` ${Object.entries(p.params).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}`);
    }
    if (thresholds && next.strictness !== "custom" && !a.strictness) {
      warnings.push(`thresholds are read from the rule settings at any strictness; the ${next.strictness} preset still decides which rules run unless a rule is switched on or off here`);
    }
  }
  const parsed = QualityConfig.safeParse(next);
  if (!parsed.success) fail(`set_quality_settings: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  (def as { quality?: unknown }).quality = parsed.data!;
  return { description: `Quality settings: ${done.join(", ") || "updated"}`, ...(lossy.length ? { destructive: lossy.join("; ") } : {}), warnings, touched: [] };
}

export function describeQualityAction(a: QualitySettingsAction): string {
  const bits = [
    a.enabled !== undefined ? (a.enabled ? "on" : "off") : "",
    a.strictness ?? "",
    a.telemetry ? `telemetry ${Object.keys(a.telemetry).join(", ")}` : "",
    a.rules ? `${Object.keys(a.rules).length} rule${Object.keys(a.rules).length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return `Set quality settings${bits.length ? ` (${bits.join("; ")})` : ""}`;
}
