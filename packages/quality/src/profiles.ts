import type { QualityConfig } from "@rescript/schema";

/**
 * Built-in quality profiles — a strictness plus the handful of overrides that
 * a research context usually wants. Researchers save their own beside these
 * (quality_profiles table); a profile is applied by copying its config into
 * the survey, so later edits to the profile never silently change a live
 * survey.
 */
export interface QualityProfile {
  id: string;
  name: string;
  description: string;
  config: Partial<QualityConfig>;
}

export const BUILTIN_PROFILES: QualityProfile[] = [
  {
    id: "consumer_standard", name: "Consumer Research — Standard",
    description: "The recommended default: common poor-quality responses and obvious suspicious behaviour, few false positives.",
    config: { enabled: true, strictness: "standard" },
  },
  {
    id: "b2b_relaxed", name: "B2B — Relaxed",
    description: "Small, expert samples: only extreme problems. Shared office IPs and devices are expected.",
    config: { enabled: true, strictness: "relaxed", rules: { "network.duplicate_ip": { enabled: false }, "device.duplicate": { params: { count: 6 } } } },
  },
  {
    id: "healthcare_strict", name: "Healthcare — Strict",
    description: "Aggressive detection with attention and consistency weighted up; open-end quality matters.",
    config: { enabled: true, strictness: "strict", rules: { "attention.failed": { weight: 1.3 }, "consistency.impossible_path": { weight: 1.3 }, "openend.gibberish": { severity: "critical" } } },
  },
  {
    id: "finance_very_strict", name: "Finance — Very Strict",
    description: "Every behavioural and response anomaly, tight duplicate and network thresholds.",
    config: { enabled: true, strictness: "very_strict", rules: { "network.duplicate_ip": { params: { count: 1 }, weight: 1.3 }, "duplicate.answers": { weight: 1.3 } } },
  },
  {
    id: "panel_very_strict", name: "Panel Research — Very Strict",
    description: "Panel samples: coordinated clusters, repeat attempts and duplicates weighted up; longitudinal history on.",
    config: { enabled: true, strictness: "very_strict", privacy: { telemetryRetentionDays: 90, longitudinal: true }, rules: { "cluster.coordinated": { weight: 1.4 }, "screener.repeat_attempts": { weight: 1.4 }, "history.poor_record": { weight: 1.3 } } },
  },
  {
    id: "custom", name: "Custom Research — Custom",
    description: "Start from Standard and tune every rule, threshold and weight yourself.",
    config: { enabled: true, strictness: "custom" },
  },
];
