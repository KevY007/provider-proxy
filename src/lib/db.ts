import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "./env";

/**
 * Singleton Prisma client (driver adapter: pg). Pool size from DB_POOL_SIZE (default 20).
 * Works with Cloud SQL unix sockets: postgresql://u:p@localhost/proxy?host=/cloudsql/PROJECT:REGION:INSTANCE
 *
 * Import: `import { db } from "@/lib/db"`; types/enums/Prisma namespace from "@/generated/prisma/client".
 */
function createClient() {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_SIZE,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const db: PrismaClient = globalForPrisma.__prisma ?? createClient();
if (env.NODE_ENV !== "production") globalForPrisma.__prisma = db;

export type Db = typeof db;
