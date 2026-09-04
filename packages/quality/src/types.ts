import type {
  SurveyDefinition, QualityCategory, QualityClass, Severity, Strictness, QualityConfig,
} from "@rescript/schema";

/* ============================================================ telemetry */

/**
 * What the runtime's event collector records while a respondent answers.
 * Derived metadata only: counts, durations, lengths, hashes. No clipboard
 * text, no raw IP, no keystrokes.
 */
export interface PageVisit {
  pageId: string;
  /** flow step index at the time */
  step: number;
  enteredAt: number;
  leftAt?: number;
  /** how the respondent arrived */
  via: "start" | "next" | "back" | "reload" | "jump";
  questionIds: string[];
  /** ms the tab was hidden / window blurred during this visit */
  outOfFocusMs: number;
  blurs: number;
  pointerEvents: number;
  keyEvents: number;
  scrollEvents: number;
}

export interface QuestionTiming {
  /** first change to the answer, ms since survey start */
  firstChangeAt?: number;
  lastChangeAt?: number;
  changes: number;
  /** ms from page entry to first change, on the visit where it first happened */
  latencyMs?: number;
  pastes: number;
  pasteChars: number;
  /** characters typed (key events) into text inputs of this question */
  typedChars: number;
  copies: number;
}

export interface DeviceInfo {
  type: "desktop" | "tablet" | "mobile" | "unknown";
  browser: string;
  os: string;
  screen: string;
  viewport: string;
  dpr: number;
  locale: string;
  language: string;
  languages?: string[];
  timezone: string;
  tzOffset: number;
  touch: boolean;
  webdriver: boolean;
  hardwareConcurrency?: number;
  /** navigator.platform / userAgentData.platform */
  platform?: string;
}

export interface ResponseTelemetry {
  v: 1;
  startedAt: number;
  submittedAt?: number;
  pages: PageVisit[];
  questions: Record<string, QuestionTiming>;
  focus: { blurs: number; totalOutOfFocusMs: number; longestOutOfFocusMs: number };
  clipboard: { copies: number; pastes: number; pasteChars: number; largePastes: number; pasteQuestions: number };
  navigation: { back: number; forward: number; reloads: number; jumps: number; sequence: string[] };
  interaction: { pointerEvents: number; keyEvents: number; scrollEvents: number };
  device?: DeviceInfo;
  /** telemetry categories the survey disabled — recorded so the engine knows a zero is "not measured" */
  disabled: string[];
}

/* ============================================================ inputs */

export interface ResponseRecord {
  sessionId: string;
  respondentId?: string | null;
  externalId?: string | null;
  status: string;
  isTest?: boolean;
  answers: Record<string, unknown>;
  embedded?: Record<string, unknown>;
  calculated?: Record<string, unknown>;
  flags?: string[];
  startedAt: string | null;
  completedAt: string | null;
  telemetry?: ResponseTelemetry | null;
  ipHash?: string | null;
  deviceHash?: string | null;
  userAgent?: string | null;
}

/**
 * Another response of the same survey, as much of it as similarity and
 * benchmarking need. `system` is the compact SYSTEM_* record the engine wrote
 * when that response was assessed (durations, signatures, fingerprints), so a
 * peer costs a few hundred bytes rather than its whole telemetry.
 */
export interface PeerRecord {
  sessionId: string;
  respondentId?: string | null;
  externalId?: string | null;
  status: string;
  answers: Record<string, unknown>;
  startedAt: string | null;
  completedAt: string | null;
  ipHash?: string | null;
  deviceHash?: string | null;
  system?: Partial<SystemVars> | null;
  /** the peer's own classification, when already assessed */
  classification?: QualityClass | null;
  reviewStatus?: string | null;
}

/** A prior assessment of the same external respondent in another study. */
export interface HistoryRecord {
  surveyId: string;
  completedAt: string | null;
  qualityScore: number;
  riskScore: number;
  classification: QualityClass;
  categories: Partial<Record<QualityCategory, number>>;
}

