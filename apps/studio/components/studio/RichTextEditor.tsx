"use client";
import React from "react";
import { sanitizeHtml } from "@rescript/engine";

/**
 * Rich text / HTML editor for question text (reqs §10–12).
 * Visual mode is a contentEditable surface with a formatting toolbar;
 * HTML mode exposes the source directly for precise control. Content is
 * sanitized on every commit, commits are debounced so typing never clones
 * the whole survey per keystroke, and piping tokens ({{Q1}}, {{calc.X}})
 * pass through untouched as plain text.
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

export function RichTextEditor({ value, onChange, placeholder, autoFocusId }: {
  value: string;
  onChange(html: string): void;
  placeholder?: string;
  /** id used for programmatic focus (new-question flow) */
  autoFocusId?: string;
}) {
  const [mode, setMode] = React.useState<"visual" | "html">("visual");
  const [htmlDraft, setHtmlDraft] = React.useState(value);
  const surface = React.useRef<HTMLDivElement>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommitted = React.useRef(value);

  // keep the surface in sync with external changes (undo via version restore,
  // variant defaults…) — but never while the programmer is typing in it
  React.useEffect(() => {
    const el = surface.current;
    if (!el) return;
    if (document.activeElement === el || el.contains(document.activeElement)) return;
    if (value !== lastCommitted.current || el.innerHTML === "") {
      el.innerHTML = value || "";
      lastCommitted.current = value;
    }
  }, [value, mode]);

  const commit = React.useCallback((html: string, immediate = false) => {
    const clean = sanitizeHtml(html);
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

  const addLink = () => {
    const url = window.prompt("Link URL (https://…):");
    if (!url) return;
    exec("createLink", /^https?:\/\//i.test(url) ? url : `https://${url}`);
  };

  return (
    <div className="rte">
      <div className="rte-bar">
        {TOOLS.map((t) => (
          <button key={t.cmd + (t.arg ?? "")} type="button" className="rte-btn" title={t.title}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => exec(t.cmd, t.arg)}>
            {t.label}
          </button>
        ))}
        <button type="button" className="rte-btn" title="Insert link"
          onMouseDown={(e) => e.preventDefault()} onClick={addLink}>🔗</button>
        <select className="rte-btn rte-size" title="Font size" defaultValue=""
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => { if (e.target.value) { exec("fontSize", e.target.value); e.target.value = ""; } }}>
          <option value="" disabled>size</option>
          <option value="2">small</option>
          <option value="3">normal</option>
          <option value="5">large</option>
          <option value="6">x-large</option>
        </select>
        <label className="rte-btn" title="Text color" style={{ padding: "0 4px" }}>
          A<input type="color" style={{ width: 16, height: 14, border: "none", padding: 0, background: "none", verticalAlign: "middle", marginLeft: 2 }}
            onChange={(e) => exec("foreColor", e.target.value)} />
        </label>
        <button type="button" className="rte-btn" title="Clear formatting"
          onMouseDown={(e) => e.preventDefault()} onClick={() => exec("removeFormat")}>⌫fmt</button>
        <button type="button" className="rte-btn" title="Undo"
          onMouseDown={(e) => e.preventDefault()} onClick={() => exec("undo")}>↶</button>
        <button type="button" className="rte-btn" title="Redo"
          onMouseDown={(e) => e.preventDefault()} onClick={() => exec("redo")}>↷</button>
        <span className="grow" />
        <button type="button" className={`rte-btn rte-mode ${mode === "visual" ? "on" : ""}`}
          onClick={() => {
            if (mode === "html") {
              const clean = sanitizeHtml(htmlDraft);
              commit(clean, true);
              if (surface.current) surface.current.innerHTML = clean;
            }
            setMode("visual");
          }}>
          Visual
        </button>
        <button type="button" className={`rte-btn rte-mode ${mode === "html" ? "on" : ""}`}
          onClick={() => {
            if (surface.current) setHtmlDraft(surface.current.innerHTML);
            setMode("html");
          }}>
          HTML
        </button>
      </div>

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
    </div>
  );
}
