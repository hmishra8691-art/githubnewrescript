"use client";
import React from "react";

/**
 * THE METHOD LIBRARY (2026-11-09) — every research method, grouped, readable: dark names, readable descriptions,
 * clear hover, focus and selected states. Replaces the native drop-down whose group headings browsers draw pale.
 * Shared by Design Generators and Study design.
 */
export interface LibraryMethod { id: string; name: string; description: string }
export interface LibraryGroup { key: string; label: string; note?: string; methods: LibraryMethod[] }

export function MethodLibrary({ groups, selected, onSelect, compact, testId = "method-library" }: { groups: LibraryGroup[]; selected: string | null; onSelect(id: string): void; compact?: boolean; testId?: string }) {
  const [q, setQ] = React.useState("");
  const query = q.trim().toLowerCase();
  const shown = groups.map((g) => ({ ...g, methods: g.methods.filter((m) => !query || `${m.name} ${m.description} ${g.label}`.toLowerCase().includes(query)) })).filter((g) => g.methods.length);
  return (
    <div className={`ml${compact ? " compact" : ""}`} data-testid={testId}>
      <input className="input ml-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a method…" aria-label="Find a method" />
      <div className="ml-groups">
        {shown.map((g) => (
          <section key={g.key} className="ml-group" aria-label={g.label}>
            <h4 className="ml-group-h">{g.label}{g.note && <span className="ml-group-note">{g.note}</span>}</h4>
            <div className="ml-items" role="listbox" aria-label={g.label}>
              {g.methods.map((m) => (
                <button key={m.id} type="button" role="option" aria-selected={selected === m.id} className={`ml-item${selected === m.id ? " on" : ""}`} onClick={() => onSelect(m.id)} data-testid={`method-${m.id}`}>
                  <span className="ml-name">{m.name}</span>
                  {!compact && <span className="ml-desc">{m.description}</span>}
                </button>
              ))}
            </div>
          </section>
        ))}
        {!shown.length && <p className="ml-empty">No method matches “{q}”.</p>}
      </div>
    </div>
  );
}
