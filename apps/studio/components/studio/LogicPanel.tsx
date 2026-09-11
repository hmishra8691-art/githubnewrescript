"use client";
import React from "react";
import type { FlowNode } from "@rescript/schema";
import {
  lintSurveyLogic, questionLogicSummary, detectLogicCycles, describeCycle,
  validateFlowStructure, runQualityCheck, describeQualityCheck,
  displayRuleTargets, unresolvableDisplayRules,
  buildLogicFlow, logicFlowText, unreachableLogicNodes,
  type LogicIssue, type QualityCheckResult, type DisplayRuleTarget,
} from "@rescript/engine";
import { AutoPunchPanel } from "./AutoPunchEditor";
import { useStudio, uid } from "./store";
import { ConditionEditor, conditionToText, OptionalCondition } from "./ConditionBuilder";
import { NamedExpressionsPanel } from "./NamedExpressionsPanel";
import { LogicTracePanel } from "./LogicTracePanel";
import { lintCalculations, lintAiConversation, lintLocalizationSummary } from "@rescript/engine";

/**
 * Survey-wide logic check (reqs §30–31): every broken reference, dead option
 * code, incompatible operator, empty group, forward reference and circular
 * dependency in one list, before a respondent ever sees it.
 */
function LogicCheck() {
  const s = useStudio();
  // logic references AND the shape of the flow — a survey can be broken by
  // either, and a programmer checking "is this survey sound?" wants one answer
  const issues: LogicIssue[] = React.useMemo(() => [
    ...lintSurveyLogic(s.def),
    ...validateFlowStructure(s.def.flow as FlowNode[]).map((i) => ({
      level: i.level,
      questionCode: "Flow",
      path: i.nodeId ? `flow.${i.nodeId}` : "flow",
      message: i.message,
    })),
    // the AI conversational survey: an adaptive setting that adapts nothing, a voice that reads nothing, a spoken version not yet approved
    ...lintAiConversation(s.def).map((message) => ({ level: "warning" as const, questionCode: "AI", path: "branding.aiConversation", message })),
    // a language marked ready/live with blocking localization issues, outdated audio, duplicate language entries
    ...lintLocalizationSummary(s.def).map((message) => ({ level: "warning" as const, questionCode: "i18n", path: "localization", message })),
  ], [s.def]);
  const cycles = React.useMemo(() => detectLogicCycles(s.def), [s.def]);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const [showWarnings, setShowWarnings] = React.useState(false);

  return (
    <div data-testid="logic-check">
      <div className="row" style={{ marginBottom: 6, flexWrap: "wrap" }}>
        <span className={`chip ${errors.length ? "warn" : ""}`} data-testid="logic-error-count">
          {errors.length} error{errors.length === 1 ? "" : "s"}
        </span>
        <span className="chip">{warnings.length} warning{warnings.length === 1 ? "" : "s"}</span>
        {cycles.length > 0 && <span className="chip warn">{cycles.length} circular dependency</span>}
        {warnings.length > 0 && (
          <button className="btn small" onClick={() => setShowWarnings((v) => !v)}>
            {showWarnings ? "hide warnings" : "show warnings"}
          </button>
        )}
        {errors.length === 0 && warnings.length === 0 && (
          <span className="muted" style={{ fontSize: 13 }}>All logic references resolve.</span>
        )}
      </div>
      {cycles.map((c, i) => (
        <div key={`cyc${i}`} className="chip warn" style={{ marginBottom: 4 }}>{describeCycle(s.def, c)}</div>
      ))}
      {[...errors, ...(showWarnings ? warnings : [])].map((i, k) => (
        <div key={k} className={`chip ${i.level === "error" ? "warn" : ""}`}
          style={{ marginBottom: 4, cursor: i.questionId ? "pointer" : undefined }}
          onClick={() => i.questionId && s.select(i.questionId)}>
          {i.level === "error" ? "✕" : "!"} <strong>{i.questionCode ?? "?"}</strong> {i.path}
          {i.optionCode ? ` [${i.optionCode}]` : ""} — {i.message}
        </div>
      ))}
    </div>
  );
}

