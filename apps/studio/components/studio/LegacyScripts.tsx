"use client";
import React from "react";
import { legacyScriptRefusals, type LegacyRefusal } from "@rescript/engine";
import { useStudio } from "./store";

/**
 * S1c (audit D17) — CODE THAT WILL NOT RUN, SAID OUT LOUD. Old Custom code moved into Styles, animations & scripts,
 * imported Scripts-panel code and Custom Component code that the script check refuses (`window`, `$`,
 * `setInterval`, `fetch`, …) used to sit in the survey looking normal and do nothing. This banner lists each with
 * where it came from, the reasons and a "Show the code" toggle, where scripts are edited: Survey Settings → Scripts
 * (everything), the survey-wide "Styles, animations & scripts" editor (everything) and a question's editor (that
 * question's items). The same list is in Intelligent Mode's outline (`legacyRefusalOutline`), so the model can
 * propose a rewrite with the rs api when asked.
 */
export function LegacyScriptsBanner({ questionId, kinds }: { questionId?: string; kinds?: LegacyRefusal["kind"][] }) {
  const s = useStudio();
  const all = React.useMemo(() => { try { return legacyScriptRefusals(s.def); } catch { return []; } }, [s.def]);
  const list = all.filter((r) => {
    if (kinds && !kinds.includes(r.kind)) return false;
    if (!questionId) return true;
    if (r.kind === "component_js") return r.id === questionId;
    if (r.kind === "ux_script") return s.def.ux?.behaviors.find((b) => b.id === r.id)?.target?.questionId === questionId;
    return false;
  });
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  if (!list.length) return null;
  return (
    <div className="note warn" role="status" data-testid="legacy-scripts-banner" style={{ fontSize: 12.5, margin: "6px 0 10px" }}>
      <strong>{list.length === 1 ? "1 script will not run" : `${list.length} scripts will not run`}</strong>{" "}
      — moved from old Custom code or imported, and refused by the script check. They stay in the survey (nothing is
      deleted) but do nothing for respondents until rewritten. Intelligent mode can propose a rewrite: ask it to
      “rewrite the scripts that will not run”.
      <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
        {list.map((r) => {
          const key = `${r.kind}:${r.id}`;
          return (
            <li key={key} data-testid="legacy-script" data-kind={r.kind} data-id={r.id} style={{ marginBottom: 4 }}>
              <strong>{r.name}</strong> <span className="muted">from {r.origin}</span>
              {r.names.length ? <> — uses {r.names.map((n, i) => <React.Fragment key={n}>{i ? ", " : ""}<code>{n}</code></React.Fragment>)}</> : null}
              <div className="muted" style={{ fontSize: 12 }}>{r.reasons.join("; ")}</div>
              <button type="button" className="btn small ghost" data-testid="legacy-script-show"
                onClick={() => setOpen((o) => ({ ...o, [key]: !o[key] }))}>
                {open[key] ? "Hide the code" : "Show the code"}
              </button>
              {open[key] && <pre className="logic-pre" data-testid="legacy-script-code" style={{ maxHeight: 220, overflow: "auto", marginTop: 4 }}>{r.code}</pre>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
