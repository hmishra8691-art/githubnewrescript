import "server-only";

/**
 * WHICH DEPLOYMENT OF THE PLATFORM THIS IS (§45).
 *
 * The platform has always known which ENVIRONMENT a response belongs to —
 * TEST or LIVE, enforced everywhere since migration 0006. It has never known
 * anything about its own deployment. `NODE_ENV` is read in three places, all
 * behavioural (a cookie flag and the diagnostics gate), and nothing anywhere
 * says whether the Studio you are looking at is a developer's laptop, a
 * staging copy, or the instance a client's fieldwork is running through.
 *
 * That is a real failure and not a cosmetic one. Two deployments of this
 * platform look identical, and the destructive actions — publish, deploy,
 * purge responses, freeze a project — are all one click. A person who
 * believes they are in staging and is in production finds out afterwards.
 *
 * So: one declared variable, `RESCRIPT_ENV`, and one place that reads it.
 * Everything else is DERIVED, because a tier that has to be configured in
 * two places is a tier that will disagree with itself.
 *
 * Nothing here ever returns a secret. The database is identified by its
 * project reference — the public part of the URL, which already appears in
 * every respondent's network tab — and never by a key. `SUPABASE_URL` is
 * reduced to that reference deliberately: "which database am I pointed at"
 * is the question, and the answer must be safe to screenshot for support,
 * exactly as the per-project diagnostics are.
 */

export type PlatformTier = "development" | "staging" | "production";

export interface PlatformInfo {
  tier: PlatformTier;
  /** true when the tier was declared rather than guessed from NODE_ENV */
  declared: boolean;
  /** the Supabase project reference — the public part of the URL, never a key */
  database: string | null;
  /** where respondents are sent */
  runtimeUrl: string;
  /** absolute base for the links this platform emails (invites, resets) */
  studioUrl: string | null;
  /** the release this instance is running, when the platform was told */
  release: string | null;
  node: string;
  /** what is configured, and what is not — no values, only presence */
  configured: {
    database: boolean;
    serviceKey: boolean;
    anonKey: boolean;
    runtimeUrl: boolean;
    studioUrl: boolean;
    authSalt: boolean;
    qualitySalt: boolean;
    mail: boolean;
  };
  /** things worth telling a deployment manager before somebody hits them */
  warnings: string[];
}

/** The project reference out of a Supabase URL. `https://abc.supabase.co` → `abc`. */
function projectRef(url: string | undefined): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  try {
    const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname;
    const first = host.split(".")[0];
    return first || host;
  } catch {
    return null;
  }
}

/**
 * The tier.
 *
 * `RESCRIPT_ENV` when it is set, because a tier is a fact about a deployment
 * and somebody should have to state it. Otherwise inferred from `NODE_ENV`,
 * which gets it right for a laptop and — importantly — errs towards
 * PRODUCTION for anything built and served, since the failure that matters is
 * treating production as staging and not the other way round.
 */
export function platformTier(): { tier: PlatformTier; declared: boolean } {
  const raw = (process.env.RESCRIPT_ENV ?? "").trim().toLowerCase();
  if (raw === "development" || raw === "dev" || raw === "local") return { tier: "development", declared: true };
  if (raw === "staging" || raw === "stage" || raw === "preview" || raw === "test") return { tier: "staging", declared: true };
  if (raw === "production" || raw === "prod" || raw === "live") return { tier: "production", declared: true };
  return { tier: process.env.NODE_ENV === "production" ? "production" : "development", declared: false };
}

