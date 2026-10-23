import { z } from "zod";

/**
 * ALERTS AND PANEL RECRUITMENT (2026-10-22, engineer G3) — two pieces of a study's CONFIGURATION that live on
 * the definition, beside the guide, so they are versioned, cloned, undone and edited by Intelligent Mode through
 * the gate (`connect_panel`, `configure_alerts`):
 *
 *   panels   how participants arrive from a sample provider (Prolific, Cint/Lucid, PureSpectrum, Dynata,
 *            Toluna, CloudResearch Connect, MTurk-style codes, or a custom panel) and where they are sent back
 *            for each outcome (complete / screen-out / quota full / terminate / over quota), optionally SIGNED.
 *   alerts   which events (an AI interview's distress flag, a quota filling, the cost cap …) go to which
 *            channels (e-mail, in-app, Slack, Teams, a webhook) for this study.
 *
 * NO SECRET IS EVER HERE. A panel's signing secret and a channel's webhook URL are secrets: they are sealed in
 * the database (migration 0072, the BYOK vault's envelope encryption) and the definition only names them —
 * a definition is exported, cloned, shown to the model and pasted into tickets.
 *
 * What these PRODUCE (panel entries, deliveries, in-app notifications) is data and lives in its own tables (0072).
 * Absent on every survey that never had them, so existing definitions are byte-identical.
 */

/** what happened to a participant, in the vocabulary panels use */
export const PANEL_OUTCOMES = ["complete", "screenout", "quota_full", "terminate", "over_quota"] as const;
export const PanelOutcome = z.enum(PANEL_OUTCOMES);
export type PanelOutcome = z.infer<typeof PanelOutcome>;

export const PANEL_PRESET_IDS = ["prolific", "cint", "purespectrum", "dynata", "toluna", "cloudresearch", "mturk", "custom"] as const;
export const PanelPresetId = z.enum(PANEL_PRESET_IDS);
export type PanelPresetId = z.infer<typeof PanelPresetId>;

/** the kinds of link a panel config applies to */
export const PANEL_TARGETS = ["ai_interview", "group_session", "live_session", "survey"] as const;
export const PanelTarget = z.enum(PANEL_TARGETS);
export type PanelTarget = z.infer<typeof PanelTarget>;

/**
 * none; HMAC over the canonical string with the secret as key; or a plain digest of the canonical string with
 * the secret appended (the "salted hash" scheme several panels document).
 */
export const PANEL_SIGNING_ALGORITHMS = ["none", "hmac-sha256", "hmac-sha1", "sha256", "sha1"] as const;
export const PanelSigningAlgorithm = z.enum(PANEL_SIGNING_ALGORITHMS);
export type PanelSigningAlgorithm = z.infer<typeof PanelSigningAlgorithm>;

export const PanelSigning = z.object({
  algorithm: PanelSigningAlgorithm.default("none"),
  /** the query parameter the signature is appended as */
  param: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/).default("hash"),
  /**
   * what is signed: `url` = the whole redirect URL (scheme to last parameter) without the signature parameter;
   * `query` = its query string only (no leading "?"); `params` = the VALUES of `params`, in that order,
   * joined by `separator`
   */
  scope: z.enum(["url", "query", "params"]).default("url"),
  params: z.array(z.string()).default([]),
  separator: z.string().max(4).default(""),
  encoding: z.enum(["hex", "base64", "base64url"]).default("hex"),
  uppercase: z.boolean().default(false),
});
export type PanelSigning = z.infer<typeof PanelSigning>;

/** a URL parameter captured on entry: `param` as it arrives, `as` the name the templates and exports use */
export const PanelEntryParam = z.object({ param: z.string().min(1).max(60), as: z.string().max(60).optional() });
export type PanelEntryParam = z.infer<typeof PanelEntryParam>;

const outcomeMap = <T extends z.ZodTypeAny>(t: T) => z.object({
  complete: t.optional(), screenout: t.optional(), quota_full: t.optional(), terminate: t.optional(), over_quota: t.optional(),
});

