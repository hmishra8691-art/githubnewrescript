"use client";
import React from "react";
import { sanitizeHtml } from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";

/**
 * text family renderers — see docs/VARIANT-BATCH.md.
 *
 * Rich Text is an ordinary `long_text` answer: a string. What changes is that
 * the string may carry formatting markup, so
 *
 *   - every keystroke is stored through `sanitizeHtml`, never raw innerHTML;
 *   - content that is only whitespace or stray `<br>` stores `""`, so the
 *     ordinary `required` rule still refuses an "empty" formatted answer;
 *   - the counter counts the TEXT the respondent sees, and validate.ts strips
 *     tags before measuring min_length / max_length for the same reason.
 */

const TOOLS: { cmd: string; label: string; title: string; key?: string }[] = [
  { cmd: "bold", label: "B", title: "Bold (Ctrl+B)" },
  { cmd: "italic", label: "I", title: "Italic (Ctrl+I)" },
  { cmd: "underline", label: "U", title: "Underline (Ctrl+U)" },
  { cmd: "insertUnorderedList", label: "• List", title: "Bulleted list" },
  { cmd: "insertOrderedList", label: "1. List", title: "Numbered list" },
  { cmd: "removeFormat", label: "clear", title: "Clear formatting" },
];

/** Is this HTML actually empty to a reader? */
function isBlankHtml(html: string): boolean {
  return (
    html
      .replace(/<br\s*\/?>/gi, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/<[^>]*>/g, "")
      .trim() === ""
  );
}

export function RichText(p: QRProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const stored = p.value == null ? "" : String(p.value);
  const [textLen, setTextLen] = React.useState(0);
  const [empty, setEmpty] = React.useState(stored === "");

  // The surface owns its own DOM while it is being typed in — writing
  // innerHTML back on every keystroke would put the caret at the start of the
  // field after every character. So the value flows in only when it changed
  // from outside (first mount, a reset, a restored partial).
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el === document.activeElement) return;
    if (el.innerHTML !== stored) el.innerHTML = sanitizeHtml(stored);
    setTextLen((el.textContent ?? "").trim().length);
    setEmpty(isBlankHtml(el.innerHTML));
  }, [stored]);

  const push = () => {
    const el = ref.current;
    if (!el) return;
    const clean = sanitizeHtml(el.innerHTML);
    const blank = isBlankHtml(clean);
    setTextLen((el.textContent ?? "").trim().length);
    setEmpty(blank);
    p.onChange(blank ? "" : clean);
  };

  const run = (cmd: string) => {
    const el = ref.current;
    if (!el || p.q.settings.readOnly) return;
    el.focus();
    // execCommand is deprecated but is still the only cross-browser way to
    // apply formatting to a selection in a contentEditable without shipping a
    // whole editor. The output is sanitized on the way to the answer anyway.
    document.execCommand(cmd);
    push();
  };

  const minLen = Number(p.q.validation?.find((v) => v.kind === "min_length")?.value);
  const maxLen = Number(p.q.validation?.find((v) => v.kind === "max_length")?.value);
  const short = Number.isFinite(minLen) && textLen < minLen;

  return (
    <div className="rs-richtext" data-testid="richtext">
      <div className="rs-richtext-tools" role="toolbar" aria-label="Text formatting">
        {TOOLS.map((t) => (
          <button
            key={t.cmd} type="button"
            className={`rs-richtext-tool ${t.cmd === "removeFormat" ? "plain" : ""}`}
            data-cmd={t.cmd}
            title={t.title} aria-label={t.title}
            disabled={p.q.settings.readOnly}
            // keep the selection: mousedown would blur the editable first
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(t.cmd)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="rs-richtext-surface-wrap">
        <div
          ref={ref}
          className="rs-richtext-surface"
          data-testid="richtext-surface"
          contentEditable={!p.q.settings.readOnly}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={p.q.text.replace(/<[^>]*>/g, "") || "Answer"}
          onInput={push}
          onBlur={push}
        />
        {empty && (
          <div className="rs-richtext-placeholder" aria-hidden>
            {p.q.settings.placeholder ?? "Type your answer…"}
          </div>
        )}
      </div>
      <div className={`rs-counter ${short ? "short" : ""}`} data-testid="char-counter">
        {textLen} character{textLen === 1 ? "" : "s"}
        {Number.isFinite(minLen) ? ` / ${minLen} minimum` : Number.isFinite(maxLen) ? ` / ${maxLen} maximum` : ""}
      </div>
    </div>
  );
}

registerVariantRenderer("richtext", RichText);
