"use client";
import React from "react";
import { useCommands } from "./CommandContext";
import { rank, formatShortcut, type Command } from "../../lib/commands/core";
import type { StudioCommandContext } from "../../lib/commands/builtins";
import { Icon } from "../ui/Icon";

/**
 * ⌘K — everything the Studio can do, and everything in the survey, one list.
 *
 * Empty query: the applicable commands, grouped. Typing: commands AND
 * survey objects (questions by code, variable and text; calculations; rules)
 * ranked together, so "Q14" jumps to Q14 and "add" offers the Add group.
 * Objects are searched, never listed whole — a 600-question survey would
 * bury the commands.
 *
 * Keyboard only needs ↑ ↓ Enter Esc; the mouse works too. The input keeps
 * focus throughout, and the list scrolls the highlighted row into view.
 */

const GROUP_ORDER = ["Add", "Edit", "Find", "Navigate", "Mode", "Survey"] as const;

type Cmd = Command<StudioCommandContext>;

export function CommandPalette() {
  const api = useCommands();
  const [query, setQuery] = React.useState("");
  const [cursor, setCursor] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  const open = !!api?.paletteOpen;

  React.useEffect(() => {
    if (open) { setQuery(""); setCursor(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  // Escape closes from anywhere, not only from inside the input — focus may
  // not have reached the field yet in the first frame after opening
  React.useEffect(() => {
    if (!open || !api) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); api.closePalette(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, api]);

  const results = React.useMemo<Cmd[]>(() => {
    if (!api) return [];
    const q = query.trim();
    // the palette does not list the command that opens the palette
    const cmds = api.commands.filter((c) => c.id !== "palette.open");
    if (!q) {
      return [...cmds].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
    }
    const pool = [...cmds, ...api.finders];
    return rank(q, pool, (c) => [c.title, ...(c.keywords ?? [])], 40).map((r) => r.item);
  }, [api, query]);

  React.useEffect(() => { setCursor(0); }, [query]);
  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!api || !open) return null;

  const choose = (cmd: Cmd) => {
    api.closePalette();
    api.runCommand(cmd);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const cmd = results[cursor]; if (cmd) choose(cmd); }
    else if (e.key === "Escape") { e.preventDefault(); api.closePalette(); }
  };

  // group headers only when the list is in group order (empty query)
  const grouped = !query.trim();

  return (
    <div className="palette-backdrop" onMouseDown={api.closePalette} data-testid="command-palette">
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input-row">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            className="palette-input"
            data-testid="palette-input"
            placeholder="Type a command, a question code, a variable…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="palette-kbd">esc</kbd>
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {results.length === 0 && <div className="palette-empty">Nothing matches “{query}”.</div>}
          {results.map((cmd, i) => {
            const header = grouped && (i === 0 || results[i - 1].group !== cmd.group);
            return (
              <React.Fragment key={cmd.id}>
                {header && <div className="palette-group">{cmd.group}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  data-index={i}
                  data-testid={`palette-item-${cmd.id}`}
                  className={`palette-item${i === cursor ? " active" : ""}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(cmd)}
                >
                  <span className="palette-item-title">{cmd.title}</span>
                  {!grouped && <span className="palette-item-group">{cmd.group}</span>}
                  {cmd.shortcut && <kbd className="palette-kbd">{formatShortcut(cmd.shortcut, mac)}</kbd>}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}
