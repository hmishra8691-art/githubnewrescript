"use client";
import React from "react";
import { renderMarkdown } from "@/lib/docs/markdown";
import { safeHref, type HelpAnswer, type HelpContext } from "@/lib/help/compose";
import { POPULAR, topicsFor } from "@/lib/help/suggestions";

/**
 * THE HELP ASSISTANT (2026-11-09) — the Help page and the Studio's Help drawer. Ask in your own words; the answer
 * comes from the ResLens.ai guides and documentation (written by the AI when a project is billed for it, otherwise
 * assembled from the guides), with its sources, follow-ups, a clarifying question when the request is ambiguous, and —
 * for "do it for me" — a hand-off to Intelligent Mode, where the change is proposed and approved. Help itself never
 * changes a survey.
 */
type Turn = { role: "user"; text: string } | { role: "assistant"; answer: HelpAnswer & { charge?: number } };
interface ConversationRow { id: string; title: string; surveyId: string | null; updatedAt: string }

/** markdown → HTML with links limited to our pages and https */
function md(text: string): string {
  return renderMarkdown(text).html.replace(/href="([^"]*)"/g, (_m, h) => `href="${safeHref(h.replace(/&amp;/g, "&"))}"`);
}

const ORIGIN: Record<HelpAnswer["origin"], string> = { model: "Written by AI from the ResLens.ai guides", guides: "From the ResLens.ai guides" };

export function HelpAssistant({ surface, surveyId, getContext, onIntelligent, compact }: {
  surface: "platform" | "studio";
  /** the project: context and AI billing (Studio), or the project chosen to bill AI answers (Help page) */
  surveyId?: string | null;
  getContext?: () => HelpContext;
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

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setError(null);
    setInput("");
    const prior = turns;
    setTurns([...prior, { role: "user", text: q }]);
    setBusy(true);
    try {
      const r = await fetch("/api/help/ask", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: q, conversationId, surveyId: surveyId ?? null, context: getContext?.() ?? { surface },
          history: prior.slice(-10).map((t) => t.role === "user" ? { role: "user", text: t.text } : { role: "assistant", text: t.answer.answer, sources: t.answer.sources.map((s) => s.id) }),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? "Help could not answer just now."); setTurns(prior); setInput(q); return; }
      setTurns([...prior, { role: "user", text: q }, { role: "assistant", answer: { ...j.answer, charge: j.usage?.charge ?? 0 } }]);
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
    setTurns((j.messages ?? []).map((m: { role: string; content: Record<string, unknown> }) => m.role === "user" ? { role: "user", text: String(m.content.text ?? "") } : { role: "assistant", answer: m.content as unknown as HelpAnswer }));
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
              : <AnswerCard key={i} a={t.answer} onAsk={(q) => void ask(q)} onOpen={(h) => void openArticle(h)} onIntelligent={onIntelligent} surface={surface} />)}
            {busy && <div className="hx-busy" data-testid="help-busy">Looking it up…</div>}
            {error && <div className="sd-warn" role="alert">{error}</div>}
            <div ref={endRef} />
          </div>
        )}
        <form className="hx-input" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
          <textarea ref={inputRef} value={input} rows={compact ? 2 : 2} placeholder="Ask anything about ResLens.ai..." aria-label="Ask anything about ResLens.ai"
            onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }} data-testid="help-input" />
          <button className="btn primary" type="submit" disabled={busy || input.trim().length < 2} data-testid="help-send">Ask</button>
        </form>
      </section>
    </div>
  );
}

function AnswerCard({ a, onAsk, onOpen, onIntelligent, surface }: { a: HelpAnswer & { charge?: number }; onAsk(q: string): void; onOpen(href: string): void; onIntelligent?: (i: string) => void; surface: "platform" | "studio" }) {
  const [copied, setCopied] = React.useState(false);
  const html = React.useMemo(() => md(a.answer), [a.answer]);
  return (
    <div className="hx-a" data-testid="help-answer" data-mode={a.mode} data-origin={a.origin}>
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
      <div className="hx-meta">
        <span>{ORIGIN[a.origin]}</span>
        {a.origin === "model" && typeof a.charge === "number" && <span> · charged to the project: {a.charge > 0 ? a.charge.toFixed(4) : "nothing (your own AI provider, or free)"}</span>}
        {a.note && <span className="hx-note" data-testid="help-note"> · {a.note}</span>}
      </div>
    </div>
  );
}
