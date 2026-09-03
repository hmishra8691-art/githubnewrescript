"use client";
import React from "react";
import { registerVariantSettings } from "./registry";
import { CountInput } from "../CountInput";

/**
 * Studio authoring for the conversational family — the chat question's pacing.
 * The prompts themselves are the question's ROWS (it is a text grid), so they
 * are edited where every other grid's rows are edited.
 */
registerVariantSettings("chat", ({ q, patchSettings }) => (
  <>
    <h3 className="sec">Chat pacing</h3>
    <label className="f">
      <span>Pause before the next prompt (ms)</span>
      <CountInput data-testid="chat-delay" min={0} max={5000} width={110}
        value={q.settings.chatDelayMs}
        onChange={(v) => patchSettings({ chatDelayMs: v })} />
    </label>
    <div className="muted" style={{ fontSize: 11 }}>
      Empty = 600ms. The pause is when the typing indicator shows; 0 asks the
      next question instantly.
    </div>
    <div className={q.rows.length === 0 ? "chip warn" : "chip"} data-testid="chat-rowcount"
      style={{ marginTop: 8 }}>
      {q.rows.length === 0
        ? "No prompts yet — the chat asks the question's ROWS, one at a time."
        : `${q.rows.length} prompt${q.rows.length === 1 ? "" : "s"}, asked one at a time`}
    </div>
    {q.required && (
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        Required means every prompt must be answered — the ordinary grid rule.
      </div>
    )}
  </>
));
