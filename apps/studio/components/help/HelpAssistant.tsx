"use client";
import React from "react";
import { renderMarkdown } from "@/lib/docs/markdown";
import { safeHref, type HelpAnswer, type HelpContext } from "@/lib/help/compose";
import { POPULAR, topicsFor } from "@/lib/help/suggestions";
import { HeardNote, VoiceButton } from "@/components/intelligent/VoiceButton";
import { DictateButton } from "@/components/analytics/DictateButton";
import type { HeardTranscript } from "@/lib/intelligent/voice";

/**
 * THE HELP ASSISTANT (2026-11-09) — the Help page and the Studio's Help drawer. Ask in your own words; the answer
 * comes from the ResLens.ai guides and documentation (written by the AI when a project is billed for it, otherwise
 * assembled from the guides), with its sources, follow-ups, a clarifying question when the request is ambiguous, and —
 * for "do it for me" — a hand-off to Intelligent Mode, where the change is proposed and approved. Help itself never
 * changes a survey.
 *
 * HELP CENTER ROUTING (2026-11-10): each answer says how it was produced — from the guides, from a check of the open
 * survey (the Studio sends its definition; the engine's own diagnostics run on it), or written by AI — because the
 * model is now called only when it adds something (lib/help/levels.ts). Troubleshooting answers ask "Did this solve
 * it?"; a No moves the problem on without repeating the fix that failed. When Help cannot resolve it, it offers to hand
 * the conversation to the support team, showing first exactly what would be shared. With a project to bill, "Ask the
 * AI instead" asks the model for the same question.
 */
type Turn = { role: "user"; text: string } | { role: "assistant"; answer: HelpAnswer & { charge?: number }; messageId?: string | null; question?: string };
interface ConversationRow { id: string; title: string; surveyId: string | null; updatedAt: string }

/** markdown → HTML with links limited to our pages and https */
function md(text: string): string {
  return renderMarkdown(text).html.replace(/href="([^"]*)"/g, (_m, h) => `href="${safeHref(h.replace(/&amp;/g, "&"))}"`);
}

const ORIGIN: Record<HelpAnswer["origin"], string> = { model: "Written by AI from the ResLens.ai guides", guides: "From the ResLens.ai guides" };
/* how the answer was produced (lib/help/levels.ts) — said plainly, so nobody wonders whether AI was used or charged */
const LEVEL_BADGE: Record<1 | 2 | 3, string> = { 1: "From the guides · no AI used", 2: "Checked your survey · no AI used", 3: "Written by AI" };

