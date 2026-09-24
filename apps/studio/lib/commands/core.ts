/**
 * THE COMMAND LAYER — what every environment dispatches instead of editing.
 *
 * The brief's failure mode is `Mode A → separate logic`. The Studio is
 * almost safe from it (one store, one write path), but every panel writes
 * its own inline `update(d => …)`, so "add a question" already exists in
 * three places. Five environments would make it fifteen, and the fifteenth
 * is the one that forgets to re-mint the option ids.
 *
 * A command is one named, discoverable operation: what it is called, when it
 * applies, what it does, and what key runs it. The palette lists them, the
 * shortcut handler fires them, hover quick-actions will render them, and an
 * AI proposal is a list of them to review. Environments contain no mutation
 * code; they dispatch.
 *
 * This file is the pure half — types, matching, shortcuts — and has no React
 * in it, so it is unit-tested directly. The built-in commands are in
 * `builtins.ts`; the provider that wires keys and the palette is
 * `components/studio/CommandContext.tsx`.
 */

export type CommandGroup = "Add" | "Edit" | "Navigate" | "Mode" | "Survey" | "Find";

export interface CommandContextBase {
  /** the active Studio tab */
  tab: string;
  /** the active programming mode */
  mode: string;
  /** the primary selection, as an engine ObjectKey, or null */
  primary: string | null;
  /** the selected question id, when the primary is a question */
  questionId: string | null;
  /** editing is refused right now (read-only, locked) */
  readOnly: boolean;
}

export interface Command<Ctx extends CommandContextBase = CommandContextBase> {
  /** stable id, `group.verb`: "question.add", "nav.logic" */
  id: string;
  title: string;
  group: CommandGroup;
  /** extra words the palette should match on: synonyms, the old label */
  keywords?: string[];
  /** e.g. "mod+shift+d"; `mod` is ⌘ on Mac and Ctrl elsewhere */
  shortcut?: string;
  /** the shortcut fires even while typing in a field (only for things like ⌘K) */
  global?: boolean;
  /** true when the command applies right now; absent means always */
  when?(ctx: Ctx): boolean;
  /** this command edits the survey, so it is refused in read-only */
  edits?: boolean;
  run(ctx: Ctx): void | Promise<void>;
}

/* ------------------------------------------------------------ shortcuts */

export interface ParsedShortcut {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

/** "mod+shift+k" → { key: "k", mod, shift }. Case-insensitive; order-free. */
export function parseShortcut(s: string): ParsedShortcut {
  const parts = s.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  const out: ParsedShortcut = { key: "", mod: false, shift: false, alt: false };
  for (const p of parts) {
    if (p === "mod" || p === "cmd" || p === "ctrl" || p === "meta") out.mod = true;
    else if (p === "shift") out.shift = true;
    else if (p === "alt" || p === "option") out.alt = true;
    else out.key = p;
  }
  return out;
}

/** The subset of KeyboardEvent a match needs — so tests need no DOM. */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function matchesShortcut(e: KeyLike, shortcut: string): boolean {
  const p = parseShortcut(shortcut);
  const mod = e.metaKey || e.ctrlKey;
  if (p.mod !== mod) return false;
  if (p.shift !== e.shiftKey) return false;
  if (p.alt !== e.altKey) return false;
  return e.key.toLowerCase() === p.key;
}

/** "mod+shift+k" → "⌘⇧K" on Mac, "Ctrl+Shift+K" elsewhere. */
export function formatShortcut(shortcut: string, mac: boolean): string {
  const p = parseShortcut(shortcut);
  const key = p.key.length === 1 ? p.key.toUpperCase() : p.key[0].toUpperCase() + p.key.slice(1);
  if (mac) return `${p.mod ? "⌘" : ""}${p.alt ? "⌥" : ""}${p.shift ? "⇧" : ""}${key}`;
  return [p.mod && "Ctrl", p.alt && "Alt", p.shift && "Shift", key].filter(Boolean).join("+");
}

/* ------------------------------------------------------------ matching */

/**
 * Subsequence scoring — the kind every editor's palette uses. Every query
 * character must appear in order; runs of consecutive matches and matches
 * at word starts score higher, so "adq" finds "Add question" above "Add a
 * display rule" and "logic" finds "Open Logic" before "Add display logic".
 * Returns 0 for no match.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t.includes(q)) {
    // a contiguous hit is always best; earlier and at a word start better still
    const at = t.indexOf(q);
    const wordStart = at === 0 || /[\s\-_./:]/.test(t[at - 1]);
    return 1000 - at + (wordStart ? 200 : 0) + (t.length === q.length ? 500 : 0);
  }
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return 0;
    const wordStart = at === 0 || /[\s\-_./:]/.test(t[at - 1]);
    run = at === ti ? run + 1 : 0;
    score += 10 + run * 5 + (wordStart ? 15 : 0) - Math.min(at - ti, 20);
    ti = at + 1;
  }
  return Math.max(1, score);
}

export interface Ranked<T> { item: T; score: number }

/**
 * Rank a list by fuzzy score over one or more text fields. Items that do not
 * match are dropped; ties keep input order (stable sort), so a caller can
 * pre-order by importance.
 */
export function rank<T>(query: string, items: T[], fields: (item: T) => string[], limit = 50): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  for (const item of items) {
    let best = 0;
    for (const f of fields(item)) {
      const s = fuzzyScore(query, f);
      if (s > best) best = s;
    }
    if (best > 0) out.push({ item, score: best });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/** The commands that apply right now, in registry order. */
export function applicable<Ctx extends CommandContextBase>(cmds: Command<Ctx>[], ctx: Ctx): Command<Ctx>[] {
  return cmds.filter((c) => (!c.when || c.when(ctx)) && !(c.edits && ctx.readOnly));
}

/** The command whose shortcut this key event matches, if any and if applicable. */
export function commandForKey<Ctx extends CommandContextBase>(
  cmds: Command<Ctx>[],
  e: KeyLike,
  ctx: Ctx,
  typing: boolean,
): Command<Ctx> | null {
  for (const c of cmds) {
    if (!c.shortcut) continue;
    if (typing && !c.global) continue;
    if (!matchesShortcut(e, c.shortcut)) continue;
    if (c.when && !c.when(ctx)) continue;
    if (c.edits && ctx.readOnly) continue;
    return c;
  }
  return null;
}
