/**
 * WHAT AN INTERVIEWER IS ALLOWED TO BUILD.
 *
 * Until now the builder was one text box. A project was created with a name
 * and nothing about it could be changed afterwards: no route accepted an edit,
 * so instructions, consent text, status and retention were reachable only by
 * writing SQL by hand. Requirements — the things the analysis compares an
 * answer against — had no write path at all, which is why the evaluation
 * pipeline had nothing to evaluate against. Per-question settings existed in
 * the schema, were accepted by the API, were honoured by the runtime, and were
 * never sent by the form.
 *
 * So this is the missing half of the product, and the rules live here rather
 * than in the routes for the usual reason: a rule in a route is a rule that
 * exists once per route, and there are now five of them.
 *
 * ## Errors block, warnings do not
 *
 * The same split `checkParticipants` already uses. An error is something the
 * database or the runtime would reject or silently mangle. A warning is
 * something an interviewer will probably regret — a ten-second maximum on an
 * open question, a requirement nobody can tell whether an answer met — and
 * regret is not grounds for refusing somebody's work. They are told and they
 * decide.
 */

/* --------------------------------------------------------------- questions */

/**
 * How a respondent answers.
 *
 * These three are the values `interview_questions.kind` has allowed since
 * 0030. They were accepted by the API and never sent by the builder, and the
 * runtime never branched on them — so every question was a video question
 * whatever the column said. The builder can now set them; the runtime honours
 * them.
 */
export const QUESTION_KINDS = ["video", "audio", "text"] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export function isQuestionKind(v: unknown): v is QuestionKind {
  return typeof v === "string" && (QUESTION_KINDS as readonly string[]).includes(v);
}

/** What each kind asks of the respondent, in the words the builder shows. */
export const KIND_SAY: Record<QuestionKind, string> = {
  video: "Records video and audio",
  audio: "Records audio only — no camera",
  text: "Typed answer — nothing is recorded",
};

/**
 * Why somebody would choose each one.
 *
 * `audio` is not merely a smaller video: a question that does not need a face
 * should not ask for one, and some respondents will answer a voice question
 * who would decline a camera. That is a real accessibility and consent
 * difference, so it is stated rather than left for the interviewer to infer.
 */
export const KIND_MEANS: Record<QuestionKind, string> = {
  video: "Use when seeing the person answer matters — presentation, demonstration, rapport.",
  audio: "Use when only the words matter. Less intrusive, smaller files, and some people who would decline a camera will answer.",
  text: "Use for anything better written than spoken — a definition, a short plan, a link.",
};

export const QUESTION_CATEGORIES = [
  "intro", "hr", "technical", "behavioural", "role", "scenario", "custom",
] as const;
export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];

export function isQuestionCategory(v: unknown): v is QuestionCategory {
  return typeof v === "string" && (QUESTION_CATEGORIES as readonly string[]).includes(v);
}

export interface QuestionDraft {
  code?: string | null;
  prompt?: string | null;
  guidance?: string | null;
  kind?: unknown;
  category?: unknown;
  required?: boolean;
  minSeconds?: number | null;
  maxSeconds?: number | null;
  maxRetries?: number | null;
  thinkSeconds?: number | null;
}

export interface CheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * A code an export column and an audit row can be keyed by.
 *
 * Upper case, letters digits and underscore, because it becomes a column
 * header in a spreadsheet and a key in a transcript bundle. Anything else is
 * stripped rather than rejected: somebody typing "Q 1" means `Q1` and does not
 * need a lecture about it.
 */
export function normaliseCode(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 32);
}

/**
 * The next free code with a given prefix.
 *
 * Shared, because question codes and requirement codes are generated in two
 * routes and a project whose codes collide is a project whose export has two
 * columns called the same thing.
 */
