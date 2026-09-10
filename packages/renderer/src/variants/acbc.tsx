"use client";
import React from "react";
import {
  normalizeAcbc, emptyAcbcAnswer, isAcbcAnswer, submitByo, submitScreen, answerRule, chooseInTournament,
  type AcbcAnswer, type AcbcConcept, type AcbcConfig, type AcbcNormalized,
} from "@rescript/engine";
import type { QRProps } from "../QuestionRenderer";
import { registerVariantRenderer } from "./registry";

/**
 * ADAPTIVE CBC — the renderer for `acbc_task`. A stage machine on screen:
 *
 *   BYO         one radio group per attribute → "Continue"
 *   SCREEN      concept cards, each "A possibility" / "Won't work for me"
 *   RULE        "Would you never consider…?" / "Must it have…?" → Yes / No
 *   TOURNAMENT  a set of concepts → pick one
 *   DONE        the winning concept
 *
 * Every transition is a pure function in the engine (acbc.ts) applied to the
 * stored answer with the respondent's seed, so the renderer holds no state of
 * its own: what is on screen is exactly what the answer says, a reload
 * resumes mid-exercise, and the analysis can replay the whole thing.
 */

function ConceptCard({ c, attrs, byo, children, selected, testId }: {
  c: AcbcConcept; attrs: AcbcNormalized["attributes"]; byo: Record<string, string>; children?: React.ReactNode; selected?: boolean; testId?: string;
}) {
  return (
    <div className={`rs-acbc-concept${selected ? " selected" : ""}`} data-testid={testId ?? "rs-acbc-concept"} data-concept={c.id}>
      <table className="rs-acbc-profile">
        <tbody>
          {attrs.map((a) => (
            <tr key={a.name} className={c.profile[a.name] !== byo[a.name] ? "differs" : ""}>
              <th>{a.name}</th>
              <td>{c.profile[a.name]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {children}
    </div>
  );
}

export function AcbcTasks(p: QRProps) {
  const design = p.def.designs.find((d) => d.id === p.q.settings.designRef);
  if (!design) return <div className="rs-error-msg">Design “{p.q.settings.designRef ?? "(none)"}” not found — create an ACBC design in Design Generators and pick it here.</div>;
  if (design.kind !== "acbc") return <div className="rs-error-msg">This question needs an ACBC design; “{design.name}” is a {design.kind} design.</div>;
  const cfg = normalizeAcbc((design.config ?? {}) as AcbcConfig);
  const seed = p.state.seed;
  const a: AcbcAnswer = isAcbcAnswer(p.value) ? p.value : emptyAcbcAnswer();
  const readOnly = !!p.q.settings.readOnly;
  const set = (next: AcbcAnswer) => { if (!readOnly) p.onChange(next); };

  /* ------------------------------------------------------------- BYO */
  const [byoDraft, setByoDraft] = React.useState<Record<string, string>>(a.byo);
  const byoComplete = cfg.attributes.every((at) => byoDraft[at.name]);
  if (a.stage === "byo") {
    return (
      <div className="rs-acbc" data-testid="rs-acbc" data-stage="byo">
        <div className="rs-acbc-lead">Build the one you would most like to buy.</div>
        {cfg.attributes.map((at) => (
          <fieldset key={at.name} className="rs-acbc-attr" data-testid="rs-acbc-byo-attr" data-attribute={at.name}>
            <legend>{at.name}</legend>
            <div className="rs-acbc-levels">
              {at.levels.map((l) => (
                <label key={l} className={`rs-option${byoDraft[at.name] === l ? " selected" : ""}`}>
                  <input type="radio" name={`${p.q.id}_byo_${at.name}`} value={l} checked={byoDraft[at.name] === l} disabled={readOnly}
                    onChange={() => setByoDraft((d) => ({ ...d, [at.name]: l }))} />
                  <span>{l}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <div className="rs-acbc-actions">
          <button type="button" className="rs-btn" data-testid="rs-acbc-continue" disabled={!byoComplete || readOnly}
            onClick={() => set(submitByo(cfg, a, seed, byoDraft))}>Continue</button>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------- SCREEN */
  if (a.stage === "screen") {
    const s = a.screens[a.screens.length - 1];
    const allJudged = s.concepts.every((c) => s.verdicts[c.id]);
    const judge = (id: string, v: "yes" | "no") => {
      const screens = [...a.screens.slice(0, -1), { ...s, verdicts: { ...s.verdicts, [id]: v } }];
      set({ ...a, screens });
    };
    return (
      <div className="rs-acbc" data-testid="rs-acbc" data-stage="screen" data-screen={a.screens.length}>
        <div className="rs-acbc-lead">Screen {a.screens.length} of {cfg.screeningTasks} — for each of these, could it work for you?</div>
        <div className="rs-acbc-grid">
          {s.concepts.map((c) => (
            <ConceptCard key={c.id} c={c} attrs={cfg.attributes} byo={a.byo}>
              <div className="rs-acbc-verdict" role="group" aria-label="Your verdict">
                <button type="button" className={`rs-btn-mini${s.verdicts[c.id] === "yes" ? " on" : ""}`} data-testid="rs-acbc-yes" aria-pressed={s.verdicts[c.id] === "yes"} disabled={readOnly} onClick={() => judge(c.id, "yes")}>A possibility</button>
                <button type="button" className={`rs-btn-mini${s.verdicts[c.id] === "no" ? " on" : ""}`} data-testid="rs-acbc-no" aria-pressed={s.verdicts[c.id] === "no"} disabled={readOnly} onClick={() => judge(c.id, "no")}>Won't work for me</button>
              </div>
            </ConceptCard>
          ))}
        </div>
        <div className="rs-acbc-actions">
          <button type="button" className="rs-btn" data-testid="rs-acbc-continue" disabled={!allJudged || readOnly}
            onClick={() => set(submitScreen(cfg, a, seed))}>Continue</button>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------ RULE */
  if (a.stage === "rule" && a.pending) {
    const r = a.pending;
    return (
      <div className="rs-acbc" data-testid="rs-acbc" data-stage="rule" data-rule-kind={r.kind}>
        <div className="rs-acbc-rule" data-testid="rs-acbc-rule">
          <p>
            {r.kind === "unacceptable"
              ? <>You have said no to every option with <strong>{r.attribute}: {r.level}</strong>. Would you <strong>never</strong> consider one?</>
              : <>Every option you kept has <strong>{r.attribute}: {r.level}</strong>. Must it have that?</>}
          </p>
          <div className="rs-acbc-actions">
            <button type="button" className="rs-btn" data-testid="rs-acbc-rule-yes" disabled={readOnly} onClick={() => set(answerRule(cfg, a, seed, true))}>
              {r.kind === "unacceptable" ? "Yes — never" : "Yes — it must"}
            </button>
            <button type="button" className="rs-btn secondary" data-testid="rs-acbc-rule-no" disabled={readOnly} onClick={() => set(answerRule(cfg, a, seed, false))}>
              {r.kind === "unacceptable" ? "No — I might" : "No — not necessarily"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------ TOURNAMENT */
  if (a.stage === "tournament") {
    const round = a.tournament[a.tournament.length - 1];
    return (
      <div className="rs-acbc" data-testid="rs-acbc" data-stage="tournament" data-round={a.tournament.length}>
        <div className="rs-acbc-lead">Round {a.tournament.length} — of these, which would you choose?</div>
        <div className="rs-acbc-grid">
          {round.concepts.map((c) => (
            <ConceptCard key={c.id} c={c} attrs={cfg.attributes} byo={a.byo} selected={round.chosen === c.id}>
              <button type="button" className="rs-btn" data-testid="rs-acbc-choose" disabled={readOnly || !!round.chosen}
                onClick={() => set(chooseInTournament(cfg, a, seed, c.id))}>Choose this one</button>
            </ConceptCard>
          ))}
        </div>
      </div>
    );
  }

  /* ------------------------------------------------------------ DONE */
  return (
    <div className="rs-acbc" data-testid="rs-acbc" data-stage="done">
      <div className="rs-acbc-lead">Thank you — this is the option you ended up preferring.</div>
      {a.winner && <ConceptCard c={a.winner} attrs={cfg.attributes} byo={a.byo} testId="rs-acbc-winner" />}
      {!readOnly && (
        <div className="rs-acbc-actions">
          <button type="button" className="rs-hotspot-clear" data-testid="rs-acbc-restart" onClick={() => { setByoDraft({}); p.onChange(emptyAcbcAnswer()); }}>start over</button>
        </div>
      )}
    </div>
  );
}

registerVariantRenderer("acbctasks", AcbcTasks);
registerVariantRenderer("base:acbc_task", AcbcTasks);
