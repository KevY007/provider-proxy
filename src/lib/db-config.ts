import tls from "node:tls";
import type { PoolConfig } from "pg";

/**
 * pg pool settings from DATABASE_URL (+ optional CA certificate). Pure, so it is unit-tested.
 *
 * Supabase (and other hosted Postgres) specifics:
 *  - TLS: `pg` treats `sslmode=require` as full verification against the system CAs, and Supabase signs its server
 *    certificates with its own CA. Set DATABASE_CA_CERT to that CA (Supabase dashboard > Database settings > SSL
 *    Configuration > Download certificate; PEM text or base64 of it): the connection is then encrypted and the
 *    server must present a certificate issued by that CA for the host name in the URL. Without DATABASE_CA_CERT the
 *    URL's own ssl* parameters apply unchanged (local Postgres, Cloud SQL sockets, `sslmode=no-verify`...).
 *  - `?schema=name` puts every table in that schema (e.g. a dedicated schema inside an existing Supabase project).
 *    The parameter is removed from the URL handed to pg and passed to the Prisma adapter instead, and every new
 *    connection runs `SET search_path` to it (the hand-written SQL in analytics / maintenance uses unqualified table
 *    names; a plain query works through any pooler, unlike a startup option). Needs a direct or session-pooler
 *    connection (Supabase port 5432), not the transaction pooler.
 */
export interface DbConnection {
  pool: PoolConfig;
  schema?: string;
}

const SSL_PARAMS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat", "ssl"];

/** PEM text as is, or base64 of it (secrets are easier to store as one line). */
export function decodeCaCert(raw: string): string {
  const s = raw.trim();
  if (s.includes("-----BEGIN")) return s.replace(/\\n/g, "\n");
  const decoded = Buffer.from(s, "base64").toString("utf8");
  if (!decoded.includes("-----BEGIN CERTIFICATE-----")) throw new Error("DATABASE_CA_CERT is neither a PEM certificate nor base64 of one");
  return decoded;
}

export function dbConnection(url: string, caCert?: string, extra: Omit<PoolConfig, "connectionString" | "ssl"> = {}): DbConnection {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { pool: { ...extra, connectionString: url } };
  }
  // nothing to change: hand the URL over byte for byte (re-serialising would re-encode e.g. ?host=/cloudsql/...)
  if (!caCert && !u.searchParams.has("schema")) return { pool: { ...extra, connectionString: url } };
  const schema = u.searchParams.get("schema")?.trim() || undefined;
  if (schema && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error("DATABASE_URL schema must be a plain identifier");
  u.searchParams.delete("schema");
  const base: PoolConfig = { ...extra };
  if (!caCert) return { pool: { ...base, connectionString: u.toString() }, schema };
  // connection-string ssl parameters would override the ssl object below, so they go
  for (const p of SSL_PARAMS) u.searchParams.delete(p);
  return {
    pool: {
      ...base,
      connectionString: u.toString(),
      // full verification (libpq "verify-full"): chain up to that CA and the host name (Supabase documents
      // verify-full with its CA for both the pooler and the direct host)
      // the public roots stay trusted too, so it works whether the endpoint (direct host or pooler) presents a
      // certificate from the provider's CA or from a public CA
      ssl: { ca: [...tls.rootCertificates, decodeCaCert(caCert)], rejectUnauthorized: true },
    },
    schema,
  };
}
