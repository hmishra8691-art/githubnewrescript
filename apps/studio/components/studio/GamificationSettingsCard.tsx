"use client";
import React from "react";
import type { Gamification } from "@rescript/schema";
import { Gamification as GamificationSchema, BADGE_ICONS } from "@rescript/schema";
import { badgeRule, lintGamification, BADGE_ICON_GLYPHS, conditionFromText } from "@rescript/engine";
import { useStudio } from "./store";

/**
 * GAMIFICATION — the survey-wide card (S5a, GA-06 / GA-07). One checkbox until it is ticked. Then: points per answer
 * and per correct answer (the answer key), an optional custom calculated variable added to the points, badges (a rule
 * → id, title, icon from the built-in set; earned once), levels by point thresholds, the HUD and its corner.
 * Everything lands in calculated variables POINTS / LEVEL / LEVEL_NAME / BADGES (+ POINTS_ANSWERED / POINTS_CORRECT),
 * exported with the response. IM: set_gamification.
 */
type Badge = Gamification["badges"][number];

function ruleText(b: Badge): string {
  const w = b.when as { type?: string; source?: { kind?: string; ref?: string }; operator?: string; value?: unknown };
  const ops: Record<string, string> = { gte: ">=", gt: ">", eq: "=", lte: "<=", lt: "<" };
  if (w?.type === "rule" && w.source?.kind === "calculation" && w.operator && ops[w.operator]) return `${w.source.ref} ${ops[w.operator]} ${String(w.value)}`;
  return "(condition)";
}

