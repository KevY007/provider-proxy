import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
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
