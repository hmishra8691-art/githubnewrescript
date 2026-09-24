"use client";
import React from "react";
import type { ObjectKey } from "@rescript/engine";
import { Icon, type IconName } from "../ui/Icon";
import type { FlatMapRow, MapKind } from "../../lib/architect/map";

/**
 * THE SURVEY MAP PANE — the tree, drawn.
 *
 * A flat list of rows from `flattenMap`, indented by depth, with a disclosure
 * for containers, a status dot, and dependency counts. Selection is the
 * shared selection; a click on a selectable row selects it, a click on a
 * disclosure toggles collapse, arrow keys walk the list, ← collapses / goes
 * to the parent, → expands / goes to the first child.
 *
 * In focus mode, rows outside the selection's dependency neighbourhood are
 * dimmed rather than hidden — the structure stays legible, the relevant part
 * stands out.
 */

const ICON: Partial<Record<MapKind, IconName>> = {
  block: "layers", group: "layers", page: "layers", question: "questions",
  branch: "flow", arm: "chevron-right", otherwise: "chevron-right", loop: "flow", randomizer: "flow",
  embedded: "variables", quotaCheck: "quotas", redirect: "share", end: "check",
  rules: "logic", rule: "logic", calculations: "calc", calculation: "calc", quotas: "quotas", quota: "quotas",
};

export function SurveyMap({
  rows, selectedKeys, primary, focusSet, onSelect, onToggle, onOpen, search, onSearch, onCollapseAll, onExpandAll,
}: {
  rows: FlatMapRow[];
  selectedKeys: ReadonlySet<string>;
  primary: string | null;
  /** keys inside the focus neighbourhood, or null when focus is off */
  focusSet: ReadonlySet<string> | null;
  onSelect(key: ObjectKey, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): void;
  onToggle(key: string): void;
  /** Enter / double-click: open the object in the workspace (it already is — this scrolls/focuses it) */
  onOpen(key: ObjectKey): void;
  search: string;
  onSearch(s: string): void;
  onCollapseAll(): void;
  onExpandAll(): void;
}) {
  const listRef = React.useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = React.useState(0);

  // keep the cursor on the primary when the selection changes elsewhere
  React.useEffect(() => {
    if (!primary) return;
    const i = rows.findIndex((r) => r.key === primary);
    if (i >= 0) setCursor(i);
  }, [primary, rows]);
  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onKey = (e: React.KeyboardEvent) => {
    const row = rows[cursor];
    const go = (i: number) => { e.preventDefault(); const n = Math.max(0, Math.min(rows.length - 1, i)); setCursor(n); const r = rows[n]; if (r?.selectable) onSelect(r.key as ObjectKey, e); };
    switch (e.key) {
      case "ArrowDown": go(cursor + 1); break;
      case "ArrowUp": go(cursor - 1); break;
      case "ArrowRight":
        if (row?.children.length && !row.expanded) { e.preventDefault(); onToggle(row.key); }
        else if (row?.children.length) go(cursor + 1);
        break;
      case "ArrowLeft":
        if (row?.children.length && row.expanded) { e.preventDefault(); onToggle(row.key); }
        else if (row?.parentKey) { const p = rows.findIndex((r) => r.key === row.parentKey); if (p >= 0) go(p); }
        break;
      case "Enter": if (row?.selectable) { e.preventDefault(); onOpen(row.key as ObjectKey); } break;
      case "Home": go(0); break;
      case "End": go(rows.length - 1); break;
      default: break;
    }
  };

  return (
    <div className="am" data-testid="survey-map">
      <div className="am-head">
        <div className="am-search">
          <Icon name="search" size={13} />
          <input className="am-search-input" data-testid="map-search" placeholder="Find in map…" value={search}
            onChange={(e) => onSearch(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <button className="am-tool" title="Collapse all" onClick={onCollapseAll} data-testid="map-collapse-all">−</button>
        <button className="am-tool" title="Expand all" onClick={onExpandAll} data-testid="map-expand-all">+</button>
      </div>
      <div className="am-list" ref={listRef} role="tree" tabIndex={0} onKeyDown={onKey} data-testid="map-list">
        {rows.length === 0 && <div className="am-empty">Nothing matches.</div>}
        {rows.map((r, i) => {
          const selected = selectedKeys.has(r.key);
          const isPrimary = primary === r.key;
          const dim = focusSet ? !focusSet.has(r.key) : false;
          const section = r.kind === "rules" || r.kind === "calculations" || r.kind === "quotas";
          return (
            <div
              key={r.rowId}
              role="treeitem"
              aria-selected={selected}
              aria-expanded={r.children.length ? r.expanded : undefined}
              aria-level={r.depth + 1}
              data-index={i}
              data-testid="map-row"
              data-key={r.key}
              data-kind={r.kind}
              className={`am-row am-${r.kind}${selected ? " selected" : ""}${isPrimary ? " primary" : ""}${i === cursor ? " cursor" : ""}${dim ? " dim" : ""}${section ? " section" : ""}${r.selectable ? "" : " static"}`}
              style={{ paddingLeft: 8 + r.depth * 14 }}
              onClick={(e) => { setCursor(i); if (r.selectable) onSelect(r.key as ObjectKey, e); else if (r.children.length) onToggle(r.key); }}
              onDoubleClick={() => { if (r.selectable) onOpen(r.key as ObjectKey); }}
            >
              <button
                className={`am-disc${r.children.length ? "" : " none"}`}
                aria-label={r.expanded ? "Collapse" : "Expand"}
                tabIndex={-1}
                data-testid="map-disclosure"
                onClick={(e) => { e.stopPropagation(); if (r.children.length) onToggle(r.key); }}
              >
                {r.children.length ? (r.expanded ? "▾" : "▸") : ""}
              </button>
              <span className={`am-dot ${r.status}`} title={r.issueCount ? `${r.issueCount} issue${r.issueCount === 1 ? "" : "s"}` : undefined} />
              <Icon name={ICON[r.kind] ?? "layers"} size={13} />
              <span className="am-label">
                {r.code && r.kind === "question" ? <span className="mono am-code">{r.code}</span> : null}
                <span className="am-text">{r.kind === "question" ? (r.detail || r.label) : r.label}</span>
                {r.kind !== "question" && r.detail && <span className="am-detail">{r.detail}</span>}
              </span>
              {r.conditional && r.kind !== "arm" && r.kind !== "otherwise" && r.kind !== "rule" && <span className="am-cond" title="Conditional">IF</span>}
              {(r.dependsOn > 0 || r.usedBy > 0) && (
                <span className="am-deps" title={`reads ${r.dependsOn} · read by ${r.usedBy}`}>
                  {r.dependsOn > 0 && <span>←{r.dependsOn}</span>}{r.usedBy > 0 && <span>→{r.usedBy}</span>}
                </span>
              )}
              {r.children.length > 0 && !r.expanded && <span className="am-count">{countLeaves(r)}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function countLeaves(r: FlatMapRow): number {
  let n = 0;
  const visit = (x: { children: { children: unknown[] }[] }) => { for (const c of x.children) { if (!c.children.length) n++; else visit(c as never); } };
  visit(r);
  return n;
}