export function nextCode(existing: readonly string[], prefix: string): string {
  const taken = new Set(existing.map((c) => normaliseCode(c)));
  let n = taken.size + 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/**
 * The longest any single answer may run, across the whole platform.
 *
 * Mirrors `PLATFORM_MAX_SECONDS` in `limits.ts` and is checked here so the
 * builder refuses at the point the number is typed rather than at the point a
 * respondent discovers their answer was cut off.
 */
export const MAX_ANSWER_SECONDS = 15 * 60;

/** Under this, a spoken answer is a soundbite rather than an answer. */
const SHORT_ANSWER_WARNING_SECONDS = 30;

export function checkQuestion(
  draft: QuestionDraft,
  otherCodes: readonly string[] = [],
): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const prompt = String(draft.prompt ?? "").trim();
  if (!prompt) errors.push("A question needs something to ask.");
  if (prompt.length > 4000) errors.push("That question is too long — keep it under 4000 characters.");

  const code = normaliseCode(draft.code);
  if (code && otherCodes.some((c) => normaliseCode(c) === code)) {
    errors.push(`Another question in this project already uses the code ${code}.`);
  }

  if (draft.kind !== undefined && !isQuestionKind(draft.kind)) {
    errors.push("That is not a kind of answer this platform can collect.");
  }
  if (draft.category !== undefined && draft.category !== null && !isQuestionCategory(draft.category)) {
    errors.push("That is not a question category.");
  }

  const kind = isQuestionKind(draft.kind) ? draft.kind : "video";
  const min = num(draft.minSeconds);
  const max = num(draft.maxSeconds);

  if (kind === "text") {
    /*
     * A typed answer has no duration, so a time limit on one is a setting that
     * cannot do anything. Silently ignoring it would leave the interviewer
     * believing they had set a limit.
     */
    if (min || max) {
      warnings.push("Time limits do not apply to a typed answer — they will be ignored.");
    }
  } else {
    if (max != null && max <= 0) errors.push("A recording limit has to be more than zero seconds.");
    if (max != null && max > MAX_ANSWER_SECONDS) {
      errors.push(`The longest a single answer may run is ${Math.round(MAX_ANSWER_SECONDS / 60)} minutes.`);
    }
    if (min != null && min <= 0) errors.push("A minimum length has to be more than zero seconds.");
    if (min != null && max != null && min >= max) {
      errors.push("The minimum length has to be shorter than the maximum, or nobody can answer.");
    }
    if (max != null && max < SHORT_ANSWER_WARNING_SECONDS) {
      warnings.push(`${max} seconds is very short for a spoken answer — most people are still introducing themselves.`);
    }
  }

  const retries = num(draft.maxRetries);
  if (retries != null && (retries < 0 || retries > 10)) {
    errors.push("Re-record attempts have to be between 0 and 10.");
  }
  const think = num(draft.thinkSeconds);
  if (think != null && (think < 0 || think > 600)) {
    errors.push("Thinking time has to be between 0 and 10 minutes.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ------------------------------------------------------------ requirements */

/**
 * What the analysis compares an answer against.
 *
 * The most consequential thing in the builder and, until now, the only one
 * with no way to create it. `interview_requirements` has been read by the
 * analysis prompt since 0030 and written by nothing, so every analysis this
 * product has ever run had an empty requirement list — which is why the
 * evidence table was always empty and the narrative always thin.
 */
export interface RequirementDraft {
  code?: string | null;
  title?: string | null;
  description?: string | null;
  /** what meeting it looks like — this is what the model is actually given */
  criteria?: string | null;
  weight?: number | null;
}

/**
 * How much this requirement counts, relative to the others.
 *
 * A multiplier, not a percentage, so adding a requirement does not silently
 * re-weight every existing one — which is what a percentage model does, and it
 * is how a rubric quietly stops meaning what its author intended. Zero is
 * allowed and means "assess it but do not let it move the score", which is the
 * honest way to track something you are not willing to rank people by.
 */
export const DEFAULT_WEIGHT = 1;
export const MAX_WEIGHT = 10;

/**
 * A weight the database will accept.
 *
 * `checkRequirement` has already refused anything out of range; this is the
 * last line of defence against a value that got past it, because a NaN
 * reaching a `numeric(6,2)` column is a 503 the interviewer cannot act on.
 * Two decimal places, which is what the column stores.
 */
export function weightOf(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_WEIGHT;
  return Math.min(MAX_WEIGHT, Math.max(0, Math.round(n * 100) / 100));
}

export function checkRequirement(
  draft: RequirementDraft,
  otherCodes: readonly string[] = [],
): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const title = String(draft.title ?? "").trim();
  if (!title) errors.push("A requirement needs a name.");
  if (title.length > 200) errors.push("That name is too long — keep it under 200 characters.");

  const code = normaliseCode(draft.code);
  if (code && otherCodes.some((c) => normaliseCode(c) === code)) {
    errors.push(`Another requirement in this project already uses the code ${code}.`);
  }

  const weight = num(draft.weight);
  if (weight != null && (weight < 0 || weight > MAX_WEIGHT)) {
    errors.push(`Weight has to be between 0 and ${MAX_WEIGHT}.`);
  }

  /*
   * The warning that matters most in this whole file.
   *
   * `criteria` is the only part of a requirement the model is shown as "what
   * meeting this looks like". Without it the model is left inferring the
   * standard from a title, which is exactly the circumstance in which it
   * invents one — and an invented standard applied to a person is the failure
   * this product is most obliged to avoid. It is a warning rather than an
   * error because a requirement being drafted is still worth saving.
   */
  if (!String(draft.criteria ?? "").trim()) {
    warnings.push(
      "Without a description of what meeting this looks like, the analysis has to guess the standard. " +
      "Say what a good answer contains.",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Is this project ready to be analysed at all?
 *
 * Answered here rather than discovered at the end of a job run, so the builder
 * can say it before anybody is invited. An interview with no requirements
 * still records perfectly well and still produces transcripts — it simply
 * cannot be evaluated, and somebody should find that out now rather than after
 * thirty candidates have sat it.
 */
export function analysisReadiness(input: {
  requirements: readonly { criteria?: string | null }[];
  questions: readonly unknown[];
}): { ready: boolean; say: string } {
  if (!input.questions.length) {
    return { ready: false, say: "Add at least one question before inviting anybody." };
  }
  if (!input.requirements.length) {
    return {
      ready: false,
      say: "This interview has no requirements, so answers will be recorded and transcribed but not evaluated. Add what you are assessing for.",
    };
  }
  const vague = input.requirements.filter((r) => !String(r.criteria ?? "").trim()).length;
  if (vague) {
    return {
      ready: true,
      say: `${vague} of ${input.requirements.length} requirements do not say what meeting them looks like. The analysis will be weaker for those.`,
    };
  }
  return { ready: true, say: "Ready to evaluate." };
}

/* ---------------------------------------------------------------- projects */

export const PROJECT_STATUSES = ["draft", "open", "closed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export function isProjectStatus(v: unknown): v is ProjectStatus {
  return typeof v === "string" && (PROJECT_STATUSES as readonly string[]).includes(v);
}

/** What each status does, said in terms of what happens to a candidate. */
export const STATUS_SAY: Record<ProjectStatus, string> = {
  draft: "Being built. Invitation links do not work yet.",
  open: "Accepting candidates. Invitation links work.",
  closed: "No longer accepting candidates. Existing recordings stay available.",
  archived: "Put away. Nothing new can be added and it is hidden from the project list.",
};

export interface ProjectDraft {
  name?: string | null;
  description?: string | null;
  instructions?: string | null;
  consentText?: string | null;
  status?: unknown;
  retentionDays?: number | null;
}

/**
 * The shortest and longest a project may keep a candidate's recordings.
 *
 * The floor is one day because `retention_days` is a whole number of days and
 * the sweep's arithmetic is in days. The ceiling is ten years, which is the
 * database's own check constraint. Anything shorter than a day — the brief's
 * 24-hour rule for practice recordings — needs a schema change and is not
 * expressible here yet.
 */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

export function checkProject(draft: ProjectDraft): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (draft.name !== undefined) {
    const name = String(draft.name ?? "").trim();
    if (!name) errors.push("A project needs a name.");
    if (name.length > 200) errors.push("That name is too long — keep it under 200 characters.");
  }

  if (draft.status !== undefined && !isProjectStatus(draft.status)) {
    errors.push("That is not a project status.");
  }

  if (draft.retentionDays !== undefined && draft.retentionDays !== null) {
    const days = num(draft.retentionDays);
    if (days == null || !Number.isInteger(days)) {
      errors.push("Retention has to be a whole number of days.");
    } else if (days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
      errors.push(`Retention has to be between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days.`);
    } else if (days <= 7) {
      /*
       * Not a mistake — it is the brief's own default for candidate data and
       * a defensible privacy position. But it is short enough that a reviewer
       * who takes a fortnight to get to an interview will find the recording
       * gone, so it is said out loud once.
       */
      warnings.push(
        `Recordings will be deleted ${days} day${days === 1 ? "" : "s"} after each interview finishes. ` +
        "Make sure reviewers watch them before then — deletion cannot be undone.",
      );
    }
  }

  if (draft.consentText !== undefined && !String(draft.consentText ?? "").trim()) {
    errors.push("Consent text cannot be empty — it is what the candidate agrees to.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ------------------------------------------------------------------ order */

/**
 * Turn a list of ids into positions.
 *
 * Positions are rewritten wholesale rather than swapped in pairs, because a
 * drag that moves one question changes the position of everything after it,
 * and doing that as a sequence of swaps is how two rows end up sharing a
 * position and the order becomes whatever the database felt like.
 *
 * Ids the caller does not mention keep their relative order and follow the
 * ones it does — so a reorder sent against a stale list cannot silently drop
 * a question somebody else added a moment ago.
 */
export function positionsFor(
  ordered: readonly string[],
  all: readonly { id: string; position: number }[],
): { id: string; position: number }[] {
  const wanted = ordered.filter((id) => all.some((a) => a.id === id));
  const seen = new Set(wanted);
  const rest = [...all]
    .filter((a) => !seen.has(a.id))
    .sort((a, b) => a.position - b.position)
    .map((a) => a.id);
  return [...wanted, ...rest].map((id, i) => ({ id, position: i + 1 }));
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
