import type { EvalCase } from "./cases.ts";

/**
 * ENGINE ITEMS 11–14 (2026-10-22, docs/ENGINE-11-14-2026-10-22.md) — eval cases, fake provider (the scripted replies
 * stand in for the model; with a real provider the same assertions score the model's own replies).
 *
 *   #11  each staged item gets the guides it needs and not the others; an action whose guide an item was not sent
 *        is judged by the gate, logged as a miss, and repaired with the guide
 *   #12  an analysis-plan item with a missing input is refused at action time, naming it, and the repair fixes it
 *   #13  refused MaxDiff / conjoint designs (CBC, CVA, dual-response, menu, ACBC, simulate_conjoint): corrected by
 *        the Studio where only one correction exists; otherwise refused → repaired → applied; repaired and still
 *        refused → said plainly
 */

const PHONE_ATTRS = [{ name: "Brand", levels: ["Alpha", "Beta", "Gamma"] }, { name: "Storage", levels: ["64 GB", "128 GB", "256 GB"] }, { name: "Price", levels: ["₹14,999", "₹19,999", "₹24,999"] }];
/** every Brand × Price combination prohibited: no concept is left */
const ALL_PROHIBITED = ["Alpha", "Beta", "Gamma"].flatMap((b) => ["₹14,999", "₹19,999", "₹24,999"].map((p) => ({ Brand: b, Price: p })));

const ITEM_PLAN = {
  kind: "plan", summary: "A smartphone buyer survey: design, a screener with regional quotas, a MaxDiff of features, demographics.",
  items: [
    { id: "p1", title: "Record the research objective and hypotheses", kind: "design", objects: ["Research design"], reason: "Anchor the study." },
    { id: "p2", title: "Add the screener with the regional quotas", kind: "create", objects: ["Screener", "Region quota"], reason: "50/50 north–south." },
    { id: "p3", title: "Add the MaxDiff of eight phone features", kind: "create", objects: ["Features MaxDiff"], reason: "Rank what matters most." },
    { id: "p4", title: "Add the closing questions", kind: "create", objects: ["Close"], reason: "Thank and close." },
  ],
  questions: [], assumptions: [],
};
const MISS_PLAN = {
  kind: "plan", summary: "A short brand survey.",
  items: [
    { id: "p1", title: "Add the brand questions", kind: "create", objects: ["Brands"], reason: "What matters in a brand." },
    { id: "p2", title: "Add the closing question", kind: "create", objects: ["Close"], reason: "Thank and close." },
  ],
  questions: [], assumptions: [],
};

