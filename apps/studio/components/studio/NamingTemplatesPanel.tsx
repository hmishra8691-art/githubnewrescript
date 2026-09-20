"use client";
import React from "react";
import type { NamingTemplate } from "@rescript/schema";
import {
  planTemplateRename,
  applyTemplateRename,
  STARTER_TEMPLATES,
  TEMPLATE_TOKENS,
} from "@rescript/engine";
import { useStudio, uid } from "./store";

/**
 * VARIABLE NAMING STANDARDS (§44, phase 3).
 *
 * A team's convention, saved on the study and applied to the whole
 * questionnaire at once. The plan is always shown before anything happens,
 * because this is the single most destructive button in the Studio: it
 * renames every variable in the survey, and a naming standard applied to the
 * wrong questions is worse than none.
 *
 * Nothing is applied that the engine has not cleared. The Apply button is
 * disabled while `plan.blockers` is non-empty, and `applyTemplateRename`
 * throws on a blocked plan as well — the check is in two places on purpose,
 * because the one in the UI is the one that can drift.
 */
export function NamingTemplatesPanel() {
  const s = useStudio();
  const saved: NamingTemplate[] = s.def.namingTemplates ?? [];

  const [pattern, setPattern] = React.useState("Q{number}");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [skipped, setSkipped] = React.useState<Set<string>>(new Set());

  /*
   * TWO PLANS, deliberately.
   *
   * `preview` covers every question, so the table always has a row for each
   * one and a question you skipped can be put back. `plan` covers only the
   * included ones and is what actually runs — its blockers are the ones that
   * matter, since a clash with a question you excluded is not a clash.
   *
   * Computing only the second one made unchecking a row delete it from the
   * table, which left no way to re-include it.
   */
  const preview = React.useMemo(() => {
    if (!pattern.trim()) return null;
    try { return planTemplateRename(s.def, pattern); } catch { return null; }
  }, [s.def, pattern]);

  const plan = React.useMemo(() => {
    if (!pattern.trim()) return null;
    const ids = s.def.questions.map((q) => q.id).filter((id) => !skipped.has(id));
    try {
      return planTemplateRename(s.def, pattern, { questionIds: ids });
    } catch {
      return null;
    }
  }, [s.def, pattern, skipped]);

  const changing = (plan?.steps ?? []).filter((x) => x.changed);

  const saveTemplate = () => {
    const name = pattern;
    s.labelNextEdit("save naming template");
    s.update((d) => {
      (d.namingTemplates ??= []).push({ id: uid("tpl"), name, pattern });
    });
  };
  const updateTemplate = (id: string, patch: Partial<NamingTemplate>) => {
    s.labelNextEdit("edit naming template");
    s.update((d) => {
      const t = (d.namingTemplates ?? []).find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    });
  };
  const duplicateTemplate = (t: NamingTemplate) => {
    s.labelNextEdit("duplicate naming template");
    s.update((d) => {
      (d.namingTemplates ??= []).push({ ...t, id: uid("tpl"), name: `${t.name} copy` });
    });
  };
  const removeTemplate = (id: string) => {
    s.labelNextEdit("delete naming template");
    s.update((d) => { d.namingTemplates = (d.namingTemplates ?? []).filter((x) => x.id !== id); });
  };

  const apply = () => {
    if (!plan || plan.blockers.length) return;
    s.labelNextEdit(`apply naming template ${pattern}`);
    s.update((d) => {
      const next = applyTemplateRename(d, plan);
      for (const k of Object.keys(d)) delete (d as any)[k];
      Object.assign(d, next);
    });
    setSkipped(new Set());
  };

  return (
    <div data-testid="naming-panel">
      <p className="muted" style={{ fontSize: 13 }}>
        A naming convention for this study. The pattern names each question&rsquo;s variable; the
        derived columns keep their own suffixes, so <span className="mono">Q3</span> still produces{" "}
        <span className="mono">Q3_1</span> and <span className="mono">Q3_R2</span>. Every rule, pipe
        and expression is rewritten to follow.
      </p>

      {/* ------------------------------------------------------- the pattern */}
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 10 }}>
        <label className="f" style={{ flex: "1 1 260px", marginBottom: 0 }}>
          <span>Pattern</span>
          <input className="input mono" data-testid="naming-pattern"
            value={pattern} onChange={(e) => setPattern(e.target.value)} />
        </label>
        <button className="btn small" data-testid="naming-save" onClick={saveTemplate}>Save as template</button>
        <button className="btn small primary" data-testid="naming-apply"
          disabled={!plan || plan.blockers.length > 0 || changing.length === 0}
          onClick={apply}>
          Apply to {changing.length} variable{changing.length === 1 ? "" : "s"}
        </button>
      </div>

      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12 }}>Tokens:</span>
        {TEMPLATE_TOKENS.map((t) => (
          <button key={t.token} className="btn small mono" title={t.describes}
            data-testid={`token-${t.token.replace(/[{}]/g, "")}`}
            onClick={() => setPattern((p) => p + t.token)}>{t.token}</button>
        ))}
      </div>

      {/* ------------------------------------------------------ saved ones */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>Saved templates</div>
        {saved.length === 0 && (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }} data-testid="starter-templates">
            <span className="muted" style={{ fontSize: 12 }}>None saved yet — start from one of these:</span>
            {STARTER_TEMPLATES.map((t) => (
              <button key={t.id} className="btn small" title={t.notes ?? t.pattern}
                onClick={() => { setPattern(t.pattern); setSelectedId(null); }}>{t.name}</button>
            ))}
          </div>
        )}
        {saved.map((t) => (
          <div key={t.id} className="row" data-testid="saved-template" style={{ gap: 6, marginBottom: 4, flexWrap: "wrap" }}>
            <input className="input" style={{ width: 200 }} value={t.name}
              data-testid="template-name"
              onChange={(e) => updateTemplate(t.id, { name: e.target.value })} />
            <input className="input mono" style={{ width: 220 }} value={t.pattern}
              data-testid="template-pattern"
              onChange={(e) => updateTemplate(t.id, { pattern: e.target.value })} />
            <button className="btn small" data-testid="template-use"
              onClick={() => { setPattern(t.pattern); setSelectedId(t.id); }}>Use</button>
            <button className="btn small" data-testid="template-duplicate"
              onClick={() => duplicateTemplate(t)}>Duplicate</button>
            <button className="btn small" data-testid="template-delete"
              onClick={() => removeTemplate(t.id)}>Delete</button>
            {selectedId === t.id && <span className="chip">in the box</span>}
          </div>
        ))}
      </div>

      {/* ------------------------------------------------------- the plan */}
      {plan && preview && (
        <div data-testid="naming-plan">
          {plan.blockers.map((b, i) => (
            <div key={`b${i}`} className="chip warn" data-testid="naming-blocker"
              style={{ display: "block", marginBottom: 4 }}>{b}</div>
          ))}
          {plan.warnings.map((w, i) => (
            <div key={`w${i}`} className="muted" data-testid="naming-warning" style={{ marginBottom: 4, fontSize: 12.5 }}>⚠ {w}</div>
          ))}

          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="grid">
              <thead>
                <tr><th style={{ width: 40 }} /><th>Question</th><th>Now</th><th>Becomes</th></tr>
              </thead>
              <tbody>
                {preview.steps.map((step) => (
                  <tr key={step.questionId} data-testid="naming-step"
                    style={{ opacity: skipped.has(step.questionId) ? 0.45 : 1 }}>
                    <td>
                      <input type="checkbox" data-testid="naming-step-include"
                        checked={!skipped.has(step.questionId)}
                        onChange={(e) => setSkipped((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.delete(step.questionId);
                          else next.add(step.questionId);
                          return next;
                        })} />
                    </td>
                    <td>{step.code}</td>
                    <td className="mono">{step.from}</td>
                    <td className="mono">
                      {step.changed
                        ? <strong data-testid="naming-step-to">{step.to}</strong>
                        : <span className="muted">unchanged</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
