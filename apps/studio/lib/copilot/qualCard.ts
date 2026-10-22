import {
  describeQualRequest, type QualRequest,
} from "@rescript/engine";
import {
  compareGroups, groupsNamedIn, selectForReel, sampleUnits, liveEvidence, themeFrequency, retrieveForQuestion,
  type QualSegment, type QualState, type GroupComparison,
} from "@rescript/analytics";

/**
 * A QUALITATIVE REQUEST'S PREVIEW CARD (2026-10-22) — the pure half of Intelligent Mode's qualitative cards: what
 * would be done, on what, and what it costs, read from the coded data by code before anything runs. The card is
 * the gate: "Run" does it; nothing happens on the sentence alone. A request the data cannot serve (no themes, no
 * such group, nothing on the topic) says why and offers nothing to run.
 */
export interface QualCardPreview {
  title: string;
  lines: string[];
  /** false: nothing to run (answered by code, or the data cannot serve it) */
  runnable: boolean;
  runLabel?: string;
  /** model calls the run will make (0 = none) */
  calls: number;
  /** resolved targets */
  themeIds?: string[];
  objective?: number;
  groups?: [string, string];
  excerptIds?: string[];
  comparison?: GroupComparison | null;
  units?: number;
  note?: string;
}

const segKey = (s: { sourceId: string; id: string }) => `${s.sourceId}|${s.id}`;

