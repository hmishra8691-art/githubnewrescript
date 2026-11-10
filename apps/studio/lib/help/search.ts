/**
 * HELP RETRIEVAL (2026-11-09). The Help assistant answers from sources, never from memory: every question is first
 * matched against the knowledge base — the task guides in content/help, the platform documentation in content/docs
 * (three pages generated from the code), and facts generated at runtime (the Studio's own menu, the quality rules,
 * the methodologies, the live billing configuration).
 *
 * Deterministic and dependency-free: BM25 over section-sized chunks, with the researcher's own words expanded into
 * the platform's vocabulary first ("show Q5 only if they said yes" → display logic), so a question works without
 * knowing a feature's name. Guides outrank reference pages; the topic of the conversation so far is carried into a
 * short follow-up ("what if I want two conditions?").
 */
export type SourceKind = "guide" | "doc" | "generated";
export interface HelpChunk {
  /** article id + "#" + section slug */
  id: string;
  article: string;
  title: string;
  heading: string;
  category: string;
  kind: SourceKind;
  keywords: string[];
  text: string;
  /** where a person can read the whole thing */
  href: string;
}
export interface IndexedChunk extends HelpChunk { tokens: string[]; len: number; tf: Map<string, number>; boost: Set<string> }
export interface HelpIndex { chunks: IndexedChunk[]; df: Map<string, number>; avgLen: number }

const STOP = new Set("a an the and or but if then else of to in on at for from by with without about into over under is are was were be been being am do does did done doing have has had having i me my we our you your it its this that these those there here what which who whom whose when where why how can could should would will shall may might must not no yes so than too very just also only own same such each any all some more most other another both either neither one two three get got make made want wants wanted need needs like please let lets tell show me us im ive id dont cant wont isnt arent doesnt didnt reslens ai platform".split(" ").filter((w) => !["show", "only", "not", "no", "yes", "if", "when", "two"].includes(w)));

