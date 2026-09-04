"use client";
import React from "react";
import type { CustomQualityRule, QualityClass, QualityConfig, RuleSetting, Severity, Strictness } from "@rescript/schema";
import { QualityConfig as QualityConfigSchema } from "@rescript/schema";
import { RULES, CATEGORY_LABELS, BUILTIN_PROFILES, SYSTEM_VARIABLE_HELP, configFingerprint, type RuleDef, type QualityProfile } from "@rescript/quality";
import { useStudio, uid } from "./store";
import { ConditionEditor } from "./ConditionBuilder";
import { CountInput } from "./CountInput";

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
 * and versions with it — there is no separate save path for these settings.
 * The status line at the top is the store's own save state, shown here so a
 * failed autosave is visible beside the controls it concerns, not only in the
 * header. "Preview rule impact" asks the server to re-assess the survey's
 * responses with the settings just saved and reports which settings ran.
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
const TELEMETRY: [keyof QualityConfig["telemetry"], string, string][] = [
  ["timing", "Page & question timing", "how long each page and question took"],
  ["focus", "Tab focus / blur", "how often and how long the tab lost focus"],
  ["clipboard", "Copy / paste counts", "counts and lengths only — never the text"],
  ["navigation", "Navigation sequence", "the order pages were visited, back moves, reloads"],
  ["interaction", "Pointer / key / scroll counts", "totals only — never positions or keys"],
  ["device", "Device class", "browser, OS, screen, timezone, language"],
  ["network", "Hashed IP address", "salted hash for duplicate detection — never the address"],
];

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

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
  const hash = configFingerprint(cfg);

  const previewImpact = async () => {
    if (!s.surveyDbId || s.surveyDbId === "sandbox") { setImpact({ busy: false, error: "Preview needs a saved survey with responses (not available in the sandbox)." }); return; }
    setImpact({ busy: true });
    // the recompute reads the saved draft — make sure it holds what is on screen
    const saved = await s.flushDraft();
    if (!saved && s.saveState.kind !== "clean" && s.saveState.kind !== "saved") {
      setImpact({ busy: false, error: "Your latest settings could not be saved, so nothing was re-assessed. Fix the save first (see the status above)." });
      return;
    }
    try {
      const res = await fetch(`/api/surveys/${s.surveyDbId}/quality/recompute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ include: "all", source: "draft" }), cache: "no-store" });
      const j = await res.json();
      if (!res.ok) setImpact({ busy: false, error: j.error ?? `HTTP ${res.status}` });
      else setImpact({ busy: false, result: j });
    } catch (e) { setImpact({ busy: false, error: (e as Error).message }); }
  };

  return (
    <div data-testid="quality-settings" className="qs">
      <div className="qs-head">
        <h3 className="sec" style={{ margin: 0 }}>Quality checks</h3>
        <SaveStatus />
      </div>
      <label className="qs-master">
        <input type="checkbox" data-testid="quality-enabled" checked={cfg.enabled}
          onChange={(e) => set("toggle quality checks", (q) => { q.enabled = e.target.checked; })} />
        <span>
          <strong>Enable Response Quality Checks</strong>
          <span className="qs-help">
            While enabled, the runtime records behavioural metadata (timing, focus, copy/paste counts, navigation, device
            class — never clipboard contents or raw IP) and every finished response is scored the moment it is submitted: a
            <strong> Quality score</strong> (100 = best) and a separate <strong>Fraud risk</strong> (100 = most suspicious), a
            classification from the bands below, and an explanation for every flag. Nothing is ever removed automatically —
            decisions are yours, in Data → Quality.
          </span>
        </span>
      </label>

      {cfg.enabled && (
        <>
          {/* ------------------------------------------------ strictness + profiles */}
          <div className="qs-grid2">
            <label className="f"><span>Quality strictness</span>
              <select className="select" data-testid="quality-strictness" value={cfg.strictness}
                onChange={(e) => set("set strictness", (q) => { q.strictness = e.target.value as Strictness; })}>
                {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
              <span className="qs-help">{LEVELS.find((l) => l.value === cfg.strictness)?.hint}</span>
            </label>
            <ProfilePicker cfg={cfg} onApply={(p) => set(`apply profile ${p.name}`, (q) => {
              const merged = QualityConfigSchema.parse({ ...q, ...p.config, enabled: true, profile: p.name, rules: { ...(p.config.rules ?? {}) }, customRules: p.config.customRules ?? q.customRules });
              Object.assign(q, merged);
            })} />
          </div>

          {/* ------------------------------------------------ bands */}
          <h3 className="sec">Classification bands <span className="qs-sec-sub">fraud risk 0–100</span></h3>
          <Bands cfg={cfg} onChange={(b) => set("edit classification bands", (q) => { q.bands = b; })} />

          {/* ------------------------------------------------ rules */}
          <h3 className="sec">Rules</h3>
          <p className="qs-help">
            Defaults shown are for <strong>{LEVELS.find((l) => l.value === level)?.label}</strong>. Change anything here and the survey
            keeps your value; “Reset” returns a rule to the preset. Weight multiplies a rule's risk points; severity scales them too.
            {cfg.strictness !== "custom" && " Editing a rule does not switch the strictness to Custom — presets and overrides layer."}
          </p>
          <div className="qs-cats">
            {CATEGORY_ORDER.map((cat) => {
              const rules = RULES.filter((r) => r.category === cat);
              if (!rules.length) return null;
              const open = openCats[cat] ?? false;
              const overridden = rules.filter((r) => cfg.rules[r.id] && Object.keys(cfg.rules[r.id]).length).length;
              const active = rules.filter((r) => cfg.rules[r.id]?.enabled ?? r.enabledIn[level]).length;
              return (
                <div key={cat} className={`qs-cat ${open ? "open" : ""}`} data-testid={`qrules-${cat}`}>
                  <div className="row qs-cat-head" role="button" tabIndex={0} aria-expanded={open}
                    onClick={() => setOpenCats((o) => ({ ...o, [cat]: !open }))}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenCats((o) => ({ ...o, [cat]: !open })); } }}>
                    <span className="qs-caret" aria-hidden>{open ? "▾" : "▸"}</span>
                    <strong>{CATEGORY_LABELS[cat]}</strong>
                    <span className="qs-cat-meta">
                      <span className={`chip ${active ? "on" : ""}`}>{active} of {rules.length} on</span>
                      {overridden > 0 && <span className="chip">{overridden} customised</span>}
                    </span>
                  </div>
                  {open && (
                    <div className="qs-cat-body">
                      {rules.map((r) => (
                        <RuleRow key={r.id} rule={r} level={level} setting={cfg.rules[r.id]} questions={s.def.questions}
                          onChange={(next) => set(`edit rule ${r.title}`, (q) => { if (next) q.rules[r.id] = next; else delete q.rules[r.id]; })} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ------------------------------------------------ custom rules */}
          <h3 className="sec">Custom rules</h3>
          <p className="qs-help">
            Your own IF … THEN rules over the answers and the quality metrics — the same condition builder and expression syntax as
            display logic. Metrics are available as calculations: <span className="mono">calc.SYSTEM_DURATION_RATIO &lt; 0.3 AND calc.SYSTEM_ATTENTION_FAILED &gt;= 1</span>.
          </p>
          {cfg.customRules.map((cr, i) => (
            <CustomRuleRow key={cr.id} rule={cr}
              onChange={(next) => set(`edit custom rule ${cr.name}`, (q) => { q.customRules[i] = next; })}
              onRemove={() => set("remove custom rule", (q) => { q.customRules.splice(i, 1); })} />
          ))}
          <div className="qs-custom-foot">
            <button className="btn small" data-testid="qcustom-add" onClick={() => set("add custom rule", (q) => {
              q.customRules.push({
                id: uid("qr"), name: `Rule ${q.customRules.length + 1}`, enabled: true, severity: "medium", riskPoints: 20, qualityPenalty: 10, questionIds: [],
                when: { type: "group", op: "and", children: [{ type: "rule", source: { kind: "calculation", ref: "SYSTEM_DURATION_RATIO" }, operator: "lt", value: 0.3 }] },
              });
            })}>+ Custom rule</button>
            <details className="qs-details">
              <summary>System variables you can test</summary>
              <div className="table-wrap">
                <table className="grid qs-sysvars"><tbody>
                  {SYSTEM_VARIABLE_HELP.map((v) => <tr key={v.name}><td className="mono">calc.{v.name}</td><td className="muted">{v.hint}</td></tr>)}
                </tbody></table>
              </div>
            </details>
          </div>

          {/* ------------------------------------------------ attention checks */}
          <h3 className="sec">Attention checks</h3>
          <AttentionSummary />

          {/* ------------------------------------------------ telemetry & privacy */}
          <h3 className="sec">Telemetry &amp; privacy</h3>
          <p className="qs-help">
            Everything recorded is derived metadata. Switch off anything your study or jurisdiction does not permit — rules that
            need it are skipped, never failed.
          </p>
          <div className="qs-telemetry">
            {TELEMETRY.map(([k, label, hint]) => (
              <label key={k} className="qs-check" title={hint}>
                <input type="checkbox" data-testid={`qtel-${k}`} checked={(cfg.telemetry as any)[k] !== false}
                  onChange={(e) => set(`telemetry ${k}`, (q) => { (q.telemetry as any)[k] = e.target.checked; })} />
                <span>{label}<span className="qs-help">{hint}</span></span>
              </label>
            ))}
          </div>
          <label className="f"><span>Disclosure shown to respondents (optional)</span>
            <input className="input" data-testid="qtel-disclosure" value={cfg.telemetry.disclosure ?? ""}
              placeholder="This survey records response timing and navigation to protect data quality."
              onChange={(e) => set("edit disclosure", (q) => { q.telemetry.disclosure = e.target.value || undefined; })} /></label>
          <div className="qs-grid2">
            <label className="f"><span>Keep raw telemetry for (days)</span>
              <CountInput className="input" min={0} max={3650} width={140} allowEmpty={false} data-testid="qpriv-retention" value={cfg.privacy.telemetryRetentionDays}
                onChange={(v) => set("edit retention", (q) => { q.privacy.telemetryRetentionDays = v ?? 0; })} />
              <span className="qs-help">0 keeps it. Scores are kept regardless.</span>
            </label>
            <label className="f"><span>Peers compared for duplicates &amp; clusters</span>
              <CountInput className="input" min={50} max={20000} width={140} allowEmpty={false} data-testid="q-maxpeers" value={cfg.maxPeers}
                onChange={(v) => set("edit max peers", (q) => { q.maxPeers = v ?? 3000; })} />
              <span className="qs-help">Newest completes considered (50–20,000; default 3,000).</span>
            </label>
          </div>
          <label className="qs-check">
            <input type="checkbox" data-testid="qpriv-longitudinal" checked={cfg.privacy.longitudinal}
              onChange={(e) => set("toggle longitudinal", (q) => { q.privacy.longitudinal = e.target.checked; })} />
            <span>Link quality history across studies<span className="qs-help">Same external respondent id; needs consent.</span></span>
          </label>

          {/* ------------------------------------------------ impact */}
          <h3 className="sec">Preview rule impact</h3>
          <div className="qs-impact">
            <button className="btn small" data-testid="q-preview-impact" disabled={impact.busy} onClick={previewImpact}>
              {impact.busy ? "Re-assessing…" : "↻ Re-assess existing responses with these settings"}
            </button>
            <span className="qs-help">Recomputes every finished response (test and live) with the settings saved above. Decisions you have made are kept.</span>
          </div>
          {impact.error && <div className="chip warn qs-block-chip" data-testid="q-impact-error">{impact.error}</div>}
          {impact.result && (
            <div className="card qs-impact-result" data-testid="q-impact-result">
              {Object.entries(impact.result.results ?? {}).map(([mode, r]: [string, any]) => (
                <div key={mode} className="qs-impact-row">
                  <strong>{mode}</strong>
                  <span>{r.assessed} assessed</span>
                  {CLASSES.map((c) => <span key={c} className="chip">{c.replace("_", " ")} {r.byClass?.[c] ?? 0}</span>)}
                </div>
              ))}
              <div className="qs-help" data-testid="q-impact-config">
                Ran with {impact.result.strictness} strictness from the {impact.result.source === "draft" ? "autosaved draft" : `saved version ${impact.result.version ?? ""}`}
                {typeof impact.result.revision === "number" ? ` (rev ${impact.result.revision})` : ""} · settings {impact.result.configHash}
                {impact.result.configHash && impact.result.configHash !== hash ? " — differs from what is on screen now; save and re-run" : " — matches this screen"} · {impact.result.ms} ms
              </div>
            </div>
          )}
          <p className="qs-foot" data-testid="q-config-fingerprint" data-config-hash={hash}>
            Settings fingerprint <span className="mono">{hash}</span> — Data → Quality shows the fingerprint of the saved settings and every
            assessment records the one it ran with, so the three can be compared. Test links use the saved draft at once; the live link
            follows <strong>Save version</strong> + <strong>Publish</strong>.
          </p>
        </>
      )}
    </div>
  );
}

/* ================================================================ save status */

/**
 * The draft autosave, as it concerns these settings: the store's save state
 * rendered beside the controls. Saving → saved (with time) → or a failure
 * that names itself and offers Retry. Never a tick over unsaved work.
 */
function SaveStatus() {
  const s = useStudio();
  const st = s.saveState;
  if (s.surveyDbId === "sandbox") return <span className="qs-save" data-testid="quality-save-state">Sandbox — settings live in this tab only</span>;
  switch (st.kind) {
    case "saving": return <span className="qs-save saving" data-testid="quality-save-state" data-state="saving">Saving…</span>;
    case "dirty": return <span className="qs-save dirty" data-testid="quality-save-state" data-state="dirty">● Unsaved — autosaving</span>;
    case "saved": return <span className="qs-save ok" data-testid="quality-save-state" data-state="saved">✓ Saved {fmtTime(st.savedAt)}</span>;
    case "error": return (
      <span className="qs-save err" data-testid="quality-save-state" data-state="error" title={st.message}>
        ⚠ Not saved — {st.message.slice(0, 80)}
        <button className="btn small" data-testid="quality-save-retry" onClick={() => void s.flushDraft()}>Retry</button>
      </span>
    );
    case "conflict": return (
      <span className="qs-save err" data-testid="quality-save-state" data-state="conflict" title={st.message}>
        ⚠ Changed elsewhere — not saved
        <button className="btn small" onClick={() => window.location.reload()}>Reload</button>
      </span>
    );
    case "unavailable": return <span className="qs-save warn" data-testid="quality-save-state" data-state="unavailable" title={st.message}>⚠ Autosave off — use Save version</span>;
    case "clean":
    default:
      return st.savedAt
        ? <span className="qs-save ok" data-testid="quality-save-state" data-state="clean">✓ Saved {fmtTime(st.savedAt)}</span>
        : <span className="qs-save" data-testid="quality-save-state" data-state="clean">No unsaved changes</span>;
  }
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
    <div data-testid="quality-bands" className="qs-bands">
      <div className="qs-bandbar">
        {segs.map(([name, from, to, color]) => (
          <div key={name} title={`${name.replace("_", " ")}: ${from}–${to}`} style={{ width: `${Math.max(0, to - from)}%`, background: color }}>
            {to - from >= 12 ? name.replace("HIGHLY_", "H. ") : ""}
          </div>
        ))}
      </div>
      <div className="qs-bandfields">
        {([["review", "Review from"], ["suspicious", "Suspicious from"], ["highlySuspicious", "Highly suspicious from"], ["critical", "Critical from"]] as [keyof QualityConfig["bands"], string][]).map(([k, label]) => (
          <label key={k} className="f"><span>{label}</span>
            <CountInput className="input" min={0} max={100} width={110} allowEmpty={false} data-testid={`qband-${k}`} value={b[k]} onChange={(v) => setB(k, v ?? 0)} /></label>
        ))}
      </div>
      <div className="qs-help">Default: 0–19 clean · 20–39 review · 40–59 suspicious · 60–79 highly suspicious · 80–100 critical.</div>
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
    <div className={`qrule ${enabled ? "" : "off"}`} data-testid={`qrule-${rule.id}`}>
      <div className="qrule-head">
        <input type="checkbox" data-testid="qrule-enabled" checked={enabled} aria-label={`${rule.title} on`}
          onChange={(e) => patch({ enabled: e.target.checked === rule.enabledIn[level] ? undefined : e.target.checked })} />
        <button type="button" className="qrule-title" onClick={() => setOpen((o) => !o)} title={rule.description}>
          {rule.title}
          {customised && <span className="chip">customised</span>}
          {!enabled && <span className="chip">off</span>}
        </button>
        <span className="qrule-points">+{rule.riskPoints} risk · −{rule.qualityPenalty} quality</span>
        <button type="button" className="btn small ghost" onClick={() => setOpen((o) => !o)}>{open ? "hide" : "edit"}</button>
      </div>
      {open && (
        <div className="qrule-body">
          <div className="qs-help">{rule.description}</div>
          <div className="qrule-fields">
            <label className="f"><span>Severity</span>
              <select className="select" data-testid="qrule-severity" value={setting?.severity ?? rule.defaultSeverity}
                onChange={(e) => patch({ severity: e.target.value === rule.defaultSeverity ? undefined : (e.target.value as Severity) })}>
                {SEVERITIES.map((sv) => <option key={sv} value={sv}>{sv}{sv === rule.defaultSeverity ? " (default)" : ""}</option>)}
              </select></label>
            <label className="f"><span>Risk weight</span>
              <input className="input" type="number" step={0.1} min={0} max={5} data-testid="qrule-weight" value={setting?.weight ?? 1}
                onChange={(e) => patch({ weight: Number(e.target.value) === 1 ? undefined : Number(e.target.value) })} /></label>
            <label className="f"><span>Quality weight</span>
              <input className="input" type="number" step={0.1} min={0} max={5} value={setting?.qualityWeight ?? 1}
                onChange={(e) => patch({ qualityWeight: Number(e.target.value) === 1 ? undefined : Number(e.target.value) })} /></label>
            {rule.params.map((p) => {
              const dflt = p.defaults[level];
              const cur = setting?.params?.[p.key];
              return (
                <label key={p.key} className={`f ${typeof dflt === "boolean" ? "qs-check-field" : ""} ${p.label.length > 24 ? "qs-wide" : ""}`} title={p.hint ?? ""}>
                  <span>{p.label}{p.unit ? ` (${p.unit})` : ""}</span>
                  {typeof dflt === "boolean" ? (
                    <span className="qs-check-inline">
                      <input type="checkbox" checked={(cur ?? dflt) as boolean} onChange={(e) => patch({ params: { ...(setting?.params ?? {}), [p.key]: e.target.checked } })} />
                      <span className="muted">{(cur ?? dflt) ? "on" : "off"}{cur === undefined ? " (preset)" : ""}</span>
                    </span>
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
          {customised && <button type="button" className="btn small" data-testid="qrule-reset" onClick={() => onChange(undefined)}>Reset to preset</button>}
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
    <details className="qs-details">
      <summary>Apply to specific questions{ids.length ? ` (${ids.length} selected)` : " (all)"}</summary>
      <div className="qs-chips">
        {questions.map((q) => (
          <label key={q.id} className={`chip qs-chip-check ${ids.includes(q.id) ? "on" : ""}`}>
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
    <div className={`card qs-custom ${rule.enabled ? "" : "off"}`} data-testid="qcustom-rule">
      <div className="row qs-custom-head">
        <input type="checkbox" checked={rule.enabled} aria-label="Rule enabled" onChange={(e) => onChange({ ...rule, enabled: e.target.checked })} />
        <input className="input grow" data-testid="qcustom-name" value={rule.name} onChange={(e) => onChange({ ...rule, name: e.target.value })} placeholder="Rule name" />
        <button type="button" className="btn small danger" data-testid="qcustom-remove" onClick={onRemove} title="Remove this rule">Remove</button>
      </div>
      <div className="qs-custom-when">
        <span className="flabel">IF</span>
        <ConditionEditor value={rule.when} onChange={(when) => onChange({ ...rule, when })} />
      </div>
      <div className="qs-custom-then">
        <span className="flabel">THEN</span>
        <div className="qrule-fields">
          <label className="f"><span>Add fraud risk</span>
            <CountInput className="input" min={0} max={100} width={110} allowEmpty={false} data-testid="qcustom-risk" value={rule.riskPoints} onChange={(v) => onChange({ ...rule, riskPoints: v ?? 0 })} /></label>
          <label className="f"><span>Quality penalty</span>
            <CountInput className="input" min={0} max={100} width={110} allowEmpty={false} value={rule.qualityPenalty} onChange={(v) => onChange({ ...rule, qualityPenalty: v ?? 0 })} /></label>
          <label className="f"><span>Severity</span>
            <select className="select" value={rule.severity} onChange={(e) => onChange({ ...rule, severity: e.target.value as Severity })}>{SEVERITIES.map((sv) => <option key={sv}>{sv}</option>)}</select></label>
          <label className="f qs-wide"><span>At least classification</span>
            <select className="select" data-testid="qcustom-minclass" value={rule.minClass ?? ""} onChange={(e) => onChange({ ...rule, minClass: (e.target.value || undefined) as QualityClass | undefined })}>
              <option value="">— from the score —</option>{CLASSES.slice(1).map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
            </select></label>
        </div>
      </div>
      <label className="f"><span>Explanation shown to the researcher</span>
        <input className="input" value={rule.explanation ?? ""} placeholder={`Custom rule “${rule.name}” matched.`} onChange={(e) => onChange({ ...rule, explanation: e.target.value || undefined })} /></label>
      <details className="qs-details">
        <summary>Related questions{rule.questionIds.length ? ` (${rule.questionIds.length})` : ""}</summary>
        <div className="qs-chips">
          {s.def.questions.map((q) => (
            <label key={q.id} className={`chip qs-chip-check ${rule.questionIds.includes(q.id) ? "on" : ""}`}>
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
  const [msg, setMsg] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const canServer = !!s.surveyDbId && s.surveyDbId !== "sandbox";
  const load = React.useCallback(async () => {
    if (!canServer) return;
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/quality/profiles`, { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setSaved((j.saved ?? []).map((p: any) => ({ id: p.id, name: p.name, description: p.description ?? "", config: p.config })));
    } catch { /* offline */ }
  }, [s.surveyDbId, canServer]);
  React.useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!name.trim()) return;
    if (!canServer) { setMsg({ text: "Saving profiles needs a saved survey (not the sandbox).", ok: false }); return; }
    setBusy(true);
    try {
      const r = await fetch(`/api/surveys/${s.surveyDbId}/quality/profiles`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim(), config: { ...cfg, profile: name.trim() } }) });
      const j = await r.json().catch(() => ({}));
      setMsg(r.ok ? { text: `Saved profile “${name.trim()}”`, ok: true } : { text: j.error ?? `Could not save (HTTP ${r.status})`, ok: false });
      if (r.ok) { setName(""); void load(); }
    } catch (e) { setMsg({ text: (e as Error).message || "Could not save", ok: false }); }
    finally { setBusy(false); }
  };

  return (
    <div className="f qs-profile" data-testid="quality-profiles">
      <span>Quality profile{cfg.profile ? <span className="qs-profile-name"> — {cfg.profile}</span> : ""}</span>
      <select className="select" data-testid="quality-profile-select" value="" onChange={(e) => {
        const p = [...BUILTIN_PROFILES, ...saved].find((x) => x.id === e.target.value);
        if (p) onApply(p);
      }}>
        <option value="">Apply a profile…</option>
        <optgroup label="Built-in">{BUILTIN_PROFILES.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
        {saved.length > 0 && <optgroup label="Saved">{saved.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>}
      </select>
      <div className="row qs-profile-save">
        <input className="input grow" data-testid="quality-profile-name" placeholder="Save current settings as…" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="btn small" data-testid="quality-profile-save" disabled={!name.trim() || busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
      </div>
      {msg && <span className={`qs-help ${msg.ok ? "ok" : "err"}`} data-testid="quality-profile-msg">{msg.text}</span>}
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
        <p className="qs-help">
          No attention checks yet. Open a question and tick <strong>Attention check</strong> in its editor to grade it — explicit,
          instruction-following, trap (impossible option), reverse-worded, repeated question or knowledge test.
        </p>
      ) : (
        <ul className="qs-attention">
          {checks.map((q) => (
            <li key={q.id}>
              <span className="mono">{q.code}</span> · {q.attentionCheck!.kind} · expects {q.attentionCheck!.expected.map(String).join(", ") || "—"} · {q.attentionCheck!.severity}, +{q.attentionCheck!.riskPoints} risk
              <button type="button" className="btn small ghost" onClick={() => s.select(q.id)}>open</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