export const PanelConfig = z.object({
  /** stable, URL-safe: the entry link carries `?rp=<key>` when a study has more than one panel */
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  preset: PanelPresetId.default("custom"),
  label: z.string().max(80).default("Panel"),
  enabled: z.boolean().default(true),
  /** the parameter carrying the panel's own id for the person (PROLIFIC_PID, RID, psid, …) */
  idParam: z.string().min(1).max(60).default("pid"),
  /** further parameters to keep (STUDY_ID, SESSION_ID, …) */
  params: z.array(PanelEntryParam).default([]),
  /** refuse entry without the id (a panel link always carries it; a missing one is a copied link) */
  requireId: z.boolean().default(true),
  /** one entry per panel id: a second arrival with the same id is refused */
  dedupe: z.boolean().default(true),
  /** redirect templates per outcome — https only; {{pid}}, {{code}}, {{outcome}} and captured params ({{STUDY_ID}} or their `as` name) */
  redirects: outcomeMap(z.string().max(2000)).default({}),
  /** completion codes per outcome (Prolific, CloudResearch, MTurk-style): piped as {{code}} and shown when `showCode` */
  codes: outcomeMap(z.string().max(80)).default({}),
  /** show the outcome's code on the thank-you page (MTurk-style: the worker pastes it back) */
  showCode: z.boolean().default(false),
  signing: PanelSigning.default({}),
  /** which links use this panel */
  targets: z.array(PanelTarget).default(["ai_interview", "group_session", "live_session", "survey"]),
  /** quota sync: completes bought from this panel; past it, new entrants are sent back as over quota */
  completesTarget: z.number().int().positive().max(1_000_000).optional(),
  notes: z.string().max(500).optional(),
});
export type PanelConfig = z.infer<typeof PanelConfig>;

/* ------------------------------------------------------------ alerts */

export const ALERT_CHANNEL_KINDS = ["email", "in_app", "slack", "teams", "webhook"] as const;
export const AlertChannelKind = z.enum(ALERT_CHANNEL_KINDS);
export type AlertChannelKind = z.infer<typeof AlertChannelKind>;

/**
 * where an alert goes. `to`:
 *   email   an address, "@me" (the person who set the rule up — the project owner until claimed) or "@team" (the project's members)
 *   in_app  "@me", "@team" or a user id
 *   slack / teams / webhook   the organisation's channel by its name ("#research-ops") or id — the webhook URL itself is a secret, never here
 */
export const AlertChannelRef = z.object({ kind: AlertChannelKind, to: z.string().min(1).max(200) });
export type AlertChannelRef = z.infer<typeof AlertChannelRef>;

export const AlertRule = z.object({
  id: z.string().min(1).max(40),
  /** event types (`ai_interview.distress`), categories (`ai_interview.*`) or "*" */
  events: z.array(z.string().min(1).max(60)).min(1).max(30),
  channels: z.array(AlertChannelRef).min(1).max(10),
  /** immediate, or collected into one message per hour / day */
  digest: z.enum(["immediate", "hourly", "daily"]).default("immediate"),
  enabled: z.boolean().default(true),
  /** who "@me" is — set when a person saves the rule in the Studio */
  claimedBy: z.string().max(80).optional(),
});
export type AlertRule = z.infer<typeof AlertRule>;

export const AlertQuietHours = z.object({
  /** "22:00" */
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  /** IANA zone; UTC when absent */
  timeZone: z.string().max(60).optional(),
  /** critical events (distress) are never held */
  bypassCritical: z.boolean().default(true),
});
export type AlertQuietHours = z.infer<typeof AlertQuietHours>;

export const AlertSettings = z.object({
  rules: z.array(AlertRule).default([]),
  quietHours: AlertQuietHours.optional(),
  /** per channel destination, at most this many immediate messages an hour; the rest wait for the hourly digest */
  maxPerHour: z.number().int().min(1).max(500).default(30),
  /** the same event about the same thing within this many minutes is one message */
  dedupeMinutes: z.number().int().min(0).max(1440).default(15),
});
export type AlertSettings = z.infer<typeof AlertSettings>;
