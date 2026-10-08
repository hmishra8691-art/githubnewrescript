"use client";
import React from "react";
import { sanitizeHtml, stripHtmlText, mediaGroupFromAttrs, type SanitizeOptions, type MediaGroup } from "@rescript/engine";
import { surfaceHtml, restoreSurfaceHtml, RTE_SCOPE_ATTR } from "@/lib/rteStyles";
import { InsertPipingButton, tokensToChips, chipsToTokens } from "./PipingPicker";
import { MediaInsertDialog, mediaValueFromElement, type MediaApply, type MediaInsertValue } from "./MediaInsertDialog";
import { useStudio } from "./store";
import { typedMarkup, decodeTypedMarkup } from "@/lib/typedMarkup";

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
function useRichSurface(value: string, onChange: (html: string) => void, mode: "visual" | "html", placement = false, clean: SanitizeOptions = {}) {
  const s = useStudio();
  /* an author's stylesheet is shown scoped to THIS surface (`rteStyles.ts`) */
  const scopeId = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const show = React.useCallback((html: string, codeFor: (r: string) => string) => surfaceHtml(tokensToChips(html || "", codeFor), scopeId), [scopeId]);
  const read = React.useCallback((html: string) => restoreSurfaceHtml(chipsToTokens(html)), []);
  const surface = React.useRef<HTMLDivElement>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitted = React.useRef(value);
  const cleanOpts = React.useMemo<SanitizeOptions>(() => ({ keepStyles: !!clean.keepStyles, allowFrames: !!clean.allowFrames }), [clean.keepStyles, clean.allowFrames]);
  const [media, setMedia] = React.useState<{ initial: Partial<MediaInsertValue> | null; target: HTMLElement | null; group?: MediaGroup | null } | null>(null);

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
      el.innerHTML = show(value || "", codeFor);
      lastCommitted.current = value;
    }
  }, [value, mode, codeFor, show]);

  const commit = React.useCallback((html: string, immediate = false) => {
    const clean = sanitizeHtml(read(html), cleanOpts);
    lastCommitted.current = clean;
    if (timer.current) clearTimeout(timer.current);
    if (immediate) onChange(clean);
    else timer.current = setTimeout(() => onChange(clean), 300);
  }, [onChange, read, cleanOpts]);

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
    const el = t.closest?.('img, video, audio, [data-rs-media="embed"]') as HTMLElement | null;
    if (!el || !surface.current?.contains(el)) return;
    e.preventDefault();
    /* an item in a group of several: its group's layout comes along, editable in the dialog */
    const groupEl = el.closest(".rs-media-group") as HTMLElement | null;
    setMedia({ initial: mediaValueFromElement(el), target: el, group: groupEl ? mediaGroupFromAttrs((n) => groupEl.getAttribute(n)) : null });
  };
  const openMedia = () => setMedia({ initial: null, target: null });
  /*
   * WHERE THE MEDIA GOES. In place of the clicked element (edit), out of the
   * text (its source was cleared), at the start or end of the question text
   * ("Above / Below question" — what used to take the HTML tab), or at the
   * cursor (an option label, or the programmer's choice).
   */
  const applyMedia = (html: string, _value: MediaInsertValue, apply?: MediaApply) => {
    const root = surface.current;
    const target = media?.target && root?.contains(media.target) ? media.target : null;
    const position = apply?.position ?? (target ? "keep" : "cursor");
    if (target && root) {
      /* the group the edited item sits in takes the layout chosen for it */
      const groupEl = target.closest(".rs-media-group") as HTMLElement | null;
      if (groupEl && apply?.group) {
        const g = apply.group;
        groupEl.setAttribute("data-rs-layout", g.layout);
        if (g.layout === "grid") groupEl.setAttribute("data-rs-cols", String(g.columns ?? 2)); else groupEl.removeAttribute("data-rs-cols");
        groupEl.setAttribute("data-rs-align", g.align ?? "left");
        groupEl.setAttribute("style", `gap: ${g.gap ?? 10}px`);
      }
      if (apply?.remove || position === "above" || position === "below") removeMediaElement(target, root);
      else target.outerHTML = html;
      if (!apply?.remove && (position === "above" || position === "below")) placeMedia(root, html, position);
      commit(root.innerHTML, true);
      return;
    }
    if (root && (position === "above" || position === "below")) {
      placeMedia(root, html, position);
      commit(root.innerHTML, true);
      return;
    }
    insertHtml(`${html}&nbsp;`);
  };
  const mediaDialog = (
    media && <MediaInsertDialog open initial={media.initial} group={media.group} onClose={() => setMedia(null)} onInsert={applyMedia} placement={placement} />
  );

  return { surface, commit, exec, insertHtml, onStyle, addLink, onSurfaceClick, openMedia, mediaDialog, codeFor, mediaOpen: !!media, show, read, scopeId, cleanOpts };
}

