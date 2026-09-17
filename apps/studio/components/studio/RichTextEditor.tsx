"use client";
import React from "react";
import { sanitizeHtml, stripHtmlText } from "@rescript/engine";
import { InsertPipingButton, tokensToChips, chipsToTokens } from "./PipingPicker";
import { MediaInsertDialog, mediaValueFromElement, type MediaInsertValue } from "./MediaInsertDialog";
import { useStudio } from "./store";

/**
 * Rich text / HTML editor for question text (reqs §10–12, §20–22) — and,
 * as `InlineRichText`, for answer options, rows and columns.
 *
 * Visual mode is a contentEditable surface with a formatting toolbar; HTML
 * mode exposes the source directly for precise control. Content is
 * sanitized on every commit and commits are debounced so typing never clones
 * the whole survey per keystroke.
 *
 * Piping: tokens are stored as `{{Q1.label}}` text — the format the engine,
 * the exporters and every existing survey already use — but rendered in the
 * visual surface as non-editable chips, so a pipe reads as one object and
 * cannot be half-deleted into broken syntax. Chips are converted back to
 * tokens on every commit; the HTML tab always shows the real stored source.
 *
 * Media: "Insert media" opens the one dialog (`MediaInsertDialog`) that
 * takes a URL or an asset from the library and the size / fit / alignment
 * controls, and inserts the markup the engine's `mediaHtml` builds. Clicking
 * a picture already in the text reopens the dialog on it. The same markup
 * is what the renderer shows, so the builder is the preview.
 *
 * ONE TOOLBAR, TWO SURFACES. `RteToolbar` is the toolbar; the block editor
 * shows it always, the inline editor shows it in a popover while the field
 * has focus. An option label gets every capability question text has — the
 * brief's "same or a compatible HTML editor architecture" is literally the
 * same component.
 */

const TOOLS: { cmd: string; arg?: string; label: string; title: string }[] = [
  { cmd: "bold", label: "B", title: "Bold" },
  { cmd: "italic", label: "I", title: "Italic" },
  { cmd: "underline", label: "U", title: "Underline" },
  { cmd: "strikeThrough", label: "S", title: "Strikethrough" },
  { cmd: "superscript", label: "x²", title: "Superscript" },
  { cmd: "subscript", label: "x₂", title: "Subscript" },
  { cmd: "insertUnorderedList", label: "•≡", title: "Bullet list" },
  { cmd: "insertOrderedList", label: "1≡", title: "Numbered list" },
  { cmd: "justifyLeft", label: "⇤", title: "Align left" },
  { cmd: "justifyCenter", label: "⇔", title: "Align center" },
  { cmd: "justifyRight", label: "⇥", title: "Align right" },
];
/** the tools that make sense in a single line: no lists */
const INLINE_TOOLS = TOOLS.filter((t) => !t.cmd.startsWith("insert"));

/**
 * `execCommand("fontSize")` writes legacy `<font size=N>`; a CSS size is
 * what the brief asks for and what a stylesheet can override. The size is
 * applied as a span with `font-size`, by wrapping the selection.
 */
const SIZES: { value: string; label: string }[] = [
  { value: "0.8em", label: "small" }, { value: "1em", label: "normal" }, { value: "1.25em", label: "large" }, { value: "1.5em", label: "x-large" }, { value: "2em", label: "xx-large" },
];

function applyInlineStyle(css: string) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (range.collapsed) return;
  const span = document.createElement("span");
  span.setAttribute("style", css);
  try {
    range.surroundContents(span);
  } catch {
    // a selection across element boundaries: wrap its extracted contents
    span.appendChild(range.extractContents());
    range.insertNode(span);
  }
  sel.removeAllRanges();
  const r = document.createRange();
  r.selectNodeContents(span);
  sel.addRange(r);
}

