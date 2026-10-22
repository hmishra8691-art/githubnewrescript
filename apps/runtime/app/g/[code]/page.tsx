"use client";
import React from "react";

/**
 * JOIN A TEXT GROUP SESSION (2026-10-22) — the participant's page. Consent first; then the current question, an
 * answer box, and — once answered — a few other participants' answers to rate (agree / disagree / pass). It polls
 * every two seconds; there is no audio or video. The participant is a handle (P1, P2 …); their token stays in this
 * tab (sessionStorage), so closing the tab ends their place in the conversation.
 */
interface View { title: string; status: string; phase: string; handle: string; prompt: { id: string; text: string } | null; myAnswer: string | null; sample: { answerId: string; text: string; myVote: 1 | -1 | 0 | null }[]; participants: number; endsInSeconds: number | null; message: string | null }

const box: React.CSSProperties = { maxWidth: 680, margin: "0 auto", padding: "24px 16px", fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", color: "#1f2a44", lineHeight: 1.5 };
const card: React.CSSProperties = { border: "1px solid #d0d5dd", borderRadius: 10, padding: 16, margin: "12px 0", background: "#fff" };
const btn: React.CSSProperties = { border: "1px solid #2f6fde", background: "#2f6fde", color: "#fff", borderRadius: 8, padding: "8px 14px", fontSize: 15, cursor: "pointer" };
const ghost: React.CSSProperties = { ...btn, background: "#fff", color: "#2f6fde" };

export default function GroupPage({ params }: { params: { code: string } }) {
  const code = params.code;
  const key = `rs-group-${code}`;
  const [token, setToken] = React.useState<string | null>(null);
  const [consent, setConsent] = React.useState(false);
  const [view, setView] = React.useState<View | null>(null);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => { try { setToken(window.sessionStorage.getItem(key)); } catch { /* a private window */ } }, [key]);

  const call = React.useCallback(async (body: Record<string, unknown>) => {
    const r = await fetch("/api/group", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, ...body }), cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error((d as { error?: string }).error ?? `HTTP ${r.status}`), { code: (d as { code?: string }).code });
    return d as { view?: View; token?: string; handle?: string };
  }, [code]);

  const refresh = React.useCallback(async () => {
    if (!token) return;
    try { const d = await call({ action: "view", token }); if (d.view) setView(d.view); setError(null); }
    catch (e) { const c = (e as { code?: string }).code; if (c === "not_joined") { try { window.sessionStorage.removeItem(key); } catch { /* */ } setToken(null); } else setError((e as Error).message); }
  }, [call, token, key]);

  React.useEffect(() => { if (!token) return; void refresh(); const t = setInterval(() => void refresh(), 2000); return () => clearInterval(t); }, [token, refresh]);
  const promptId = view?.prompt?.id ?? null;
  React.useEffect(() => { setDraft(""); }, [promptId]);

  const join = async () => {
    setBusy(true); setError(null);
    try { const d = await call({ action: "join", consent: true }); if (d.token) { try { window.sessionStorage.setItem(key, d.token); } catch { /* */ } setToken(d.token); } }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const answer = async () => {
    if (!view?.prompt || !draft.trim()) return;
    setBusy(true); setError(null);
    try { const d = await call({ action: "answer", token, promptId: view.prompt.id, text: draft }); if (d.view) setView(d.view); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const vote = async (answerId: string, v: 1 | -1 | 0) => {
    setBusy(true); setError(null);
    try { const d = await call({ action: "vote", token, answerId, vote: v }); if (d.view) setView(d.view); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (!token) return (
    <main style={box} data-testid="group-join">
      <h1 style={{ fontSize: 24 }}>Join the conversation</h1>
      <p>This is a live, text-only group discussion. A moderator asks questions; you answer in your own words, then rate a few other participants' answers. You appear as a number (P1, P2 …), never by name. Please do not write your name, e-mail address or phone number in your answers.</p>
      <p style={{ color: "#5b6475" }}>Your answers are used for research. Taking part is voluntary and you can stop at any time by closing this page.</p>
      <label style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0" }}><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="group-consent" /> I agree to take part</label>
      <button type="button" style={btn} disabled={!consent || busy} onClick={join} data-testid="group-join-button">Join</button>
      {error && <p role="alert" style={{ color: "#b42318" }} data-testid="group-error">{error}</p>}
    </main>
  );

  return (
    <main style={box} data-testid="group-room" data-phase={view?.phase ?? ""} data-handle={view?.handle ?? ""}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>{view?.title ?? "Conversation"}</h1>
        <span style={{ color: "#5b6475" }}>You are <b data-testid="group-handle">{view?.handle}</b> · {view?.participants ?? 0} taking part{view?.endsInSeconds != null ? ` · ${view.endsInSeconds}s left` : ""}</span>
      </div>
      {view?.message && <div style={card} data-testid="group-message">{view.message}</div>}
      {view?.prompt && (
        <div style={card} data-testid="group-prompt" data-prompt={view.prompt.id}>
          <p style={{ fontSize: 18, fontWeight: 600, marginTop: 0 }}>{view.prompt.text}</p>
          {view.myAnswer === null || view.phase === "answering" ? (
            <>
              {view.myAnswer !== null && <p style={{ color: "#5b6475" }} data-testid="group-my-answer">Your answer: “{view.myAnswer}” — you can change it while answers are open.</p>}
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} maxLength={1500} style={{ width: "100%", boxSizing: "border-box", fontSize: 16, padding: 8, borderRadius: 8, border: "1px solid #d0d5dd" }} data-testid="group-answer" aria-label="Your answer" />
              <button type="button" style={btn} disabled={busy || !draft.trim()} onClick={answer} data-testid="group-submit">{view.myAnswer === null ? "Send answer" : "Change answer"}</button>
            </>
          ) : <p style={{ color: "#5b6475" }} data-testid="group-my-answer">Your answer: “{view.myAnswer}”</p>}
        </div>
      )}
      {view?.sample && view.sample.length > 0 && (
        <div style={card} data-testid="group-sample">
          <p style={{ marginTop: 0, fontWeight: 600 }}>What others said — do you agree?</p>
          {view.sample.map((s) => (
            <div key={s.answerId} style={{ borderTop: "1px solid #eef0f3", padding: "10px 0" }} data-testid="group-sample-item" data-voted={s.myVote === null ? "" : String(s.myVote)}>
              <p style={{ margin: "0 0 6px" }}>“{s.text}”</p>
              {s.myVote === null ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" style={btn} disabled={busy} onClick={() => vote(s.answerId, 1)} data-testid="group-agree">Agree</button>
                  <button type="button" style={ghost} disabled={busy} onClick={() => vote(s.answerId, -1)} data-testid="group-disagree">Disagree</button>
                  <button type="button" style={{ ...ghost, borderColor: "#d0d5dd", color: "#5b6475" }} disabled={busy} onClick={() => vote(s.answerId, 0)} data-testid="group-pass">Pass</button>
                </div>
              ) : <span style={{ color: "#5b6475" }}>{s.myVote === 1 ? "You agreed" : s.myVote === -1 ? "You disagreed" : "You passed"}</span>}
            </div>
          ))}
        </div>
      )}
      {error && <p role="alert" style={{ color: "#b42318" }} data-testid="group-error">{error}</p>}
    </main>
  );
}
