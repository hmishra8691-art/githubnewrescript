/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rescript/schema", "@rescript/engine", "@rescript/renderer", "@rescript/ai"],
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
