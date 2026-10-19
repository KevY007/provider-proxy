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
  // Browser hardening for the app (dashboard, admin, site). The gateway (/v1, /v1beta, /upload) is a faithful API
  // proxy and gets nothing added (PLAN 9d).
  async headers() {
    return [
      {
        source: "/:path((?!v1/|v1$|v1beta/|v1beta$|upload/).*)",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
          ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
        ],
      },
    ];
  },
  experimental: {
    serverActions: { bodySizeLimit: "5mb" },
  },
};

export default nextConfig;
