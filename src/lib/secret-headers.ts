import { decrypt, encrypt } from "./crypto";

/**
 * Admin-configured upstream headers (`Provider.extraHeaders`, `ProviderKey.extra.headers`) may carry credentials.
 * Values of credential-like headers are stored encrypted (`enc:<payload>`), decrypted only when the gateway builds an
 * upstream request, and shown to admins as MASKED. Saving MASKED back keeps the stored value.
 */
export const MASKED = "[encrypted]";
const PREFIX = "enc:";

export function isSensitiveHeader(name: string): boolean {
  return /auth|key|token|secret|cookie|signature|password|credential/i.test(name);
}

type Headers = Record<string, unknown>;
const obj = (v: unknown): Headers => (v && typeof v === "object" && !Array.isArray(v) ? (v as Headers) : {});

/** Encrypt sensitive values for storage; MASKED keeps the previously stored value of that header. */
export function sealHeaders(input: unknown, previous?: unknown): Record<string, string> {
  const prev = obj(previous);
  const prevByLower = new Map(Object.entries(prev).map(([k, v]) => [k.toLowerCase(), v]));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(input))) {
    if (typeof v !== "string") continue;
    if (!isSensitiveHeader(k)) out[k] = v;
    else if (v === MASKED) {
      const old = prevByLower.get(k.toLowerCase());
      if (typeof old === "string") out[k] = old.startsWith(PREFIX) ? old : `${PREFIX}${encrypt(old)}`;
    } else out[k] = v.startsWith(PREFIX) ? v : `${PREFIX}${encrypt(v)}`;
  }
  return out;
}

/** Plain values for the upstream request (lower-cased names); undecryptable values are dropped. */
export function openHeaders(stored: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(stored))) {
    if (typeof v !== "string") continue;
    if (!v.startsWith(PREFIX)) out[k.toLowerCase()] = v;
    else {
      try {
        out[k.toLowerCase()] = decrypt(v.slice(PREFIX.length));
      } catch {
        /* key rotated / corrupt: never send garbage */
      }
    }
  }
  return out;
}

/** What admins see: sensitive values masked. */
export function maskHeaders(stored: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(stored))) if (typeof v === "string") out[k] = isSensitiveHeader(k) ? MASKED : v;
  return out;
}

/** The same for a key's `extra` JSON (only its `headers` member is affected). */
export function sealKeyExtra(input: unknown, previous?: unknown): Record<string, unknown> {
  const i = obj(input);
  if (!("headers" in i)) return i;
  return { ...i, headers: sealHeaders(i.headers, obj(previous).headers) };
}
export function maskKeyExtra(stored: unknown): Record<string, unknown> {
  const s = obj(stored);
  return "headers" in s ? { ...s, headers: maskHeaders(s.headers) } : s;
}
