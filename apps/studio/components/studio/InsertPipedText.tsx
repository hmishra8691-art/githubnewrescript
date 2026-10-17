"use client";
import React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import {
  pipeSourceCatalog, searchPipeSources, buildRandomToken, RANDOM_PERSISTENCE,
  type PipeSourceCategory, type PipeSourceItem, type RandomPersistence,
} from "@rescript/engine";
import { Icon } from "@/components/ui/Icon";

/**
 * INSERT PIPED TEXT (document 15/10/2026, items C and D).
 *
 * A button beside a value field that opens a searchable, two-level menu —
 * categories, then fields (and, where a field has them, a third level: what
 * to read from a question, a date format, a random value's settings) — and
 * hands the chosen `{{…}}` token to the caller, which inserts it at ITS
 * cursor. Shared: the Survey Flow fields use it, and the condition builder's
 * value field imports it.
 *
 * What it lists is `pipeSourceCatalog` from the engine — built from the
 * sources the runtime can actually resolve. A source the platform cannot
 * supply at this point is shown disabled, with the reason, instead of a token
 * that would silently resolve to nothing.
 *
 * API (stable — other panels import it):
 *   def        the survey being edited
 *   onInsert   receives the token; the caller inserts it at its cursor
 *   accept     the field's type: "number" offers only numeric sources
 *   context    { loop, flowPosition } — what is available at this point
 *   label, testId
 *   syntax     optional, additive: "calc" writes references in the Calc
 *              DSL's own syntax (`ed.NAME`, a variable name) for a
 *              calculation field; default "piped" (`{{…}}`)
 */
