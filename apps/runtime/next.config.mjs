/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rescript/schema", "@rescript/engine"],
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