export function RteToolbar({ exec, onLink, onMedia, insertPipe, questionId, mode, setMode, compact, onStyle }: {
  exec(cmd: string, arg?: string): void;
  onLink(): void;
  onMedia(): void;
  insertPipe(token: string): void;
  questionId?: string;
  mode?: "visual" | "html";
  setMode?(m: "visual" | "html"): void;
  compact?: boolean;
  onStyle(css: string): void;
}) {
  const tools = compact ? INLINE_TOOLS : TOOLS;
  const stop = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className={`rte-bar ${compact ? "rte-bar-compact" : ""}`} onMouseDown={stop}>
      {tools.map((t) => (
        <button key={t.cmd + (t.arg ?? "")} type="button" className="rte-btn" title={t.title} onMouseDown={stop} onClick={() => exec(t.cmd, t.arg)}>
          {t.label}
        </button>
      ))}
      <button type="button" className="rte-btn" title="Insert link" onMouseDown={stop} onClick={onLink}>🔗</button>
      <button type="button" className="rte-btn" title="Insert image, video or audio — from the asset library or a URL" data-testid="rte-media" onMouseDown={stop} onClick={onMedia}>🖼</button>
      <select className="rte-btn rte-size" title="Font size" defaultValue="" onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => { if (e.target.value) { onStyle(`font-size: ${e.target.value}`); e.target.value = ""; } }}>
        <option value="" disabled>size</option>
        {SIZES.map((sz) => <option key={sz.value} value={sz.value}>{sz.label}</option>)}
      </select>
      <label className="rte-btn" title="Text color" style={{ padding: "0 4px" }} onMouseDown={(e) => e.stopPropagation()}>
        A<input type="color" style={{ width: 16, height: 14, border: "none", padding: 0, background: "none", verticalAlign: "middle", marginLeft: 2 }}
          onChange={(e) => exec("foreColor", e.target.value)} />
      </label>
      <label className="rte-btn" title="Highlight color" style={{ padding: "0 4px" }} onMouseDown={(e) => e.stopPropagation()}>
        ▆<input type="color" style={{ width: 16, height: 14, border: "none", padding: 0, background: "none", verticalAlign: "middle", marginLeft: 2 }}
          onChange={(e) => exec("hiliteColor", e.target.value)} />
      </label>
      <button type="button" className="rte-btn" title="Clear formatting" onMouseDown={stop} onClick={() => exec("removeFormat")}>⌫fmt</button>
      <InsertPipingButton className="rte-btn pipe-btn" label={compact ? "{{ }}" : "＋ Piping"} currentQuestionId={questionId} onInsert={insertPipe} />
      {!compact && (
        <>
          <button type="button" className="rte-btn" title="Undo" onMouseDown={stop} onClick={() => exec("undo")}>↶</button>
          <button type="button" className="rte-btn" title="Redo" onMouseDown={stop} onClick={() => exec("redo")}>↷</button>
        </>
      )}
      {setMode && (
        <>
          <span className="grow" />
          <button type="button" className={`rte-btn rte-mode ${mode === "visual" ? "on" : ""}`} onMouseDown={stop} onClick={() => setMode("visual")}>Visual</button>
          <button type="button" className={`rte-btn rte-mode ${mode === "html" ? "on" : ""}`} onMouseDown={stop} onClick={() => setMode("html")}>HTML</button>
        </>
      )}
    </div>
  );
}

