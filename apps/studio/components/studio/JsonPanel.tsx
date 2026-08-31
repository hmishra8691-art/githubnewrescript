"use client";
import React from "react";
import { SurveyDefinition } from "@rescript/schema";
import { useStudio } from "./store";

/** First-class JSON view (requirements §11 / §26): inspect, edit, import, export. */
export function JsonPanel() {
  const s = useStudio();
  const [text, setText] = React.useState(() => JSON.stringify(s.def, null, 2));
  const [error, setError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);

  React.useEffect(() => {
    if (!editing) setText(JSON.stringify(s.def, null, 2));
  }, [s.def, editing]);

  const apply = () => {
    try {
      const raw = JSON.parse(text);
      const parsed = SurveyDefinition.safeParse(raw);
      if (!parsed.success) {
        setError(parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
        return;
      }
      s.replace(parsed.data);
      setError(null);
      setEditing(false);
      s.toast("Definition applied from JSON");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(s.def, null, 2)], { type: "application/json" }));
    a.download = `${s.def.meta.code}_v${s.def.meta.version}.json`;
    a.click();
  };

  const importFile = (file: File) => {
    file.text().then((t) => { setText(t); setEditing(true); });
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Survey JSON</h2>
        <span className="muted" style={{ fontSize: 12 }}>the complete, reconstructable definition</span>
        <span className="grow" />
        <label className="btn small">
          import .json
          <input type="file" accept=".json" hidden
            onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
        </label>
        <button className="btn small" onClick={download}>⬇ export .json</button>
        <button className="btn small" onClick={() => { navigator.clipboard.writeText(text); s.toast("JSON copied"); }}>copy</button>
        {editing ? (
          <>
            <button className="btn small primary" onClick={apply}>validate &amp; apply</button>
            <button className="btn small" onClick={() => { setEditing(false); setError(null); }}>cancel</button>
          </>
        ) : (
          <button className="btn small" onClick={() => setEditing(true)}>edit</button>
        )}
      </div>
      {error && <pre className="logic-pre" style={{ color: "var(--red)" }}>{error}</pre>}
      <textarea className="ta code" style={{ minHeight: "70vh", opacity: editing ? 1 : 0.85 }}
        value={text} readOnly={!editing}
        onChange={(e) => setText(e.target.value)} />
    </div>
  );
}
