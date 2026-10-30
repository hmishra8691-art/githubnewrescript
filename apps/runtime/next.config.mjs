/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rescript/schema", "@rescript/engine", "@rescript/renderer", "@rescript/ai", "@rescript/media"],
  eslint: { ignoreDuringBuilds: true },
  /*
   * S1b: RUNTIME_LEGACY_SCRIPTS=main runs Scripts-panel logic scripts on the respondent's page again (the pre-S1b
   * main-thread runner) instead of in the sandboxed frame. A temporary escape hatch for one release; read when the
   * runtime is built (or the dev server started) and inlined into the client bundle. Default: off (sandboxed).
   */
  env: { RUNTIME_LEGACY_SCRIPTS: process.env.RUNTIME_LEGACY_SCRIPTS ?? "" },
};
export default nextConfig;
