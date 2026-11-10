/**
 * THE CONVERSATION AS A SUPPORT CASE (2026-11-10) — what Help needs to know about the turns so far to avoid
 * repeating itself and to know when to stop trying:
 *
 *   stillFailing   "still blank", "that didn't work", "same problem" — the last answer did not fix it
 *   wantsHuman     "talk to a person", "contact support" — escalate now, don't argue
 *   problemThread  the problem being worked on: where it started (the first troubleshooting question that the
 *                  "still failing" turns go back to), how many fixes have failed since, and the guides already given —
 *                  the next answer leaves those out unless nothing else fits
 */
export interface Turn { role: "user" | "assistant"; text: string; sources?: string[]; level?: number; solved?: boolean | null }

const STILL = /\b(?:still|again)\b.{0,30}\b(?:not|n'?t|blank|empty|missing|broken|wrong|same|fail|error|doesn|isn|won)|\b(?:that|this|it|those|they|the (?:steps|fix|answer|suggestion)s?)\s+(?:didn'?t|did not|doesn'?t|does not|hasn'?t|has not|won'?t)\s+(?:work|help|fix|solve|change)|\b(?:didn'?t|did not) (?:work|help|fix|solve)\b|\b(?:same|still the same)\s+(?:problem|issue|error|thing|result)\b|\bnot (?:fixed|solved|resolved)\b|\bno luck\b|\b(?:i )?(?:already )?tried (?:that|this|it|those)\b|\bnothing changed\b|\bstill (?:happening|there|broken|blank|empty|missing|not)\b/i;
const HUMAN = /\b(?:talk|speak|chat) (?:to|with) (?:a |an |the )?(?:human|person|someone|real person|support|agent|team|engineer)\b|\b(?:contact|reach|email|escalate to) (?:the )?support\b|\b(?:a real person|live agent|support agent)\b|\bescalate\b|\b(?:open|raise|file|create) (?:a )?(?:support )?(?:ticket|case)\b/i;

export const stillFailing = (text: string): boolean => STILL.test(text);
export const wantsHuman = (text: string): boolean => HUMAN.test(text);

export interface ProblemThread {
  /** the question that started the problem being worked on, or null when this is a fresh question */
  origin: string | null;
  /** answers since then that did not fix it (including the one this message replies to) */
  failedAttempts: number;
  /** guides (article ids) given in those answers — not to be repeated */
  tried: string[];
  /** the levels already used in the thread (1 internal, 2 diagnostics, 3 model) */
  levels: number[];
}

/**
 * `message` is the new user turn; `history` the turns before it, oldest first. A thread exists only when the new
 * message says the problem persists (or the user answered "No" to "Did this solve it?", which arrives as such a
 * message): then it reaches back over every consecutive "still failing" turn to the question that started it.
 */
export function problemThread(message: string, history: Turn[]): ProblemThread {
  const none: ProblemThread = { origin: null, failedAttempts: 0, tried: [], levels: [] };
  if (!stillFailing(message)) return none;
  let failed = 1;
  const tried = new Set<string>();
  const levels: number[] = [];
  let origin: string | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i];
    if (t.role === "assistant") { for (const s of t.sources ?? []) tried.add(s.split("#")[0]); if (t.level) levels.push(t.level); continue; }
    if (stillFailing(t.text)) { failed++; continue; }
    origin = t.text;
    break;
  }
  if (!origin) return none;
  return { origin, failedAttempts: failed, tried: [...tried], levels };
}
