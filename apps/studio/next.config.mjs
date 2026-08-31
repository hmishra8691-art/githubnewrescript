/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rescript/schema", "@rescript/engine", "@rescript/designs", "@rescript/exporters"],
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
