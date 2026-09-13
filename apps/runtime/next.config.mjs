/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rescript/schema", "@rescript/engine", "@rescript/renderer", "@rescript/ai", "@rescript/media"],
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
