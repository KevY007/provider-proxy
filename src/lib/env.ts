import { z } from "zod";

/**
 * Zod-validated environment. Every value is optional/defaulted so the app can boot in dev and so
 * `next build` / `prisma generate` work without secrets. Security-critical values (SESSION_SECRET,
 * ENCRYPTION_KEY) are enforced lazily where they are used (see lib/crypto.ts) and fail hard in production.
 *
 * Empty strings are treated as "unset" (so `REDIS_URL=` in .env disables Redis).
 */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optStr = z.preprocess(blank, z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.preprocess(
    blank,
    z.string().default("postgresql://proxy:proxy@localhost:5433/proxy"),
  ),
  /** CA certificate of the database server (PEM or base64 of it), e.g. Supabase's. See lib/db-config.ts. */
  DATABASE_CA_CERT: optStr,
  DB_POOL_SIZE: z.preprocess(blank, z.coerce.number().int().min(1).max(500).default(20)),
  REDIS_URL: optStr,
  APP_URL: z.preprocess(blank, z.string().default("http://localhost:3000")),
  SESSION_SECRET: optStr,
  ENCRYPTION_KEY: optStr,
  ADMIN_EMAIL: optStr,
  ADMIN_PASSWORD: optStr,
  STRIPE_SECRET_KEY: optStr,
  STRIPE_PUBLISHABLE_KEY: optStr,
  STRIPE_WEBHOOK_SECRET: optStr,
  SMTP_URL: optStr,
  EMAIL_FROM: z.preprocess(blank, z.string().default("ProviderProxy <no-reply@example.com>")),
  CRON_SECRET: optStr,
  MOCK_UPSTREAM_URL: z.preprocess(blank, z.string().default("http://localhost:4010")),
  /** Number of trusted reverse proxies in front of the app (Cloud Run = 1). Used by getClientIp. */
  TRUSTED_PROXY_HOPS: z.preprocess(blank, z.coerce.number().int().min(0).max(10).default(1)),
  LOG_LEVEL: z.preprocess(blank, z.enum(["debug", "info", "warn", "error"]).default("info")),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    console.error(JSON.stringify({ severity: "ERROR", message: `Invalid environment: ${msg}` }));
    // only local dev / tests may boot on defaults; anything else (production, or a typo like NODE_ENV=staging) fails
    const local = process.env.NODE_ENV === undefined || process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
    if (!local && process.env.NEXT_PHASE !== "phase-production-build") {
      throw new Error(`Invalid environment: ${msg}`);
    }
    return schema.parse({});
  }
  return parsed.data;
}

/** Validated environment (server-only). */
export const env: Env = load();

export const isProd = env.NODE_ENV === "production";
export const isDev = env.NODE_ENV !== "production";

/** Public base URL of the app without trailing slash. */
export const appUrl = env.APP_URL.replace(/\/+$/, "");
