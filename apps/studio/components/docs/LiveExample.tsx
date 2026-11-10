"use client";
import * as React from "react";
import type { SurveyDefinition } from "@rescript/schema";
import { LiveSurvey } from "./LiveSurvey";
import { DesignPreview } from "../studio/DesignPreview";

/**
 * ONE FEATURE, THREE VIEWS (Developer Docs, 2026-11-09): how it is configured in the builder (a screenshot of the real
 * Studio with this example loaded), how it is stored (the engine's expression text and the definition's JSON), and
 * what the respondent sees (the live survey). The three are numbered and joined so the reader follows one example
 * from the editor to the screen.
 */
export interface LiveExampleData {
  id: string; title: string; tryIt: string;
  def: SurveyDefinition;
  logic: { label: string; text: string }[];
  json: string;
  builder: { images: string[]; caption: string; tab: string; question?: string; section?: string };
  embedded: Record<string, string>;
  said?: { text: string; kind: string; understood: string; actions: string; applied: string[]; note?: string }[];
  output?: { name: string; n: number; table?: { title: string; columns: { key: string; label: string }[]; rows: Record<string, string>[] }; bars?: { label: string; value: number }[]; insights: string[]; warnings: string[]; error?: string }[] | null;
  simulated?: number;
  designs?: { kind: string; name: string; file: { columns: string[]; rows: Record<string, unknown>[]; summary?: Record<string, unknown> } }[];
}

const KIND_LABEL: Record<string, string> = { actions: "Proposed", refused: "Refused", model: "To the language model", clarify: "Asked back", answer: "Answered" };