/** The editing behaviours both surfaces share: sync, commit, exec, link, media. */
function useRichSurface(value: string, onChange: (html: string) => void, mode: "visual" | "html") {
  const s = useStudio();
  const surface = React.useRef<HTMLDivElement>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitted = React.useRef(value);
  const [media, setMedia] = React.useState<{ initial: Partial<MediaInsertValue> | null; target: HTMLElement | null } | null>(null);

  const codeFor = React.useCallback(
    (ref: string) => s.def.questions.find((q) => q.code === ref || q.id === ref)?.code ?? ref,
    [s.def.questions],
  );

  // keep the surface in sync with external changes (undo via version restore,
  // variant defaults…) — but never while the programmer is typing in it
  React.useEffect(() => {
    const el = surface.current;
    if (!el) return;
    if (document.activeElement === el || el.contains(document.activeElement)) return;
    if (value !== lastCommitted.current || (el.innerHTML === "" && value)) {
      el.innerHTML = tokensToChips(value || "", codeFor);
      lastCommitted.current = value;
    }
  }, [value, mode, codeFor]);

  const commit = React.useCallback((html: string, immediate = false) => {
    const clean = sanitizeHtml(chipsToTokens(html));
    lastCommitted.current = clean;
    if (timer.current) clearTimeout(timer.current);
    if (immediate) onChange(clean);
    else timer.current = setTimeout(() => onChange(clean), 300);
  }, [onChange]);

  const exec = (cmd: string, arg?: string) => {
    surface.current?.focus();
    document.execCommand(cmd, false, arg);
    if (surface.current) commit(surface.current.innerHTML);
  };
  const insertHtml = (html: string) => {
    surface.current?.focus();
    document.execCommand("insertHTML", false, html);
    if (surface.current) commit(surface.current.innerHTML);
  };
  const onStyle = (css: string) => {
    surface.current?.focus();
    applyInlineStyle(css);
    if (surface.current) commit(surface.current.innerHTML);
  };
  const addLink = () => {
    const url = window.prompt("Link URL (https://…):");
    if (!url) return;
    exec("createLink", /^https?:\/\//i.test(url) ? url : `https://${url}`);
  };
  /** a click on a picture or player inside the surface reopens the dialog on it */
  const onSurfaceClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const el = t.closest?.("img, video, audio") as HTMLElement | null;
    if (!el || !surface.current?.contains(el)) return;
    e.preventDefault();
    setMedia({ initial: mediaValueFromElement(el), target: el });
  };
  const openMedia = () => setMedia({ initial: null, target: null });
  const applyMedia = (html: string) => {
    if (media?.target && surface.current?.contains(media.target)) {
      media.target.outerHTML = html;
      if (surface.current) commit(surface.current.innerHTML, true);
    } else {
      insertHtml(`${html}&nbsp;`);
    }
  };
  const mediaDialog = (
    <MediaInsertDialog open={!!media} initial={media?.initial ?? null} onClose={() => setMedia(null)} onInsert={applyMedia} />
  );

  return { surface, commit, exec, insertHtml, onStyle, addLink, onSurfaceClick, openMedia, mediaDialog, codeFor, mediaOpen: !!media };
}

/* ================================================================ block editor */

export function RichTextEditor({ value, onChange, placeholder, autoFocusId, questionId }: {
  value: string;
  onChange(html: string): void;
  placeholder?: string;
  /** id used for programmatic focus (new-question flow) */
  autoFocusId?: string;
  /** the question being edited — lets the piping picker warn about forward refs */
  questionId?: string;
}) {
  const [mode, setMode] = React.useState<"visual" | "html">("visual");
  const [htmlDraft, setHtmlDraft] = React.useState(value);
  const r = useRichSurface(value, onChange, mode);
  const { surface, commit, exec, codeFor } = r;

  /** Insert a piping token at the caret, as a chip. */
  const insertPipe = (token: string) => {
    if (mode === "html") {
      setHtmlDraft((d) => d + token);
      commit(htmlDraft + token);
      return;
    }
    r.insertHtml(`${tokensToChips(token, codeFor)}&nbsp;`);
  };

  const switchMode = (m: "visual" | "html") => {
    if (m === mode) return;
    if (m === "visual") {
      const clean = sanitizeHtml(chipsToTokens(htmlDraft));
      commit(clean, true);
      if (surface.current) surface.current.innerHTML = tokensToChips(clean, codeFor);
    } else if (surface.current) {
      setHtmlDraft(chipsToTokens(surface.current.innerHTML));
    }
    setMode(m);
  };

  return (
    <div className="rte">
      <RteToolbar exec={exec} onLink={r.addLink} onMedia={r.openMedia} insertPipe={insertPipe} questionId={questionId} mode={mode} setMode={switchMode} onStyle={r.onStyle} />

      <div
        ref={surface}
        id={autoFocusId}
        className="rte-surface"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder ?? "Question text — formatting and piping like {{Q1}} allowed"}
        style={{ display: mode === "visual" ? undefined : "none" }}
        onInput={() => surface.current && commit(surface.current.innerHTML)}
        onBlur={() => surface.current && commit(surface.current.innerHTML, true)}
        onClick={r.onSurfaceClick}
        onPaste={(e) => {
          // paste as sanitized HTML, never as live markup with handlers
          const html = e.clipboardData.getData("text/html");
          if (html) {
            e.preventDefault();
            document.execCommand("insertHTML", false, sanitizeHtml(html));
            if (surface.current) commit(surface.current.innerHTML);
          }
        }}
      />

      {mode === "html" && (
        <textarea
          className="ta code"
          style={{ minHeight: 110, borderTopLeftRadius: 0, borderTopRightRadius: 0 }}
          value={htmlDraft}
          onChange={(e) => {
            setHtmlDraft(e.target.value);
            commit(e.target.value);
          }}
          onBlur={(e) => commit(e.target.value, true)}
        />
      )}
      {r.mediaDialog}
    </div>
  );
}

