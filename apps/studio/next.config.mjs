/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rescript/schema", "@rescript/engine", "@rescript/designs", "@rescript/exporters", "@rescript/templates", "@rescript/analytics", "@rescript/renderer", "@rescript/mail"],
  eslint: { ignoreDuringBuilds: true },
  // The UI typeface is a plain <link> with a system fallback (see app/layout.tsx);
  // build-time font inlining would make the build depend on the font host.
  optimizeFonts: false,
  /*
   * WHY THIS APP CAN BUILD SOMEWHERE OTHER THAN `.next`.
   *
   * `scripts/p0-cookie-test.mjs` proves the session gate on the wire, which
   * needs a PRODUCTION build of this app (`next start`) while the ordinary dev
   * server is usually running on the same working tree. Both default to
   * `.next`: the production build overwrites the dev server's chunks, and the
   * dev server then serves 404s for its own assets — a failure that looks
   * exactly like a broken application and costs an hour to recognise.
   *
   * Honouring NEXT_DIST_DIR lets that one suite build and start in a
   * directory of its own and leave `.next` untouched. Unset — which is every
   * normal `dev`, `build` and deployment — this is Next's own default.
   */
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};
export default nextConfig;