export function HelpAssistant({ surface, surveyId, getContext, getDefinition, onIntelligent, compact }: {
  surface: "platform" | "studio";
  /** the project: context and AI billing (Studio), or the project chosen to bill AI answers (Help page) */
  surveyId?: string | null;
  getContext?: () => HelpContext;
  /** Studio only: the open survey as it is now (unsaved edits included) — checked by the engine for troubleshooting */
  getDefinition?: () => unknown;
  /** Studio only: put the instruction into Intelligent Mode's input */
  onIntelligent?: (instruction: string) => void;
  compact?: boolean;
}) {
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [conversationId, setConversationId] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<ConversationRow[]>([]);
  const [storedNote, setStoredNote] = React.useState<string | null>(null);
  const [article, setArticle] = React.useState<{ id: string; title: string; markdown: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  /* a spoken question that was not English: the original words beside the English reading in the box */
  const [heard, setHeard] = React.useState<HeardTranscript | null>(null);
  const endRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const tab = getContext?.().tab;
  const topics = React.useMemo(() => topicsFor(tab), [tab]);

  const loadHistory = React.useCallback(async () => {
    const r = await fetch("/api/help/conversations", { cache: "no-store" }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setHistory(j.conversations ?? []);
    setStoredNote(j.persisted === false ? (j.note ?? "Conversations are kept for this session only.") : null);
  }, []);
  React.useEffect(() => { void loadHistory(); }, [loadHistory]);
  React.useEffect(() => { endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [turns, busy]);
  React.useEffect(() => {
    if (surface !== "platform") return;
    const id = new URL(window.location.href).searchParams.get("article");
    if (id) void openArticle(id);
  }, [surface]);

  async function openArticle(href: string) {
    const id = href.startsWith("/help?article=") ? decodeURIComponent(href.split("=")[1] ?? "") : href;
    if (href.startsWith("/docs/")) { window.open(href, "_blank", "noopener"); return; }
    const r = await fetch(`/api/help/article?id=${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) setArticle({ id: j.id, title: j.title, markdown: j.markdown });
  }

  async function ask(text: string, opts: { forceAi?: boolean } = {}) {
    const q = text.trim();
    if (!q || busy) return;
    setError(null);
    setInput("");
    setHeard(null);
    const prior = turns;
    setTurns([...prior, { role: "user", text: q }]);
    setBusy(true);
    try {
      const r = await fetch("/api/help/ask", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: q, conversationId, surveyId: surveyId ?? null, context: getContext?.() ?? { surface },
          ...(getDefinition ? { definition: getDefinition() } : {}),
          ...(opts.forceAi ? { forceAi: true } : {}),
          history: prior.slice(-10).map((t) => t.role === "user" ? { role: "user", text: t.text } : { role: "assistant", text: t.answer.answer, sources: t.answer.sources.map((s) => s.id), level: t.answer.route?.level }),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? "Help could not answer just now."); setTurns(prior); setInput(q); return; }
      setTurns([...prior, { role: "user", text: q }, { role: "assistant", answer: { ...j.answer, charge: j.usage?.charge ?? 0 }, messageId: j.messageId ?? null, question: q }]);
      if (j.conversationId && j.conversationId !== conversationId) { setConversationId(j.conversationId); void loadHistory(); }
    } catch {
      setError("Help could not be reached."); setTurns(prior); setInput(q);
    } finally { setBusy(false); inputRef.current?.focus(); }
  }

  async function openConversation(id: string) {
    const r = await fetch(`/api/help/conversations?id=${encodeURIComponent(id)}`, { cache: "no-store" }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) return;
    setConversationId(id);
    setArticle(null);
    setTurns((j.messages ?? []).map((m: { id?: string; role: string; content: Record<string, unknown> }) => m.role === "user" ? { role: "user", text: String(m.content.text ?? "") } : { role: "assistant", answer: m.content as unknown as HelpAnswer, messageId: m.id ?? null }));
  }
  async function deleteConversation(id: string) {
    await fetch(`/api/help/conversations?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (id === conversationId) newConversation();
    void loadHistory();
  }
  function newConversation() { setTurns([]); setConversationId(null); setArticle(null); setError(null); inputRef.current?.focus(); }

  const empty = turns.length === 0;
  return (
    <div className={`hx${compact ? " compact" : ""}`} data-testid="help-assistant">
      {!compact && (
        <aside className="hx-side" aria-label="Help conversations">
          <button type="button" className="btn small" onClick={newConversation} data-testid="help-new">New conversation</button>
          <div className="hx-hist" data-testid="help-history">
            {history.map((c) => (
              <div key={c.id} className={`hx-hist-row${c.id === conversationId ? " on" : ""}`}>
                <button type="button" className="hx-hist-open" onClick={() => void openConversation(c.id)} title={c.title}>{c.title}</button>
                <button type="button" className="hx-hist-del" onClick={() => void deleteConversation(c.id)} aria-label={`Delete “${c.title}”`}>×</button>
              </div>
            ))}
            {!history.length && <p className="muted hx-small">{storedNote ?? "Your conversations will appear here."}</p>}
          </div>
        </aside>
      )}
      <section className="hx-main">
        {article ? (
          <div className="hx-article" data-testid="help-article">
            <button type="button" className="btn small ghost" onClick={() => setArticle(null)}>← Back to the conversation</button>
            <div className="hx-md" dangerouslySetInnerHTML={{ __html: md(article.markdown) }} />
          </div>
        ) : (
          <div className="hx-log" data-testid="help-log" aria-live="polite">
            {empty && (
              <div className="hx-welcome" data-testid="help-welcome">
                <h2>ResLens.ai Help</h2>
                <p className="muted">Ask in your own words — how to program something, why something isn't working, which method fits your research, how billing works. Answers come from the ResLens.ai guides, with their sources.</p>
                <div className="hx-chips" data-testid="help-suggestions">{POPULAR.slice(0, compact ? 6 : 12).map((q) => <button key={q} type="button" className="hx-chip" onClick={() => void ask(q)}>{q}</button>)}</div>
                <div className="hx-topics">
                  {topics.slice(0, compact ? 4 : topics.length).map((t) => (
                    <details key={t.category} className="hx-topic" data-testid={`help-topic-${t.category}`}>
                      <summary>{t.label}</summary>
                      <ul>{t.questions.map((q) => <li key={q}><button type="button" className="hx-link" onClick={() => void ask(q)}>{q}</button></li>)}</ul>
                    </details>
                  ))}
                </div>
              </div>
            )}
            {turns.map((t, i) => t.role === "user"
              ? <div key={i} className="hx-q" data-testid="help-question">{t.text}</div>
              : <AnswerCard key={i} a={t.answer} last={i === turns.length - 1 && !busy} messageId={t.messageId ?? null}
                  onAsk={(q, o) => void ask(q, o)} onOpen={(h) => void openArticle(h)} onIntelligent={onIntelligent} surface={surface}
                  canAskAi={!!surveyId && surveyId !== "sandbox"} question={t.question ?? lastQuestionBefore(turns, i)}
                  escalation={{ conversationId, surveyId: surveyId ?? null, context: () => getContext?.() ?? { surface }, transcript: () => turns.map((x) => x.role === "user" ? { role: "user", text: x.text } : { role: "assistant", answer: x.answer }) }} />)}
            {busy && <div className="hx-busy" data-testid="help-busy">Looking it up…</div>}
            {error && <div className="sd-warn" role="alert">{error}</div>}
            <div ref={endRef} />
          </div>
        )}
        <HeardNote heard={heard} onUseOriginal={heard ? () => { setInput((t) => t.replace(heard.english ?? "", heard.text)); setHeard(null); } : undefined} />
        <form className="hx-input" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
          <textarea ref={inputRef} value={input} rows={compact ? 2 : 2} placeholder="Ask anything about ResLens.ai..." aria-label="Ask anything about ResLens.ai"
            onChange={(e) => { setInput(e.target.value); setHeard(null); }} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }} data-testid="help-input" />
          {/*
           * VOICE (2026-11-09): speak the question instead. In a project the platform's voice pipeline transcribes it
           * (any language, billed to the project like other speech); on the Help page without a project, the browser's
           * own dictation (on the device, no charge). Either way the words land in the box to edit — nothing is sent
           * until Ask.
           */}
          <span className="hx-voice">
            {surveyId
              ? <VoiceButton compact surveyId={surveyId} label="Speak your question" disabled={busy} refusedMessage="Microphone access was refused — allow it in the browser to ask by voice."
                  onHeard={(h) => { const words = (h.english || h.text).trim(); if (!words) return; setInput((t) => `${t.trim()}${t.trim() ? " " : ""}${words}`); setHeard(h.english && h.language !== "en" ? h : null); inputRef.current?.focus(); }} />
              : <DictateButton value={input} onChange={(t) => { setInput(t); inputRef.current?.focus(); }} disabled={busy} />}
          </span>
          <button className="btn primary" type="submit" disabled={busy || input.trim().length < 2} data-testid="help-send">Ask</button>
        </form>
      </section>
    </div>
  );
}

function lastQuestionBefore(turns: Turn[], i: number): string {
  for (let k = i - 1; k >= 0; k--) { const t = turns[k]; if (t.role === "user") return t.text; }
  return "";
}

interface EscalationInput { conversationId: string | null; surveyId: string | null; context: () => HelpContext; transcript: () => unknown[] }

function AnswerCard({ a, last, messageId, onAsk, onOpen, onIntelligent, surface, canAskAi, question, escalation }: {
  a: HelpAnswer & { charge?: number }; last: boolean; messageId: string | null;
  onAsk(q: string, o?: { forceAi?: boolean }): void; onOpen(href: string): void; onIntelligent?: (i: string) => void; surface: "platform" | "studio";
  canAskAi: boolean; question: string; escalation: EscalationInput;
}) {
  const [copied, setCopied] = React.useState(false);
  const [solved, setSolved] = React.useState<boolean | null>(a.solved ?? null);
  const html = React.useMemo(() => md(a.answer), [a.answer]);
  const level = a.route?.level;
  const asksFeedback = last && !a.clarify && (a.mode === "troubleshoot" || !!a.diagnosis || !!a.route?.attempt);
  const feedback = async (yes: boolean) => {
    setSolved(yes);
    if (messageId) void fetch("/api/help/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId, solved: yes }) }).catch(() => {});
    if (!yes) onAsk("That didn't solve it — it's still happening.");
  };
  return (
    <div className="hx-a" data-testid="help-answer" data-mode={a.mode} data-origin={a.origin} data-level={level ?? ""}>
      {level && (
        <div className={`hx-route l${level}`} data-testid="help-route" title={a.route?.reason}>
          {LEVEL_BADGE[level]}{a.route?.cached ? " · reused, no new charge" : ""}
        </div>
      )}
      {a.diagnosis && (
        <div className={`hx-diag${a.diagnosis.verdict ? ` v-${a.diagnosis.verdict}` : ""}`} data-testid="help-diagnosis" data-verdict={a.diagnosis.verdict ?? ""}>
          Checked {a.diagnosis.target ?? "your survey"}{a.diagnosis.verdict ? ` — ${a.diagnosis.verdict === "never" ? "never shown" : a.diagnosis.verdict === "sometimes" ? "shown only sometimes" : "always shown"}` : ""} · {a.diagnosis.findings.filter((f) => f.severity !== "info").length} finding{a.diagnosis.findings.filter((f) => f.severity !== "info").length === 1 ? "" : "s"}
        </div>
      )}
      <div className="hx-md" dangerouslySetInnerHTML={{ __html: html }} onClick={(e) => {
        const el = (e.target as HTMLElement).closest("a");
        if (el && el.getAttribute("href")?.startsWith("/help?article=")) { e.preventDefault(); onOpen(el.getAttribute("href")!); }
      }} />
      {a.clarify && (
        <div className="hx-clarify" data-testid="help-clarify">
          <strong>{a.clarify.question}</strong>
          <div className="hx-chips">{a.clarify.options.map((o) => <button key={o.label} type="button" className="hx-chip" onClick={() => onAsk(o.ask)}>{o.label}</button>)}</div>
        </div>
      )}
      {a.intelligent?.instruction && (
        <div className="hx-do" data-testid="help-intelligent">
          <div><strong>Have Intelligent Mode do it</strong> <span className="muted">— it proposes the change; nothing is applied until you approve it.</span></div>
          <code className="hx-instr">{a.intelligent.instruction}</code>
          {surface === "studio" && onIntelligent
            ? <button type="button" className="btn small primary" onClick={() => onIntelligent(a.intelligent!.instruction)} data-testid="help-send-intelligent">Send to Intelligent Mode</button>
            : <button type="button" className="btn small" onClick={() => { void navigator.clipboard?.writeText(a.intelligent!.instruction).then(() => setCopied(true)).catch(() => {}); }}>{copied ? "Copied — paste it in Intelligent Mode in your project" : "Copy for Intelligent Mode"}</button>}
        </div>
      )}
      {a.sources.length > 0 && (
        <div className="hx-sources" data-testid="help-sources">
          <span className="muted">Sources:</span>
          {[...new Map(a.sources.map((s) => [s.href, s])).values()].map((s) => (
            <a key={s.id} href={s.href} onClick={(e) => { e.preventDefault(); onOpen(s.href); }} className="hx-src">{s.title}</a>
          ))}
        </div>
      )}
      {a.followUps.length > 0 && (
        <div className="hx-chips hx-follow" data-testid="help-followups">{a.followUps.map((q) => <button key={q} type="button" className="hx-chip small" onClick={() => onAsk(q)}>{q}</button>)}</div>
      )}
      {asksFeedback && (
        <div className="hx-solved" data-testid="help-solved">
          {solved === null ? (
            <>
              <span>Did this solve it?</span>
              <button type="button" className="btn small" onClick={() => void feedback(true)} data-testid="help-solved-yes">Yes</button>
              <button type="button" className="btn small" onClick={() => void feedback(false)} data-testid="help-solved-no">No, still happening</button>
            </>
          ) : <span className="muted">{solved ? "Glad that sorted it." : "Thanks — looking further."}</span>}
        </div>
      )}
      {last && canAskAi && level !== 3 && !a.clarify && a.mode !== "do" && question && (
        <button type="button" className="btn small ghost hx-askai" onClick={() => onAsk(question, { forceAi: true })} data-testid="help-ask-ai"
          title="Have the AI write an answer from the same guides and your survey's context — charged to the project like other AI requests">Ask the AI instead</button>
      )}
      {a.escalate?.offer && <Escalation reason={a.escalate.reason} input={escalation} />}
      <div className="hx-meta">
        <span>{ORIGIN[a.origin]}</span>
        {a.origin === "model" && typeof a.charge === "number" && <span> · charged to the project: {a.charge > 0 ? a.charge.toFixed(4) : "nothing (your own AI provider, or free)"}</span>}
        {a.note && <span className="hx-note" data-testid="help-note"> · {a.note}</span>}
      </div>
    </div>
  );
}

/**
 * HAND IT TO A PERSON — offered when the router says so (the user asked, two fixes failed, the guides don't cover it).
 * Nothing is sent until the user has seen what will be shared and pressed Send; the reference comes back to quote.
 */
function Escalation({ reason, input }: { reason: string | null; input: EscalationInput }) {
  const [stage, setStage] = React.useState<"offer" | "confirm" | "sending" | "sent">("offer");
  const [shared, setShared] = React.useState<string[]>([]);
  const [unavailable, setUnavailable] = React.useState<string | null>(null);
  const [note, setNote] = React.useState("");
  const [result, setResult] = React.useState<{ reference: string; emailed: boolean; stored: boolean } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const open = async () => {
    setStage("confirm");
    const turns = input.transcript().length;
    const local = [`this conversation (${turns} message${turns === 1 ? "" : "s"})`, "the answers tried and how each was produced", "what the checks of your survey found, if they ran", "where you were: the Studio tab, your survey's title and size, and the selected question", "your account e-mail, so the support team can reply"];
    const r = await fetch(`/api/help/escalate${input.conversationId ? `?conversationId=${encodeURIComponent(input.conversationId)}` : ""}`, { cache: "no-store" }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (j.available === false) setUnavailable(j.note ?? "Support hand-off isn't set up on this installation.");
    setShared(Array.isArray(j.shared) && j.shared.length ? j.shared : local);
  };
  const send = async () => {
    setStage("sending"); setError(null);
    const r = await fetch("/api/help/escalate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: input.conversationId, surveyId: input.surveyId, message: note.trim() || null, reason, context: input.context(), transcript: input.transcript() }),
    }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) { setError(j.error ?? "The hand-off could not be sent."); setStage("confirm"); return; }
    setResult({ reference: j.reference, emailed: !!j.emailed, stored: !!j.stored }); setStage("sent");
  };

  if (stage === "sent" && result) {
    return (
      <div className="hx-esc sent" data-testid="help-escalated" role="status">
        <strong>Sent to the support team — reference <span className="mono" data-testid="help-escalation-ref">{result.reference}</span>.</strong>{" "}
        <span className="muted">They have the whole conversation and what was tried, so you won't need to explain it again. They'll reply to your account e-mail.</span>
      </div>
    );
  }
  return (
    <div className="hx-esc" data-testid="help-escalate">
      {stage === "offer" ? (
        <>
          <span>{reason === "you asked for a person" ? "Want a person to take it from here?" : "Still stuck? A person from the support team can take it from here."}</span>
          <button type="button" className="btn small" onClick={() => void open()} data-testid="help-escalate-open">Hand this to support</button>
        </>
      ) : (
        <div className="hx-esc-confirm" data-testid="help-escalate-confirm">
          <strong>This is what the support team will receive:</strong>
          <ul>{shared.map((x) => <li key={x}>{x}</li>)}</ul>
          {unavailable && <div className="sd-warn" role="alert" data-testid="help-escalate-unavailable">{unavailable}</div>}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything to add? (optional)" aria-label="A note for the support team" data-testid="help-escalate-note" />
          {error && <div className="sd-warn" role="alert" data-testid="help-escalate-error">{error}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn small primary" disabled={stage === "sending" || !!unavailable} onClick={() => void send()} data-testid="help-escalate-send">{stage === "sending" ? "Sending…" : "Send to support"}</button>
            <button type="button" className="btn small ghost" onClick={() => setStage("offer")}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
