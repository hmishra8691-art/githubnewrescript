import type { SurveyDefinition } from "@rescript/schema";
import { BASE_SECS, SEGMENTS, corpusTelemetry, rng, syntheticLabelledCorpus, type LabelledResponse, type TelOpts } from "./validation.js";

/**
 * THE RED-TEAM CORPUS (Level 5 roadmap, F1 — 2026-11-22).
 *
 * `syntheticLabelledCorpus` answers "does the engine catch a careless person, a copy and a crude bot without
 * flagging real people?". It does. This asks the harder question the roadmap is about: what happens when the
 * attacker is competent — a language model driving a real browser, a stealthy script, a farm of real devices, a
 * ring that shares answers. Every case here is fraudulent BY CONSTRUCTION and is built to look as much like a
 * person as that kind of attacker can manage, so the detection rate per attack is an honest baseline.
 *
 * WHAT THIS IS NOT. The attacks are simulated from a description of how each one behaves; none is a recording of a
 * real attack. A real language-model agent run against the live runtime is the next step (F1b), and the corpus must
 * be extended as attackers' tools change. Until then a high score here proves less than a low score does.
 *
 * The genuine respondents (hard negatives included) are the same people as in the validation corpus, so the
 * false-positive rate is measured on the same footing.
 */
export type AttackId =
  | "llm_agent_typed" | "llm_agent_pasted" | "stealth_script" | "device_farm" | "click_farm_humans"
  | "shared_answer_ring" | "translated_paste" | "geo_spoof_only" | "classic_bot";

export const ATTACKS: { id: AttackId; name: string; what: string }[] = [
  { id: "llm_agent_typed", name: "Language-model agent, typing", what: "A model reads each page in a real browser, answers coherently, passes the attention check and types fluent, unique open ends at a steady machine pace." },
  { id: "llm_agent_pasted", name: "Language-model agent, pasting", what: "The same, but open ends are generated elsewhere and pasted in." },
  { id: "stealth_script", name: "Stealth script", what: "Automation that hides its automation flag: no pointer movement, plausible but regular timing, random valid answers, attention check passed." },
  { id: "device_farm", name: "Device farm", what: "Many submissions from a few real phones, each with different answers and human timing." },
  { id: "click_farm_humans", name: "Click-farm workers", what: "Real people paid per complete: fast, attention check passed, grids varied on purpose, open ends of one or two words." },
  { id: "shared_answer_ring", name: "Answer-sharing ring", what: "Different people on different devices following one shared answer sheet, minutes apart." },
  { id: "translated_paste", name: "Copied open ends", what: "Respondents who paste the same sentence, lightly reworded, into the open ends." },
  { id: "geo_spoof_only", name: "Location spoof only", what: "Otherwise ordinary answers from a browser whose language and time zone do not match." },
  { id: "classic_bot", name: "Classic bot", what: "Automation flag on, no pointer or key events, two seconds a page, gibberish text, attention check failed." },
];

/* fluent, on-topic, each one different: the style of a competent model, not of a person on a phone */
const L_OPEN = ["I chose this brand primarily because", "My decision was mainly driven by the fact that", "The key reason I selected it is that", "I went with this brand largely because", "What ultimately convinced me was that"];
const L_WHY = ["it offers a strong balance of reliability and value", "its safety record and build quality stood out", "the overall cost of ownership is reasonable", "it has a reputation for durability and low maintenance", "the driving experience and comfort exceeded my expectations", "the warranty and dealer support were reassuring"];
const L_ADD = ["Additionally, the fuel efficiency suits my daily commute.", "It has also proven dependable over several years of use.", "The interior is practical for a family as well.", "Resale values in my area are also consistently good.", "Servicing has been straightforward and affordable too.", "The technology features are modern without being distracting."];
const L_SWITCH = ["I would consider switching if a competitor offered", "I might change brands if another manufacturer provided", "A compelling reason to switch would be", "I would be open to another brand that delivered"];
const L_WHAT = ["a meaningfully lower total cost of ownership", "a significantly longer warranty with comparable quality", "a well-reviewed electric model at a similar price", "noticeably better after-sales service", "more interior space without a higher running cost"];
const RING_SHEET = { own: "y", brand: "b", freq: "daily", grid: { r1: "4", r2: "5", r3: "2", r4: "4", r5: "3", r6: "2" }, grid2: { r1: "4", r2: "3", r3: "5", r4: "4", r5: "2" }, att: "b", s1: "4", s2: "5", s3: "4", s4: "4", s5: "5", s6: "3" };
const COPIED = ["It is a reliable car with good mileage and low maintenance cost.", "It is reliable car with a good mileage and low cost of maintenance.", "A reliable car, good mileage and low maintenance costs.", "Reliable car with good mileage, and maintenance cost is low."];

export interface RedTeamOptions { seed?: number; perAttack?: number; genuine?: number }