function Said({ said }: { said: NonNullable<LiveExampleData["said"]> }) {
  const [open, setOpen] = React.useState<number | null>(null);
  return (
    <ol className="docs-say" data-testid="docs-say">
      {said.map((l, i) => (
        <li key={i} className={`docs-say-item k-${l.kind}`} data-kind={l.kind}>
          <div className="docs-say-you"><span className="docs-say-who">You</span>{l.text}</div>
          <div className="docs-say-eng">
            <span className={`docs-say-badge k-${l.kind}`}>{KIND_LABEL[l.kind] ?? l.kind}</span>
            {l.understood && <span className="docs-say-und">{l.understood}</span>}
            {l.applied.length > 0 && <ul className="docs-say-applied">{l.applied.map((a, k) => <li key={k}>✓ {a}</li>)}</ul>}
            {l.note && <p className="docs-say-note">{l.note}</p>}
            {l.actions && (
              <div className="docs-ex-json-bar">
                <button type="button" className="linkish" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i} data-testid="docs-say-actions">{open === i ? "▾" : "▸"} The actions</button>
                <CopyButton text={l.actions} label="Copy" />
              </div>
            )}
            {open === i && <pre className="docs-ex-pre"><code>{l.actions}</code></pre>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Output({ output, n }: { output: NonNullable<LiveExampleData["output"]>; n: number }) {
  return (
    <div className="docs-out" data-testid="docs-output">
      <p className="docs-out-note"><b>Simulated respondents.</b> {n} test respondents from the Studio's own <i>Simulate</i> feature walked this survey with random answers, and the analysis ran on their responses. The numbers show the shape of the output — they are not findings.</p>
      {output.map((o, i) => (
        <div key={i} className="docs-out-item">
          <div className="docs-out-name">{o.name} <span className="muted">n = {o.n}</span></div>
          {o.error && <p className="docs-out-err">{o.error}</p>}
          {o.bars && o.bars.length > 0 && (() => {
            const max = Math.max(...o.bars.map((b) => Math.abs(b.value)), 1e-9);
            return <div className="docs-out-bars">{o.bars.map((b, k) => <div key={k} className="docs-out-bar"><span className="docs-out-bl">{b.label}</span><span className="docs-out-track"><span style={{ width: `${Math.max(2, (Math.abs(b.value) / max) * 100)}%` }} /></span><span className="docs-out-bv">{Math.round(b.value * 100) / 100}</span></div>)}</div>;
          })()}
          {o.table && (
            <div className="docs-out-table">
              <div className="docs-out-tt">{o.table.title}</div>
              <table><thead><tr>{o.table.columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                <tbody>{o.table.rows.map((r, k) => <tr key={k}>{o.table!.columns.map((c) => <td key={c.key}>{r[c.key]}</td>)}</tr>)}</tbody></table>
            </div>
          )}
          {o.insights.length > 0 && <ul className="docs-out-ins">{o.insights.map((x, k) => <li key={k}>{x}</li>)}</ul>}
        </div>
      ))}
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <button type="button" className="docs-copy" data-testid="docs-copy" aria-label={`${label} to clipboard`}
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); }).catch(() => {}); }}>
      {done ? "Copied ✓" : label}
    </button>
  );
}

export function LiveExample({ ex }: { ex: LiveExampleData }) {
  const [zoom, setZoom] = React.useState<string | null>(null);
  const [showJson, setShowJson] = React.useState(false);
  /* the live survey starts in the browser only: a new respondent has a random seed and session, so the server's
     drawing could never match the browser's (randomized orders, ids) */
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const where = ex.builder.tab === "Questions" && ex.builder.question
    ? `Programming → Questions → ${ex.builder.question}${ex.builder.section ? ` → Properties` : ""}`
    : `Programming → ${ex.builder.tab}`;
  return (
    <section className="docs-ex" data-testid="docs-example" data-example={ex.id} aria-label={`Example: ${ex.title}`}>
      <header className="docs-ex-head">
        <span className="docs-ex-kicker">Live example</span>
        <h3 className="docs-ex-title">{ex.title}</h3>
      </header>
      <div className="docs-ex-grid">
        <div className="docs-ex-left">
          <div className="docs-ex-pane" data-testid="docs-ex-builder">
            <div className="docs-ex-stage"><span className="docs-ex-n">1</span> Builder view <span className="docs-ex-where">{where}</span></div>
            {ex.builder.images.length ? (
              <div className="docs-ex-shots">
                {ex.builder.images.map((src) => (
                  <button key={src} type="button" className="docs-ex-shot" onClick={() => setZoom(src)} aria-label="Enlarge the screenshot">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt={`${ex.title} — ${ex.builder.caption}`} loading="lazy" />
                  </button>
                ))}
              </div>
            ) : <p className="docs-ex-missing">The builder screenshot for this example has not been captured in this build (run <code>node scripts/capture-docs-builder.mjs</code>).</p>}
            <p className="docs-ex-cap">{ex.builder.caption}</p>
          </div>
          <div className="docs-ex-arrow" aria-hidden>↓ stored as</div>
          <div className="docs-ex-pane" data-testid="docs-ex-expression">
            <div className="docs-ex-stage"><span className="docs-ex-n">2</span> Programming view <span className="docs-ex-where">expression and definition</span></div>
            {ex.said && ex.said.length > 0 && <Said said={ex.said} />}
            {ex.designs?.map((d) => (
              <div key={d.name} className="docs-ex-design" data-testid="docs-ex-design">
                <div className="docs-ex-logic-l">The generated design — {d.name} (version 1 shown)</div>
                <DesignPreview kind={d.kind} file={d.file} tasks={2} />
              </div>
            ))}
            {ex.logic.length > 0 ? (
              <ul className="docs-ex-logic">
                {ex.logic.map((l, i) => (
                  <li key={i}><span className="docs-ex-logic-l">{l.label}</span><code className="docs-ex-logic-t">{l.text}</code><CopyButton text={l.text} /></li>
                ))}
              </ul>
            ) : !ex.said?.length ? <p className="docs-ex-cap">No logic — the feature is in the question's stored settings below.</p> : null}
            <div className="docs-ex-json">
              <div className="docs-ex-json-bar">
                <button type="button" className="linkish" onClick={() => setShowJson((s) => !s)} aria-expanded={showJson} data-testid="docs-ex-json-toggle">{showJson ? "▾" : "▸"} Stored JSON (survey definition)</button>
                <CopyButton text={ex.json} label="Copy JSON" />
              </div>
              {showJson && <pre className="docs-ex-pre"><code>{ex.json}</code></pre>}
            </div>
          </div>
        </div>
        <div className="docs-ex-arrow docs-ex-arrow-side" aria-hidden>respondent sees →</div>
        <div className="docs-ex-right">
          <div className="docs-ex-pane docs-ex-respondent" data-testid="docs-ex-respondent">
            <div className="docs-ex-stage"><span className="docs-ex-n">3</span> Respondent view <span className="docs-ex-where">live — try it</span></div>
            <p className="docs-ex-try"><b>Try it:</b> {ex.tryIt}</p>
            <div className="docs-ex-device">{mounted ? <LiveSurvey def={ex.def} embedded={ex.embedded} /> : <p className="docs-live-loading">Starting the survey…</p>}</div>
          </div>
        </div>
      </div>
      {ex.output && ex.output.length > 0 && (
        <div className="docs-ex-pane docs-ex-results" data-testid="docs-ex-results">
          <div className="docs-ex-stage"><span className="docs-ex-n">4</span> Sample output <span className="docs-ex-where">the analysis, on simulated respondents</span></div>
          <Output output={ex.output} n={ex.simulated ?? 0} />
        </div>
      )}
      {zoom && (
        <div className="docs-zoom" role="dialog" aria-label="Screenshot" onClick={() => setZoom(null)} data-testid="docs-zoom">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom} alt={ex.builder.caption} />
          <button type="button" className="btn small" onClick={() => setZoom(null)}>Close</button>
        </div>
      )}
    </section>
  );
}
