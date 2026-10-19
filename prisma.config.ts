import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Migrations need a session (not transaction-pooled) connection: DIRECT_URL when set (Supabase: the direct or
    // session-pooler URL), else DATABASE_URL. `prisma generate` must work without a database (Docker build, CI).
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || "postgresql://proxy:proxy@localhost:5433/proxy",
  },
});