export function qualPreview(req: QualRequest, data: { state: QualState; segments: QualSegment[]; objectives: string[]; aiReady: boolean; sandbox: boolean }): QualCardPreview {
  const title = describeQualRequest(req);
  const live = liveEvidence(data.state, data.segments);
  const themes = data.state.codebook.themes.filter((t) => t.status !== "rejected");
  const groups = themeFrequency(data.state, data.segments, { level: "theme" }).groups;
  const noModel = data.aiReady ? [] : ["No AI provider is configured: this needs one (the counts and quotes are available without it)."];
  switch (req.op) {
    case "summarise_themes": {
      const pick = req.theme ? themes.filter((t) => t.name.toLowerCase().includes(req.theme!.toLowerCase())) : themes;
      if (!themes.length) return { title, lines: ["There are no themes yet — code the data and group codes under themes first (Research Tools → Qualitative → Coding)."], runnable: false, calls: 0 };
      if (!pick.length) return { title, lines: [`No theme is called “${req.theme}”. The themes are: ${themes.map((t) => t.name).join(", ")}.`], runnable: false, calls: 0 };
      return { title, lines: [`${pick.length} theme${pick.length === 1 ? "" : "s"}: ${pick.map((t) => t.name).join(", ")} — ${live.length} excerpts of evidence in all.`, `One model call per theme (${pick.length}), metered. Each summary cites its excerpts; uncited sentences and numbers are dropped; the counts are the Studio's. Stored as a new version; earlier versions are kept.`, ...noModel], runnable: data.aiReady && live.length > 0, runLabel: "Write the summaries", calls: pick.length, themeIds: pick.map((t) => t.id) };
    }
    case "insights": {
      const n = req.objective;
      if (n && (!data.objectives.length || n > data.objectives.length)) return { title, lines: [data.objectives.length ? `There are ${data.objectives.length} objectives; there is no objective ${n}.` : "No objectives are recorded (the guide's or the research design's) — the findings would be by theme only.", ...(data.objectives.length ? data.objectives.map((o, i) => `O${i + 1}: ${o}`) : [])], runnable: !data.objectives.length && data.aiReady && live.length > 0, runLabel: "Write findings by theme", calls: 1 };
      if (!live.length) return { title, lines: ["There is no coded evidence yet — code the data first."], runnable: false, calls: 0 };
      return { title, lines: [...(n ? [`Objective ${n}: ${data.objectives[n - 1]}`] : data.objectives.map((o, i) => `O${i + 1}: ${o}`)), `One model call over ${live.length} excerpts. An objective the excerpts do not answer is reported as “not enough evidence”; recommendations are labelled interpretation.`, ...noModel], runnable: data.aiReady, runLabel: "Write the key findings", calls: 1, ...(n ? { objective: n } : {}) };
    }
    case "compare_groups": {
      const a = groupsNamedIn(req.a, groups)[0] ?? groups.find((g) => g.toLowerCase() === req.a.toLowerCase());
      const b = groupsNamedIn(req.b, groups)[0] ?? groups.find((g) => g.toLowerCase() === req.b.toLowerCase());
      if (!a || !b || a === b) return { title, lines: [groups.length ? `The participant groups are: ${groups.join(", ")}. ${!a ? `“${req.a}”` : `“${req.b}”`} is not one of them.` : "Speakers are not assigned to participant groups yet (Transcripts → Open → speakers)."], runnable: false, calls: 0 };
      const cmp = compareGroups(data.state, data.segments, a, b);
      const rows = cmp?.rows.slice(0, 6) ?? [];
      return { title, lines: [`${a}: ${cmp?.base.a.segments ?? 0} participant segments; ${b}: ${cmp?.base.b.segments ?? 0}.`, ...rows.map((r) => `${r.theme}: ${a} ${r.a.segments} (${r.a.share}%) · ${b} ${r.b.segments} (${r.b.share}%) · ${r.difference > 0 ? "+" : ""}${r.difference} points`), cmp?.note ?? ""], runnable: false, calls: 0, groups: [a, b], comparison: cmp };
    }
    case "highlight_reel": {
      const s = selectForReel(data.state, data.segments, req.topic);
      if (!s.excerpts.length) return { title, lines: [`No coded excerpt is about “${req.topic}”. Code the data, or name the topic as the codes do.`], runnable: false, calls: 0 };
      return { title, lines: [s.note, ...s.excerpts.slice(0, 6).map((e) => `“${e.quote.slice(0, 140)}” — ${e.speaker ?? ""} [${e.id}]`), ...(s.excerpts.length > 6 ? [`… and ${s.excerpts.length - 6} more`] : []), "No model call. You can reorder, note and export the reel afterwards (Research Tools → Qualitative → Highlights)."], runnable: true, runLabel: `Make the reel (${s.excerpts.length})`, calls: 0, excerptIds: s.excerpts.map((e) => e.id) };
    }
    case "double_coding": {
      const codes = data.state.codebook.codes.filter((c) => c.status !== "rejected");
      if (!codes.length) return { title, lines: ["The codebook has no codes yet — double-coding applies existing codes. Propose or add codes first."], runnable: false, calls: 0 };
      const units = sampleUnits(data.segments, req.overlapPct, 1).length;
      return { title, lines: [`About ${units} participant segments (${req.overlapPct}% of each source), ${codes.length} codes.`, req.coder === "ai" ? "Coders: you and the AI. The AI codes blind (one metered call per batch of segments) when you press “Let the AI code”." : "Coders: you and a colleague — choose them in Research Tools → Qualitative → Double coding.", "Neither coder sees the other's coding until both submit; then κ and Krippendorff's α per code, and the disagreements to resolve."], runnable: req.coder === "ai", runLabel: "Set it up", calls: 0, units };
    }
    case "ask": {
      const r = retrieveForQuestion(req.question, data.state, data.segments, { groups });
      if (!r.items.length) return { title, lines: [`Not enough evidence: no coded excerpt${r.groups.length ? ` from ${r.groups.join(" or ")}` : ""} matches${r.terms.length ? ` (${r.terms.join(", ")})` : ""}. No model call was made.`, ...(r.note ? [r.note] : [])], runnable: false, calls: 0 };
      return { title, lines: [`${r.items.length} excerpt${r.items.length === 1 ? "" : "s"} retrieved${r.groups.length ? ` from ${r.groups.join(", ")}` : ""} (of ${r.considered}).`, "One model call; the answer may only cite these excerpts.", ...noModel], runnable: data.aiReady, runLabel: "Answer", calls: 1 };
    }
    case "auto_code": return { title, lines: [req.enabled ? "Each new transcript, AI interview or closed group session is coded as AI suggestions (deductive with the current codebook, or proposing codes when there are none), at most 6 model calls per source, metered. Turning it on needs Data: Edit." : "New sources will no longer be coded automatically; what was coded stays."], runnable: true, runLabel: req.enabled ? "Turn it on" : "Turn it off", calls: 0 };
    case "group_session": return { title, lines: ["A text-only live conversation: participants join by link, answer each prompt and rate a few of each other's answers; you (or, autonomous, the session's clock) move it on. Video conferencing is not supported.", "Set it up and start it in Research Tools → Qualitative → Group sessions."], runnable: true, runLabel: "Set it up", calls: 0 };
  }
}

/** the excerpt keys sampled for a preview (exported for the tests) */
export const unitKeys = (segments: QualSegment[], pct: number) => sampleUnits(segments, pct, 1).filter((k) => segments.some((s) => segKey(s) === k));
