import type { FlowNode, Question, SurveyDefinition, TimerInput } from "@rescript/schema";
import { lintTimers, resolveTimer } from "./timers.js";

/**
 * set_timer — A NATIVE TIMER ON A QUESTION OR A PAGE (S4b, GA-05 / IM-19).
 *
 * Writes exactly what the Studio's Timer panel writes: `question.timer`, or `timer` on the flow page node that holds
 * the question (`scope: "page"`) or that is named (`page: "<page id or title>"`):
 *   limitSeconds   1–3600 — how long it is open (absent: only a minimum wait)
 *   show           countdown (default) | hidden
 *   onTimeout      advance (default; unanswered questions are skipped, an invalid answer still stops the page)
 *                  | lock (inputs disabled) | message (a message, nothing else)
 *   warnAtSeconds  remaining seconds at which the countdown is announced (once)
 *   minSeconds     minimum seconds on the page before Next is enabled
 *   message        the text for onTimeout "message"
 * `clear: true` removes the timer. A question timer counts on the page's one clock.
 */
export type TimerAction = {
  op: "set_timer";
  /** a question code — the question's own timer, or with scope "page" the timer of the page that holds it */
  target?: string;
  scope?: "question" | "page";
  /** a flow page node id or title — the page's timer */
  page?: string;
  limitSeconds?: number; show?: "countdown" | "hidden"; onTimeout?: "advance" | "lock" | "message";
  warnAtSeconds?: number; minSeconds?: number; message?: string;
  clear?: boolean;
};
export const TIMER_ACTION_OPS = ["set_timer"] as const;

const s = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
const secs = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** the gate: a wire object → the action, or why not */
export function coerceTimerAction(o: Record<string, unknown>): TimerAction | string {
  const target = s(o.target ?? o.question, 120);
  const page = s(o.page ?? o.pageId, 160);
  if (!target && !page) return "set_timer needs a target question (or scope \"page\" with a target, or page)";
  const scope = o.scope === "page" || o.scope === "question" ? o.scope : undefined;
  const a: TimerAction = { op: "set_timer", ...(target ? { target } : {}), ...(page ? { page } : {}), ...(scope ? { scope } : {}) };
  if (o.clear === true || o.timer === null) { a.clear = true; return a; }
  const src = (o.timer && typeof o.timer === "object" ? o.timer : o) as Record<string, unknown>;
  for (const k of ["limitSeconds", "warnAtSeconds", "minSeconds"] as const) {
    const v = secs(src[k] ?? (k === "limitSeconds" ? src.seconds ?? src.timeLimitSeconds : undefined));
    if (v === undefined) continue;
    if (v < 1 || v > 3600) return `set_timer: ${k} must be 1–3600 seconds (got ${v})`;
    a[k] = Math.round(v);
  }
  if (src.show === "countdown" || src.show === "hidden") a.show = src.show;
  if (src.onTimeout === "advance" || src.onTimeout === "lock" || src.onTimeout === "message") a.onTimeout = src.onTimeout;
  const msg = s(src.message, 500);
  if (msg) a.message = msg;
  if (!a.limitSeconds && !a.minSeconds) return "set_timer needs limitSeconds (1–3600) or minSeconds, or clear";
  return a;
}

export interface TimerEnv { question(ref: string): Question | undefined }

function findPage(def: SurveyDefinition, pred: (n: Extract<FlowNode, { type: "page" }>) => boolean): Extract<FlowNode, { type: "page" }> | undefined {
  const walk = (nodes: FlowNode[]): Extract<FlowNode, { type: "page" }> | undefined => {
    for (const n of nodes) {
      if (n.type === "page" && pred(n)) return n;
      const kids = [...((n as { children?: FlowNode[] }).children ?? []), ...(((n as { branches?: { children: FlowNode[] }[] }).branches) ?? []).flatMap((b) => b.children ?? [])];
      const hit = kids.length ? walk(kids) : undefined;
      if (hit) return hit;
    }
    return undefined;
  };
  return walk(def.flow ?? []);
}

