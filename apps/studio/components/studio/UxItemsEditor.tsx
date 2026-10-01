"use client";
import React from "react";
import type { SurveyDefinition, UxAnimation, UxBehavior, UxRule, UxStyle, UxTarget } from "@rescript/schema";
import { UX_ANIMATION_TRIGGERS, UX_EVENTS, UX_MEDIA, UX_PRESETS, UX_STATES } from "@rescript/schema";
import { compileAnimation, compileStyle, describeUxTarget, uxDeclarations, validateUxItem } from "@rescript/engine";
import { useStudio, uid } from "./store";
import { OptionalCondition } from "./ConditionBuilder";

/**
 * THE MANUAL CONTROL LAYER for the survey's styles, animations, behaviours
 * and scripts — the same `def.ux` items the Intelligent copilot creates, the
 * runtime renders and the copilot's UX tab lists. There is one copy of each:
 * this edits it in place, through the same gate (`validateUxItem`) the
 * copilot's actions go through, as an ordinary undoable edit. So a script
 * the copilot wrote is here to read and change without another prompt, and
 * a change made here is what the next prompt (and the next respondent) sees.
 *
 * Mounted where each level of the survey is edited:
 *   question   Properties → "Styles, animations & scripts"
 *   option     Live View → option → Properties
 *   page/block the flow's page / block editor
 *   survey     Research tools → Branding
 */
export type UxScope =
  | { kind: "question"; questionId: string }
  | { kind: "option"; questionId: string; code: string }
  | { kind: "block"; blockId: string }
  | { kind: "page"; pageId: string }
  | { kind: "survey" };

type Kind = "style" | "animation" | "behavior";
type Item = { kind: Kind; item: UxStyle | UxAnimation | UxBehavior };

const empty = { styles: [], animations: [], behaviors: [] };
export function uxItemsFor(def: SurveyDefinition, scope: UxScope): Item[] {
  const ux = def.ux ?? empty;
  const match = (t: UxTarget) => {
    switch (scope.kind) {
      case "question": return t.questionId === scope.questionId;
      case "option": return t.questionId === scope.questionId && t.kind === "option" && (t.code == null || t.code === scope.code);
      case "block": return t.blockId === scope.blockId && !t.questionId;
      case "page": return t.pageId === scope.pageId && !t.questionId;
      case "survey": return !t.questionId && !t.blockId && !t.pageId;
    }
  };
  return [
    ...ux.styles.filter((x) => match(x.target)).map((item) => ({ kind: "style" as const, item })),
    ...ux.animations.filter((x) => match(x.target)).map((item) => ({ kind: "animation" as const, item })),
    ...ux.behaviors.filter((x) => match(x.target)).map((item) => ({ kind: "behavior" as const, item })),
  ];
}
const listOf = (kind: Kind) => (kind === "style" ? "styles" : kind === "animation" ? "animations" : "behaviors") as "styles";
const defaultTarget = (scope: UxScope): UxTarget =>
  scope.kind === "question" ? { kind: "question", questionId: scope.questionId }
    : scope.kind === "option" ? { kind: "option", questionId: scope.questionId, code: scope.code }
      : scope.kind === "block" ? { kind: "block", blockId: scope.blockId }
        : scope.kind === "page" ? { kind: "page", pageId: scope.pageId }
          : { kind: "survey" };