export interface QualityInput {
  def: SurveyDefinition;
  response: ResponseRecord;
  peers: PeerRecord[];
  history?: HistoryRecord[];
  /** override for tests */
  now?: number;
}

/* ============================================================ outputs */

export interface QualityFlag {
  /** stable rule id, e.g. "timing.overall_speeding" or "custom.<id>" */
  ruleId: string;
  category: QualityCategory;
  severity: Severity;
  title: string;
  /** what happened, in words the researcher reads */
  explanation: string;
  observed: string;
  expected?: string;
  /** contribution to the fraud-risk score (before weighting), 0–100 */
  riskPoints: number;
  /** contribution to the quality penalty, 0–100 */
  qualityPenalty: number;
  questionIds: string[];
  relatedSessionIds?: string[];
  at: string;
}

/**
 * The hidden system variables. Every value here is exported with the
 * response (prefixed SYSTEM_) and is what custom rules test against as
 * `calc.SYSTEM_*`. Kept flat and JSON-friendly.
 */
export interface SystemVars {
  SYSTEM_RESPONSE_ID: string;
  SYSTEM_SESSION_ID: string;
  SYSTEM_START_TIMESTAMP: string | null;
  SYSTEM_END_TIMESTAMP: string | null;
  SYSTEM_TOTAL_DURATION: number | null;
  SYSTEM_MEDIAN_DURATION: number | null;
  SYSTEM_DURATION_RATIO: number | null;
  SYSTEM_TAB_SWITCH_COUNT: number | null;
  SYSTEM_TOTAL_OUT_OF_FOCUS_TIME: number | null;
  SYSTEM_COPY_COUNT: number | null;
  SYSTEM_PASTE_COUNT: number | null;
  SYSTEM_PASTE_CHARS: number | null;
  SYSTEM_PAGE_TIME: Record<string, number>;
  SYSTEM_QUESTION_TIME: Record<string, number>;
  SYSTEM_MATRIX_TIME: Record<string, number>;
  SYSTEM_BACK_COUNT: number | null;
  SYSTEM_RELOAD_COUNT: number | null;
  SYSTEM_NAV_FINGERPRINT: string | null;
  SYSTEM_DEVICE_TYPE: string | null;
  SYSTEM_BROWSER: string | null;
  SYSTEM_OS: string | null;
  SYSTEM_SCREEN_SIZE: string | null;
  SYSTEM_TIMEZONE: string | null;
  SYSTEM_LOCALE: string | null;
  SYSTEM_DEVICE_HASH: string | null;
  SYSTEM_IP_HASH: string | null;
  SYSTEM_NETWORK_RISK: number | null;
  SYSTEM_MATRIX_SIGNATURE: Record<string, string>;
  SYSTEM_OPENEND_HASHES: Record<string, string>;
  SYSTEM_ANSWER_SIGNATURE: string | null;
  SYSTEM_ATTENTION_FAILED: number;
  SYSTEM_ATTENTION_PASSED: number;
  SYSTEM_SPEEDER_SCORE: number;
  SYSTEM_STRAIGHTLINE_SCORE: number;
  SYSTEM_ATTENTION_SCORE: number;
  SYSTEM_CONSISTENCY_SCORE: number;
  SYSTEM_OPENEND_SCORE: number;
  SYSTEM_NAVIGATION_SCORE: number;
  SYSTEM_BOT_SCORE: number;
  SYSTEM_DUPLICATE_SCORE: number;
  SYSTEM_PATTERN_SCORE: number;
  SYSTEM_CLUSTER_SCORE: number;
  SYSTEM_DEVICE_SCORE: number;
  SYSTEM_INTERACTION_SCORE: number;
  SYSTEM_SCREENER_SCORE: number;
  SYSTEM_QUALITY_SCORE: number;
  SYSTEM_FRAUD_RISK_SCORE: number;
  SYSTEM_QUALITY_STATUS: QualityClass;
  SYSTEM_SIMILARITY_SCORE: number | null;
  SYSTEM_SIMILAR_RESPONDENT_IDS: string[];
  SYSTEM_CLUSTER_ID: string | null;
  SYSTEM_CLUSTER_RISK_SCORE: number | null;
  SYSTEM_FLAG_COUNT: number;
  SYSTEM_HIGH_SEVERITY_FLAGS: number;
}

