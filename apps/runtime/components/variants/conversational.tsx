"use client";
import React from "react";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";
import { useRows } from "./shared";

/**
 * Conversational family — Chat-Based Question.
 *
 * Base type `matrix_text`: the rows are the prompts and the answer is
 * `{rowCode: text}`, exactly like a text grid, so `required` means "every
 * visible row answered" through the ordinary matrix validator and the export
 * gets one column per prompt. Only the presentation is a conversation.
 *
 * Prompts arrive one at a time — that is the whole point of the treatment —
 * so `visible` counts how many have been asked. It starts past whatever was
 * already answered, which is what makes coming Back to the page resume the
 * conversation instead of restarting it.
 */
export function ChatQuestion(p: QRProps) {
  const rows = useRows(p);
  const vals = (p.value ?? {}) as Record<string, unknown>;
  const delay = Math.max(0, p.q.settings.chatDelayMs ?? 600);
  const readOnly = !!p.q.settings.readOnly;

  const answeredCount = rows.filter((r) => {
    const v = vals[String(r.code)];
    return v != null && String(v).trim() !== "";
  }).length;

  const [visible, setVisible] = React.useState(() => Math.min(rows.length, answeredCount + 1));
  const [typing, setTyping] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [editing, setEditing] = React.useState<string | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);

  // rows can arrive later (carry-forward, piped rows): never show fewer
  // prompts than have already been answered
  React.useEffect(() => {
    setVisible((v) => Math.max(Math.min(rows.length, answeredCount + 1), Math.min(v, rows.length)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  React.useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [visible, typing, answeredCount]);

  const shown = rows.slice(0, Math.max(1, visible));
  // the prompt awaiting a reply: the first shown row without one
  const pendingRow = editing
    ? rows.find((r) => String(r.code) === editing)
    : shown.find((r) => {
      const v = vals[String(r.code)];
      return v == null || String(v).trim() === "";
    });

  const send = () => {
    const text = draft.trim();
    if (!text || !pendingRow || readOnly) return;
    const rc = String(pendingRow.code);
    p.onChange({ ...vals, [rc]: text });
    setDraft("");
    if (editing) { setEditing(null); return; }
    // typing indicator, then the next prompt — a conversation that answers
    // itself instantly reads like a form with speech bubbles
    if (visible < rows.length) {
      setTyping(true);
      setTimeout(() => { setTyping(false); setVisible((v) => Math.min(rows.length, v + 1)); }, delay);
    }
  };

  const edit = (rc: string) => {
    if (readOnly) return;
    setEditing(rc);
    setDraft(String(vals[rc] ?? ""));
  };

  if (rows.length === 0) {
    return (
      <div className="rs-empty-hint" data-testid="chat-empty">
        A chat question asks its <strong>rows</strong> one at a time — add the
        prompts in the question editor.
      </div>
    );
  }

  const finished = answeredCount >= rows.length && !editing;

  return (
    <div className="rs-chat" data-testid="chat">
      <div className="rs-chat-progress" data-testid="chat-progress">
        {answeredCount} of {rows.length} answered
      </div>
      <div className="rs-chat-log" role="log" aria-live="polite">
        {shown.map((r) => {
          const rc = String(r.code);
          const reply = vals[rc];
          const hasReply = reply != null && String(reply).trim() !== "";
          return (
            <React.Fragment key={rc}>
              <div className="rs-chat-row in">
                <div className="rs-chat-bubble in" data-row={rc}
                  dangerouslySetInnerHTML={{ __html: r.label }} />
              </div>
              {hasReply && (
                <div className="rs-chat-row out">
                  <div className={`rs-chat-bubble out ${editing === rc ? "editing" : ""}`}
                    data-reply={rc} role="button" tabIndex={0}
                    title="click to change this answer"
                    onClick={() => edit(rc)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); edit(rc); } }}>
                    {String(reply)}
                    <span className="rs-chat-edit" aria-hidden>✎</span>
                  </div>
                </div>
              )}
            </React.Fragment>
          );
        })}
        {typing && (
          <div className="rs-chat-row in">
            <div className="rs-chat-bubble in typing" data-testid="chat-typing" aria-label="typing">
              <i /><i /><i />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="rs-chat-compose">
        <input
          className="rs-input rs-chat-input"
          data-testid="chat-input"
          placeholder={
            editing ? "Change your answer…"
              : pendingRow ? "Type your answer…"
                : "All answered"
          }
          aria-label="Your answer"
          value={draft}
          disabled={readOnly || (!pendingRow && !editing)}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(); } }}
        />
        <button type="button" className="rs-btn rs-chat-send" data-testid="chat-send"
          disabled={readOnly || !draft.trim() || (!pendingRow && !editing)}
          onClick={send}>
          {editing ? "Update" : "Send"}
        </button>
      </div>
      {editing && (
        <button type="button" className="rs-chat-cancel"
          onClick={() => { setEditing(null); setDraft(""); }}>
          cancel edit
        </button>
      )}
      {finished && <div className="rs-chat-done" data-testid="chat-done">That’s everything — thank you.</div>}
    </div>
  );
}

registerVariantRenderer("chat", ChatQuestion);
