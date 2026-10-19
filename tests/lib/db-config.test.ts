/** Postgres connection settings for Supabase-style hosts: private CA, ?schema=, untouched local URLs. */
import { describe, expect, it } from "vitest";
import { dbConnection, decodeCaCert } from "@/lib/db-config";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBdummy\n-----END CERTIFICATE-----";

describe("dbConnection", () => {
  it("leaves a plain URL alone (local, Cloud SQL socket, no-verify)", () => {
    const url = "postgresql://u:p@localhost:5433/proxy";
    expect(dbConnection(url).pool).toEqual({ connectionString: url });
    const sock = "postgresql://u:p@localhost/proxy?host=/cloudsql/p:r:i";
    expect(dbConnection(sock, undefined, { max: 5 }).pool).toEqual({ connectionString: sock, max: 5 });
  });

  it("with a CA: drops the URL's ssl parameters and verifies against that CA", () => {
    const c = dbConnection("postgresql://u:p@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true", PEM, { max: 10 });
    expect(c.pool.connectionString).toBe("postgresql://u:p@aws-0-us-west-2.pooler.supabase.com:5432/postgres");
    expect(c.pool.max).toBe(10);
    const ssl = c.pool.ssl as { ca: string[]; rejectUnauthorized: boolean; checkServerIdentity?: unknown };
    expect(ssl.ca).toContain(PEM); // the provider's CA ...
    expect(ssl.ca.length).toBeGreaterThan(100); // ... on top of the public roots
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.checkServerIdentity).toBeUndefined(); // host name checked too
  });

  it("CA as base64 or with escaped newlines", () => {
    expect(decodeCaCert(Buffer.from(PEM).toString("base64"))).toBe(PEM);
    expect(decodeCaCert(PEM.replace(/\n/g, "\\n"))).toBe(PEM);
    expect(() => decodeCaCert("bm90IGEgY2VydA==")).toThrow(/neither a PEM/);
  });

  it("?schema= goes to the adapter (and the per-connection search_path), not to pg", () => {
    const c = dbConnection("postgresql://u:p@h:5432/postgres?schema=providerproxy&sslmode=require", PEM);
    expect(c.schema).toBe("providerproxy");
    expect(c.pool.options).toBeUndefined(); // no startup option (poolers may drop it); db.ts SETs it per connection
    expect(c.pool.connectionString).toBe("postgresql://u:p@h:5432/postgres");
    expect(() => dbConnection("postgresql://u:p@h/db?schema=a;drop")).toThrow(/identifier/);
  });
});
