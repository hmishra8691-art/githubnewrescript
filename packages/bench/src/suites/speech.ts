import type { Suite } from "../core.js";

/**
 * SPEECH PROVIDERS (roadmap Q1) — not measured. The measures exist (`../speech.ts`: word error rate, percentiles);
 * what is missing is everything they would be applied to.
 */
export const speechProviders: Suite = {
  id: "qualitative.speech", area: "qualitative", title: "Speech-to-text word error rate and voice turn latency",
  run() {
    return {
      status: "blocked",
      reason: "three things are missing: a speech-to-text and a text-to-speech provider (none is chosen, no key exists), a benchmark set of recorded speech with checked transcripts for each of the ten main languages, and a machine with a microphone path to time a voice turn. The word-error-rate and percentile arithmetic is written and tested; no provider has been heard.",
      metrics: [], cases: [],
    };
  },
};
