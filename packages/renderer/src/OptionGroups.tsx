"use client";
import React from "react";
import type { Question } from "@rescript/schema";
import { groupSegments, type GroupSegment } from "@rescript/engine";

/**
 * AQ-08 — OPTION GROUPS THE RESPONDENT CAN SEE (schema OptionGroup.label / display; engine groupSegments).
 *
 * `heading`      a heading above the members, the members in a role=group named by it;
 * `collapsible`  a disclosure button (aria-expanded / aria-controls; Enter and Space work because it is a <button>)
 *                that shows or hides the members — closed at first unless a member is already selected;
 * `none`         (and a group without a label) — drawn exactly as before this existed.
 *
 * The wrappers are `display: contents`, so a multi-column option grid keeps flowing; the heading / button spans the
 * whole row. Order, randomization and visibility are untouched — the items arrive already ordered by
 * `effectiveQuestion` (optionGroups.ts keeps every group contiguous), this only cuts them into runs.
 */
export function useGroupOpen(q: Question, scope: "options" | "rows", selected: (string | number)[]) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const isOpen = (seg: GroupSegment<{ code: string | number }>) => {
    if (seg.display !== "collapsible" || !seg.groupId) return true;
    const v = open[seg.groupId];
    if (v !== undefined) return v;
    return seg.items.some((it) => selected.some((s) => String(s) === String(it.code)));
  };
  const toggle = (id: string, now: boolean) => setOpen((o) => ({ ...o, [id]: !now }));
  void q; void scope;
  return { isOpen, toggle };
}

const plain = (s: string | null) => (s ?? "").replace(/<[^>]*>/g, "").trim();

export function GroupedItems<T extends { code: string | number }>({ q, scope, items, selected, render }: {
  q: Question;
  scope: "options" | "rows";
  items: T[];
  selected: (string | number)[];
  render: (item: T) => React.ReactNode;
}): React.ReactElement {
  const segs = groupSegments(q, scope, items);
  const { isOpen, toggle } = useGroupOpen(q, scope, selected);
  if (segs.length === 1 && segs[0].display === "none") return <>{items.map(render)}</>;
  return (
    <>
      {segs.map((seg, i) => {
        if (seg.display === "none" || !seg.groupId) return <React.Fragment key={`n${i}`}>{seg.items.map(render)}</React.Fragment>;
        const hid = `${q.id}__grp_${seg.groupId}_${i}`;
        if (seg.display === "heading") {
          return (
            <div key={hid} className="rs-optgroup" role="group" aria-labelledby={hid} data-testid="rs-optgroup" data-group={seg.groupId} data-display="heading">
              <div className="rs-optgroup-heading" id={hid}>{plain(seg.label)}</div>
              {seg.items.map(render)}
            </div>
          );
        }
        const open = isOpen(seg);
        const bodyId = `${hid}_body`;
        return (
          <div key={hid} className="rs-optgroup collapsible" data-testid="rs-optgroup" data-group={seg.groupId} data-display="collapsible" data-open={open ? "1" : "0"}>
            <button type="button" className="rs-optgroup-toggle" id={hid} aria-expanded={open} aria-controls={bodyId}
              data-testid="rs-optgroup-toggle" onClick={() => toggle(seg.groupId!, open)}>
              <span className="rs-optgroup-caret" aria-hidden="true">{open ? "▾" : "▸"}</span> {plain(seg.label)}
              <span className="rs-optgroup-count">{` (${seg.items.length})`}</span>
            </button>
            <div className="rs-optgroup-body" id={bodyId} role="group" aria-labelledby={hid} hidden={!open}>
              {open && seg.items.map(render)}
            </div>
          </div>
        );
      })}
    </>
  );
}