/** media placed above or below the question text sits on its own line */
function placeMedia(root: HTMLElement, html: string, position: "above" | "below") {
  if (!html) return;
  root.insertAdjacentHTML(position === "above" ? "afterbegin" : "beforeend", `<div>${html}</div>`);
}

/** take one picture or player out, and the line it stood on if that is now empty */
function removeMediaElement(el: HTMLElement, root: HTMLElement) {
  const parent = el.parentElement;
  const group = el.closest(".rs-media-group") as HTMLElement | null;
  /* the &nbsp; the cursor insert put after it goes with it */
  const next = el.nextSibling;
  if (next && next.nodeType === Node.TEXT_NODE && /^\u00a0$/.test(next.textContent ?? "")) next.remove();
  el.remove();
  if (parent && parent !== root && /^(DIV|P|SPAN)$/.test(parent.tagName)
    && !(parent.textContent ?? "").replace(/\u00a0/g, " ").trim()
    && !parent.querySelector('img, video, audio, [data-rs-media]')) parent.remove();
  /* the last item out of a group of several takes the group with it */
  if (group && root.contains(group) && !group.querySelector('img, video, audio, [data-rs-media]')) group.remove();
}

/* ================================================================ block editor */

export function RichTextEditor({ value, onChange, placeholder, autoFocusId, questionId, mediaPlacement, keepStyles, allowFrames, markup }: {
  value: string;
  /**
   * A Text / HTML block (07-10 review, Oweas #2): opens on the HTML tab, so
   * markup typed is markup, and offers to turn HTML that was typed into the
   * Visual tab — stored as text, shown to respondents as code — into markup.
   */
  markup?: boolean;
  /**
   * A question's text or instruction: the author's own `<style>` is kept
   * (and scoped when drawn) — October 2026 review. Off elsewhere.
   */
  keepStyles?: boolean;
  /** a Text / HTML block: frames, objects and forms are kept, as they always were drawn */
  allowFrames?: boolean;
  /**
   * The QUESTION TEXT editor: Insert media offers Above / Below question,
   * several items and players (1-10-26 review). Off for every other editor.
   */
  mediaPlacement?: boolean;
  onChange(html: string): void;
  placeholder?: string;
  /** id used for programmatic focus (new-question flow) */
  autoFocusId?: string;
  /** the question being edited — lets the piping picker warn about forward refs */
  questionId?: string;
}) {
  const [mode, setMode] = React.useState<"visual" | "html">(markup ? "html" : "visual");
  const [htmlDraft, setHtmlDraft] = React.useState(value);
  const r = useRichSurface(value, onChange, mode, !!mediaPlacement, { keepStyles, allowFrames });
  /* the HTML tab shows what is stored — kept in step when the value changes from outside (undo, a restore) */
  React.useEffect(() => {
    if (mode !== "html") return;
    if (value !== r.read(htmlDraft) && document.activeElement?.getAttribute("data-rte-source") !== "1") setHtmlDraft(value);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const looksTyped = !!markup && typedMarkup(value);
  const renderTyped = () => {
    const fixed = sanitizeHtml(decodeTypedMarkup(value), r.cleanOpts);
    commit(fixed, true);
    setHtmlDraft(fixed);
    if (surface.current) surface.current.innerHTML = r.show(fixed, codeFor);
  };
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
      const clean = sanitizeHtml(chipsToTokens(htmlDraft), r.cleanOpts);
      commit(clean, true);
      if (surface.current) surface.current.innerHTML = r.show(clean, codeFor);
    } else if (surface.current) {
      setHtmlDraft(r.read(surface.current.innerHTML));
    }
    setMode(m);
  };

  return (
    <div className="rte">
      <RteToolbar exec={exec} onLink={r.addLink}
        /* the dialog edits the visual surface — from the HTML tab, come back to it first */
        onMedia={() => { if (mode === "html") switchMode("visual"); r.openMedia(); }}
        insertPipe={insertPipe} questionId={questionId} mode={mode} setMode={switchMode} onStyle={r.onStyle} />

      <div
        ref={surface}
        id={autoFocusId}
        className="rte-surface"
        {...{ [RTE_SCOPE_ATTR]: r.scopeId }}
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
          data-rte-source="1"
          data-testid="rte-html-source"
          spellCheck={false}
          placeholder={markup ? "<h2>Welcome to our survey</h2>\n<p>It takes about <b>5 minutes</b>.</p>" : undefined}
          style={{ minHeight: markup ? 170 : 110, borderTopLeftRadius: 0, borderTopRightRadius: 0 }}
          value={htmlDraft}
          onChange={(e) => {
            setHtmlDraft(e.target.value);
            commit(e.target.value);
          }}
          onBlur={(e) => commit(e.target.value, true)}
        />
      )}
      {looksTyped && (
        <div className="alert warning rte-typed" data-testid="rte-typed-markup" role="status">
          <span>
            This content holds HTML typed as text — respondents would see the tags as code, like
            <code> &lt;b&gt;</code>.
          </span>
          <button type="button" className="btn small" data-testid="rte-render-typed" onClick={renderTyped}>
            Render it as HTML
          </button>
        </div>
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
export function InlineRichText({ value, onChange, placeholder, questionId, testId, index, onEnter, onBackspaceEmpty, onArrow, onPasteLines, className, disabled, style, multiline }: {
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
  /**
   * Opt-in: a growing, wrapping paragraph box instead of the one-line label
   * this component was built for (an option/row/column label is always one
   * line, by design — Enter adds the next option). A validation message is
   * not a label; it can run to a sentence or two of formatted text, so it
   * needs to wrap and to let Enter start a new line rather than being
   * swallowed. Every other caller leaves this unset and is unaffected.
   */
  multiline?: boolean;
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
      const clean = sanitizeHtml(chipsToTokens(htmlDraft), r.cleanOpts);
      commit(clean, true);
      if (surface.current) surface.current.innerHTML = r.show(clean, codeFor);
    } else if (surface.current) {
      setHtmlDraft(r.read(surface.current.innerHTML));
    }
    setMode(m);
  };

  return (
    <div ref={wrap} className={`rte-inline-wrap ${className ?? ""}`} style={style} onFocus={onFocusIn} onBlur={onFocusOut}>
      {mode === "visual" ? (
        <div
          ref={surface}
          className={`input rte-inline ${multiline ? "rte-inline-multiline" : ""} ${disabled ? "disabled" : ""}`}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline={multiline ? "true" : "false"}
          data-oidx={index}
          data-testid={testId}
          data-placeholder={placeholder ?? ""}
          onInput={() => surface.current && commit(surface.current.innerHTML)}
          onBlur={() => surface.current && commit(surface.current.innerHTML, true)}
          onClick={r.onSurfaceClick}
          onKeyDown={(e) => {
            if (!multiline && e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (surface.current) commit(surface.current.innerHTML, true);
              onEnter?.();
            } else if (!multiline && e.key === "Enter") {
              e.preventDefault(); // a label is one line
            } else if (e.key === "Backspace" && onBackspaceEmpty && isEmpty()) {
              e.preventDefault();
              onBackspaceEmpty();
            } else if (e.key === "ArrowUp" && onArrow) {
              e.preventDefault(); onArrow(-1);
            } else if (e.key === "ArrowDown" && onArrow) {
              e.preventDefault(); onArrow(1);
            }
            // multiline + Enter: no handler above claims it, so the browser's
            // own default runs and starts a new line — the one thing a label
            // never gets to do and a message always should.
          }}
          onPaste={(e) => {
            const plain = e.clipboardData.getData("text/plain");
            if (!multiline && plain.includes("\n") && onPasteLines) {
              e.preventDefault();
              if (surface.current) commit(surface.current.innerHTML, true);
              if (onPasteLines(plain)) return;
            }
            const html = e.clipboardData.getData("text/html");
            e.preventDefault();
            const clean = multiline
              // a message keeps the paragraph/line breaks a paste carries
              ? (html
                  ? sanitizeHtml(html)
                  : plain.split(/\r\n|\r|\n/).map((line) =>
                      line.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string)),
                    ).join("<br>"))
              // one line: block wrappers a word processor pastes become the text they hold
              : (html
                  ? sanitizeHtml(html).replace(/<\/?(p|div|br|h[1-6])\b[^>]*>/gi, " ")
                  : plain.replace(/\s+/g, " ").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c] as string)));
            document.execCommand("insertHTML", false, clean);
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
