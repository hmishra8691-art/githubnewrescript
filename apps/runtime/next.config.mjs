/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@rescript/schema", "@rescript/engine", "@rescript/renderer"],
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
