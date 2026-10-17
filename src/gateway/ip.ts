/** Minimal IPv4/IPv6 + CIDR allowlist matching (no deps). */

function parseV4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i]);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n;
}

function parseV6(input: string): bigint | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  // embedded IPv4 tail
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (tail) {
    const v4 = parseV4(tail[1]);
    if (v4 === null) return null;
    s = s.slice(0, s.length - tail[1].length) + ((v4 >>> 16) & 0xffff).toString(16) + ":" + (v4 & 0xffff).toString(16);
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(":") : [];
  const rest = dbl.length === 2 && dbl[1] ? dbl[1].split(":") : [];
  let groups: string[];
  if (dbl.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill("0"), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let n = BigInt(0);
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n = (n << BigInt(16)) | BigInt(parseInt(g, 16));
  }
  return n;
}

interface Parsed {
  v: 4 | 6;
  n: bigint;
}

function parseIp(ip: string): Parsed | null {
  const t = ip.trim();
  if (t.includes(":")) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(t);
    if (mapped) {
      const v4 = parseV4(mapped[1]);
      return v4 === null ? null : { v: 4, n: BigInt(v4) };
    }
    const n = parseV6(t);
    return n === null ? null : { v: 6, n };
  }
  const v4 = parseV4(t);
  return v4 === null ? null : { v: 4, n: BigInt(v4) };
}

/** True when `ip` matches any exact IP or CIDR in `list`. An empty list allows everything. */
export function ipAllowed(ip: string, list: readonly string[]): boolean {
  if (!list.length) return true;
  const target = parseIp(ip);
  if (!target) return false;
  for (const raw of list) {
    const entry = raw.trim();
    if (!entry) continue;
    const [addr, bitsStr] = entry.split("/");
    const net = parseIp(addr);
    if (!net || net.v !== target.v) continue;
    const total = net.v === 4 ? 32 : 128;
    const bits = bitsStr === undefined ? total : Number(bitsStr);
    if (!Number.isInteger(bits) || bits < 0 || bits > total) continue;
    const shift = BigInt(total - bits);
    if (net.n >> shift === target.n >> shift) return true;
  }
  return false;
}
