/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rescript/schema", "@rescript/engine", "@rescript/designs", "@rescript/exporters", "@rescript/templates", "@rescript/analytics"],
  eslint: { ignoreDuringBuilds: true },
  // The UI typeface is a plain <link> with a system fallback (see app/layout.tsx);
  // build-time font inlining would make the build depend on the font host.
  optimizeFonts: false,
};
export default nextConfig;
