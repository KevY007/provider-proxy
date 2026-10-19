import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { env, isProd } from "./env";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let cachedKey: Buffer | null = null;
let warned = false;

/** 32-byte AES key from ENCRYPTION_KEY (base64). Dev falls back to a fixed insecure key with a warning. */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = env.ENCRYPTION_KEY;
  if (raw) {
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== 32) {
      throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)");
    }
    cachedKey = buf;
    return buf;
  }
  if (isProd) throw new Error("ENCRYPTION_KEY is required in production");
  if (!warned) {
    warned = true;
    console.warn("[crypto] ENCRYPTION_KEY not set - using an insecure dev key");
  }
  cachedKey = createHash("sha256").update("providerproxy-dev-insecure-key").digest();
  return cachedKey;
}

function getSessionSecret(): string {
  const s = env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (isProd) throw new Error("SESSION_SECRET (32+ chars) is required in production");
  return "providerproxy-dev-insecure-session-secret!!";
}

/** AES-256-GCM encrypt. Output format: `v1:<iv b64>:<tag b64>:<ciphertext b64>`. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Inverse of {@link encrypt}. Throws if the payload was tampered with or the key is wrong. */
export function decrypt(payload: string): string {
  const [v, iv, tag, ct] = payload.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Invalid encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

/** Hex sha256. */
export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** HMAC-SHA256 (hex) keyed with SESSION_SECRET. */
export function hmac(input: string): string {
  return createHmac("sha256", getSessionSecret()).update(input).digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Random URL-safe token (default 32 bytes => 43 chars). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Random base62 string of `length` characters (uniform, no modulo bias). */
export function randomBase62(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[randomInt(0, 62)];
  return out;
}

export const API_KEY_PREFIX = "sk-pp-";

/**
 * Generate a customer API key: `sk-pp-` + 40 base62 chars.
 * `prefix` (first 12 chars) is safe to display; `hash` (sha256 hex of the full key) is what's stored.
 */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = API_KEY_PREFIX + randomBase62(40);
  return { key, prefix: key.slice(0, 12), hash: sha256(key) };
}

/** Hash a presented API key for lookup. */
export function hashApiKey(key: string): string {
  return sha256(key);
}

/** Last-4 hint for display of upstream secrets. */
export function secretHint(secret: string): string {
  return secret.slice(-4);
}