export function platformInfo(): PlatformInfo {
  const { tier, declared } = platformTier();
  const database = projectRef(process.env.SUPABASE_URL);
  const runtimeUrl = (process.env.NEXT_PUBLIC_RUNTIME_URL ?? "").trim() || "http://localhost:3001";
  const studioUrl = (process.env.STUDIO_PUBLIC_URL ?? "").trim() || null;

  const configured = {
    database: !!process.env.SUPABASE_URL,
    serviceKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey: !!process.env.SUPABASE_ANON_KEY,
    runtimeUrl: !!(process.env.NEXT_PUBLIC_RUNTIME_URL ?? "").trim(),
    studioUrl: !!studioUrl,
    authSalt: !!(process.env.AUTH_HASH_SALT ?? process.env.QUALITY_HASH_SALT),
    qualitySalt: !!process.env.QUALITY_HASH_SALT,
    /*
     * Both halves, because either alone sends nothing: a key with no From
     * address has nowhere to send from, and an address with no key has no way
     * to send. `mailConfig()` applies the same rule.
     */
    mail: !!(process.env.RESEND_API_KEY && (process.env.MAIL_FROM ?? "").trim()),
  };

  const warnings: string[] = [];
  if (!declared) {
    warnings.push(
      `RESCRIPT_ENV is not set, so this instance is assumed to be ${tier}. Declare it, so a staging copy cannot be mistaken for production.`,
    );
  }
  if (!configured.database || !configured.serviceKey) {
    warnings.push("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not both set — every database read will fail with a 503.");
  }
  if (!configured.anonKey) {
    warnings.push("SUPABASE_ANON_KEY is not set, so sign-in falls back to the service key. Set it: the anon key is the only one that belongs in a password exchange.");
  }
  if (!configured.runtimeUrl) {
    warnings.push(`NEXT_PUBLIC_RUNTIME_URL is not set, so respondent links point at ${runtimeUrl} — correct on a laptop, wrong anywhere else.`);
  }
  if (!configured.studioUrl && tier !== "development") {
    warnings.push("STUDIO_PUBLIC_URL is not set, so password-reset and invitation links come out relative and unusable in an email.");
  }
  if (!configured.authSalt) {
    warnings.push("AUTH_HASH_SALT is not set, so throttling hashes use a default salt shared with every other unconfigured instance.");
  }
  if (!configured.mail) {
    warnings.push("No mail is configured (RESEND_API_KEY and MAIL_FROM), so password resets cannot be delivered and invitations fall back to handing you a link to send by hand.");
  }
  /*
   * Configured, and unable to reach anybody — the state a staging instance
   * SHOULD be in, but worth saying out loud so nobody spends an afternoon
   * wondering why a test never arrives.
   */
  if (configured.mail && tier !== "production" && !(process.env.MAIL_DEV_REDIRECT ?? "").trim()) {
    warnings.push(`Mail is configured but this is the ${tier} platform, so nothing is delivered. Set MAIL_DEV_REDIRECT to your own address to receive it instead.`);
  }
  if (configured.mail && !(process.env.MAIL_FROM_INVITATIONS ?? "").trim()) {
    warnings.push("MAIL_FROM_INVITATIONS is not set, so respondent invitations send from the same address as password resets. A survey wave that lands in spam folders can then take your password-reset delivery down with it.");
  }
  if (tier === "production" && (process.env.RESCRIPT_DIAGNOSTICS ?? "") === "1") {
    warnings.push("RESCRIPT_DIAGNOSTICS=1 in production: per-project diagnostics are readable by every project member, not only platform admins.");
  }

  return {
    tier,
    declared,
    database,
    runtimeUrl,
    studioUrl,
    release:
      (process.env.RESCRIPT_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "").trim().slice(0, 12) || null,
    node: process.version,
    configured,
    warnings,
  };
}

/**
 * What the CLIENT is allowed to know, for the banner.
 *
 * A tier and a database reference, and only when the instance is not
 * production: the point of the banner is to stop somebody mistaking a
 * non-production copy for the real one, and a permanent badge on the real one
 * would be noise that everybody learns to ignore — which is how a banner
 * stops working. The warnings and the configuration state stay behind the
 * platform route's gate.
 */
export function platformBadge(): { tier: PlatformTier; database: string | null } | null {
  const { tier } = platformTier();
  if (tier === "production") return null;
  return { tier, database: projectRef(process.env.SUPABASE_URL) };
}