/**
 * The SYSTEM_* variables a researcher can test in a custom rule, with the
 * unit or range each carries — one list, shared by the settings help table and
 * the condition builder's "Quality metrics" source group, so a rule saved as
 * `calc.SYSTEM_DURATION_RATIO` is displayed as exactly that when reopened.
 */
export const SYSTEM_VARIABLE_HELP: { name: keyof SystemVars; hint: string }[] = [
  { name: "SYSTEM_DURATION_RATIO", hint: "total time ÷ benchmark (0.3 = 70% faster than median)" },
  { name: "SYSTEM_TOTAL_DURATION", hint: "seconds" },
  { name: "SYSTEM_MEDIAN_DURATION", hint: "benchmark seconds" },
  { name: "SYSTEM_ATTENTION_FAILED", hint: "checks failed" },
  { name: "SYSTEM_ATTENTION_PASSED", hint: "checks passed" },
  { name: "SYSTEM_SPEEDER_SCORE", hint: "0–100" },
  { name: "SYSTEM_STRAIGHTLINE_SCORE", hint: "0–100" },
  { name: "SYSTEM_ATTENTION_SCORE", hint: "0–100" },
  { name: "SYSTEM_CONSISTENCY_SCORE", hint: "0–100" },
  { name: "SYSTEM_OPENEND_SCORE", hint: "0–100" },
  { name: "SYSTEM_NAVIGATION_SCORE", hint: "0–100" },
  { name: "SYSTEM_BOT_SCORE", hint: "0–100" },
  { name: "SYSTEM_DUPLICATE_SCORE", hint: "0–100" },
  { name: "SYSTEM_PATTERN_SCORE", hint: "0–100" },
  { name: "SYSTEM_CLUSTER_SCORE", hint: "0–100" },
  { name: "SYSTEM_DEVICE_SCORE", hint: "0–100" },
  { name: "SYSTEM_INTERACTION_SCORE", hint: "0–100" },
  { name: "SYSTEM_SCREENER_SCORE", hint: "0–100" },
  { name: "SYSTEM_SIMILARITY_SCORE", hint: "0–100 vs closest peer" },
  { name: "SYSTEM_CLUSTER_RISK_SCORE", hint: "0–100" },
  { name: "SYSTEM_NETWORK_RISK", hint: "0–100 (provider hook)" },
  { name: "SYSTEM_PASTE_COUNT", hint: "pastes" },
  { name: "SYSTEM_PASTE_CHARS", hint: "pasted characters" },
  { name: "SYSTEM_COPY_COUNT", hint: "copies" },
  { name: "SYSTEM_TAB_SWITCH_COUNT", hint: "tab switches" },
  { name: "SYSTEM_TOTAL_OUT_OF_FOCUS_TIME", hint: "seconds out of focus" },
  { name: "SYSTEM_BACK_COUNT", hint: "back moves" },
  { name: "SYSTEM_RELOAD_COUNT", hint: "reloads" },
  { name: "SYSTEM_DEVICE_TYPE", hint: "desktop / tablet / mobile" },
  { name: "SYSTEM_BROWSER", hint: "browser name" },
  { name: "SYSTEM_OS", hint: "operating system" },
  { name: "SYSTEM_TIMEZONE", hint: "IANA timezone" },
  { name: "SYSTEM_LOCALE", hint: "locale" },
  { name: "SYSTEM_FLAG_COUNT", hint: "flags raised" },
  { name: "SYSTEM_HIGH_SEVERITY_FLAGS", hint: "high / critical flags" },
];