/** "border-radius: 12px;\npadding: 8px" ⇄ { "border-radius": "12px", padding: "8px" } */
export const declText = (d: Record<string, string>) => Object.entries(d).map(([k, v]) => `${k}: ${v};`).join("\n");
export function parseDecls(text: string): { decls: Record<string, string>; error?: string } {
  const decls: Record<string, string> = {};
  for (const raw of text.split(/;|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i <= 0) return { decls, error: `“${line}” is not “property: value”` };
    decls[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { decls: uxDeclarations(decls) };
}

export function UxItemsEditor({ scope, intro }: { scope: UxScope; intro?: string }) {
  const s = useStudio();
  const items = uxItemsFor(s.def, scope);
  const [draft, setDraft] = React.useState<Item | null>(null);
  const write = (kind: Kind, next: UxStyle | UxAnimation | UxBehavior, label: string): string[] => {
    const v = validateUxItem(s.def, kind, next);
    if (v.errors.length) return v.errors;
    s.labelNextEdit(label);
    s.update((d) => {
      d.ux = d.ux ?? { styles: [], animations: [], behaviors: [] };
      const list = d.ux[listOf(kind)] as (typeof next)[];
      const i = list.findIndex((x) => x.id === next.id);
      if (i >= 0) list[i] = next; else list.push(next);
    });
    return [];
  };
  const remove = (kind: Kind, id: string, label: string) => {
    s.labelNextEdit(`Remove ${kind === "behavior" ? "behaviour" : kind} “${label}”`);
    s.update((d) => { if (!d.ux) return; const list = d.ux[listOf(kind)] as { id: string }[]; const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1); });
  };
  const start = (kind: Kind, script = false) => {
    const target = defaultTarget(scope);
    const now = new Date().toISOString();
    const item: UxStyle | UxAnimation | UxBehavior = kind === "style"
      ? { id: uid("uxs"), label: "New style", target, rules: [{ declarations: {} }], createdAt: now }
      : kind === "animation"
        ? { id: uid("uxa"), label: "New animation", target, preset: "fade-up", trigger: "appear", durationMs: 400, delayMs: 0, easing: "ease-out", staggerMs: 0, iterations: 1, createdAt: now }
        : script
          ? { id: uid("uxb"), label: "New script", target, effects: [], script: `rs.listen("select", "self", (e) => {\n  rs.animate("self", "pop");\n});`, createdAt: now }
          : { id: uid("uxb"), label: "New behaviour", target, on: "answer", effects: [{ do: "animate", preset: "pulse" }], createdAt: now };
    setDraft({ kind, item });
  };
  return (
    <div className="ux-items" data-testid="ux-items" data-scope={scope.kind}>
      {intro && <p className="muted" style={{ fontSize: 11.5, margin: "0 0 6px" }}>{intro}</p>}
      {items.length === 0 && !draft && <p className="muted" style={{ fontSize: 11.5 }} data-testid="ux-items-empty">None yet. Add one here, or ask Intelligent mode (“make these options look like cards”) — either way it is the same setting, editable here.</p>}
      {items.map((x) => (
        <UxItemCard key={x.item.id} kind={x.kind} item={x.item} def={s.def} readOnly={s.readOnly}
          onSave={(next, label) => write(x.kind, next, label)} onRemove={() => remove(x.kind, x.item.id, x.item.label)} />
      ))}
      {draft && (
        <UxItemCard kind={draft.kind} item={draft.item} def={s.def} readOnly={s.readOnly} isNew
          onSave={(next) => { const e = write(draft.kind, next, `Add ${draft.kind === "behavior" ? "behaviour" : draft.kind} “${next.label}”`); if (!e.length) setDraft(null); return e; }}
          onRemove={() => setDraft(null)} />
      )}
      {!s.readOnly && !draft && (
        <div className="ux-add" data-testid="ux-add">
          <button type="button" className="btn sm" onClick={() => start("style")} data-testid="ux-add-style">+ Style</button>
          <button type="button" className="btn sm" onClick={() => start("animation")} data-testid="ux-add-animation">+ Animation</button>
          <button type="button" className="btn sm" onClick={() => start("behavior")} data-testid="ux-add-behavior">+ Behaviour</button>
          <button type="button" className="btn sm" onClick={() => start("behavior", true)} data-testid="ux-add-script">+ Script</button>
        </div>
      )}
    </div>
  );
}

/**
 * ONE ITEM, editable. Fields are held locally while typed; a change is
 * written to the survey when it passes the gate (text on blur, choices at
 * once) — an invalid state is shown with its reasons and never saved.
 */
function UxItemCard({ kind, item, def, onSave, onRemove, readOnly, isNew }: {
  kind: Kind; item: UxStyle | UxAnimation | UxBehavior; def: SurveyDefinition; readOnly: boolean; isNew?: boolean;
  onSave(next: UxStyle | UxAnimation | UxBehavior, label: string): string[];
  onRemove(): void;
}) {
  const [cur, setCur] = React.useState(item);
  const [errors, setErrors] = React.useState<string[]>([]);
  const [showCode, setShowCode] = React.useState(false);
  React.useEffect(() => { setCur(item); setErrors([]); }, [item]);
  const noun = kind === "behavior" ? ((item as UxBehavior).script ? "script" : "behaviour") : kind;
  const commit = (next: typeof cur, immediate = false) => {
    setCur(next);
    if (isNew && !immediate) return;
    if (isNew) return;
    const e = onSave(next, `Edit ${noun} “${next.label}”`);
    setErrors(e);
  };
  const save = () => { const e = onSave(cur, `Edit ${noun} “${cur.label}”`); setErrors(e); };
  const warnings = React.useMemo(() => validateUxItem(def, kind, cur).warnings, [def, kind, cur]);
  const code = kind === "style" ? compileStyle(def, cur as UxStyle).css : kind === "animation" ? compileAnimation(def, cur as UxAnimation) : (cur as UxBehavior).script ?? "";
  return (
    <div className="ux-item" data-testid="ux-item" data-kind={noun} data-id={item.id}>
      <div className="ux-item-head">
        <span className="ux-kind">{noun}</span>
        <input className="input sm" value={cur.label} disabled={readOnly} aria-label="Name"
          onChange={(e) => setCur({ ...cur, label: e.target.value })} onBlur={() => commit(cur)} data-testid="ux-item-label" />
        <button type="button" className="btn sm ghost" onClick={onRemove} disabled={readOnly} title={isNew ? "Discard" : "Remove"} data-testid="ux-item-remove">{isNew ? "Discard" : "Remove"}</button>
      </div>
      <div className="muted" style={{ fontSize: 11 }}>on {describeUxTarget(def, cur.target)}</div>
      {kind === "style" && <StyleFields style={cur as UxStyle} readOnly={readOnly} onChange={(n, now) => (now ? commit(n, true) : setCur(n))} onBlur={() => commit(cur)} />}
      {kind === "animation" && <AnimationFields a={cur as UxAnimation} readOnly={readOnly} onChange={(n) => commit(n, true)} />}
      {kind === "behavior" && <BehaviorFields b={cur as UxBehavior} readOnly={readOnly} onChange={(n, now) => (now ? commit(n, true) : setCur(n))} onBlur={() => commit(cur)} />}
      {errors.length > 0 && <ul className="ux-errors" role="alert" data-testid="ux-item-errors">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      {warnings.length > 0 && <ul className="ux-warnings" data-testid="ux-item-warnings">{warnings.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      <div className="ux-item-foot">
        <button type="button" className="btn sm ghost" onClick={() => setShowCode((v) => !v)} data-testid="ux-item-code-toggle">{showCode ? "Hide" : "Show"} generated {kind === "behavior" && (cur as UxBehavior).script ? "script" : "CSS"}</button>
        {isNew && <button type="button" className="btn sm primary" onClick={save} disabled={readOnly} data-testid="ux-item-save">Save</button>}
      </div>
      {showCode && <pre className="ux-code mono" data-testid="ux-item-code">{code || "(nothing yet)"}</pre>}
    </div>
  );
}

function StyleFields({ style, readOnly, onChange, onBlur }: { style: UxStyle; readOnly: boolean; onChange(n: UxStyle, now?: boolean): void; onBlur(): void }) {
  const setRule = (i: number, r: UxRule, now = false) => onChange({ ...style, rules: style.rules.map((x, k) => (k === i ? r : x)) }, now);
  return (
    <div className="ux-fields">
      {style.rules.map((r, i) => (
        <div key={i} className="ux-rule" data-testid="ux-rule">
          <div className="ux-row">
            <select className="input sm" value={r.state ?? ""} disabled={readOnly} onChange={(e) => setRule(i, { ...r, state: (e.target.value || undefined) as UxRule["state"] }, true)} aria-label="State" data-testid="ux-rule-state">
              <option value="">always</option>{UX_STATES.map((x) => <option key={x} value={x}>when {x}</option>)}
            </select>
            <select className="input sm" value={r.media ?? ""} disabled={readOnly} onChange={(e) => setRule(i, { ...r, media: (e.target.value || undefined) as UxRule["media"] }, true)} aria-label="Device" data-testid="ux-rule-media">
              <option value="">every device</option>{UX_MEDIA.map((x) => <option key={x} value={x}>{x.replace("_", " ")}</option>)}
            </select>
            <button type="button" className="btn sm ghost" disabled={readOnly} onClick={() => onChange({ ...style, rules: style.rules.filter((_, k) => k !== i) }, true)} title="Remove this rule">×</button>
          </div>
          <input className="input sm mono" placeholder="inside the target (optional), e.g. input[type=radio]" value={r.selector ?? ""} disabled={readOnly}
            onChange={(e) => setRule(i, { ...r, selector: e.target.value || undefined })} onBlur={onBlur} data-testid="ux-rule-selector" />
          <DeclArea value={r.declarations} readOnly={readOnly} onChange={(d) => setRule(i, { ...r, declarations: d })} onBlur={onBlur} />
        </div>
      ))}
      {!readOnly && <button type="button" className="btn sm ghost" onClick={() => onChange({ ...style, rules: [...style.rules, { declarations: {} }] })} data-testid="ux-add-rule">+ Rule</button>}
      <label className="f"><span>Scoped CSS (selectors relative to the target; &amp; is the target)</span>
        <textarea className="ta code" style={{ minHeight: 50 }} value={style.css ?? ""} disabled={readOnly} placeholder="& { … }"
          onChange={(e) => onChange({ ...style, css: e.target.value || undefined })} onBlur={onBlur} data-testid="ux-style-css" /></label>
    </div>
  );
}
function DeclArea({ value, readOnly, onChange, onBlur }: { value: Record<string, string>; readOnly: boolean; onChange(d: Record<string, string>): void; onBlur(): void }) {
  const [text, setText] = React.useState(declText(value));
  const [err, setErr] = React.useState<string | undefined>();
  React.useEffect(() => { setText(declText(value)); }, [value]);
  return (
    <>
      <textarea className="ta code" style={{ minHeight: 48 }} value={text} disabled={readOnly} placeholder="border-radius: 12px;"
        onChange={(e) => { setText(e.target.value); const p = parseDecls(e.target.value); setErr(p.error); if (!p.error) onChange(p.decls); }} onBlur={onBlur} data-testid="ux-rule-decls" />
      {err && <div className="ux-errors">{err}</div>}
    </>
  );
}
function AnimationFields({ a, readOnly, onChange }: { a: UxAnimation; readOnly: boolean; onChange(n: UxAnimation): void }) {
  const num = (k: "durationMs" | "delayMs" | "staggerMs", label: string) => (
    <label className="f sm"><span>{label}</span><input className="input sm" type="number" min={0} value={a[k]} disabled={readOnly} onChange={(e) => onChange({ ...a, [k]: Math.max(0, Number(e.target.value) || 0) })} data-testid={`ux-anim-${k}`} /></label>
  );
  return (
    <div className="ux-fields ux-grid">
      <label className="f sm"><span>Animation</span><select className="input sm" value={a.preset} disabled={readOnly} onChange={(e) => onChange({ ...a, preset: e.target.value as UxAnimation["preset"] })} data-testid="ux-anim-preset">{UX_PRESETS.map((x) => <option key={x}>{x}</option>)}</select></label>
      <label className="f sm"><span>Plays</span><select className="input sm" value={a.trigger} disabled={readOnly} onChange={(e) => onChange({ ...a, trigger: e.target.value as UxAnimation["trigger"] })} data-testid="ux-anim-trigger">{UX_ANIMATION_TRIGGERS.map((x) => <option key={x} value={x}>on {x.replace("_", " ")}</option>)}</select></label>
      {num("durationMs", "Duration (ms)")}
      {num("delayMs", "Delay (ms)")}
      {num("staggerMs", "One at a time (ms apart)")}
      <label className="f sm"><span>Repeat</span><select className="input sm" value={String(a.iterations)} disabled={readOnly} onChange={(e) => onChange({ ...a, iterations: e.target.value === "infinite" ? "infinite" : Number(e.target.value) })}>{["1", "2", "3", "infinite"].map((x) => <option key={x}>{x}</option>)}</select></label>
    </div>
  );
}
function BehaviorFields({ b, readOnly, onChange, onBlur }: { b: UxBehavior; readOnly: boolean; onChange(n: UxBehavior, now?: boolean): void; onBlur(): void }) {
  const [effects, setEffects] = React.useState(JSON.stringify(b.effects, null, 1));
  const [err, setErr] = React.useState<string | undefined>();
  React.useEffect(() => { setEffects(JSON.stringify(b.effects, null, 1)); }, [b.effects]);
  if (b.script !== undefined) {
    return (
      <div className="ux-fields">
        <label className="f"><span>Script — runs sandboxed; it can only use the rs api (rs.listen, rs.addClass, rs.animate, rs.setStyle, rs.showMessage…)</span>
          <textarea className="ta code" style={{ minHeight: 110 }} value={b.script} disabled={readOnly} spellCheck={false}
            onChange={(e) => onChange({ ...b, script: e.target.value })} onBlur={onBlur} data-testid="ux-script" /></label>
        <BehaviorGuard b={b} readOnly={readOnly} onChange={onChange} />
      </div>
    );
  }
  return (
    <div className="ux-fields">
      <div className="ux-row">
        <label className="f sm"><span>When</span><select className="input sm" value={b.on ?? "answer"} disabled={readOnly} onChange={(e) => onChange({ ...b, on: e.target.value as UxBehavior["on"] }, true)} data-testid="ux-beh-on">{UX_EVENTS.map((x) => <option key={x} value={x}>{x.replace("_", " ")}</option>)}</select></label>
        <label className="f sm"><span>Options (codes)</span><input className="input sm mono" value={(b.options ?? []).join(", ")} disabled={readOnly} placeholder="any"
          onChange={(e) => onChange({ ...b, options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} onBlur={onBlur} data-testid="ux-beh-options" /></label>
      </div>
      <label className="f"><span>Effects</span>
        <textarea className="ta code" style={{ minHeight: 60 }} value={effects} disabled={readOnly} spellCheck={false}
          onChange={(e) => { setEffects(e.target.value); try { const v = JSON.parse(e.target.value); if (!Array.isArray(v)) throw new Error("a list of effects"); setErr(undefined); onChange({ ...b, effects: v }); } catch (x) { setErr(`Effects must be a JSON list: ${(x as Error).message}`); } }}
          onBlur={onBlur} data-testid="ux-beh-effects" /></label>
      {err && <div className="ux-errors">{err}</div>}
      <BehaviorGuard b={b} readOnly={readOnly} onChange={onChange} />
    </div>
  );
}

/**
 * "Only when" — the behaviour (or script) runs only while this condition
 * holds on the respondent's answers so far. The engine and the runtime honour
 * `when`; this is where it is seen and set (the Copilot could already write it).
 */
function BehaviorGuard({ b, readOnly, onChange }: { b: UxBehavior; readOnly: boolean; onChange(n: UxBehavior, now?: boolean): void }) {
  if (readOnly) return b.when ? <div className="muted" style={{ fontSize: 12.5 }} data-testid="ux-beh-when-ro">Only when a condition holds.</div> : null;
  return (
    <div data-testid="ux-beh-when">
      <OptionalCondition label="Only when" value={b.when ?? undefined}
        hint="Otherwise it runs for every respondent."
        onChange={(when) => onChange({ ...b, when }, true)} />
    </div>
  );
}