/**
 * RUN QUALITY CHECK.
 *
 * The lint above runs constantly and lives in one panel, which is why a
 * survey could deploy with a broken piping token: nobody had to look. This is
 * the deliberate act — one button, one verdict per area, and a plain answer
 * to "can this go out?".
 *
 * It is on demand rather than live because that is what makes the answer mean
 * something: a result carries the moment it was taken, and re-running it is
 * how a programmer signs off.
 */
function QualityCheckPanel() {
  const s = useStudio();
  const [result, setResult] = React.useState<QualityCheckResult | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);
  const run = () => {
    const r = runQualityCheck(s.def);
    setResult(r);
    setOpen(r.areas.find((a) => a.status === "fail")?.key ?? null);
  };

  const mark = (st: string) => (st === "pass" ? "✓" : st === "warn" ? "!" : "✕");

  return (
    <div data-testid="quality-check">
      <div className="row" style={{ marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <button className="btn primary" data-testid="run-quality-check" onClick={run}>
          Run quality check
        </button>
        {result && (
          <>
            <span className={`badge ${result.deployable ? "success" : "danger"}`} data-testid="qc-verdict">
              {result.deployable ? "Ready to deploy" : "Not ready to deploy"}
            </span>
            <span className="muted" style={{ fontSize: 13 }} data-testid="qc-summary">
              {describeQualityCheck(result)} Checked at{" "}
              {new Date(result.checkedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}.
            </span>
          </>
        )}
        {!result && (
          <span className="muted" style={{ fontSize: 13 }}>
            Ten areas, from the definition alone — no responses needed.
          </span>
        )}
      </div>

      {result?.areas.map((a) => (
        <div key={a.key} className={`card qc-area qc-${a.status}`} data-testid="qc-area" data-area={a.key}
          data-status={a.status} style={{ padding: "9px 12px", marginBottom: 6 }}>
          <div className="row" style={{ gap: 8, cursor: a.issues.length ? "pointer" : undefined }}
            onClick={() => a.issues.length && setOpen(open === a.key ? null : a.key)}>
            <span className={`qc-mark qc-mark-${a.status}`} aria-hidden>{mark(a.status)}</span>
            <strong style={{ fontSize: 14 }}>{a.label}</strong>
            <span className="grow" />
            {a.errors > 0 && <span className="chip warn">{a.errors} problem{a.errors === 1 ? "" : "s"}</span>}
            {a.warnings > 0 && <span className="chip">{a.warnings} warning{a.warnings === 1 ? "" : "s"}</span>}
            {a.issues.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>{a.note}</span>}
          </div>
          {open === a.key && a.issues.map((i, k) => (
            <div key={k} className={`chip ${i.level === "error" ? "warn" : ""}`}
              style={{ marginTop: 5, cursor: i.questionId ? "pointer" : undefined }}
              onClick={() => i.questionId && s.select(i.questionId)}>
              {i.level === "error" ? "✕" : "!"}{" "}
              {i.questionCode && <strong>{i.questionCode} </strong>}{i.message}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Plain-English summary of everything dynamic in the survey (req §14). */
function LogicSummaryList() {
  const s = useStudio();
  const rows = s.def.questions
    .map((q) => ({ q, lines: questionLogicSummary(s.def, q) }))
    .filter((r) => r.lines.length > 0);
  if (rows.length === 0)
    return <p className="muted" style={{ fontSize: 13 }}>No dynamic content configured yet.</p>;
  return (
    <div>
      {rows.map(({ q, lines }) => (
        <div key={q.id} className="card selectable" style={{ padding: 10 }} onClick={() => s.select(q.id)}>
          <strong className="mono">{q.code}</strong>
          <div className="logic-summary">
            {lines.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Logic panel: named display rules (any target) + the Logic Flow view —
 * an inspectable, exportable decision tree derived from the programmed
 * branches and skip rules (requirement §8).
 */

function deriveLogicFlowText(s: ReturnType<typeof useStudio>): string {
  const lines: string[] = [];
  const qcode = (id: string) => s.def.questions.find((q) => q.id === id)?.code ?? id;

  const walk = (nodes: FlowNode[], indent: string) => {
    for (const node of nodes) {
      switch (node.type) {
        case "page":
          for (const qid of node.questionIds) {
            const q = s.def.questions.find((x) => x.id === qid);
            if (!q) continue;
            let line = `${indent}${q.code}`;
            if (q.displayLogic) line += `   [show if ${conditionToText(q.displayLogic, s.def)}]`;
            lines.push(line);
            for (const rule of q.skipLogic) {
              const t = rule.target;
              const target =
                t.kind === "question" ? qcode(t.ref ?? "") :
                t.kind === "url" ? `URL ${t.ref}` :
                t.kind === "page" ? `page ${t.ref}` :
                t.kind === "terminate" ? `TERMINATE (${t.status ?? "terminated"})` : "END";
              lines.push(`${indent} ├─ if ${conditionToText(rule.when, s.def)} → ${target}`);
            }
          }
          break;
        case "branch":
          lines.push(`${indent}BRANCH`);
          for (const b of node.branches) {
            lines.push(`${indent} ├─ ${b.label ?? ""} [${conditionToText(b.when, s.def)}]`);
            walk(b.children, indent + " │   ");
          }
          if (node.otherwise?.length) {
            lines.push(`${indent} └─ otherwise`);
            walk(node.otherwise, indent + "     ");
          }
          break;
        case "loop":
          lines.push(`${indent}LOOP (${node.loopVar})`);
          walk(node.children, indent + "  ");
          break;
        case "randomizer":
          lines.push(`${indent}RANDOMIZE${node.show ? ` show ${node.show}` : ""}`);
          walk(node.children, indent + "  ");
          break;
        case "section":
        case "block":
          lines.push(`${indent}[${node.title ?? node.id}]`);
          walk(node.children, indent + "  ");
          break;
        case "quota_check":
          lines.push(`${indent}QUOTA CHECK (${node.quotaIds.join(", ")}) → ${node.onFull.kind} when full`);
          break;
        case "end":
          lines.push(`${indent}END (${node.status})`);
          break;
        case "redirect":
          lines.push(`${indent}REDIRECT → ${node.url}`);
          break;
        default:
          break;
      }
    }
  };
  walk(s.def.flow, "");
  return lines.join("\n");
}

/**
 * WHAT A DISPLAY RULE POINTS AT.
 *
 * Three selects rather than one, because the target has three parts and
 * squashing them into a single question list is precisely what made six of
 * the seven target kinds unreachable: the engine has always resolved them,
 * and this panel could only ever write `kind: "question"`.
 *
 * The kind comes first because it decides what the other two can offer, and
 * changing it clears the rest — a rule that says "option" while still holding
 * a page id would be saved happily and do nothing.
 */
const TARGET_KINDS: { kind: DisplayRuleTarget["kind"]; label: string; hint: string }[] = [
  { kind: "question", label: "Question", hint: "one question on its page" },
  { kind: "page", label: "Page", hint: "every question on that page" },
  { kind: "block", label: "Block", hint: "every page inside the block" },
  { kind: "section", label: "Section", hint: "every page inside the section" },
  { kind: "option", label: "Option", hint: "one answer option" },
  { kind: "row", label: "Grid row", hint: "one row of a grid" },
  { kind: "column", label: "Column", hint: "one column of a composite question" },
];

function RuleTargetPicker({ index }: { index: number }) {
  const s = useStudio();
  const rule = s.def.displayRules[index];
  const targets = React.useMemo(() => displayRuleTargets(s.def), [s.def]);
  const kind = rule.target.kind;
  const forKind = targets.filter((t) => t.kind === kind);
  const chosen = forKind.find((t) => t.ref === rule.target.ref);
  const needsItem = kind === "option" || kind === "row" || kind === "column";

  return (
    <>
      <select
        className="select" style={{ width: 118 }} value={kind}
        data-testid={`dr-kind-${index}`}
        onChange={(e) =>
          s.update((d) => {
            /* the ref and subRef cannot survive a kind change — see above */
            d.displayRules[index].target = { kind: e.target.value as typeof kind, ref: "" };
          })
        }
      >
        {TARGET_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
      </select>

      <select
        className="select grow" value={rule.target.ref}
        data-testid={`dr-ref-${index}`}
        onChange={(e) =>
          s.update((d) => {
            d.displayRules[index].target = { kind, ref: e.target.value };
          })
        }
      >
        <option value="">— {kind} —</option>
        {forKind.map((t) => <option key={`${t.kind}:${t.ref}`} value={t.ref}>{t.label}</option>)}
      </select>

      {needsItem && (
        <select
          className="select" style={{ width: 170 }} value={rule.target.subRef ?? ""}
          data-testid={`dr-sub-${index}`}
          disabled={!chosen?.items?.length}
          onChange={(e) =>
            s.update((d) => {
              d.displayRules[index].target = { kind, ref: rule.target.ref, subRef: e.target.value };
            })
          }
        >
          {/* an item rule with nothing named is ignored by the engine on
              purpose, so the picker says so rather than looking complete */}
          <option value="">— none (rule ignored) —</option>
          {(chosen?.items ?? []).map((it) => (
            <option key={it.subRef} value={it.subRef}>{it.label}</option>
          ))}
        </select>
      )}
    </>
  );
}

/**
 * Rules that cannot fire.
 *
 * A named rule outlives whatever it pointed at — delete the question and the
 * rule stays, looking correct. Nothing else in the survey looks wrong
 * afterwards, which is why this is stated here as well as inside the quality
 * check.
 */
function DeadRuleNotice() {
  const s = useStudio();
  const dead = React.useMemo(() => unresolvableDisplayRules(s.def), [s.def]);
  if (!dead.length) return null;
  return (
    <div className="card" style={{ padding: 10, borderColor: "var(--amber)" }} data-testid="dr-dead">
      <div className="flabel">THESE RULES CANNOT FIRE</div>
      {dead.map((d, i) => (
        <div key={`${d.rule.id}-${i}`} style={{ fontSize: 12.5 }}>
          <strong>{d.rule.label?.trim() || d.rule.id}</strong> {d.reason}
          {d.level === "warning" ? " (may be intentional)" : ""}
        </div>
      ))}
    </div>
  );
}

/**
 * THE DECISION GRAPH.
 *
 * The tree above shows the survey's SHAPE — what nests inside what. This
 * shows its PATHS, which is a different question and the one a skip rule is
 * written to answer. The two views are worth having side by side because the
 * tree structurally cannot draw a jump: a skip rule out of Q3 that lands on
 * Q9 is invisible in a nested outline, and it is exactly the thing that gets
 * a survey wrong.
 *
 * Generated, never stored. `def.logicFlow` was a hand-written graph that
 * nothing read; whatever positions it holds are merged back in, and its
 * labels are regenerated so they cannot describe a survey that has since
 * changed.
 */
function DecisionGraph() {
  const s = useStudio();
  const [perQuestion, setPerQuestion] = React.useState(true);
  const graph = React.useMemo(
    () => buildLogicFlow(s.def, { questions: perQuestion }),
    [s.def, perQuestion],
  );
  const text = React.useMemo(() => logicFlowText(graph), [graph]);
  const orphans = React.useMemo(() => unreachableLogicNodes(graph), [graph]);

  const download = () => {
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${s.def.meta.code || "survey"}-decision-graph.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div data-testid="decision-graph">
      <p className="muted" style={{ fontSize: 13 }}>
        Every path a respondent can take, including the jumps the tree above cannot draw. Derived from the
        flow, the branch conditions and the skip rules — so it cannot disagree with what the survey does.
      </p>
      <div className="row" style={{ marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <span className="chip" data-testid="dg-counts">
          {graph.nodes.length} node{graph.nodes.length === 1 ? "" : "s"} · {graph.edges.length} path
          {graph.edges.length === 1 ? "" : "s"}
        </span>
        <label className="qs-check" style={{ margin: 0 }}>
          <input
            type="checkbox" checked={perQuestion} data-testid="dg-per-question"
            onChange={(e) => setPerQuestion(e.target.checked)}
          />
          {/* the page-level map is the one a client reads; per-question is the
              one a programmer debugs a skip rule in */}
          <span>one node per question</span>
        </label>
        <button className="btn small" onClick={download}>download .txt</button>
        <button className="btn small" onClick={() => {
          navigator.clipboard.writeText(text);
          s.toast("Decision graph copied");
        }}>copy</button>
      </div>
      {orphans.length > 0 && (
        <div className="card" style={{ padding: 10, borderColor: "var(--amber)" }} data-testid="dg-orphans">
          <div className="flabel">NOTHING REACHES THESE</div>
          {/* reachability here follows the EDGES, so a page reached only by a
              skip rule counts as reached — unlike a walk in document order */}
          {orphans.map((n) => <div key={n.id} style={{ fontSize: 12.5 }}>{n.label ?? n.id}</div>)}
        </div>
      )}
      <pre className="logic-pre">{text || "(nothing programmed yet)"}</pre>
    </div>
  );
}

export function LogicPanel() {
  const s = useStudio();
  const logicText = deriveLogicFlowText(s);

  const download = () => {
    const blob = new Blob([logicText], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${s.def.meta.code}_logic_flow.txt`;
    a.click();
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Logic</h2>
      </div>

      {/* the deliberate, whole-survey verdict comes first: it is what a
          programmer opens this panel to get before a release */}
      <h3 className="sec">Quality check</h3>
      <QualityCheckPanel />

      <h3 className="sec">Logic check</h3>
      <LogicCheck />

      <h3 className="sec">What is dynamic in this survey</h3>
      <LogicSummaryList />

      {/*
        * The named expression library sits above the rules that use it, and
        * above Auto punch and Display rules specifically, because those are
        * the two that most often repeat the same condition three times.
        */}
      {/*
        * The trace sits with the rest of the logic tooling and above the rules
        * it explains. It was runtime-only before — a programmer had to launch
        * a session and answer their way to the question to see why a rule
        * fired, which is why nobody did.
        */}
      <h3 className="sec">Logic trace</h3>
      <LogicTracePanel />

      <h3 className="sec">Named expressions</h3>
      <NamedExpressionsPanel />

      <h3 className="sec">Auto punch (option → option)</h3>
      <AutoPunchPanel />

      <h3 className="sec">Display rules (show/hide anything)</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Question-level display &amp; skip logic lives on each question (right panel). A rule here can
        target a whole <strong>page, section or block</strong>, a single <strong>question</strong>, or one
        <strong> option, grid row or column</strong> — from one place, without editing what it points at.
        <strong> HIDE beats SHOW</strong>, and a SHOW rule whose condition is false hides its target.
      </p>
      <DeadRuleNotice />
      {s.def.displayRules.map((r, i) => (
        <div key={r.id} className="card" style={{ padding: 10 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <input className="input" style={{ width: 180 }} placeholder="rule label" value={r.label ?? ""}
              onChange={(e) => s.update((d) => { d.displayRules[i].label = e.target.value; })} />
            <select className="select" value={r.action}
              onChange={(e) => s.update((d) => { d.displayRules[i].action = e.target.value as any; })}>
              <option value="show">SHOW</option><option value="hide">HIDE</option>
            </select>
            <RuleTargetPicker index={i} />
            <button className="btn small danger"
              onClick={() => s.update((d) => { d.displayRules.splice(i, 1); })}>×</button>
          </div>
          <div className="flabel">WHEN</div>
          <ConditionEditor value={r.when}
            onChange={(when) => s.update((d) => { d.displayRules[i].when = when; })} />
        </div>
      ))}
      <button className="btn small" onClick={() =>
        s.update((d) => {
          d.displayRules.push({
            id: uid("dr"), label: "", action: "show",
            target: { kind: "question", ref: d.questions[0]?.id ?? "" },
            when: { type: "group", op: "and", children: [] },
          });
        })}>
        + display rule
      </button>

      <h3 className="sec">Logic Flow (derived — inspectable &amp; exportable)</h3>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn small" onClick={download}>download .txt</button>
        <button className="btn small" onClick={() => {
          navigator.clipboard.writeText(logicText);
          s.toast("Logic flow copied");
        }}>copy</button>
      </div>
      <pre className="logic-pre">{logicText || "(empty flow)"}</pre>

      <h3 className="sec">Decision graph (derived)</h3>
      <DecisionGraph />
    </div>
  );
}

export function CalcPanel() {
  const s = useStudio();
  // lazy import to avoid SSR cycles
  const [exprErrors, setExprErrors] = React.useState<Record<string, string | null>>({});
  React.useEffect(() => {
    import("@rescript/engine").then(({ validateExpression }) => {
      const errs: Record<string, string | null> = {};
      for (const c of s.def.calculations) errs[c.id] = validateExpression(c.expression);
      setExprErrors(errs);
    });
  }, [s.def.calculations]);

  return (
    <div>
      <div className="row" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 17 }}>Calculations</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          Calc DSL: + − × ÷ %, sum() avg() min() max() count() countif() pct() weighted() if() round(),
          wildcards like sum(ALLOC_*)
        </span>
      </div>

      {/*
        * Calculations were absent from the dependency graph entirely, so a
        * calc-to-calc cycle went unreported and — worse, because it looks like
        * it works — a calculation reading one declared BELOW it silently used
        * the previous value. `runCalculations` iterates the array in order.
        */}
      {lintCalculations(s.def).map((p) => (
        <div key={p} className="chip warn qd-note" data-testid="calc-problem">{p}</div>
      ))}

      {s.def.calculations.map((c, i) => (
        <div key={c.id} className="card" style={{ padding: 12 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <input className="input mono" style={{ width: 180 }} value={c.targetVariable}
              placeholder="TARGET_VAR"
              onChange={(e) => s.update((d) => { d.calculations[i].targetVariable = e.target.value.toUpperCase(); })} />
            <span className="muted">=</span>
            <input className="input mono grow" value={c.expression}
              placeholder="Q1 + Q2 + Q3"
              onChange={(e) => s.update((d) => { d.calculations[i].expression = e.target.value; })} />
            <select className="select" style={{ width: 140 }} value={c.trigger}
              onChange={(e) => s.update((d) => { d.calculations[i].trigger = e.target.value as any; })}>
              <option value="on_change">on change</option>
              <option value="on_page_submit">on page submit</option>
              <option value="on_complete">on complete</option>
            </select>
            <button className="btn small danger" onClick={() => s.update((d) => { d.calculations.splice(i, 1); })}>×</button>
          </div>
          {exprErrors[c.id] && <div className="chip warn">syntax: {exprErrors[c.id]}</div>}
          <OptionalCondition label="Only compute when" value={c.when}
            onChange={(w) => s.update((d) => { d.calculations[i].when = w; })} />
        </div>
      ))}
      <button className="btn small" onClick={() =>
        s.update((d) => {
          d.calculations.push({
            id: uid("calc"), targetVariable: `CALC_${d.calculations.length + 1}`,
            expression: "", trigger: "on_page_submit", dataType: "numeric",
          });
        })}>
        + calculation
      </button>
    </div>
  );
}