export interface ClusterInfo {
  clusterId: string | null;
  similarityScore: number;
  similarSessionIds: string[];
  clusterRisk: number;
  size: number;
  /** which signals the cluster shares, for the explanation */
  sharedSignals: string[];
}

export interface QualityAssessment {
  version: 1;
  computedAt: string;
  strictness: Strictness;
  enabled: boolean;
  /**
   * Fingerprint of the resolved `def.quality` this assessment was computed
   * with (see `configFingerprint`). The dashboard compares it with the
   * fingerprint of the settings now saved, so a response scored under older
   * settings is visibly "older settings" rather than silently mixed in.
   * Absent on assessments written before the field existed.
   */
  configHash?: string;
  qualityScore: number;
  riskScore: number;
  classification: QualityClass;
  /** per-category risk (0–100) — the SYSTEM_*_SCORE values by category */
  categories: Record<QualityCategory, number>;
  flags: QualityFlag[];
  system: SystemVars;
  cluster: ClusterInfo;
  /** one line per reason, ordered by contribution — the "Reasons:" list */
  reasons: string[];
  recommendation: "INCLUDE" | "REVIEW BEFORE INCLUSION" | "LIKELY EXCLUDE";
  /** which telemetry categories were unavailable (disabled or not collected) */
  notMeasured: string[];
  benchmarks: { peers: number; medianDurationSec: number | null };
}

/* ============================================================ rules */

export interface RuleParamDef {
  key: string;
  label: string;
  /** default per strictness; `custom` inherits standard */
  defaults: Record<Exclude<Strictness, "custom">, number | boolean | string>;
  unit?: string;
  hint?: string;
}

export interface RuleDef {
  id: string;
  category: QualityCategory;
  title: string;
  description: string;
  defaultSeverity: Severity;
  /** risk points a single firing contributes before weighting */
  riskPoints: number;
  qualityPenalty: number;
  params: RuleParamDef[];
  /** rules off in relaxed / standard etc. */
  enabledIn: Record<Exclude<Strictness, "custom">, boolean>;
  /** does this rule need telemetry of a given kind (skipped, not failed, when absent) */
  needs?: ("timing" | "focus" | "clipboard" | "navigation" | "interaction" | "device" | "network" | "peers")[];
}

/** Everything a rule implementation receives. */
export interface RuleContext {
  def: SurveyDefinition;
  config: QualityConfig;
  strictness: Strictness;
  response: ResponseRecord;
  telemetry: ResponseTelemetry | null;
  peers: PeerRecord[];
  history: HistoryRecord[];
  bench: Benchmarks;
  now: number;
  /** resolved params for a rule id */
  param<T = number>(ruleId: string, key: string): T;
  severity(ruleId: string): Severity;
  enabled(ruleId: string): boolean;
  /** question filter from the rule's settings */
  applies(ruleId: string, questionId: string): boolean;
  disabledTelemetry: Set<string>;
}

/** A flag as a rule emits it; the engine fills in points, severity and time. */
export interface FlagDraft {
  ruleId: string;
  title?: string;
  explanation: string;
  observed: string;
  expected?: string;
  questionIds?: string[];
  relatedSessionIds?: string[];
  /** 0–1 multiplier on the rule's default points, for graded findings */
  intensity?: number;
  severity?: Severity;
}

export interface Benchmarks {
  peers: number;
  medianDurationSec: number | null;
  /** page id → median seconds among peers */
  pageMedians: Record<string, number>;
  questionMedians: Record<string, number>;
  /** estimated reading + answering seconds per page from the definition alone */
  pageEstimates: Record<string, number>;
  questionEstimates: Record<string, number>;
  estimatedDurationSec: number;
}
