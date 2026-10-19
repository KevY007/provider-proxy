import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for URLs that come back from an upstream (fal / Replicate result files, video CDN links, redirects):
 * customers steer what those vendors return (`extra_input`), so the gateway must never fetch an address inside our own
 * network for them. Loopback, private, link-local (cloud metadata), CGNAT, unique-local and unspecified addresses are
 * refused - except on the provider's own host (a self-hosted / mock upstream legitimately lives on a private address).
 */
export class BlockedUrlError extends Error {
  constructor(readonly url: string) {
    super("refusing to fetch a URL that resolves to a private or reserved address");
    this.name = "BlockedUrlError";
  }
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]);
    return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || /^fe[89ab]/.test(x) || x.startsWith("ff");
  }
  return true;
}

/** Throws BlockedUrlError unless `url` is http(s) and every address its host resolves to is public (or it is `allowHost`). */
export async function assertPublicUrl(url: string, allowHosts: Array<string | null | undefined> = []): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BlockedUrlError(url);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedUrlError(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (allowHosts.some((h) => h && h.toLowerCase() === host.toLowerCase())) return;
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new BlockedUrlError(url);
}

export function hostOf(url: string | null | undefined): string | null {
  try {
    return url ? new URL(url).hostname.replace(/^\[|\]$/g, "") : null;
  } catch {
    return null;
  }
}
