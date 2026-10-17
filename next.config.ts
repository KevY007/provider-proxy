import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Lets several dev servers run side by side from one checkout (NEXT_DIST_DIR=.next-foo).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  // Never gzip responses: compression buffers/corrupts SSE streams and large API bodies (PLAN §9d).
  compress: false,
  serverExternalPackages: [
    "pg",
    "@node-rs/argon2",
    "ioredis",
    "nodemailer",
    "undici",
    "js-tiktoken",
  ],
  experimental: {
    serverActions: { bodySizeLimit: "5mb" },
  },
};

export default nextConfig;
