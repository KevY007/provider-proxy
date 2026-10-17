import { hash, verify } from "@node-rs/argon2";

/** Argon2id (OWASP-recommended parameters). */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** Constant-ish time verify; returns false on malformed hashes instead of throwing. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;
/** Verify against a throwaway hash so unknown-email logins take as long as real ones (anti-enumeration). */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword("providerproxy-dummy-password");
  await verifyPassword(await dummy, password);
}