const words = (t: TimerInput) => [
  t.limitSeconds ? `${t.limitSeconds}s${t.show === "hidden" ? " (no countdown shown)" : " countdown"}, then ${t.onTimeout === "lock" ? "the answers lock" : t.onTimeout === "message" ? "a message" : "the page moves on"}` : "",
  t.warnAtSeconds ? `warning at ${t.warnAtSeconds}s left` : "",
  t.minSeconds ? `Next enabled after ${t.minSeconds}s` : "",
].filter(Boolean).join("; ");

export function applyTimerAction(def: SurveyDefinition, a: TimerAction, env: TimerEnv): { description: string; destructive?: string; warnings: string[]; touched: string[] } {
  const timer: TimerInput | undefined = a.clear ? undefined : {
    ...(a.limitSeconds ? { limitSeconds: a.limitSeconds } : {}),
    show: a.show ?? "countdown", onTimeout: a.onTimeout ?? "advance",
    ...(a.warnAtSeconds ? { warnAtSeconds: a.warnAtSeconds } : {}),
    ...(a.minSeconds ? { minSeconds: a.minSeconds } : {}),
    ...(a.message ? { message: a.message } : {}),
  };
  if (timer && !resolveTimer(timer)) throw new Error("set_timer needs limitSeconds or minSeconds");
  const lintOf = (where: (i: ReturnType<typeof lintTimers>[number]) => boolean) => lintTimers(def).filter(where).map((i) => i.message);
  if (a.page || a.scope === "page") {
    let node: Extract<FlowNode, { type: "page" }> | undefined;
    if (a.page) node = findPage(def, (n) => n.id === a.page || (n.title ?? "").trim().toLowerCase() === a.page!.toLowerCase());
    else {
      const q = env.question(a.target!);
      if (!q) throw new Error(`there is no question “${a.target}”`);
      node = findPage(def, (n) => n.questionIds.includes(q.id));
      if (!node) throw new Error(`${q.code} is not on a page of the flow`);
    }
    if (!node) throw new Error(`there is no page “${a.page}”`);
    const name = node.title ? `page “${node.title}”` : `page ${node.id}`;
    if (a.clear) {
      if (!node.timer) throw new Error(`${name} has no timer`);
      delete node.timer;
      return { description: `${name}: timer removed`, destructive: `removes the timer of ${name}`, warnings: [], touched: node.questionIds };
    }
    const had = !!node.timer;
    node.timer = timer as never;
    return { description: `${name}: ${words(timer!)}`, ...(had ? { destructive: `replaces the timer of ${name}` } : {}), warnings: lintOf((i) => i.pageId === node!.id), touched: node.questionIds };
  }
  const q = env.question(a.target!);
  if (!q) throw new Error(`there is no question “${a.target}”`);
  if (a.clear) {
    if (!q.timer) throw new Error(`${q.code} has no timer`);
    delete q.timer;
    return { description: `${q.code}: timer removed`, destructive: `removes the timer of ${q.code}`, warnings: [], touched: [q.id] };
  }
  const had = !!q.timer;
  q.timer = timer as never;
  return { description: `${q.code}: ${words(timer!)}`, ...(had ? { destructive: `replaces the timer of ${q.code}` } : {}), warnings: lintOf((i) => i.questionId === q.id), touched: [q.id] };
}

export function describeTimerAction(a: TimerAction): string {
  const where = a.page ? `page ${a.page}` : a.scope === "page" ? `the page of ${a.target}` : a.target;
  if (a.clear) return `Remove the timer of ${where}`;
  return `Timer on ${where}: ${words({ limitSeconds: a.limitSeconds, show: a.show ?? "countdown", onTimeout: a.onTimeout ?? "advance", warnAtSeconds: a.warnAtSeconds, minSeconds: a.minSeconds })}`;
}
