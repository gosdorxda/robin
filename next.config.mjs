/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next 15+: `experimental.serverComponentsExternalPackages` → top-level `serverExternalPackages`.
  serverExternalPackages: [
    "node-cron",
    "@coral-xyz/anchor-31",
    "axios",
    // Prisma: keep the runtime + generated client external so webpack does not bundle
    // them. Bundling breaks the dynamic require to the generated query engine
    // (node_modules/.prisma/client) and surfaces at server start as
    // "@prisma/client did not initialize yet. Please run prisma generate".
    // In Next 16 this applies to server-side code incl. the instrumentation hook
    // (scheduler -> engine -> prisma).
    "@prisma/client",
    ".prisma/client",
  ],
  // Nav consolidation: /live merged into the homepage (5s polling), /holders
  // merged into /eligibility (Holders tab), /winners merged into /draws (winner
  // lists now live on each round card). Redirect old routes so bookmarks work.
  async redirects() {
    return [
      { source: "/live", destination: "/", permanent: true },
      { source: "/holders", destination: "/eligibility", permanent: true },
      { source: "/winners", destination: "/draws", permanent: true },
    ];
  },
  // Next 15+: `experimental.instrumentationHook` is stable & auto-detected (src/instrumentation.ts).
  // Next 16 removed the `eslint` next-config key (lint is no longer part of `next build`).
  // Next 16 defaults to Turbopack; this project keeps a webpack config for the Buffer polyfill +
  // node-builtin fallbacks that @solana/web3.js needs, so dev/build run with `--webpack`
  // (see package.json scripts) until that polyfill is migrated to Turbopack.
  webpack: (config, { webpack, isServer }) => {
    // Provide Buffer globally (required by @solana/web3.js + wallet adapter in the browser)
    config.plugins.push(
      new webpack.ProvidePlugin({
        Buffer: ["buffer", "Buffer"],
      })
    );

    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        bufferutil: false,
        "utf-8-validate": false,
      };
    }

    return config;
  },
};

export default nextConfig;
