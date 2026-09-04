"use client";
import React from "react";
import type { CustomQualityRule, QualityClass, QualityConfig, RuleSetting, Severity, Strictness } from "@rescript/schema";
import { QualityConfig as QualityConfigSchema } from "@rescript/schema";
import { RULES, CATEGORY_LABELS, BUILTIN_PROFILES, type RuleDef, type QualityProfile } from "@rescript/quality";
import { useStudio, uid } from "./store";
import { ConditionEditor } from "./ConditionBuilder";

/**
 * Survey Settings → Quality checks.
 *
 * One toggle, one strictness, and then everything the engine reads laid out
 * so it can be changed: classification bands, every built-in rule (on/off,
 * severity, weight, thresholds, question restriction — the "Custom"
 * strictness is just this table edited), researcher-authored IF/THEN rules
 * over the SYSTEM_* metrics using the ordinary condition builder, saved
 * profiles, and the telemetry / privacy switches the runtime honours.
 *
 * Every edit is `s.update` on `def.quality`, so it autosaves with the survey
 * and versions with it. "Preview rule impact" asks the server to re-assess
 * the survey's responses with the draft's settings.
 */

const LEVELS: { value: Strictness; label: string; hint: string }[] = [
  { value: "relaxed", label: "Relaxed", hint: "Only extreme problems; fewest false positives." },
  { value: "standard", label: "Standard", hint: "Recommended: common poor-quality responses and obvious suspicious behaviour." },
  { value: "strict", label: "Strict", hint: "More aggressive detection for high-value studies." },
  { value: "very_strict", label: "Very strict", hint: "Subtle behavioural and response anomalies too." },
  { value: "custom", label: "Custom", hint: "Start from Standard and tune every rule, threshold and weight." },
];
const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];
const CLASSES: QualityClass[] = ["CLEAN", "REVIEW", "SUSPICIOUS", "HIGHLY_SUSPICIOUS", "CRITICAL"];
const CATEGORY_ORDER = ["timing", "matrix", "consistency", "pattern", "attention", "open_end", "interaction", "navigation", "device", "network", "bot", "duplicate", "cluster", "screener", "custom"];

const SYSTEM_VARS_HELP: [string, string][] = [
  ["SYSTEM_DURATION_RATIO", "total time ÷ benchmark (0.3 = 70% faster than median)"],
  ["SYSTEM_TOTAL_DURATION", "seconds"], ["SYSTEM_ATTENTION_FAILED", "checks failed"], ["SYSTEM_SPEEDER_SCORE", "0–100"],
  ["SYSTEM_STRAIGHTLINE_SCORE", "0–100"], ["SYSTEM_OPENEND_SCORE", "0–100"], ["SYSTEM_DUPLICATE_SCORE", "0–100"], ["SYSTEM_BOT_SCORE", "0–100"],
  ["SYSTEM_CONSISTENCY_SCORE", "0–100"], ["SYSTEM_PATTERN_SCORE", "0–100"], ["SYSTEM_NAVIGATION_SCORE", "0–100"], ["SYSTEM_CLUSTER_SCORE", "0–100"],
  ["SYSTEM_PASTE_COUNT", "pastes"], ["SYSTEM_TAB_SWITCH_COUNT", "tab switches"], ["SYSTEM_BACK_COUNT", "back moves"], ["SYSTEM_SIMILARITY_SCORE", "0–100 vs closest peer"],
];

