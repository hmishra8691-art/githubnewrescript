/** @type {import('next').NextConfig} */
const nextConfig = {
  /*
   * The story-report renderer's native pieces stay outside the server bundle:
   * resvg's platform binding (a .node file webpack cannot parse) and the
   * ffmpeg binary's path. They are required from node_modules at run time —
   * listed here as well as in serverComponentsExternalPackages because they
   * are imported through a workspace package, which that list does not reach.
   */
  webpack: (config, { isServer }) => {
    if (isServer) config.externals = [...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)), { "@resvg/resvg-js": "commonjs @resvg/resvg-js", "ffmpeg-static": "commonjs ffmpeg-static" }];
    return config;
  },
  transpilePackages: ["@rescript/schema", "@rescript/engine", "@rescript/designs", "@rescript/exporters", "@rescript/import", "@rescript/templates", "@rescript/analytics", "@rescript/renderer", "@rescript/mail", "@rescript/ai", "@rescript/media"],
  eslint: { ignoreDuringBuilds: true },
  // The UI typeface is a plain <link> with a system fallback (see app/layout.tsx);
  // build-time font inlining would make the build depend on the font host.
  optimizeFonts: false,
  /*
   * WHY THIS APP CAN BUILD SOMEWHERE OTHER THAN `.next`.
   *
   * `scripts/p0-cookie-test.mjs` proves the session gate on the wire, which
   * needs a PRODUCTION build of this app (`next start`) while the ordinary dev
   * server is usually running on the same working tree. Both default to
   * `.next`: the production build overwrites the dev server's chunks, and the
   * dev server then serves 404s for its own assets — a failure that looks
   * exactly like a broken application and costs an hour to recognise.
   *
   * Honouring NEXT_DIST_DIR lets that one suite build and start in a
   * directory of its own and leave `.next` untouched. Unset — which is every
   * normal `dev`, `build` and deployment — this is Next's own default.
   */
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  /* the public documentation pages are read from disk at request time (Phase 7): a traced deploy must carry them */
  experimental: {
    /* the story-report renderer: native modules and a binary, loaded from node_modules at run time, never bundled */
    serverComponentsExternalPackages: ["@resvg/resvg-js", "ffmpeg-static"],
    outputFileTracingIncludes: {
      "/api/surveys/*/stories/**": ["./public/report-fonts/**", "./node_modules/ffmpeg-static/ffmpeg", "../../node_modules/.pnpm/ffmpeg-static@5.2.0/node_modules/ffmpeg-static/ffmpeg", "../../node_modules/.pnpm/@resvg+resvg-js-*/node_modules/@resvg/**"],
      "/api/cron/story-renders": ["./public/report-fonts/**", "./node_modules/ffmpeg-static/ffmpeg", "../../node_modules/.pnpm/ffmpeg-static@5.2.0/node_modules/ffmpeg-static/ffmpeg", "../../node_modules/.pnpm/@resvg+resvg-js-*/node_modules/@resvg/**"],
      "/docs": ["./content/docs/**"], "/docs/[slug]": ["./content/docs/**"], "/llms.txt": ["./content/docs/**"], "/llms-full.txt": ["./content/docs/**"], "/sitemap.xml": ["./content/docs/**"],
    },
  },
};
export default nextConfig;
