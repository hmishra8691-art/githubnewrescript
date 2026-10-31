"use client";
import React from "react";
import { ScriptHistoryPanel } from "./ScriptHistory";

/**
 * S3b — the management tools of ONE script editor (behaviour script, logic script, component JS): buttons for the
 * editor's header and the panels shown under it. `itemKey` is the script audit log's item (`${kind}:${id}`); `code`
 * is the editor's CURRENT text (unsaved included).
 */
export function useScriptTools(o: { itemKey: string | null; code: string }) {
  const [panel, setPanel] = React.useState<"history" | null>(null);
  if (!o.itemKey) return { buttons: null, panels: null };
  const buttons = (
    <button type="button" className="btn sm ghost" aria-expanded={panel === "history"} data-testid="code-history-toggle"
      onClick={() => setPanel((p) => (p === "history" ? null : "history"))}>History</button>
  );
  const panels = panel === "history" ? <ScriptHistoryPanel itemKey={o.itemKey} current={o.code} onClose={() => setPanel(null)} /> : null;
  return { buttons, panels };
}