/** a light stem: plural, -ing, -ed, -ly — enough for "quotas" ~ "quota", "piped" ~ "pipe" */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ss|us|is)$/.test(w)) return w;
  if (/ing$/.test(w) && w.length > 5) { const b = w.slice(0, -3); return /(.)\1$/.test(b) ? b.slice(0, -1) : b; }
  if (/ed$/.test(w) && w.length > 4) { const b = w.slice(0, -2); return /(.)\1$/.test(b) ? b.slice(0, -1) : b; }
  if (/es$/.test(w) && /(ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) w = w.slice(0, -1);
  return w.length >= 4 && w.endsWith("e") ? w.slice(0, -1) : w;
}
export function tokenize(text: string): string[] {
  return (text.toLowerCase().replace(/[’']/g, "").match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)).map(stem);
}

/**
 * THE RESEARCHER'S WORDS → THE PLATFORM'S VOCABULARY. Each entry adds the canonical terms of a feature when its
 * everyday phrasing appears. Order does not matter; several may fire.
 */
export const EXPANSIONS: [RegExp, string][] = [
  [/\b(?:show|display|ask)\b.{0,60}\b(?:only|just)\b.{0,30}\b(?:when|if|for)\b|\bonly (?:show|display|ask)\b|\bconditional(?:ly)? (?:show|display|question)|\bhide (?:a |the |this )?question|\bshow (?:a |the |this )?question (?:when|if)|\bshould (?:only )?(?:see|get) (?:q|question)/i, "display logic condition"],
  [/\bskip\b|\bjump (?:to|over|ahead)|\bgo (?:straight )?to (?:q|question|the end|page)|\bbypass\b|\bskip the next/i, "skip logic rule go to"],
  [/\bbranch(?:ing|es)?\b|\bdifferent (?:path|route|questions) for|\broute (?:people|respondents)\b/i, "branching flow branch logic"],
  [/\b(?:and|or)\b.{0,10}\bcondition|\btwo conditions|\bmultiple conditions|\bmore than one condition|\bboth (?:conditions|answers)|\beither\b|\bcombine conditions/i, "condition group and or match all any"],
  [/\bpip(?:e|ed|ing)\b|\binsert (?:their|the|an?) (?:earlier |previous )?answer|\b(?:mention|repeat|reference) (?:their|the) (?:earlier |previous )?answer|\bname (?:they|the respondent) (?:gave|entered)|\bdynamic text/i, "piping piped text insert"],
  [/\bonly (?:the )?(?:brands?|options?|items?|answers?|choices?) (?:they|the respondent|respondents) (?:selected|chose|picked|ticked)|\bselected (?:in|at) (?:an? )?(?:earlier|previous)|\bfrom (?:an? )?(?:earlier|previous) question\b|\bcarry(?:ing)?[- ]forward|\bbring forward/i, "carry forward masking option previous selected"],
  [/\bmask(?:ing)?\b|\bhide (?:some |the )?(?:options|answers|choices|rows|columns)|\bremove (?:options|answers) (?:they|not)/i, "masking mask option row column"],
  [/\bloop(?:s|ing)?\b|\brepeat (?:the |these )?questions? for each|\bfor each (?:brand|product|item|child)|\bmerge\b/i, "loop iteration repeat each"],
  /* "show every selected brand in a separate set of questions" — a loop over the earlier answer, with the item piped in */
  [/\b(?:each|every) (?:selected |chosen |picked )?(?:brand|product|item|option|answer|store|child)s?\b.{0,50}\b(?:separate|own|set of questions|same questions|questions about)|\bseparate (?:set of )?questions (?:for|about) each\b|\bsame questions (?:for|about) (?:each|every)\b/i, "loop iteration repeat each loop source question piping loop label"],
  [/\brandom(?:i[sz]e|i[sz]ation|ly)?\b|\bshuffle\b|\brotate\b|\border bias\b/i, "randomization shuffle rotate order"],
  [/\bquotas?\b|\bcells?\b.{0,20}\b(?:target|full)|\bhow many (?:completes|people) (?:per|from each)|\bquota full/i, "quota cell target full"],
  [/\bterminat(?:e|ion|ed)|\bscreen(?:ed)?[- ]?out|\bdisqualif|\bend (?:the )?survey (?:for|if|when)/i, "termination screen out end screened"],
  [/\bvalidat(?:e|ion)\b|\bmust (?:answer|enter|be between)|\brequired\b|\berror message\b|\ballow only\b/i, "validation rule required message"],
  [/\bjavascript\b|\bjquery\b|\bjs\b|\bcustom (?:code|script)|\bscripts?\b/i, "script javascript custom code"],
  [/\bcalculat(?:e|ion|ed)|\bcomputed? (?:variable|value)|\bscore\b|\bsum of\b|\bderived\b/i, "calculation calculated variable expression"],
  [/\bembedded (?:data|variable|field)|\burl param|\bhidden (?:variable|field)|\bpanel id|\bquery string/i, "embedded data variable url parameter"],
  [/\bmax ?diff|\bbest[- ]worst|\bmaximum difference/i, "maxdiff design best worst"],
  [/\bconjoint\b|\bcbc\b|\bacbc\b|\btrade[- ]offs?\b|\battributes? and levels|\bwillingness to pay\b|\bwtp\b|\bchoice[- ]based/i, "conjoint cbc acbc design attribute level"],
  [/\bmenu[- ]based\b|\bbuild your own\b|\bbundle\b/i, "menu conjoint design"],
  [/\bwhich (?:method|methodology|approach)|\bresearch design\b|\bwhat (?:kind|type) of (?:study|research)|\bhow (?:should|do) i (?:measure|test|research)/i, "methodology study design recommend"],
  [/\bwallet\b|\bcredits?\b|\bcharg(?:e|ed|es|ing)\b|\bbill(?:ed|ing)?\b|\bdeduct|\bbalance\b|\bpayment\b|\binvoice|\bspend(?:ing)?\b|\bmoney\b/i, "wallet usage billing credit charge balance"],
  [/\btest (?:responses?|data|link)\b.{0,40}\b(?:cost|charg|credit|bill|consum|free|paid|pay)|\b(?:cost|charg|credit|bill|consum|pay)\w*\b.{0,40}\btest (?:responses?|data)\b|\bwhen (?:does|is) a (?:live )?response (?:become )?billable/i, "test live environment billing billable"],
  [/\b(?:find|set|choose|right|optimal|best) (?:the )?price\b|\bhow much (?:would|will|do|are) (?:customers|people|users|they)\b.{0,20}\bpay\b|\bpricing (?:research|study)\b/i, "pricing methodology study design price sensitivity"],
  [/\btest (?:responses?|data|link|survey)|\bpreview\b|\btry (?:the|my) survey|\bdry run/i, "test preview response link"],
  [/\bdeploy|\bpublish|\bgo live\b|\blaunch\b|\blive link\b|\bnew version\b|\bversions?\b/i, "deploy version publish live link"],
  [/\bcross[- ]?tab(?:s|ulation)?\b|\bbanner\b|\b(?:by|against|versus|vs\.?) (?:gender|age|region|segment)|\btable of .{0,30} by\b/i, "crosstab table rows columns analytics"],
  [/\bsignifican(?:t|ce)\b|\bstat(?:istical)? test|\bp[- ]value|\bchi[- ]square|\bt[- ]test/i, "significance test statistic"],
  [/\bcharts?\b|\bgraph\b|\bvisuali[sz]/i, "chart visualization analytics"],
  [/\bexport|\bdownload (?:the )?(?:data|responses)|\bspss\b|\bsav\b|\bstata\b|\bexcel\b|\bcsv\b/i, "export download data spss excel"],
  [/\bresponses? (?:are |is )?(?:not|missing|n'?t)|\bnot (?:appearing|showing|in) (?:the )?(?:results|analytics|data)|\bwhere are (?:my )?responses|\bno (?:responses|data)\b/i, "responses missing data live test analytics dataset troubleshoot"],
  [/\bfieldwork\b|\bsuppliers?\b|\bincidence\b|\bcompletion rate\b|\bmonitor(?:ing)?\b|\bprogress\b/i, "fieldwork progress monitor supplier completes"],
  [/\brecruit(?:ment|ing)?\b|\bpanel\b|\bvendor\b|\bsample (?:provider|partner)|\bfeasibility\b|\bcpi\b/i, "recruitment vendor sample feasibility"],
  [/\bwaves?\b|\btracker\b|\btracking study|\blongitudinal|\bwave[- ]on[- ]wave/i, "wave tracker"],
  [/\bqualitative\b|\binterviews?\b|\bfocus group|\btranscripts?\b|\bthemes?\b|\bcoding\b|\bdiscussion guide|\bprobes?\b/i, "qualitative interview transcript theme guide"],
  [/\bbrand(?:ing)?\b.{0,20}\b(?:colou?rs?|logo|font|theme|look)|\blogo\b|\bcolou?rs?\b|\bfonts?\b|\btheme\b|\bcss\b|\blook and feel/i, "branding theme colour logo font css"],
  [/\bcollaborat|\binvite\b|\bshare (?:the |my |this )?(?:project|survey)|\bpermission|\broles?\b|\baccess\b|\bowner\b|\bteam ?mates?\b/i, "collaborator permission role access invite"],
  [/\bintelligent mode\b|\bai (?:assist|mode|copilot|programm)|\bcopilot\b|\bgenerate (?:a |the )?survey|\bwrite (?:the )?questions? for me/i, "intelligent mode copilot ai generate"],
  [/\bquality\b|\bspeeders?\b|\bstraight[- ]?lin|\bbots?\b|\bfraud\b|\bclean(?:ing)?\b|\bcontradict|\binconsisten/i, "quality cleaning speeder straightline fraud consistency"],
  [/\bsimulat|\bdummy (?:data|responses)|\bsynthetic (?:data|responses)|\bfake responses/i, "simulation simulated respondents test"],
  [/\blist ?fill\b|\ballocat(?:e|ion)\b|\bleast[- ]fill/i, "list fill allocation"],
  [/\btranslat|\blanguages?\b|\blocali[sz]/i, "translation language localization"],
  [/\bredirect|\bend (?:page|screen)|\bthank[- ]you page/i, "redirect end page"],
  [/\bjson\b|\bdefinition file/i, "json definition"],
];

export function expandQuery(text: string): string {
  const extra = EXPANSIONS.filter(([re]) => re.test(text)).map(([, t]) => t);
  return [text, ...extra].join(" ");
}

export function buildIndex(chunks: HelpChunk[]): HelpIndex {
  const df = new Map<string, number>();
  const indexed: IndexedChunk[] = chunks.map((c) => {
    const tokens = tokenize(`${c.title} ${c.heading} ${c.keywords.join(" ")} ${c.text}`);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const boost = new Set(tokenize(`${c.title} ${c.heading} ${c.keywords.join(" ")}`));
    return { ...c, tokens, len: tokens.length, tf, boost };
  });
  const avgLen = indexed.reduce((a, c) => a + c.len, 0) / Math.max(1, indexed.length);
  return { chunks: indexed, df, avgLen };
}

export interface SearchHit { chunk: IndexedChunk; score: number }
export interface SearchOptions { limit?: number; /** articles discussed earlier in the conversation */ topic?: string[]; /** the guides those articles point to — where a follow-up usually goes next */ near?: string[]; /** a short follow-up leans on the topic more */ followUp?: boolean; /** the category the kind of request points at (troubleshooting, billing) */ category?: string; categoryBoost?: number }

const KIND_WEIGHT: Record<SourceKind, number> = { guide: 1.6, generated: 1.2, doc: 1.0 };

export function search(index: HelpIndex, query: string, opts: SearchOptions = {}): SearchHit[] {
  const q = tokenize(expandQuery(query));
  if (!q.length) return [];
  const N = index.chunks.length, k1 = 1.2, b = 0.75;
  const qset = [...new Set(q)];
  const hits: SearchHit[] = [];
  for (const c of index.chunks) {
    let s = 0;
    for (const t of qset) {
      const f = c.tf.get(t);
      if (!f) continue;
      const n = index.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / index.avgLen))) * (c.boost.has(t) ? 2 : 1);
    }
    if (s <= 0) continue;
    s *= KIND_WEIGHT[c.kind];
    if (opts.topic?.includes(c.article)) s *= opts.followUp ? 1.5 : 1.15;
    else if (opts.followUp && opts.near?.includes(c.article)) s *= 1.6;
    if (opts.category && c.category === opts.category) s *= opts.categoryBoost ?? 1.2;
    hits.push({ chunk: c, score: s });
  }
  hits.sort((a, z) => z.score - a.score);
  return hits.slice(0, opts.limit ?? 8);
}

/** the best articles behind the hits, each with its strongest sections, in order */
export function topArticles(hits: SearchHit[], max = 3): { article: string; title: string; href: string; kind: SourceKind; score: number; chunks: IndexedChunk[] }[] {
  const by = new Map<string, { article: string; title: string; href: string; kind: SourceKind; score: number; chunks: IndexedChunk[] }>();
  for (const h of hits) {
    const a = by.get(h.chunk.article) ?? { article: h.chunk.article, title: h.chunk.title, href: h.chunk.href, kind: h.chunk.kind, score: 0, chunks: [] };
    a.score = Math.max(a.score, h.score) + (a.chunks.length ? h.score * 0.15 : 0);
    a.chunks.push(h.chunk);
    by.set(h.chunk.article, a);
  }
  return [...by.values()].sort((a, z) => z.score - a.score).slice(0, max);
}

/** the category a kind of request leans towards, and how much */
export function categoryFor(mode: string, text = ""): { category?: string; categoryBoost?: number } {
  const trouble = /\b(?:unexpected(?:ly)?|wrong|incorrect|why (?:was|were|am|is|are)|not (?:working|appearing|showing)|blank|missing|failed|error|broken)\b/i.test(text);
  return mode === "troubleshoot" || trouble ? { category: "troubleshooting", categoryBoost: 1.8 } : mode === "billing" ? { category: "billing", categoryBoost: 1.5 } : {};
}

/** a follow-up leans on the conversation: short, or pointing back at what was just discussed */
export function isFollowUp(text: string): boolean {
  const words = text.trim().split(/\s+/).length;
  return words <= 9 || /^(?:and|but|also|what if|what about|how about|then|ok(?:ay)?|so)\b|\b(?:it|this|that|those|them|the same|instead)\b/i.test(text.trim());
}
