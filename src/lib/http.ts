import { env } from "./env";

type HeaderReader = { get(name: string): string | null };

/**
 * Best-effort client IP from `x-forwarded-for`.
 * Behind N trusted proxies (TRUSTED_PROXY_HOPS, Cloud Run = 1) the real client is the Nth entry from
 * the RIGHT - anything further left is client-controlled and spoofable. With TRUSTED_PROXY_HOPS=0 (nothing in front
 * of the app) server.mjs replaces the header with the socket address, so it is never client-controlled.
 * `x-real-ip` is NOT used: no proxy we deploy behind sets it, so it would be whatever the client sent.
 */
export function getClientIp(headers: HeaderReader): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) {
      const hops = Math.max(1, env.TRUSTED_PROXY_HOPS);
      return parts[Math.max(0, parts.length - hops)];
    }
  }
  return "unknown";
}

/**
 * Origin check for cookie-authenticated route handlers (server actions are already same-origin).
 * Returns true for safe methods, or when Origin/Referer host matches the request Host / APP_URL.
 * Requests with neither header (curl, server-to-server) are allowed only when `allowMissing` is true.
 */
export function isSameOrigin(req: Request, opts: { allowMissing?: boolean } = {}): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const origin = req.headers.get("origin") ?? req.headers.get("referer");
  if (!origin) return opts.allowMissing ?? false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = new Set<string>();
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) allowed.add(host);
  try {
    allowed.add(new URL(env.APP_URL).host);
  } catch {
    /* ignore */
  }
  return allowed.has(originHost);
}

/** Returns a 403 Response when the origin check fails, else null. */
export function assertSameOrigin(req: Request, opts: { allowMissing?: boolean } = {}): Response | null {
  if (isSameOrigin(req, opts)) return null;
  return Response.json({ error: { code: "bad_origin", message: "Cross-origin request blocked" } }, { status: 403 });
}

/** Only allow same-site relative redirect targets (prevents open redirects via ?next=). */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next) return fallback;
  // control characters are dropped by URL parsers: "/\t/evil.com" would become "//evil.com"
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\u0000-\u001f\u007f]/.test(next)) return fallback;
  try {
    const base = new URL("http://app.invalid");
    const u = new URL(next, base);
    if (u.origin !== base.origin) return fallback;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return fallback;
  }
}