export function redTeamCorpus(opts: RedTeamOptions = {}): { def: SurveyDefinition; responses: LabelledResponse[] } {
  const R = rng(opts.seed ?? 20261122);
  const per = opts.perAttack ?? 30;
  const base = syntheticLabelledCorpus({ genuine: opts.genuine ?? 240, perProblem: per });
  /* the people: every genuine respondent of the validation corpus, hard negatives included. Its duplicate pairs are
     dropped with their problem halves, so "earlier half of a duplicate pair" becomes an ordinary person again. */
  const genuine = base.responses.filter((l) => l.label === "genuine").map((l) => ({ ...l, persona: l.persona === "earlier half of a duplicate pair" ? "typical" : l.persona, reviewAcceptable: false }));
  /* the attackers' closed answers come from a SECOND, independent draw of people — never from the genuine set above:
     an attacker who copied a real respondent would be caught as a duplicate, and that is not the attack being tested */
  const donors = syntheticLabelledCorpus({ seed: (opts.seed ?? 20261122) + 7919, genuine: 400, perProblem: 1 }).responses.filter((l) => l.persona === "typical");
  const out: LabelledResponse[] = [...genuine];
  const t0 = 1_790_400_000_000;
  let seq = 0;
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(R() * xs.length)]!;
  const jitter = (factor: number, spread = 0.5) => BASE_SECS.map((s) => Math.max(2, Math.round(s * factor * (1 - spread / 2 + R() * spread))));
  const seg = (i: number) => SEGMENTS[i % SEGMENTS.length]!;
  let donor = 0;
  /** a fresh coherent person each time: no two attack responses share a donor */
  const coherent = (_i?: number): Record<string, unknown> => JSON.parse(JSON.stringify(donors[donor++ % donors.length]!.response.answers));
  const add = (attack: AttackId, answers: Record<string, unknown>, tel: TelOpts, ids?: { ip?: string; dev?: string }, at?: number) => {
    const i = ++seq;
    const startAt = at ?? t0 + i * 487_000 + Math.floor(R() * 240_000);
    const t = corpusTelemetry(tel, startAt);
    out.push({
      label: "fraudulent", persona: attack, source: "synthetic", segments: { device: tel.device, locale: tel.locale },
      response: { sessionId: `rt${String(i).padStart(4, "0")}`, status: "complete", answers, startedAt: new Date(startAt).toISOString(), completedAt: new Date(t.submittedAt!).toISOString(), telemetry: t, ipHash: ids?.ip ?? `rt-ip-${i}`, deviceHash: ids?.dev ?? `rt-dev-${i}` },
    });
  };
  const llmText = () => ({ oe: `${pick(L_OPEN)} ${pick(L_WHY)}. ${pick(L_ADD)}`, oe2: `${pick(L_SWITCH)} ${pick(L_WHAT)}.` });

  for (let i = 0; i < per; i++) {
    /* a model in a real browser: coherent answers, a person's total time, but every page takes about as long as the
       last (it does not slow down for the grid), and it types exactly what it wrote with no corrections */
    const a = { ...coherent(i), ...llmText() };
    const chars = String(a.oe).length + String(a.oe2).length;
    add("llm_agent_typed", a, { secs: jitter(0.85, 0.15), ...seg(i), device: "desktop", pointer: 3, keys: chars, typed: chars });
  }
  for (let i = 0; i < per; i++) {
    const a = { ...coherent(i + 7), ...llmText() };
    add("llm_agent_pasted", a, { secs: jitter(0.8, 0.2), ...seg(i), device: "desktop", pointer: 4, keys: 2, typed: 0, pastes: { oe: 1, oe2: 1 } });
  }
  for (let i = 0; i < per; i++) {
    /* random but valid answers, the attention check read and passed, no pointer at all, the automation flag hidden */
    const c = () => String(1 + Math.floor(R() * 5));
    add("stealth_script", {
      own: "y", brand: pick(["a", "b", "c", "d"]), freq: pick(["daily", "some"]),
      grid: { r1: c(), r2: c(), r3: c(), r4: c(), r5: c(), r6: c() }, grid2: { r1: c(), r2: c(), r3: c(), r4: c(), r5: c() },
      att: "b", oe: pick(["Good car, reliable.", "I like the brand.", "Value for money.", "It works well for me."]), oe2: pick(["Lower price.", "Better offer.", "Nothing.", "A new model."]),
      s1: c(), s2: c(), s3: c(), s4: c(), s5: c(), s6: c(),
    }, { secs: jitter(0.5, 0.1), ...seg(i), device: "desktop", pointer: 0, keys: 30, typed: 30, webdriver: false, uniform: true });
  }
  for (let i = 0; i < per; i++) {
    /* five real phones, each used again and again, by people answering differently and at a human pace */
    add("device_farm", coherent(i * 3 + 1), { secs: jitter(0.9), ...SEGMENTS[1]! }, { dev: `rt-farm-phone-${i % 5}`, ip: `rt-farm-ip-${i % 2}` });
  }
  for (let i = 0; i < per; i++) {
    const a = coherent(i * 5 + 2);
    a.oe = pick(["good", "nice car", "ok", "best", "like it"]); a.oe2 = pick(["price", "no", "nothing", "offer"]);
    add("click_farm_humans", a, { secs: jitter(0.38, 0.4), ...SEGMENTS[1 + (i % 2)]!, keys: 8, typed: 8 });
  }
  for (let i = 0; i < per; i++) {
    /* one answer sheet, different people and devices, a few minutes apart; open ends written by each person */
    const own = coherent(i * 2 + 3);
    add("shared_answer_ring", { ...RING_SHEET, oe: own.oe, oe2: own.oe2 }, { secs: jitter(0.8), ...seg(i) }, undefined, t0 + 9_000_000 + i * 240_000);
  }
  for (let i = 0; i < per; i++) {
    const a = coherent(i * 4 + 5);
    a.oe = COPIED[i % COPIED.length]!; a.oe2 = "Lower price and better mileage.";
    add("translated_paste", a, { secs: jitter(0.75), ...seg(i), pastes: { oe: 1 }, keys: 20, typed: 28 });
  }
  for (let i = 0; i < per; i++) {
    add("geo_spoof_only", coherent(i * 6 + 4), { secs: jitter(1), device: "desktop", locale: "en-GB", timezone: "Asia/Dhaka", tzOffset: -360 });
  }
  for (const l of base.responses.filter((x) => x.persona === "bot")) out.push({ ...l, persona: "classic_bot" });
  return { def: base.def, responses: out };
}
