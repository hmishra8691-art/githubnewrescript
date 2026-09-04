import type { FlagDraft, RuleContext } from "../types.js";
import { pageBenchmark, pageSeconds, questionSeconds, totalBenchmark, totalSeconds } from "../benchmarks.js";
import { cv, median, normalizedEntropy, pct, round1 } from "../metrics.js";
import { isMatrix, isOpen, isRespondentQuestion, pageQuestionIds, pageWordCount, screenerQuestionIds } from "../survey.js";

const fmtSec = (s: number) => {
  if (s < 60) return `${round1(s)}s`;
  const m = Math.floor(s / 60); const r = Math.round(s - m * 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};

export function timingRules(ctx: RuleContext): FlagDraft[] {
  const out: FlagDraft[] = [];
  const t = ctx.telemetry;
  const { def, bench } = ctx;
  const total = totalSeconds(t, ctx.response.startedAt, ctx.response.completedAt);
  const tb = totalBenchmark(bench);
  const vs = tb.source === "median" ? `median of ${bench.peers} completes` : "estimated reading time";

  /* overall speeding — works from timestamps alone, no telemetry needed */
  if (ctx.enabled("timing.overall_speeding") && total !== null && tb.seconds > 0) {
    const ratio = ctx.param<number>("timing.overall_speeding", "ratio");
    const r = total / tb.seconds;
    if (r < ratio) {
      out.push({
        ruleId: "timing.overall_speeding",
        observed: fmtSec(total), expected: `≥ ${fmtSec(tb.seconds * ratio)} (${vs} ${fmtSec(tb.seconds)})`,
        explanation: `Completion time was ${pct(1 - r)} below the benchmark (${vs}).`,
        intensity: Math.min(1, 0.5 + (ratio - r) / ratio),
      });
    }
  }

  const pq = pageQuestionIds(def);
  const answeredPages = t ? t.pages.filter((v) => (v.questionIds ?? []).some((q) => ctx.response.answers[q] !== undefined && ctx.response.answers[q] !== null)) : [];
  const pageIds = [...new Set(answeredPages.map((v) => v.pageId))];
  const ps = pageSeconds(t);
  if (!t || ctx.disabledTelemetry.has("timing") || pageIds.length === 0) return out;

  /* page-level speeding */
  if (ctx.enabled("timing.page_speeding")) {
    const ratio = ctx.param<number>("timing.page_speeding", "ratio");
    const share = ctx.param<number>("timing.page_speeding", "share");
    const fast = pageIds.filter((pid) => ps[pid] !== undefined && ps[pid] < pageBenchmark(bench, pid).seconds * ratio);
    if (pageIds.length >= 3 && fast.length / pageIds.length >= share) {
      out.push({
        ruleId: "timing.page_speeding",
        observed: `${fast.length} of ${pageIds.length} pages under ${pct(ratio)} of benchmark`,
        expected: `fewer than ${pct(share)} of pages`,
        explanation: `${fast.length} pages were answered in under ${pct(ratio)} of their benchmark time.`,
        questionIds: fast.flatMap((pid) => pq[pid] ?? []),
        intensity: Math.min(1, fast.length / pageIds.length),
      });
    }
  }

  /* question-level speeding: reaction latency after the page appeared */
  if (ctx.enabled("timing.question_speeding")) {
    const minMs = ctx.param<number>("timing.question_speeding", "minLatencyMs");
    const share = ctx.param<number>("timing.question_speeding", "share");
    const answered = Object.entries(t.questions).filter(([qid, qt]) => qt.latencyMs !== undefined && ctx.applies("timing.question_speeding", qid));
    // only the first question on a page can be judged on page-entry latency
    const firsts = new Set<string>();
    for (const v of t.pages) if (v.questionIds[0]) firsts.add(v.questionIds[0]);
    const judged = answered.filter(([qid]) => firsts.has(qid));
    const fast = judged.filter(([, qt]) => (qt.latencyMs ?? Infinity) < minMs);
    if (judged.length >= 3 && fast.length / judged.length >= share) {
      out.push({
        ruleId: "timing.question_speeding",
        observed: `${fast.length} of ${judged.length} first answers within ${minMs} ms of the page appearing`,
        expected: `reaction ≥ ${minMs} ms`,
        explanation: `${fast.length} questions were answered before the page could have been read.`,
        questionIds: fast.map(([qid]) => qid),
        intensity: Math.min(1, fast.length / judged.length),
      });
    }
  }

  /* matrix speeding */
  if (ctx.enabled("timing.matrix_speeding")) {
    const secPerRow = ctx.param<number>("timing.matrix_speeding", "secPerRow");
    const qs = questionSeconds(t);
    const hits: string[] = [];
    for (const q of def.questions) {
      if (!isMatrix(q) || !ctx.applies("timing.matrix_speeding", q.id)) continue;
      const a = ctx.response.answers[q.id];
      const rowsAnswered = a && typeof a === "object" ? Object.keys(a as object).length : 0;
      if (rowsAnswered < 3 || qs[q.id] === undefined) continue;
      if (qs[q.id] / rowsAnswered < secPerRow) hits.push(q.id);
    }
    if (hits.length) {
      out.push({
        ruleId: "timing.matrix_speeding",
        observed: hits.map((id) => `${def.questions.find((q) => q.id === id)?.code}: ${round1(qs[id])}s`).join(", "),
        expected: `≥ ${secPerRow}s per row`,
        explanation: `${hits.length} grid${hits.length === 1 ? " was" : "s were"} completed in less time than the rows could be read.`,
        questionIds: hits,
        intensity: Math.min(1, 0.6 + hits.length * 0.2),
      });
    }
  }

  /* open-ended speeding: chars per second of active time, excluding pasted chars */
  if (ctx.enabled("timing.openend_speeding")) {
    const cps = ctx.param<number>("timing.openend_speeding", "charsPerSec");
    const qs = questionSeconds(t);
    const hits: string[] = [];
    for (const q of def.questions) {
      if (!isOpen(q) || !ctx.applies("timing.openend_speeding", q.id)) continue;
      const a = ctx.response.answers[q.id];
      const text = typeof a === "string" ? a : Array.isArray(a) ? a.join(" ") : "";
      const qt = t.questions[q.id];
      const typed = Math.max(0, text.length - (qt?.pasteChars ?? 0));
      if (typed < 20 || qs[q.id] === undefined) continue;
      if (typed / Math.max(0.5, qs[q.id]) > cps) hits.push(q.id);
    }
    if (hits.length) {
      out.push({
        ruleId: "timing.openend_speeding",
        observed: `${hits.length} text answer${hits.length === 1 ? "" : "s"} produced faster than ${cps} characters/second`,
        expected: `≤ ${cps} chars/s when typed`,
        explanation: "Text appeared faster than a person types — likely pasted or automated.",
        questionIds: hits,
      });
    }
  }

  /* reading time */
  if (ctx.enabled("timing.reading_time")) {
    const wpm = ctx.param<number>("timing.reading_time", "wordsPerMin");
    const share = ctx.param<number>("timing.reading_time", "share");
    const early = pageIds.filter((pid) => {
      const wordsOnPage = pageWordCount(def, pq[pid] ?? []);
      const needSec = (wordsOnPage / wpm) * 60;
      return wordsOnPage >= 15 && ps[pid] !== undefined && ps[pid] < needSec;
    });
    const judged = pageIds.filter((pid) => pageWordCount(def, pq[pid] ?? []) >= 15);
    if (judged.length >= 3 && early.length / judged.length >= share) {
      out.push({
        ruleId: "timing.reading_time",
        observed: `${early.length} of ${judged.length} pages left before their text could be read at ${wpm} wpm`,
        expected: `fewer than ${pct(share)} of pages`,
        explanation: "Pages were left before the words on them could have been read, even at a fast reading speed.",
        questionIds: early.flatMap((pid) => pq[pid] ?? []),
      });
    }
  }

  /* uniform timing */
  const times = pageIds.map((pid) => ps[pid]).filter((x) => x !== undefined && x > 0) as number[];
  if (ctx.enabled("timing.uniform")) {
    const maxCv = ctx.param<number>("timing.uniform", "maxCv");
    const minPages = ctx.param<number>("timing.uniform", "minPages");
    const c = cv(times);
    if (times.length >= minPages && c !== null && c < maxCv) {
      out.push({
        ruleId: "timing.uniform",
        observed: `page times vary by only ${pct(c)} (CV) across ${times.length} pages`,
        expected: `natural variation ≥ ${pct(maxCv)}`,
        explanation: "Every page took almost exactly the same time — people vary, scripts do not.",
        intensity: Math.min(1, 0.6 + (maxCv - c) / maxCv),
      });
    }
  }

  /* short dwell */
  if (ctx.enabled("timing.short_dwell")) {
    const minMs = ctx.param<number>("timing.short_dwell", "minMs");
    const share = ctx.param<number>("timing.short_dwell", "share");
    const short = pageIds.filter((pid) => ps[pid] !== undefined && ps[pid] * 1000 < minMs && (pq[pid] ?? []).some((id) => { const q = def.questions.find((x) => x.id === id); return q && isRespondentQuestion(q) && q.type !== "html"; }));
    if (pageIds.length >= 3 && short.length / pageIds.length >= share) {
      out.push({
        ruleId: "timing.short_dwell",
        observed: `${short.length} of ${pageIds.length} pages shown for under ${minMs} ms`,
        expected: `fewer than ${pct(share)} of pages`,
        explanation: "Pages with real questions were shown for barely a moment.",
        questionIds: short.flatMap((pid) => pq[pid] ?? []),
      });
    }
  }

  /* idle then rush */
  if (ctx.enabled("timing.idle_then_rush") && t.pages.length >= 4) {
    const idleSec = ctx.param<number>("timing.idle_then_rush", "idleSec");
    const rush = ctx.param<number>("timing.idle_then_rush", "rushRatio");
    const visits = [...t.pages].sort((a, b) => a.enteredAt - b.enteredAt);
    let idleAt = -1;
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i];
      const dwell = ((v.leftAt ?? t.submittedAt ?? v.enteredAt) - v.enteredAt) / 1000;
      if (dwell >= idleSec || v.outOfFocusMs / 1000 >= idleSec) { idleAt = i; break; }
    }
    if (idleAt >= 0 && idleAt < visits.length - 2) {
      const after = visits.slice(idleAt + 1);
      const rushed = after.filter((v) => {
        const sec = ((v.leftAt ?? t.submittedAt ?? v.enteredAt) - v.enteredAt - v.outOfFocusMs) / 1000;
        return sec < pageBenchmark(bench, v.pageId).seconds * rush;
      });
      if (rushed.length >= Math.max(2, after.length * 0.6)) {
        out.push({
          ruleId: "timing.idle_then_rush",
          observed: `idle ≥ ${fmtSec(idleSec)} on ${visits[idleAt].pageId}, then ${rushed.length} of ${after.length} remaining pages under ${pct(rush)} of benchmark`,
          explanation: "A long pause was followed by the rest of the survey being rushed.",
          questionIds: rushed.flatMap((v) => v.questionIds),
        });
      }
    }
  }

  /* timing entropy — page times bucketed on a log scale */
  if (ctx.enabled("timing.entropy") && times.length >= 6 && bench.peers >= 8) {
    const minE = ctx.param<number>("timing.entropy", "minEntropy");
    const buckets = times.map((s) => Math.round(Math.log2(Math.max(0.25, s)) * 2));
    const e = normalizedEntropy(buckets, Math.min(times.length, 8));
    if (e < minE) {
      out.push({
        ruleId: "timing.entropy",
        observed: `normalised timing entropy ${round1(e * 100) / 100}`,
        expected: `≥ ${minE}`,
        explanation: "Page times cluster on a few values instead of varying with page content.",
      });
    }
  }

  /* acceleration: second half vs first half, relative to benchmark */
  if (ctx.enabled("timing.acceleration") && pageIds.length >= 6) {
    const ratio = ctx.param<number>("timing.acceleration", "ratio");
    const ordered = [...new Set([...t.pages].sort((a, b) => a.enteredAt - b.enteredAt).map((v) => v.pageId))].filter((pid) => ps[pid] !== undefined);
    const half = Math.floor(ordered.length / 2);
    const pace = (ids: string[]) => {
      const obs = ids.reduce((s, pid) => s + ps[pid], 0);
      const exp = ids.reduce((s, pid) => s + pageBenchmark(bench, pid).seconds, 0);
      return exp > 0 ? obs / exp : 1;
    };
    const first = pace(ordered.slice(0, half)), second = pace(ordered.slice(half));
    if (first > 0 && second / first < ratio) {
      out.push({
        ruleId: "timing.acceleration",
        observed: `second half at ${pct(second)} of benchmark pace vs ${pct(first)} in the first half`,
        expected: `second half ≥ ${pct(ratio)} of first-half pace`,
        explanation: "The respondent slowed down far less than the content did — attention ran out towards the end.",
        questionIds: ordered.slice(half).flatMap((pid) => pq[pid] ?? []),
      });
    }
  }

  /* repeated timing pattern across respondents */
  if (ctx.enabled("timing.pattern_match") && times.length >= 5) {
    const tol = ctx.param<number>("timing.pattern_match", "tolerance");
    const minPages = ctx.param<number>("timing.pattern_match", "minPages");
    const mine = ps;
    const matches: string[] = [];
    for (const peer of ctx.peers) {
      if (peer.sessionId === ctx.response.sessionId) continue;
      const theirs = peer.system?.SYSTEM_PAGE_TIME;
      if (!theirs) continue;
      const common = pageIds.filter((pid) => theirs[pid] !== undefined && mine[pid] !== undefined && mine[pid] > 0);
      if (common.length < minPages) continue;
      const close = common.filter((pid) => Math.abs(theirs[pid] - mine[pid]) / Math.max(mine[pid], 0.5) <= tol);
      if (close.length === common.length) matches.push(peer.sessionId);
    }
    if (matches.length) {
      out.push({
        ruleId: "timing.pattern_match",
        observed: `page-by-page timing within ${pct(tol)} of ${matches.length} other respondent${matches.length === 1 ? "" : "s"}`,
        explanation: "The per-page timing profile matches another respondent's almost exactly — a signature of scripted or coordinated completion.",
        relatedSessionIds: matches.slice(0, 10),
        intensity: Math.min(1, 0.7 + matches.length * 0.15),
      });
    }
  }

  /* screener speed */
  if (ctx.enabled("screener.fast")) {
    const ratio = ctx.param<number>("screener.fast", "ratio");
    const scr = screenerQuestionIds(def);
    if (scr.size) {
      const scrPages = pageIds.filter((pid) => (pq[pid] ?? []).some((id) => scr.has(id)));
      const obs = scrPages.reduce((s, pid) => s + (ps[pid] ?? 0), 0);
      const exp = scrPages.reduce((s, pid) => s + pageBenchmark(bench, pid).seconds, 0);
      if (scrPages.length && exp > 0 && obs / exp < ratio) {
        out.push({
          ruleId: "screener.fast",
          observed: `screener pages in ${fmtSec(obs)} vs benchmark ${fmtSec(exp)}`,
          expected: `≥ ${pct(ratio)} of benchmark`,
          explanation: "The screening questions were answered far faster than they can be read.",
          questionIds: [...scr],
        });
      }
    }
  }

  /* machine-like timing (bot) */
  if (ctx.enabled("bot.machine_timing") && times.length >= 4) {
    const maxMs = ctx.param<number>("bot.machine_timing", "maxPageMs");
    const med = median(times);
    const c = cv(times);
    const latencies = Object.values(t.questions).map((q) => q.latencyMs).filter((x): x is number => x !== undefined);
    const instant = latencies.length ? latencies.filter((x) => x < 300).length / latencies.length : 0;
    if (med !== null && med * 1000 < maxMs && (c === null || c < 0.35) && (instant > 0.5 || latencies.length === 0)) {
      out.push({
        ruleId: "bot.machine_timing",
        observed: `median page ${Math.round(med * 1000)} ms, variation ${c === null ? "n/a" : pct(c)}, ${pct(instant)} instant reactions`,
        expected: `median page ≥ ${maxMs} ms with natural variation`,
        explanation: "Pages were completed at machine speed with almost no variation — consistent with automation.",
      });
    }
  }

  /* impossible sequences */
  if (ctx.enabled("bot.impossible_sequence")) {
    const problems: string[] = [];
    for (const [qid, qt] of Object.entries(t.questions)) {
      if (qt.firstChangeAt === undefined) continue;
      const visit = t.pages.find((v) => v.questionIds.includes(qid) && qt.firstChangeAt! >= v.enteredAt - 50 && (v.leftAt === undefined || qt.firstChangeAt! <= v.leftAt + 50));
      if (!visit && t.pages.some((v) => v.questionIds.includes(qid))) problems.push(`${qid} changed while its page was not shown`);
      const dwell = t.pages.filter((v) => v.questionIds.includes(qid)).reduce((s, v) => s + ((v.leftAt ?? t.submittedAt ?? v.enteredAt) - v.enteredAt), 0);
      if (qt.changes > 3 && dwell > 0 && qt.changes / (dwell / 1000) > 8) problems.push(`${qid}: ${qt.changes} changes in ${Math.round(dwell)} ms`);
    }
    if (problems.length) {
      out.push({
        ruleId: "bot.impossible_sequence",
        observed: problems.slice(0, 3).join("; "),
        explanation: "Answer events arrived in an order or at a rate a person using the page cannot produce.",
        questionIds: problems.map((p) => p.split(/[: ]/)[0]),
      });
    }
  }

  return out;
}