export function QualitySettings() {
  const s = useStudio();
  const cfg: QualityConfig = QualityConfigSchema.parse(s.def.quality ?? {});
  const set = (label: string, fn: (q: QualityConfig) => void) => {
    s.labelNextEdit?.(label);
    s.update((d) => { d.quality = QualityConfigSchema.parse(d.quality ?? {}); fn(d.quality); });
  };
  const level = cfg.strictness === "custom" ? "standard" : cfg.strictness;
  const [openCats, setOpenCats] = React.useState<Record<string, boolean>>({});
  const [impact, setImpact] = React.useState<{ busy: boolean; result?: any; error?: string }>({ busy: false });

  const previewImpact = async () => {
    if (!s.surveyDbId || s.surveyDbId === "sandbox") { setImpact({ busy: false, error: "Preview needs a saved survey with responses (not available in the sandbox)." }); return; }
    setImpact({ busy: true });
    await s.flushDraft();
    try {
      const res = await fetch(`/api/surveys/${s.surveyDbId}/quality/recompute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ include: "all", source: "draft" }) });
      const j = await res.json();
      if (!res.ok) setImpact({ busy: false, error: j.error ?? `HTTP ${res.status}` });
      else setImpact({ busy: false, result: j });
    } catch (e) { setImpact({ busy: false, error: (e as Error).message }); }
  };

  return (
    <div data-testid="quality-settings">
      <h3 className="sec">Quality checks</h3>
      <label className="row" style={{ gap: 8, fontSize: 13, marginBottom: 8, alignItems: "center" }}>
        <input type="checkbox" data-testid="quality-enabled" checked={cfg.enabled}
          onChange={(e) => set("toggle quality checks", (q) => { q.enabled = e.target.checked; })} />
        <strong>Enable Response Quality Checks</strong>
      </label>
      <p className="muted" style={{ fontSize: 11, marginTop: -4 }}>
        While enabled, the runtime records behavioural metadata (timing, focus, copy/paste counts, navigation,
        device class — never clipboard contents or raw IP), and every finished response is scored the moment it is
        submitted: a <strong>Quality score</strong> (100 = best) and a separate <strong>Fraud risk</strong> (100 =
        most suspicious), a classification from the bands below, and an explanation for every flag. Nothing is ever
        removed automatically — decisions are yours, in Data → Quality.
      </p>

      {cfg.enabled && (
        <>
          {/* ------------------------------------------------ strictness + profiles */}
          <div className="row" style={{ alignItems: "flex-start", gap: 12 }}>
            <label className="f grow"><span>Quality strictness</span>
              <select className="select" data-testid="quality-strictness" value={cfg.strictness}
                onChange={(e) => set("set strictness", (q) => { q.strictness = e.target.value as Strictness; })}>
                {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
              <span className="muted" style={{ fontSize: 11 }}>{LEVELS.find((l) => l.value === cfg.strictness)?.hint}</span>
            </label>
            <ProfilePicker cfg={cfg} onApply={(p) => set(`apply profile ${p.name}`, (q) => {
              const merged = QualityConfigSchema.parse({ ...q, ...p.config, enabled: true, profile: p.name, rules: { ...(p.config.rules ?? {}) }, customRules: p.config.customRules ?? q.customRules });
              Object.assign(q, merged);
            })} />
          </div>

          {/* ------------------------------------------------ bands */}
          <h3 className="sec">Classification bands (fraud risk 0–100)</h3>
          <Bands cfg={cfg} onChange={(b) => set("edit classification bands", (q) => { q.bands = b; })} />

          {/* ------------------------------------------------ rules */}
          <h3 className="sec">Rules</h3>
          <p className="muted" style={{ fontSize: 11, marginTop: -4 }}>
            Defaults shown are for <strong>{LEVELS.find((l) => l.value === level)?.label}</strong>. Change anything here and the survey
            keeps your value; “Reset” returns a rule to the preset. Weight multiplies a rule's risk points; severity scales them too.
            {cfg.strictness !== "custom" && " Editing a rule does not switch the strictness to Custom — presets and overrides layer."}
          </p>
          {CATEGORY_ORDER.map((cat) => {
            const rules = RULES.filter((r) => r.category === cat);
            if (!rules.length) return null;
            const open = openCats[cat] ?? false;
            const overridden = rules.filter((r) => cfg.rules[r.id] && Object.keys(cfg.rules[r.id]).length).length;
            const active = rules.filter((r) => cfg.rules[r.id]?.enabled ?? r.enabledIn[level]).length;
            return (
              <div key={cat} className="card" style={{ padding: 8 }} data-testid={`qrules-${cat}`}>
                <div className="row" style={{ alignItems: "center", cursor: "pointer" }} onClick={() => setOpenCats((o) => ({ ...o, [cat]: !open }))}>
                  <span>{open ? "▾" : "▸"}</span>
                  <strong style={{ fontSize: 13 }}>{CATEGORY_LABELS[cat]}</strong>
                  <span className="muted" style={{ fontSize: 11 }}>{active} of {rules.length} on{overridden ? ` · ${overridden} customised` : ""}</span>
                </div>
                {open && rules.map((r) => (
                  <RuleRow key={r.id} rule={r} level={level} setting={cfg.rules[r.id]} questions={s.def.questions}
                    onChange={(next) => set(`edit rule ${r.title}`, (q) => { if (next) q.rules[r.id] = next; else delete q.rules[r.id]; })} />
                ))}
              </div>
            );
          })}

          {/* ------------------------------------------------ custom rules */}
          <h3 className="sec">Custom rules</h3>
          <p className="muted" style={{ fontSize: 11, marginTop: -4 }}>
            Your own IF … THEN rules over the answers and the quality metrics — the same condition builder and expression syntax as
            display logic. Metrics are available as calculations: <span className="mono">calc.SYSTEM_DURATION_RATIO &lt; 0.3 AND calc.SYSTEM_ATTENTION_FAILED &gt;= 1</span>.
          </p>
          {cfg.customRules.map((cr, i) => (
            <CustomRuleRow key={cr.id} rule={cr}
              onChange={(next) => set(`edit custom rule ${cr.name}`, (q) => { q.customRules[i] = next; })}
              onRemove={() => set("remove custom rule", (q) => { q.customRules.splice(i, 1); })} />
          ))}
          <button className="btn small" data-testid="qcustom-add" onClick={() => set("add custom rule", (q) => {
            q.customRules.push({
              id: uid("qr"), name: `Rule ${q.customRules.length + 1}`, enabled: true, severity: "medium", riskPoints: 20, qualityPenalty: 10, questionIds: [],
              when: { type: "group", op: "and", children: [{ type: "rule", source: { kind: "calculation", ref: "SYSTEM_DURATION_RATIO" }, operator: "lt", value: 0.3 }] },
            });
          })}>+ custom rule</button>
          <details style={{ marginTop: 6 }}>
            <summary className="muted" style={{ fontSize: 11, cursor: "pointer" }}>System variables you can test</summary>
            <table className="grid" style={{ fontSize: 11 }}><tbody>
              {SYSTEM_VARS_HELP.map(([k, v]) => <tr key={k}><td className="mono">calc.{k}</td><td className="muted">{v}</td></tr>)}
            </tbody></table>
          </details>

          {/* ------------------------------------------------ attention checks */}
          <h3 className="sec">Attention checks</h3>
          <AttentionSummary />

          {/* ------------------------------------------------ telemetry & privacy */}
          <h3 className="sec">Telemetry &amp; privacy</h3>
          <p className="muted" style={{ fontSize: 11, marginTop: -4 }}>
            Everything recorded is derived metadata. Switch off anything your study or jurisdiction does not permit — rules that
            need it are skipped, never failed.
          </p>
          <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
            {([
              ["timing", "Page & question timing"], ["focus", "Tab focus / blur"], ["clipboard", "Copy / paste counts & lengths"],
              ["navigation", "Navigation sequence"], ["interaction", "Pointer / key / scroll counts"], ["device", "Device class (browser, OS, screen, timezone, language)"],
              ["network", "Hashed IP address"],
            ] as [keyof QualityConfig["telemetry"], string][]).map(([k, label]) => (
              <label key={k} className="row" style={{ gap: 6, fontSize: 12 }}>
                <input type="checkbox" data-testid={`qtel-${k}`} checked={(cfg.telemetry as any)[k] !== false}
                  onChange={(e) => set(`telemetry ${k}`, (q) => { (q.telemetry as any)[k] = e.target.checked; })} />
                {label}
              </label>
            ))}
          </div>
          <label className="f" style={{ marginTop: 8 }}><span>Disclosure shown to respondents (optional)</span>
            <input className="input" data-testid="qtel-disclosure" value={cfg.telemetry.disclosure ?? ""}
              placeholder="This survey records response timing and navigation to protect data quality."
              onChange={(e) => set("edit disclosure", (q) => { q.telemetry.disclosure = e.target.value || undefined; })} /></label>
          <div className="row">
            <label className="f"><span>Keep raw telemetry for (days, 0 = keep)</span>
              <input className="input" type="number" min={0} data-testid="qpriv-retention" value={cfg.privacy.telemetryRetentionDays}
                onChange={(e) => set("edit retention", (q) => { q.privacy.telemetryRetentionDays = Math.max(0, Number(e.target.value) || 0); })} /></label>
            <label className="row" style={{ gap: 6, fontSize: 12, alignSelf: "end", marginBottom: 12 }}>
              <input type="checkbox" data-testid="qpriv-longitudinal" checked={cfg.privacy.longitudinal}
                onChange={(e) => set("toggle longitudinal", (q) => { q.privacy.longitudinal = e.target.checked; })} />
              Link quality history across studies (same external respondent id; needs consent)
            </label>
          </div>
          <label className="f"><span>Peers compared for duplicates &amp; clusters (newest completes)</span>
            <input className="input" type="number" min={50} max={20000} data-testid="q-maxpeers" value={cfg.maxPeers}
              onChange={(e) => set("edit max peers", (q) => { q.maxPeers = Math.min(20000, Math.max(50, Number(e.target.value) || 3000)); })} /></label>

          {/* ------------------------------------------------ impact */}
          <h3 className="sec">Preview rule impact</h3>
          <div className="row" style={{ alignItems: "center" }}>
            <button className="btn small" data-testid="q-preview-impact" disabled={impact.busy} onClick={previewImpact}>
              {impact.busy ? "Re-assessing…" : "Re-assess existing responses with these settings"}
            </button>
            <span className="muted" style={{ fontSize: 11 }}>Recomputes every finished response (test and live) with the draft's settings. Decisions you have made are kept.</span>
          </div>
          {impact.error && <div className="chip warn" style={{ marginTop: 6 }} data-testid="q-impact-error">{impact.error}</div>}
          {impact.result && (
            <div className="card" style={{ padding: 10, marginTop: 6 }} data-testid="q-impact-result">
              {Object.entries(impact.result.results ?? {}).map(([mode, r]: [string, any]) => (
                <div key={mode} style={{ fontSize: 12 }}>
                  <strong>{mode}</strong>: {r.assessed} assessed — {CLASSES.map((c) => `${c} ${r.byClass?.[c] ?? 0}`).join(" · ")}
                </div>
              ))}
              <div className="muted" style={{ fontSize: 11 }}>{impact.result.strictness} · {impact.result.ms} ms</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ================================================================ bands */

function Bands({ cfg, onChange }: { cfg: QualityConfig; onChange(b: QualityConfig["bands"]): void }) {
  const b = cfg.bands;
  const setB = (k: keyof QualityConfig["bands"], v: number) => {
    const next = { ...b, [k]: Math.max(0, Math.min(100, v)) };
    // keep ascending
    if (next.suspicious < next.review) next.suspicious = next.review;
    if (next.highlySuspicious < next.suspicious) next.highlySuspicious = next.suspicious;
    if (next.critical < next.highlySuspicious) next.critical = next.highlySuspicious;
    onChange(next);
  };
  const segs = [
    ["CLEAN", 0, b.review, "#2f9e44"], ["REVIEW", b.review, b.suspicious, "#f0b429"], ["SUSPICIOUS", b.suspicious, b.highlySuspicious, "#f76707"],
    ["HIGHLY_SUSPICIOUS", b.highlySuspicious, b.critical, "#e03131"], ["CRITICAL", b.critical, 100, "#862e9c"],
  ] as [string, number, number, string][];
  return (
    <div data-testid="quality-bands">
      <div style={{ display: "flex", height: 18, borderRadius: 9, overflow: "hidden", border: "1px solid var(--border)", marginBottom: 6 }}>
        {segs.map(([name, from, to, color]) => (
          <div key={name} title={`${name}: ${from}–${to}`} style={{ width: `${Math.max(0, to - from)}%`, background: color, fontSize: 9, color: "#fff", textAlign: "center", lineHeight: "18px", overflow: "hidden", whiteSpace: "nowrap" }}>
            {to - from >= 12 ? name.replace("HIGHLY_", "H.") : ""}
          </div>
        ))}
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        {([["review", "REVIEW from"], ["suspicious", "SUSPICIOUS from"], ["highlySuspicious", "HIGHLY SUSPICIOUS from"], ["critical", "CRITICAL from"]] as [keyof QualityConfig["bands"], string][]).map(([k, label]) => (
          <label key={k} className="f" style={{ width: 150 }}><span>{label}</span>
            <input className="input" type="number" min={0} max={100} data-testid={`qband-${k}`} value={b[k]} onChange={(e) => setB(k, Number(e.target.value))} /></label>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 11 }}>Default: 0–19 CLEAN · 20–39 REVIEW · 40–59 SUSPICIOUS · 60–79 HIGHLY SUSPICIOUS · 80–100 CRITICAL.</div>
    </div>
  );
}

/* ================================================================ rule row */

function RuleRow({ rule, level, setting, questions, onChange }: {
  rule: RuleDef; level: Exclude<Strictness, "custom">; setting: RuleSetting | undefined; questions: { id: string; code: string; text: string }[];
  onChange(next: RuleSetting | undefined): void;
}) {
  const enabled = setting?.enabled ?? rule.enabledIn[level];
  const [open, setOpen] = React.useState(false);
  const patch = (p: Partial<RuleSetting>) => {
    const next: RuleSetting = { ...(setting ?? {}), ...p };
    // drop keys equal to undefined
    for (const k of Object.keys(next) as (keyof RuleSetting)[]) if (next[k] === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const customised = !!setting && Object.keys(setting).length > 0;
  return (
    <div className="qrule" data-testid={`qrule-${rule.id}`} style={{ borderTop: "1px solid var(--border)", padding: "6px 0" }}>
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <input type="checkbox" data-testid="qrule-enabled" checked={enabled} onChange={(e) => patch({ enabled: e.target.checked === rule.enabledIn[level] ? undefined : e.target.checked })} />
        <span style={{ fontSize: 12, cursor: "pointer", flex: 1 }} onClick={() => setOpen((o) => !o)} title={rule.description}>
          {rule.title} {customised && <span className="chip" style={{ marginLeft: 4 }}>customised</span>}
          {!enabled && <span className="muted"> · off</span>}
        </span>
        <span className="muted" style={{ fontSize: 11 }}>+{rule.riskPoints} risk · −{rule.qualityPenalty} quality</span>
        <button className="btn small ghost" onClick={() => setOpen((o) => !o)}>{open ? "hide" : "edit"}</button>
      </div>
      {open && (
        <div style={{ paddingLeft: 24, paddingTop: 4 }}>
          <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>{rule.description}</div>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <label className="f" style={{ width: 120 }}><span>Severity</span>
              <select className="select" data-testid="qrule-severity" value={setting?.severity ?? rule.defaultSeverity}
                onChange={(e) => patch({ severity: e.target.value === rule.defaultSeverity ? undefined : (e.target.value as Severity) })}>
                {SEVERITIES.map((sv) => <option key={sv} value={sv}>{sv}{sv === rule.defaultSeverity ? " (default)" : ""}</option>)}
              </select></label>
            <label className="f" style={{ width: 110 }}><span>Risk weight</span>
              <input className="input" type="number" step={0.1} min={0} max={5} data-testid="qrule-weight" value={setting?.weight ?? 1}
                onChange={(e) => patch({ weight: Number(e.target.value) === 1 ? undefined : Number(e.target.value) })} /></label>
            <label className="f" style={{ width: 110 }}><span>Quality weight</span>
              <input className="input" type="number" step={0.1} min={0} max={5} value={setting?.qualityWeight ?? 1}
                onChange={(e) => patch({ qualityWeight: Number(e.target.value) === 1 ? undefined : Number(e.target.value) })} /></label>
            {rule.params.map((p) => {
              const dflt = p.defaults[level];
              const cur = setting?.params?.[p.key];
              return (
                <label key={p.key} className="f" style={{ width: typeof dflt === "boolean" ? 160 : 220 }} title={p.hint ?? ""}>
                  <span>{p.label}{p.unit ? ` (${p.unit})` : ""}</span>
                  {typeof dflt === "boolean" ? (
                    <input type="checkbox" checked={(cur ?? dflt) as boolean} onChange={(e) => patch({ params: { ...(setting?.params ?? {}), [p.key]: e.target.checked } })} />
                  ) : typeof dflt === "number" ? (
                    <input className="input" type="number" step="any" data-testid={`qparam-${p.key}`} value={cur === undefined ? "" : String(cur)} placeholder={`preset ${dflt}`}
                      onChange={(e) => {
                        const params = { ...(setting?.params ?? {}) };
                        if (e.target.value === "") delete params[p.key]; else params[p.key] = Number(e.target.value);
                        patch({ params: Object.keys(params).length ? params : undefined });
                      }} />
                  ) : (
                    <input className="input" value={cur === undefined ? "" : String(cur)} placeholder={String(dflt) || "any"}
                      onChange={(e) => { const params = { ...(setting?.params ?? {}) }; if (e.target.value === "") delete params[p.key]; else params[p.key] = e.target.value; patch({ params: Object.keys(params).length ? params : undefined }); }} />
                  )}
                </label>
              );
            })}
          </div>
          <QuestionScope rule={rule} setting={setting} questions={questions} onChange={(ids) => patch({ questionIds: ids.length ? ids : undefined })} />
          {customised && <button className="btn small" data-testid="qrule-reset" onClick={() => onChange(undefined)}>Reset to preset</button>}
        </div>
      )}
    </div>
  );
}

function QuestionScope({ rule, setting, questions, onChange }: { rule: RuleDef; setting: RuleSetting | undefined; questions: { id: string; code: string; text: string }[]; onChange(ids: string[]): void }) {
  const scoped = ["timing.question_speeding", "timing.matrix_speeding", "timing.openend_speeding", "matrix.straightline", "consistency.impossible_path", "openend.too_short", "openend.gibberish", "openend.repeated", "openend.generic", "openend.irrelevant", "openend.contradiction", "openend.duplicate", "openend.ai_like", "openend.pasted"];
  if (!scoped.includes(rule.id)) return null;
  const ids = setting?.questionIds ?? [];
  return (
    <details style={{ margin: "4px 0 8px" }}>
      <summary className="muted" style={{ fontSize: 11, cursor: "pointer" }}>Apply to specific questions{ids.length ? ` (${ids.length} selected)` : " (all)"}</summary>
      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {questions.map((q) => (
          <label key={q.id} className="chip" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={ids.includes(q.id)} onChange={(e) => onChange(e.target.checked ? [...ids, q.id] : ids.filter((x) => x !== q.id))} /> {q.code}
          </label>
        ))}
      </div>
    </details>
  );
}

/* ================================================================ custom rule */

function CustomRuleRow({ rule, onChange, onRemove }: { rule: CustomQualityRule; onChange(next: CustomQualityRule): void; onRemove(): void }) {
  const s = useStudio();
  return (
    <div className="card" style={{ padding: 10 }} data-testid="qcustom-rule">
      <div className="row" style={{ alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={rule.enabled} onChange={(e) => onChange({ ...rule, enabled: e.target.checked })} />
        <input className="input grow" data-testid="qcustom-name" value={rule.name} onChange={(e) => onChange({ ...rule, name: e.target.value })} placeholder="Rule name" />
        <button className="btn small danger" data-testid="qcustom-remove" onClick={onRemove}>×</button>
      </div>
      <div style={{ margin: "8px 0" }}>
        <span className="flabel">IF</span>
        <ConditionEditor value={rule.when} onChange={(when) => onChange({ ...rule, when })} />
      </div>
      <div className="row" style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
        <span className="flabel" style={{ alignSelf: "center" }}>THEN</span>
        <label className="f" style={{ width: 120 }}><span>Add fraud risk</span>
          <input className="input" type="number" min={0} max={100} data-testid="qcustom-risk" value={rule.riskPoints} onChange={(e) => onChange({ ...rule, riskPoints: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} /></label>
        <label className="f" style={{ width: 120 }}><span>Quality penalty</span>
          <input className="input" type="number" min={0} max={100} value={rule.qualityPenalty} onChange={(e) => onChange({ ...rule, qualityPenalty: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} /></label>
        <label className="f" style={{ width: 120 }}><span>Severity</span>
          <select className="select" value={rule.severity} onChange={(e) => onChange({ ...rule, severity: e.target.value as Severity })}>{SEVERITIES.map((sv) => <option key={sv}>{sv}</option>)}</select></label>
        <label className="f" style={{ width: 200 }}><span>At least classification</span>
          <select className="select" data-testid="qcustom-minclass" value={rule.minClass ?? ""} onChange={(e) => onChange({ ...rule, minClass: (e.target.value || undefined) as QualityClass | undefined })}>
            <option value="">— from the score —</option>{CLASSES.slice(1).map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
          </select></label>
      </div>
      <label className="f" style={{ marginTop: 6 }}><span>Explanation shown to the researcher</span>
        <input className="input" value={rule.explanation ?? ""} placeholder={`Custom rule “${rule.name}” matched.`} onChange={(e) => onChange({ ...rule, explanation: e.target.value || undefined })} /></label>
      <details>
        <summary className="muted" style={{ fontSize: 11, cursor: "pointer" }}>Related questions{rule.questionIds.length ? ` (${rule.questionIds.length})` : ""}</summary>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {s.def.questions.map((q) => (
            <label key={q.id} className="chip" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={rule.questionIds.includes(q.id)} onChange={(e) => onChange({ ...rule, questionIds: e.target.checked ? [...rule.questionIds, q.id] : rule.questionIds.filter((x) => x !== q.id) })} /> {q.code}
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}

/* ================================================================ profiles */

function ProfilePicker({ cfg, onApply }: { cfg: QualityConfig; onApply(p: QualityProfile): void }) {
  const s = useStudio();
  const [saved, setSaved] = React.useState<QualityProfile[]>([]);
  const [name, setName] = React.useState("");
  const [msg, setMsg] = React.useState<string | null>(null);
  const canServer = !!s.surveyDbId && s.surveyDbId !== "sandbox";
  const load = React.useCallback(async () => {
    if (!canServer) return;
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/quality/profiles`);
      if (!r.ok) return;
      const j = await r.json();
      setSaved((j.saved ?? []).map((p: any) => ({ id: p.id, name: p.name, description: p.description ?? "", config: p.config })));
    } catch { /* offline */ }
  }, [s.surveyDbId, canServer]);
  React.useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!name.trim()) return;
    if (!canServer) { setMsg("Saving profiles needs a saved survey (not the sandbox)."); return; }
    const r = await fetch(`/api/surveys/${s.surveyDbId}/quality/profiles`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim(), config: { ...cfg, profile: name.trim() } }) });
    const j = await r.json();
    setMsg(r.ok ? `Saved “${name.trim()}”` : j.error ?? "Could not save");
    if (r.ok) { setName(""); void load(); }
  };

  return (
    <div className="f" style={{ minWidth: 260 }} data-testid="quality-profiles">
      <span>Quality profile{cfg.profile ? ` — ${cfg.profile}` : ""}</span>
      <select className="select" data-testid="quality-profile-select" value="" onChange={(e) => {
        const p = [...BUILTIN_PROFILES, ...saved].find((x) => x.id === e.target.value);
        if (p) onApply(p);
      }}>
        <option value="">Apply a profile…</option>
        <optgroup label="Built-in">{BUILTIN_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
        {saved.length > 0 && <optgroup label="Saved">{saved.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
      </select>
      <div className="row" style={{ marginTop: 4 }}>
        <input className="input grow" data-testid="quality-profile-name" placeholder="Save current settings as…" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn small" data-testid="quality-profile-save" disabled={!name.trim()} onClick={save}>Save</button>
      </div>
      {msg && <span className="muted" style={{ fontSize: 11 }}>{msg}</span>}
    </div>
  );
}

/* ================================================================ attention summary */

function AttentionSummary() {
  const s = useStudio();
  const checks = s.def.questions.filter((q) => q.attentionCheck);
  return (
    <div data-testid="quality-attention-summary">
      {checks.length === 0 ? (
        <p className="muted" style={{ fontSize: 11, marginTop: -4 }}>
          No attention checks yet. Open a question and tick <strong>Attention check</strong> in its editor to grade it — explicit,
          instruction-following, trap (impossible option), reverse-worded, repeated question or knowledge test.
        </p>
      ) : (
        <ul style={{ fontSize: 12, margin: "0 0 8px 16px" }}>
          {checks.map((q) => (
            <li key={q.id}>
              <span className="mono">{q.code}</span> · {q.attentionCheck!.kind} · expects {q.attentionCheck!.expected.map(String).join(", ") || "—"} · {q.attentionCheck!.severity}, +{q.attentionCheck!.riskPoints} risk
              <button className="btn small ghost" style={{ marginLeft: 6 }} onClick={() => s.select(q.id)}>open</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
