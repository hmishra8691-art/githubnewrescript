/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rescript/schema", "@rescript/engine", "@rescript/designs", "@rescript/exporters", "@rescript/templates", "@rescript/analytics"],
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
