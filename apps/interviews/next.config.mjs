/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rescript/interviews", "@rescript/storage", "@rescript/access", "@rescript/billing", "@rescript/ai"],
  eslint: { ignoreDuringBuilds: true },
  /*
   * The same allowance `apps/studio/next.config.mjs` makes, for the same
   * reason: `scripts/auth-handoff-test.mjs` needs a PRODUCTION build of this
   * app and of the Studio, started together, while a dev server is usually
   * running on the same tree. Both default to `.next`, so the production build
   * would overwrite the dev server's chunks and that server would then serve
   * 404s for its own assets — a failure that looks like a broken application
   * rather than a test treading on something.
   *
   * Unset, which is every ordinary `dev`, `build` and deployment, this is
   * Next's own default.
   */
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};
export default nextConfig;