/* ================================================================ inline editor */

/**
 * A single-line rich label: an option, a row, a column.
 *
 * Looks like the plain `<input>` it replaces and keeps its keyboard contract
 * — Enter adds the next option, Backspace on an empty label removes it,
 * arrows move between labels, a multi-line paste splits into options — all
 * through callbacks, because the list they act on belongs to the caller.
 * The toolbar is a popover: it opens when text is SELECTED in the field or
 * when the small "Aa" button beside it is clicked, and closes on blur — not
 * on every focus, because a toolbar that drops over the next option while
 * you type this one is in the way more often than it is useful. "HTML" in
 * it swaps the field for a source box so a precise tag can be typed.
 *
 * `data-oidx` is kept on the editable element so the existing focus logic
 * (`[data-oidx="3"]`) finds it exactly as it found the input.
 */
export function InlineRichText({ value, onChange, placeholder, questionId, testId, index, onEnter, onBackspaceEmpty, onArrow, onPasteLines, className, disabled, style }: {
  value: string;
  onChange(html: string): void;
  placeholder?: string;
  questionId?: string;
  testId?: string;
  /** position in the list — `data-oidx`, for keyboard focus */
  index?: number;
  onEnter?(): void;
  onBackspaceEmpty?(): void;
  onArrow?(dir: -1 | 1): void;
  /** a multi-line plain-text paste; return true when handled */
  onPasteLines?(text: string): boolean;
  className?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const [mode, setMode] = React.useState<"visual" | "html">("visual");
  const [focused, setFocused] = React.useState(false);
  const [toolbar, setToolbar] = React.useState(false);
  const [htmlDraft, setHtmlDraft] = React.useState(value);
  const wrap = React.useRef<HTMLDivElement>(null);
  const r = useRichSurface(value, onChange, mode);
  const { surface, commit, exec, codeFor } = r;
  const blurTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // the popover stays while focus is anywhere inside this editor or its dialog
  const onFocusIn = () => { if (blurTimer.current) clearTimeout(blurTimer.current); setFocused(true); };
  const onFocusOut = () => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => {
      if (r.mediaOpen) return;
      const active = document.activeElement;
      if (active && wrap.current?.contains(active)) return;
      setFocused(false);
      setToolbar(false);
      if (mode === "html") { setMode("visual"); }
    }, 120);
  };
  /** a text selection inside the field opens the toolbar — the moment formatting becomes possible */
  React.useEffect(() => {
    if (!focused) return;
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && surface.current?.contains(sel.anchorNode)) setToolbar(true);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [focused, surface]);

  const isEmpty = () => {
    const html = surface.current?.innerHTML ?? "";
    return stripHtmlText(html) === "" && !/<(img|video|audio)\b/i.test(html);
  };

  const insertPipe = (token: string) => {
    if (mode === "html") { setHtmlDraft((d) => d + token); commit(htmlDraft + token); return; }
    r.insertHtml(`${tokensToChips(token, codeFor)}&nbsp;`);
  };
  const switchMode = (m: "visual" | "html") => {
    if (m === mode) return;
    if (m === "visual") {
      const clean = sanitizeHtml(chipsToTokens(htmlDraft));
      commit(clean, true);
      if (surface.current) surface.current.innerHTML = tokensToChips(clean, codeFor);
    } else if (surface.current) {
      setHtmlDraft(chipsToTokens(surface.current.innerHTML));
    }
    setMode(m);
  };

  return (
    <div ref={wrap} className={`rte-inline-wrap ${className ?? ""}`} style={style} onFocus={onFocusIn} onBlur={onFocusOut}>
      {mode === "visual" ? (
        <div
          ref={surface}
          className={`input rte-inline ${disabled ? "disabled" : ""}`}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="false"
          data-oidx={index}
          data-testid={testId}
          data-placeholder={placeholder ?? ""}
          onInput={() => surface.current && commit(surface.current.innerHTML)}
          onBlur={() => surface.current && commit(surface.current.innerHTML, true)}
          onClick={r.onSurfaceClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (surface.current) commit(surface.current.innerHTML, true);
              onEnter?.();
            } else if (e.key === "Enter") {
              e.preventDefault(); // a label is one line
            } else if (e.key === "Backspace" && onBackspaceEmpty && isEmpty()) {
              e.preventDefault();
              onBackspaceEmpty();
            } else if (e.key === "ArrowUp" && onArrow) {
              e.preventDefault(); onArrow(-1);
            } else if (e.key === "ArrowDown" && onArrow) {
              e.preventDefault(); onArrow(1);
            }
          }}
          onPaste={(e) => {
            const plain = e.clipboardData.getData("text/plain");
            if (plain.includes("\n") && onPasteLines) {
              e.preventDefault();
              if (surface.current) commit(surface.current.innerHTML, true);
              if (onPasteLines(plain)) return;
            }
            const html = e.clipboardData.getData("text/html");
            e.preventDefault();
            // one line: block wrappers a word processor pastes become the text they hold
            const clean = html ? sanitizeHtml(html).replace(/<\/?(p|div|br|h[1-6])\b[^>]*>/gi, " ") : plain.replace(/\s+/g, " ");
            document.execCommand("insertHTML", false, html ? clean : clean.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string)));
            if (surface.current) commit(surface.current.innerHTML);
          }}
        />
      ) : (
        <input className="input mono rte-inline" data-oidx={index} data-testid={testId ? `${testId}-html` : undefined} value={htmlDraft} autoFocus
          onChange={(e) => { setHtmlDraft(e.target.value); commit(e.target.value); }}
          onBlur={(e) => commit(e.target.value, true)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); switchMode("visual"); } }} />
      )}
      {focused && !disabled && (
        /*
         * A <span>, not a <button>: an inline label often sits inside a
         * <label> element, and a click anywhere in a <label> is forwarded to
         * its first labelable control — which would be this button, stealing
         * the focus the click meant for the text. A span is not labelable.
         */
        <span role="button" className="rte-inline-toggle" tabIndex={-1} title="Formatting, media, piping, HTML" aria-label="Formatting"
          data-testid={testId ? `${testId}-format` : "rte-inline-format"}
          onMouseDown={(e) => e.preventDefault()} onClick={() => setToolbar((t) => !t)}>Aa</span>
      )}
      {focused && toolbar && !disabled && (
        <div className="rte-pop" data-testid={testId ? `${testId}-toolbar` : "rte-inline-toolbar"}>
          <RteToolbar compact exec={exec} onLink={r.addLink} onMedia={r.openMedia} insertPipe={insertPipe} questionId={questionId} mode={mode} setMode={switchMode} onStyle={r.onStyle} />
        </div>
      )}
      {r.mediaDialog}
    </div>
  );
}
