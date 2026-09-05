/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rescript/schema", "@rescript/engine", "@rescript/designs", "@rescript/exporters", "@rescript/templates"],
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
