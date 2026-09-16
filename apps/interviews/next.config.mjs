/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rescript/interviews", "@rescript/storage", "@rescript/access", "@rescript/billing", "@rescript/ai"],
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
