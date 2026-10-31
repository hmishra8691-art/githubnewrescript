"use client";
import React from "react";
import { useStudio, uid } from "./store";
import type { CodeRow } from "@/lib/scripts/inventory.ts";
import { exportScripts, importScripts, parseBundle, type ImportOutcome } from "@/lib/scripts/bundle.ts";

/**
 * S3b item 4 (audit MM-08) — Research tools → All code → "Export / import scripts". Export the selected scripts (or
 * every script) as a `rescript-scripts` JSON bundle; import one into this survey: questions are matched by CODE, every
 * item passes its gate, what is imported arrives SWITCHED OFF with a review note, and what could not be mapped or was
 * refused is listed (lib/scripts/bundle.ts).
 */
export function ScriptBundleTools({ selected }: { selected: CodeRow[]; all: CodeRow[] }) {
  const s = useStudio();
  const [open, setOpen] = React.useState(false);
  const [json, setJson] = React.useState<string | null>(null);
  const [skipped, setSkipped] = React.useState<string[]>([]);
  const [incoming, setIncoming] = React.useState("");
  const [preview, setPreview] = React.useState<ImportOutcome | string | null>(null);
  const [done, setDone] = React.useState<ImportOutcome | null>(null);
  const scripts = selected.filter((r) => r.kind === "ux_script" || r.kind === "logic_script");
  const doExport = (pick: boolean) => {
    const b = pick
      ? exportScripts(s.def, { behaviors: scripts.filter((r) => r.kind === "ux_script").map((r) => r.id), logic: scripts.filter((r) => r.kind === "logic_script").map((r) => r.id) })
      : exportScripts(s.def);
    setSkipped(pick ? selected.filter((r) => !scripts.includes(r)).map((r) => r.name) : []);
    setJson(JSON.stringify(b, null, 2));
  };
  const check = (text: string) => {
    setDone(null);
    const b = parseBundle(text);
    setPreview(typeof b === "string" ? b : importScripts(s.def, b, uid));
  };
  const apply = () => {
    const b = parseBundle(incoming);
    if (typeof b === "string") { setPreview(b); return; }
    const r = importScripts(s.def, b, uid);
    if (!r.added.length) { setPreview(r); return; }
    s.labelNextEdit(`Import ${r.added.length} script${r.added.length === 1 ? "" : "s"} (switched off)`);
    s.update((d) => { d.ux = r.def.ux; d.scripts = r.def.scripts; });
    setDone(r);
    setPreview(null);
    s.toast(`Imported ${r.added.length} — switched off until you review and switch them on.`);
  };
  const href = React.useMemo(() => (json && typeof URL !== "undefined" && typeof Blob !== "undefined" ? URL.createObjectURL(new Blob([json], { type: "application/json" })) : null), [json]);
  React.useEffect(() => () => { if (href) URL.revokeObjectURL(href); }, [href]);
  const Outcome = ({ r, applied }: { r: ImportOutcome; applied: boolean }) => (
    <div style={{ fontSize: 12.5 }}>
      <p style={{ margin: "4px 0" }}><b data-testid="bundle-added-count">{r.added.length}</b> {applied ? "imported" : "will be imported"}, switched off{r.added.length ? ":" : "."} {r.added.map((a) => `“${a.name}”`).join(", ")}</p>
      {r.unmapped.length > 0 && <div data-testid="bundle-unmapped"><b>Could not be mapped to this survey (not imported):</b><ul style={{ margin: "2px 0 4px 18px" }}>{r.unmapped.map((u, i) => <li key={i}>“{u.name}” — {u.reason}</li>)}</ul></div>}
      {r.refused.length > 0 && <div data-testid="bundle-refused"><b>Refused by the check (not imported):</b><ul style={{ margin: "2px 0 4px 18px" }}>{r.refused.map((u, i) => <li key={i}>“{u.name}” — {u.reasons[0]}</li>)}</ul></div>}
      {r.added.some((a) => a.notes.length > 1) && <p className="muted" style={{ margin: "2px 0" }}>An “only when” condition is not carried by a bundle — set it again where needed.</p>}
    </div>
  );
  return (
    <div className="card" style={{ padding: 8, marginBottom: 8 }} data-testid="bundle-tools">
      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        <button type="button" className="btn small ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="bundle-toggle">Export / import scripts</button>
        {open && <>
          <button type="button" className="btn small" disabled={!scripts.length} onClick={() => doExport(true)} data-testid="bundle-export-selected">Export selected ({scripts.length})</button>
          <button type="button" className="btn small" onClick={() => doExport(false)} data-testid="bundle-export-all">Export every script</button>
        </>}
      </div>
      {open && (
        <div style={{ marginTop: 6 }}>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 4px" }}>
            A bundle carries behaviour scripts and logic scripts with their events and where they run, by question <b>code</b> (not id), so it can be imported into another survey with the same codes.
            Components, Branding and question CSS are not part of a bundle.
          </p>
          {json && (
            <div data-testid="bundle-export">
              {skipped.length > 0 && <p className="muted" style={{ fontSize: 12 }}>Not in the bundle (not a script): {skipped.join(", ")}</p>}
              <textarea className="ta code" readOnly value={json} style={{ minHeight: 120, width: "100%" }} data-testid="bundle-json" aria-label="Exported bundle" />
              {href && <a className="btn small" href={href} download={`${String(s.def.meta.code ?? "survey")}-scripts.json`} data-testid="bundle-download">Download .json</a>}
            </div>
          )}
          {!s.readOnly && (
            <div style={{ marginTop: 8 }} data-testid="bundle-import">
              <b style={{ fontSize: 12.5 }}>Import into this survey</b>
              <div className="row" style={{ gap: 6, margin: "4px 0" }}>
                <input type="file" accept="application/json,.json" data-testid="bundle-import-file" aria-label="Bundle file"
                  onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const t = await f.text(); setIncoming(t); check(t); }} />
              </div>
              <textarea className="ta code" value={incoming} placeholder='or paste a bundle: { "format": "rescript-scripts", "version": 1, "items": [ … ] }' style={{ minHeight: 70, width: "100%" }}
                onChange={(e) => { setIncoming(e.target.value); setPreview(null); }} data-testid="bundle-import-text" aria-label="Bundle to import" />
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="btn small" disabled={!incoming.trim()} onClick={() => check(incoming)} data-testid="bundle-import-check">Check</button>
                <button type="button" className="btn small primary" disabled={!preview || typeof preview === "string" || !preview.added.length} onClick={apply} data-testid="bundle-import-apply">Import (switched off)</button>
              </div>
              {typeof preview === "string" && <p className="ux-errors" role="alert" data-testid="bundle-import-error">{preview}</p>}
              {preview && typeof preview !== "string" && <div data-testid="bundle-preview"><Outcome r={preview} applied={false} /></div>}
              {done && <div data-testid="bundle-import-result"><Outcome r={done} applied /></div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
