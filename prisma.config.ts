import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // `prisma generate` must work without a database (Docker build, CI), so fall back to a placeholder.
    url: process.env.DATABASE_URL ?? "postgresql://proxy:proxy@localhost:5433/proxy",
  },
});