export function GamificationSettingsCard() {
  const s = useStudio();
  const g = s.def.gamification;
  const on = !!g && g.enabled !== false;
  const write = (next: Partial<Gamification> | null) => s.update((d) => {
    if (next === null) { if (d.gamification) d.gamification = { ...d.gamification, enabled: false }; return; }
    d.gamification = GamificationSchema.parse({ ...(d.gamification ?? {}), ...next });
  });
  const [draft, setDraft] = React.useState({ title: "", icon: "star" as Badge["icon"], rule: "POINTS >= 30" });
  const [err, setErr] = React.useState<string | null>(null);
  const addBadge = () => {
    if (!g) return;
    const title = draft.title.trim();
    if (!title) { setErr("Give the badge a title"); return; }
    const when = badgeRule(draft.rule) ?? conditionFromText(s.def, draft.rule, { strict: true }).condition;
    if (!when) { setErr(`Cannot read “${draft.rule}” — e.g. POINTS >= 30, POINTS_CORRECT >= 3, Q3 = 1`); return; }
    const id = title.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase().slice(0, 40) || `badge${g.badges.length + 1}`;
    if (g.badges.some((b) => b.id === id)) { setErr(`A badge “${id}” exists`); return; }
    setErr(null);
    write({ badges: [...g.badges, { id: /^[A-Za-z]/.test(id) ? id : `b_${id}`, title, icon: draft.icon, when }] });
    setDraft({ ...draft, title: "" });
  };
  const problems = g ? lintGamification(s.def) : [];
  return (
    <div className="card" style={{ padding: 10, marginTop: 8 }} data-testid="gamification-card">
      <label className="row" style={{ gap: 6 }}>
        <input type="checkbox" data-testid="gamification-on" checked={on}
          onChange={(e) => (e.target.checked ? write({ enabled: true }) : write(null))} />
        <b>Gamification</b> — points, badges and levels
      </label>
      {on && g && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "6px 10px", alignItems: "center" }}>
            <span className="flabel">Points per answered question</span>
            <input className="input" type="number" min={0} max={1000} style={{ width: 90 }} data-testid="gamification-per-answer" value={g.points.perAnswer}
              onChange={(e) => write({ points: { ...g.points, perAnswer: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) } })} />
            <span className="flabel">Points per correct answer (answer key)</span>
            <input className="input" type="number" min={0} max={1000} style={{ width: 90 }} data-testid="gamification-per-correct" value={g.points.perCorrect}
              onChange={(e) => write({ points: { ...g.points, perCorrect: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) } })} />
            <span className="flabel">Add a calculated variable</span>
            <select className="select" data-testid="gamification-custom" value={g.points.customVariable ?? ""}
              onChange={(e) => write({ points: { ...g.points, customVariable: e.target.value || undefined } })}>
              <option value="">(none)</option>
              {s.def.calculations.map((c) => <option key={c.id} value={c.targetVariable}>{c.targetVariable}</option>)}
            </select>
            <span className="flabel">Points display (HUD)</span>
            <span className="row" style={{ gap: 6 }}>
              <input type="checkbox" data-testid="gamification-hud" checked={g.hud.show} onChange={(e) => write({ hud: { ...g.hud, show: e.target.checked } })} />
              <select className="select" data-testid="gamification-hud-position" value={g.hud.position} onChange={(e) => write({ hud: { ...g.hud, position: e.target.value as Gamification["hud"]["position"] } })}>
                {(["top-right", "top-left", "bottom-right", "bottom-left"] as const).map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </span>
          </div>
          <div className="flabel" style={{ marginTop: 10 }}>Badges (earned once, shown in a popup)</div>
          {g.badges.map((b, i) => (
            <div key={b.id} className="row" style={{ gap: 6, marginBottom: 4 }} data-testid={`gamification-badge-${i}`}>
              <span aria-hidden>{BADGE_ICON_GLYPHS[b.icon]}</span><b>{b.title}</b><code style={{ fontSize: 12 }}>{ruleText(b)}</code>
              <button type="button" className="btn small danger" aria-label={`Remove badge ${b.title}`} onClick={() => write({ badges: g.badges.filter((x) => x.id !== b.id) })}>×</button>
            </div>
          ))}
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <input className="input" placeholder="Badge title" data-testid="gamification-badge-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <select className="select" data-testid="gamification-badge-icon" value={draft.icon} onChange={(e) => setDraft({ ...draft, icon: e.target.value as Badge["icon"] })}>
              {BADGE_ICONS.map((ic) => <option key={ic} value={ic}>{BADGE_ICON_GLYPHS[ic]} {ic}</option>)}
            </select>
            <input className="input" placeholder="When — e.g. POINTS >= 30" data-testid="gamification-badge-rule" value={draft.rule} onChange={(e) => setDraft({ ...draft, rule: e.target.value })} />
            <button type="button" className="btn small" data-testid="gamification-badge-add" onClick={addBadge}>+ Badge</button>
          </div>
          {err && <div className="muted" style={{ color: "var(--danger, #b91c1c)", fontSize: 12.5 }}>{err}</div>}
          <div className="flabel" style={{ marginTop: 10 }}>Levels (minimum points)</div>
          {g.levels.map((l, i) => (
            <div key={i} className="row" style={{ gap: 6, marginBottom: 4 }}>
              <input className="input" value={l.name} data-testid={`gamification-level-name-${i}`} onChange={(e) => write({ levels: g.levels.map((x, j) => (j === i ? { ...x, name: e.target.value || x.name } : x)) })} />
              <input className="input" type="number" min={0} style={{ width: 90 }} value={l.minPoints} onChange={(e) => write({ levels: g.levels.map((x, j) => (j === i ? { ...x, minPoints: Math.max(0, Number(e.target.value) || 0) } : x)) })} />
              <button type="button" className="btn small danger" aria-label={`Remove level ${l.name}`} onClick={() => write({ levels: g.levels.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button type="button" className="btn small" data-testid="gamification-level-add" onClick={() => write({ levels: [...g.levels, { name: `Level ${g.levels.length + 1}`, minPoints: (g.levels[g.levels.length - 1]?.minPoints ?? 0) + 50 }] })}>+ Level</button>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>Stored and exported as POINTS, POINTS_ANSWERED, POINTS_CORRECT, LEVEL, LEVEL_NAME and BADGES.</div>
          {problems.length > 0 && <ul className="muted" data-testid="gamification-problems" style={{ fontSize: 12.5, color: "var(--warn, #b45309)", margin: "6px 0 0 16px" }}>{problems.map((m) => <li key={m}>{m}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}
