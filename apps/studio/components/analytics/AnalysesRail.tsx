"use client";
import React from "react";
import { ANALYSIS_KINDS } from "@rescript/analytics";
import { type Row, timeAgo } from "./api";

/**
 * THE ANALYSES RAIL — every saved analysis of the survey, in the researcher's
 * own order, one click from opening. Search, new, and per item: open,
 * duplicate, rename, move up / down, delete. The rail never computes; it
 * lists definitions and tells the workspace which one to open.
 */
export function AnalysesRail({ analyses, currentId, dirty, canEdit, onNew, onOpen, onDuplicate, onRename, onMove, onDelete }: {
  analyses: Row[];
  currentId: string | null;
  /** the open analysis has unsaved changes */
  dirty?: boolean;
  canEdit: boolean;
  onNew: () => void;
  onOpen: (a: Row) => void;
  onDuplicate: (a: Row) => void;
  onRename: (a: Row, name: string) => void;
  onMove: (a: Row, dir: -1 | 1) => void;
  onDelete: (a: Row) => void;
}) {
  const [q, setQ] = React.useState("");
  const [menu, setMenu] = React.useState<string | null>(null);
  const [renaming, setRenaming] = React.useState<{ id: string; name: string } | null>(null);
  React.useEffect(() => { if (!menu) return; const close = () => setMenu(null); window.addEventListener("click", close); return () => window.removeEventListener("click", close); }, [menu]);
  const list = analyses.filter((a) => !q || String(a.name).toLowerCase().includes(q.toLowerCase()) || String(a.kind).includes(q.toLowerCase()));
  const kindLabel = (k: string) => ANALYSIS_KINDS.find((x) => x.kind === k)?.label ?? k;
  return (
    <aside className="ax-rail" data-testid="ax-rail" aria-label="Analyses">
      <div className="ax-rail-head">
        <span className="ax-rail-title">Analyses <span className="ax-rail-count">{analyses.length}</span></span>
        {canEdit && <button type="button" className="btn small primary" onClick={onNew} data-testid="ax-rail-new" title="Start a new analysis">+ New</button>}
      </div>
      {analyses.length > 6 && <input className="input small" placeholder="Search analyses…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="ax-rail-search" />}
      <div className="ax-rail-list">
        {currentId === null && <div className="ax-rail-item on draft" data-testid="ax-rail-draft"><span className="ax-rail-name">Untitled analysis{dirty ? <span className="ax-dirty" title="Unsaved changes" /> : null}</span><span className="ax-rail-meta">not saved yet</span></div>}
        {list.map((a, i) => {
          const on = a.id === currentId;
          const isRenaming = renaming?.id === a.id;
          const commitRename = () => { if (!renaming) return; const n = renaming.name.trim(); if (n && n !== a.name) onRename(a, n); setRenaming(null); };
          return (
            <div key={a.id} className={`ax-rail-item ${on ? "on" : ""}`} data-testid="ax-rail-item" data-id={a.id} onClick={() => { if (!isRenaming) onOpen(a); }} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" && !isRenaming) onOpen(a); }}>
              {isRenaming ? (
                <input className="input small" autoFocus value={renaming?.name ?? ""} data-testid="ax-rail-rename" onClick={(e) => e.stopPropagation()} onChange={(e) => setRenaming({ id: a.id, name: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenaming(null); }}
                  onBlur={commitRename} />
              ) : (
                <span className="ax-rail-name" title={String(a.name)}>{String(a.name)}{on && dirty ? <span className="ax-dirty" title="Unsaved changes" /> : null}</span>
              )}
              <span className="ax-rail-meta">{kindLabel(String(a.kind))} · v{String(a.version ?? 1)}{a.updated_at ? ` · ${timeAgo(a.updated_at as string)}` : ""}</span>
              {canEdit && (
                <div className="ax-rail-actions" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="ax-rail-btn" title="Move up" disabled={i === 0} onClick={() => onMove(a, -1)} data-testid="ax-rail-up">↑</button>
                  <button type="button" className="ax-rail-btn" title="Move down" disabled={i === list.length - 1} onClick={() => onMove(a, 1)} data-testid="ax-rail-down">↓</button>
                  <button type="button" className="ax-rail-btn" title="More" onClick={() => setMenu(menu === a.id ? null : a.id)} data-testid="ax-rail-menu">⋯</button>
                  {menu === a.id && (
                    <div className="menu ax-rail-menu" role="menu">
                      <button type="button" className="menu-item" onClick={() => { setMenu(null); onOpen(a); }}>Open</button>
                      <button type="button" className="menu-item" data-testid="ax-rail-duplicate" onClick={() => { setMenu(null); onDuplicate(a); }}>Duplicate</button>
                      <button type="button" className="menu-item" data-testid="ax-rail-rename-start" onClick={() => { setMenu(null); setRenaming({ id: a.id, name: String(a.name) }); }}>Rename</button>
                      <button type="button" className="menu-item danger" data-testid="ax-rail-delete" onClick={() => { setMenu(null); onDelete(a); }}>Delete</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!analyses.length && <div className="ax-rail-empty">Saved analyses appear here. Build one on the right and save it.</div>}
        {analyses.length > 0 && !list.length && <div className="ax-rail-empty">Nothing matches “{q}”.</div>}
      </div>
    </aside>
  );
}
