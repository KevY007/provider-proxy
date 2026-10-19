import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PrismaClient } from "@/generated/prisma/client";
import { dbConnection } from "./db-config";
import { env } from "./env";

/**
 * Singleton Prisma client (driver adapter: pg). Pool size from DB_POOL_SIZE (default 20).
 * DATABASE_URL: any Postgres URL - Supabase (pooler, with DATABASE_CA_CERT), local, or a Cloud SQL unix socket
 * (postgresql://u:p@localhost/proxy?host=/cloudsql/PROJECT:REGION:INSTANCE). `?schema=` selects a schema.
 *
 * Import: `import { db } from "@/lib/db"`; types/enums/Prisma namespace from "@/generated/prisma/client".
 */
function createClient() {
  const conn = dbConnection(env.DATABASE_URL, env.DATABASE_CA_CERT, {
    max: env.DB_POOL_SIZE,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // TCP keep-alive: idle pooled connections survive NAT / pooler idle cuts instead of failing on next use
    keepAlive: true,
  });
  const pool = new pg.Pool(conn.pool);
  const schema = conn.schema;
  // queued before anything else on a fresh connection (pg runs a client's queries in order)
  if (schema) pool.on("connect", (client) => void client.query(`SET search_path TO "${schema}"`).catch(() => undefined));
  const adapter = new PrismaPg(pool, schema ? { schema } : undefined);
  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

export const db: PrismaClient = globalForPrisma.__prisma ?? createClient();
if (env.NODE_ENV !== "production") globalForPrisma.__prisma = db;

export type Db = typeof db;