export const ENGINE_1114_CASES: EvalCase[] = [
  /* ---------------------------------------------------------------- #11 per-item guides */
  {
    id: "staged-item-guides", category: "staged_generation", title: "#11 each staged item gets the guides it needs, not the brief's whole set", fixture: "blank", tags: ["engine-11-14"],
    turns: [
      { message: "Create a survey of smartphone buyers in India with quotas by region (50/50 north–south), a MaxDiff of eight phone features and a Hindi version", mode: "generate", stage: "plan", fake: ITEM_PLAN, expect: { stage: "plan", planItemsMin: 4 } },
      { message: "Create a survey of smartphone buyers in India with quotas by region (50/50 north–south), a MaxDiff of eight phone features and a Hindi version", mode: "generate", stage: "execute",
        fake: [
          { kind: "edit", reply: "Recorded the objective.", actions: [{ op: "set_research", objective: "Understand which phone features drive choice among Indian smartphone buyers.", hypotheses: ["Battery life matters more than camera to buyers outside metros."] }] },
          { kind: "edit", reply: "Added the screener and the regional quota.", actions: [{ op: "create_block", ref: "SCR", title: "Screener" }, { op: "create_question", ref: "REGION", block: "SCR", type: "single", text: "Where do you live?", options: ["North", "South"], required: true }, { op: "create_quota", name: "Region", total: 400, dimensions: [{ question: "REGION" }] }] },
          { kind: "edit", reply: "Added the MaxDiff.", actions: [{ op: "create_maxdiff", ref: "FEAT_MD", items: ["Battery life", "Camera", "Price", "Screen size", "Storage", "Durability", "Weight", "Warranty"] }] },
          { kind: "edit", reply: "Added the close.", actions: [{ op: "create_question", ref: "AGE", type: "numeric", text: "How old are you?" }] },
        ],
        expect: {
          stage: "executed", appliedMin: 5, opsPresent: ["create_maxdiff", "create_quota"], guideMisses: 0,
          itemGuides: {
            p1: { has: ["research", "analysis"], not: ["methods", "translation", "ux", "reporting", "findings", "listFill"] },
            p2: { has: ["quota", "analysis"], not: ["methods", "translation", "ux", "qual", "reporting", "findings"] },
            p3: { has: ["methods", "analysis"], not: ["quota", "translation", "ux", "research", "reporting"] },
            p4: { has: ["analysis"], not: ["methods", "quota", "translation", "ux", "research", "reporting"] },
          },
        } },
    ],
  },
  {
    id: "staged-guide-miss", category: "staged_generation", title: "#11 an item proposes a MaxDiff it was not sent the guide for: refused by the gate, logged, repaired with the guide", fixture: "blank", tags: ["engine-11-14"],
    turns: [
      { message: "Create a short brand survey with a MaxDiff of what matters in a brand", mode: "generate", stage: "plan", fake: MISS_PLAN, expect: { stage: "plan", planItemsMin: 2 } },
      { message: "Create a short brand survey with a MaxDiff of what matters in a brand", mode: "generate", stage: "execute",
        fake: [
          { kind: "edit", reply: "Added the brand MaxDiff.", actions: [{ op: "create_maxdiff", ref: "BRAND_MD", items: ["Price", "Quality", "Trust"] }] },
          { kind: "edit", reply: "Added the close.", actions: [{ op: "create_question", ref: "THANKS", type: "long_text", text: "Anything else you would like to tell us?" }] },
        ],
        fakeRepair: { kind: "edit", reply: "Corrected: the MaxDiff now scales six attributes.", actions: [{ op: "create_maxdiff", ref: "BRAND_MD", items: ["Price", "Quality", "Trust", "Design", "Service", "Availability"] }] },
        expect: { stage: "executed", guideMisses: 1, itemGuides: { p1: { not: ["methods"] } }, opsPresent: ["create_maxdiff"], appliedMin: 2, parse: "repaired" } },
    ],
  },

  /* ---------------------------------------------------------------- #12 the readiness rule at action time */
  {
    id: "analysis-readiness-repair", category: "analysis_plan", title: "#12 an ANOVA with no grouping is refused at action time, naming it; the repair adds it", fixture: "nps_relationship", tags: ["engine-11-14"],
    turns: [{ message: "Plan an ANOVA of the NPS score",
      fake: [
        { kind: "edit", reply: "Planned the ANOVA.", actions: [{ op: "add_analysis_test", method: "anova", outcome: "Q1", priority: 1 }] },
        { kind: "edit", reply: "Planned the ANOVA of NPS across contact permission.", actions: [{ op: "add_analysis_test", method: "anova", outcome: "Q1", groupBy: "Q6", priority: 1 }] },
      ],
      expect: { opsPresent: ["add_analysis_test"], appliedMin: 1, parse: "repaired", valid: true } }],
  },

  /* ---------------------------------------------------------------- #13 refused designs */
  {
    id: "method-fix-maxdiff-per-task", category: "methods", title: "#13 5 items per task from 5 items: corrected to 4 by the Studio, no second call", fixture: "nps_relationship", tags: ["engine-11-14"],
    turns: [{ message: "Add a MaxDiff of battery, camera, price, screen and storage, 5 per task",
      fake: { kind: "edit", reply: "Added the MaxDiff.", actions: [{ op: "create_maxdiff", ref: "MD5", items: ["Battery", "Camera", "Price", "Screen", "Storage"], perTask: 5 }] },
      expect: { opsPresent: ["create_maxdiff"], appliedMin: 1, methodFixesMin: 1, parse: "clean", replyNotMatches: ["could not be made"] } }],
  },
  {
    id: "method-fix-dual-none", category: "methods", title: "#13 dual-response plus an in-task None: the None is dropped (the two cannot be combined)", fixture: "nps_relationship", tags: ["engine-11-14"],
    turns: [{ message: "Add a choice-based conjoint of brand, storage and price with a dual-response none",
      fake: { kind: "edit", reply: "Added the CBC with dual response.", actions: [{ op: "create_conjoint", ref: "DUAL_CBC", method: "cbc", attributes: PHONE_ATTRS, dualResponse: true, none: true }] },
      expect: { opsPresent: ["create_conjoint"], appliedMin: 1, methodFixesMin: 1 } }],
  },
  {
    id: "method-fix-cva-profiles", category: "methods", title: "#13 a rating-based conjoint with too few profiles: raised to the fewest that identify the part-worths", fixture: "nps_relationship", tags: ["engine-11-14"],
    turns: [{ message: "Make a rating-based conjoint of brand, storage and price with 5 profiles",
      fake: { kind: "edit", reply: "Added the CVA.", actions: [{ op: "create_conjoint", ref: "CVA5", method: "cva", attributes: PHONE_ATTRS, profiles: 5 }] },
      expect: { opsPresent: ["create_conjoint"], appliedMin: 1, methodFixesMin: 1 } }],
  },
  {
    id: "method-repair-prohibitions", category: "methods", title: "#13 prohibitions that rule out every concept: refused with the prohibitions named → repaired → applied", fixture: "nps_relationship", tags: ["engine-11-14"],
    turns: [{ message: "Add a choice-based conjoint of brand, storage and price; never show Alpha at ₹14,999",
      fake: [
        { kind: "edit", reply: "Added the CBC.", actions: [{ op: "create_conjoint", ref: "PRO_CBC", method: "cbc", attributes: PHONE_ATTRS, prohibitions: ALL_PROHIBITED }] },
        { kind: "edit", reply: "Added the CBC; Alpha is never shown at ₹14,999.", actions: [{ op: "create_conjoint", ref: "PRO_CBC", method: "cbc", attributes: PHONE_ATTRS, prohibitions: [{ Brand: "Alpha", Price: "₹14,999" }] }] },
      ],
      expect: { opsPresent: ["create_conjoint"], appliedMin: 1, parse: "repaired", replyNotMatches: ["could not be made"] } }],
  },
  {
    id: "method-repair-gate-cbc", category: "methods", title: "#13 a CBC refused at the gate (no attributes) now reaches the repair", fixture: "nps_relationship", tags: ["engine-11-14"],
    turns: [{ message: "Add a choice-based conjoint with brand (Alpha, Beta, Gamma), storage (64 GB, 128 GB, 256 GB) and price (₹14,999, ₹19,999, ₹24,999)",
      fake: [
        { kind: "edit", reply: "Added the CBC.", actions: [{ op: "create_conjoint", ref: "GATE_CBC", method: "cbc" }] },
        { kind: "edit", reply: "Added the CBC with the three attributes.", actions: [{ op: "create_conjoint", ref: "GATE_CBC", method: "cbc", attributes: PHONE_ATTRS }] },
      ],
      expect: { opsPresent: ["create_conjoint"], appliedMin: 1, parse: "repaired" } }],
  },
  {
    id: "method-repair-menu", category: "methods", title: "#13 a menu-based conjoint without its menu: refused at the gate → repaired with the items → applied", fixture: "nps_relationship", tags: ["engine-11-14"],
    turns: [{ message: "Add a menu-based conjoint: data pack (₹99, ₹149), insurance (₹149, ₹199), streaming (₹199, ₹299)",
      fake: [
        { kind: "edit", reply: "Added the menu.", actions: [{ op: "create_conjoint", ref: "MENU", method: "menu" }] },
        { kind: "edit", reply: "Added the menu of three items.", actions: [{ op: "create_conjoint", ref: "MENU", method: "menu", items: [{ name: "Data pack", prices: ["₹99", "₹149"] }, { name: "Insurance", prices: ["₹149", "₹199"] }, { name: "Streaming", prices: ["₹199", "₹299"] }] }] },
      ],
      expect: { opsPresent: ["create_conjoint"], appliedMin: 1, parse: "repaired" } }],
  },
  {
    id: "method-repair-acbc", category: "methods", title: "#13 an ACBC with CBC-only fields (tasks): refused with the reason → repaired → applied", fixture: "nps_relationship", tags: ["engine-11-14"],
    turns: [{ message: "Add an adaptive conjoint (ACBC) of brand, storage and price",
      fake: [
        { kind: "edit", reply: "Added the ACBC.", actions: [{ op: "create_conjoint", ref: "PHONE_ACBC", method: "acbc", attributes: PHONE_ATTRS, tasks: 12 }] },
        { kind: "edit", reply: "Added the ACBC (its screens are built from each respondent's own build-your-own answer).", actions: [{ op: "create_conjoint", ref: "PHONE_ACBC", method: "acbc", attributes: PHONE_ATTRS }] },
      ],
      expect: { opsPresent: ["create_conjoint"], appliedMin: 1, parse: "repaired" } }],
  },
  {
    id: "method-repair-simulate", category: "methods", title: "#13 simulate_conjoint naming a level the design does not have: refused → repaired → applied", fixture: "nps_relationship", tags: ["engine-11-14"],
    turns: [
      { message: "Add a choice-based conjoint with brand (Alpha, Beta, Gamma), storage (64 GB, 128 GB, 256 GB) and price (₹14,999, ₹19,999, ₹24,999)",
        fake: { kind: "edit", reply: "Added the CBC.", actions: [{ op: "create_conjoint", ref: "SIM_CBC", method: "cbc", attributes: PHONE_ATTRS }] },
        expect: { opsPresent: ["create_conjoint"], appliedMin: 1 } },
      { message: "simulate the market share of Alpha 128 GB at ₹19,999 against Beta 256 GB at ₹24,999",
        fake: [
          { kind: "edit", reply: "Saved the scenario.", actions: [{ op: "simulate_conjoint", target: "SIM_CBC", scenario: { name: "Alpha vs Beta", products: [{ name: "Alpha 128", levels: { Brand: "Alpha", Storage: "128GB", Price: "₹19,999" } }, { name: "Beta 256", levels: { Brand: "Beta", Storage: "256 GB", Price: "₹24,999" } }] } }] },
          { kind: "edit", reply: "Saved the scenario Alpha vs Beta.", actions: [{ op: "simulate_conjoint", target: "SIM_CBC", scenario: { name: "Alpha vs Beta", products: [{ name: "Alpha 128", levels: { Brand: "Alpha", Storage: "128 GB", Price: "₹19,999" } }, { name: "Beta 256", levels: { Brand: "Beta", Storage: "256 GB", Price: "₹24,999" } }] } }] },
        ],
        expect: { opsPresent: ["simulate_conjoint"], appliedMin: 1, parse: "repaired" } },
    ],
  },
  {
    id: "method-repair-refused-again", category: "methods", title: "#13 repaired and still refused (one-level attribute): nothing added, and the reason said plainly", fixture: "nps_relationship", tags: ["engine-11-14"],
    turns: [{ message: "Add a choice-based conjoint of brand and price",
      fake: [
        { kind: "edit", reply: "Added the CBC.", actions: [{ op: "create_conjoint", ref: "BAD_CBC", method: "cbc", attributes: [{ name: "Brand", levels: ["Alpha"] }, { name: "Price", levels: ["₹14,999", "₹19,999"] }] }] },
        { kind: "edit", reply: "Added the CBC.", actions: [{ op: "create_conjoint", ref: "BAD_CBC", method: "cbc", attributes: [{ name: "Brand", levels: ["Alpha"] }, { name: "Price", levels: ["₹14,999", "₹24,999"] }] }] },
      ],
      expect: { appliedExactly: 0, replyMatches: ["could not be made", "sent back once", "at least 2 levels"], opsAbsent: ["create_question"] } }],
  },
];