export function InsertPipedText(props: {
  def: SurveyDefinition;
  onInsert: (token: string) => void;
  accept?: "text" | "number" | "any";
  context?: { loop?: boolean; flowPosition?: string };
  label?: string;
  testId?: string;
  syntax?: "piped" | "calc";
}): JSX.Element {
  const { def, onInsert, accept = "any", context, label, testId = "insert-piped-text", syntax = "piped" } = props;
  const [open, setOpen] = React.useState(false);
  const [catId, setCatId] = React.useState<string | null>(null);
  const [item, setItem] = React.useState<PipeSourceItem | null>(null);
  const [query, setQuery] = React.useState("");
  const menuRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);

  const cats = React.useMemo(
    () => (open ? pipeSourceCatalog(def, { accept, loop: context?.loop, flowPosition: context?.flowPosition, syntax }) : []),
    [open, def, accept, context?.loop, context?.flowPosition, syntax],
  );
  const cat = cats.find((c) => c.id === catId) ?? null;
  const hits = React.useMemo(() => (query.trim() ? searchPipeSources(cats, query) : []), [cats, query]);

  const reset = () => { setCatId(null); setItem(null); setQuery(""); };
  const close = (refocus = true) => {
    setOpen(false); reset();
    if (refocus) requestAnimationFrame(() => buttonRef.current?.focus());
  };
  const choose = (token: string | undefined) => {
    if (!token) return;
    close(false);
    onInsert(token);
  };
  const back = () => { if (item) setItem(null); else setCatId(null); setQuery(""); focusFirst(); };
  const focusFirst = () => requestAnimationFrame(() => {
    const el = menuRef.current?.querySelector<HTMLElement>("[data-pipe-focus], .pipe-list button:not([disabled])");
    el?.focus();
  });
  const openItem = (it: PipeSourceItem) => {
    if (it.disabled) return;
    if (it.token && !it.options && !it.random) { choose(it.token); return; }
    setItem(it); setQuery(""); focusFirst();
  };

  /* arrow keys move between the rows of the current list; Escape closes */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(".pipe-list .menu-item:not([disabled])") ?? []);
    if (!rows.length) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? (at + 1) % rows.length : (at <= 0 ? rows.length - 1 : at - 1);
    rows[next]?.focus();
  };

  const title = item ? item.label : cat ? cat.label : "Insert piped text";

  return (
    <div className="menu-anchor pipe-anchor">
      <button ref={buttonRef} type="button" className="btn small pipe-btn" data-testid={testId}
        aria-haspopup="menu" aria-expanded={open}
        title={syntax === "calc" ? "Insert a variable into this calculation" : "Insert piped text — a value from a question, embedded data, the date, a random value…"}
        onClick={() => (open ? close() : setOpen(true))}>
        <Icon name="json" size={14} /> {label ?? (syntax === "calc" ? "Insert variable" : "Insert piped text")}
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => close()} />
          <div ref={menuRef} className="menu wide pipe-menu" role="menu" aria-label={title}
            data-testid="pipe-menu" onKeyDown={onKeyDown}>
            <div className="pipe-head">
              {(cat || item) && !query && (
                <button type="button" className="btn small pipe-back" data-testid="pipe-back" aria-label="Back" title="Back" onClick={back}>
                  <span aria-hidden>←</span>
                </button>
              )}
              <span className="pipe-title">{query ? "Search results" : title}</span>
            </div>
            {!item?.random && (
              <input className="input pipe-search" autoFocus data-testid="pipe-search"
                placeholder={cat ? `search ${cat.label.toLowerCase()}…` : "search all sources…"}
                aria-label="Search piped text sources"
                value={query} onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); menuRef.current?.querySelector<HTMLElement>(".pipe-list .menu-item:not([disabled])")?.focus(); } }} />
            )}
            <div className="menu-scroll pipe-list">
              {query.trim() ? (
                <SearchResults hits={catId ? hits.filter((h) => h.category.id === catId) : hits} onPick={(it) => openItem(it)} query={query} />
              ) : item?.random ? (
                <RandomForm item={item} onInsert={choose} />
              ) : item ? (
                (item.options ?? []).map((o) => <Row key={o.id} item={o} onPick={() => o.token && !o.disabled && choose(o.token)} />)
              ) : cat ? (
                cat.items.length ? cat.items.map((it) => <Row key={it.id} item={it} onPick={() => openItem(it)} />)
                  : <div className="menu-group">{cat.disabled ?? "nothing here"}</div>
              ) : (
                cats.map((c) => <CategoryRow key={c.id} cat={c} onOpen={() => { setCatId(c.id); focusFirst(); }} />)
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function CategoryRow({ cat, onOpen }: { cat: PipeSourceCategory; onOpen(): void }) {
  return (
    <button type="button" role="menuitem" className="menu-item pipe-row" data-testid={`pipe-cat-${cat.id}`}
      disabled={!!cat.disabled} aria-disabled={!!cat.disabled} title={cat.disabled ?? cat.description}
      onClick={onOpen}>
      <span className="pipe-row-text">
        <span className="mi-label">{cat.label}</span>
        <span className="mi-hint">{cat.disabled ?? cat.description}</span>
      </span>
      {!cat.disabled && <Icon name="chevron-right" size={14} />}
    </button>
  );
}

function Row({ item, onPick, path }: { item: PipeSourceItem; onPick(): void; path?: string }) {
  const leaf = !!item.token && !item.options && !item.random;
  return (
    <button type="button" role="menuitem" className={`menu-item pipe-row${item.disabled ? " is-disabled" : ""}`}
      data-testid="pipe-item" data-token={item.token ?? ""} disabled={!!item.disabled} aria-disabled={!!item.disabled}
      title={item.disabled ?? item.warning ?? item.token ?? item.detail ?? item.label} onClick={onPick}>
      <span className="pipe-row-text">
        <span className="mi-label">{path ? <span className="pipe-path">{path} › </span> : null}{item.label}</span>
        {item.disabled ? <span className="mi-hint">{item.disabled}</span>
          : <span className="mi-hint">{[item.detail, leaf ? item.token : null].filter(Boolean).join(" · ")}</span>}
        {item.warning && !item.disabled && <span className="mi-hint pipe-warn">⚠ {item.warning}</span>}
      </span>
      {!leaf && !item.disabled && <Icon name="chevron-right" size={14} />}
    </button>
  );
}

function SearchResults({ hits, onPick, query }: { hits: ReturnType<typeof searchPipeSources>; onPick(it: PipeSourceItem): void; query: string }) {
  if (!hits.length) return <div className="menu-group">nothing matches “{query}”</div>;
  return (
    <>
      {hits.map((h, i) => (
        <Row key={`${h.category.id}:${h.item.id}:${i}`} item={h.item} onPick={() => onPick(h.item)}
          path={h.parent ? `${h.category.label} › ${h.parent.label}` : h.category.label} />
      ))}
    </>
  );
}

/** A random value's settings, then Insert. */
function RandomForm({ item, onInsert }: { item: PipeSourceItem; onInsert(token: string): void }) {
  const spec = item.random!;
  const [values, setValues] = React.useState<Record<string, string>>(() => Object.fromEntries(spec.params.map((p) => [p.name, p.default])));
  const [per, setPer] = React.useState<RandomPersistence>("respondent");
  const token = buildRandomToken(spec.kind, values, per);
  return (
    <form className="pipe-random" data-testid="pipe-random-form" onSubmit={(e) => { e.preventDefault(); onInsert(token); }}>
      <p className="muted pipe-random-note">{item.detail}</p>
      {spec.params.map((p, i) => (
        <label key={p.name} className="f pipe-random-field">
          <span>{p.label}</span>
          <input className="input" data-testid={`pipe-random-${p.name}`} {...(i === 0 ? { "data-pipe-focus": "" } : {})}
            inputMode={p.kind === "number" ? "decimal" : undefined}
            value={values[p.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))} />
        </label>
      ))}
      <label className="f pipe-random-field">
        <span>Generate</span>
        <select className="select" data-testid="pipe-random-per" {...(spec.params.length === 0 ? { "data-pipe-focus": "" } : {})}
          value={per} onChange={(e) => setPer(e.target.value as RandomPersistence)}>
          {RANDOM_PERSISTENCE.map((p) => <option key={p.value} value={p.value}>{p.label}{p.value === "respondent" ? " (default)" : ""}</option>)}
        </select>
      </label>
      <div className="row pipe-random-foot">
        <code className="mono pipe-random-token" data-testid="pipe-random-token">{token}</code>
        <button type="submit" className="btn small primary" data-testid="pipe-random-insert">Insert</button>
      </div>
    </form>
  );
}
