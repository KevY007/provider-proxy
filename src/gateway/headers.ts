/**
 * Faithful header passthrough (PLAN 9d.3). A response header of the upstream reaches the client only when it is on
 * this allow-list; everything else (hop-by-hop, encoding, cookies, server banners, org / project ids, CDN ids...) is
 * dropped so nothing identifies our accounts and nothing the transport layer owns (length, encoding, connection) is
 * ever copied. Request ids are RENAMED to `x-upstream-request-id`.
 */
export interface HeaderSource {
  get(name: string): string | null;
  forEach(cb: (value: string, key: string) => void): void;
}

/** retry-after + every rate-limit family (OpenAI x-ratelimit-*, Anthropic anthropic-ratelimit-*, IETF ratelimit-*). */
const RATE_LIMIT = /^(retry-after|retry-after-ms|x-ratelimit-.+|anthropic-ratelimit-.+|ratelimit-.+|x-should-retry)$/i;
/** Media downloads keep range / length semantics so players and resumable downloaders keep working. */
const MEDIA = /^(content-disposition|content-range|accept-ranges|etag|last-modified|content-language)$/i;
/** Gemini resumable upload protocol (x-goog-upload-url is rewritten by the files layer, never copied here). */
const UPLOAD = /^x-goog-upload-(?!url$).+$/i;
const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "x-amzn-requestid", "anthropic-request-id"] as const;

export interface ForwardOptions {
  /** Forward retry-after / rate-limit headers (settings.passUpstreamRateLimits). */
  rateLimits: boolean;
  /** Download semantics (content-range, accept-ranges, etag ...). */
  media?: boolean;
  /** Gemini resumable-upload status headers. */
  upload?: boolean;
}

/** The upstream's request id, if it sent one. */
export function upstreamRequestId(src: HeaderSource): string | null {
  for (const n of REQUEST_ID_HEADERS) {
    const v = src.get(n);
    if (v) return v.slice(0, 200);
  }
  return null;
}

/** Allow-listed upstream headers as a plain object (keys lower-case). */
export function pickForwardHeaders(src: HeaderSource, o: ForwardOptions): Record<string, string> {
  const out: Record<string, string> = {};
  src.forEach((v, k) => {
    const key = k.toLowerCase();
    if (o.rateLimits && RATE_LIMIT.test(key)) out[key] = v;
    else if (o.media && MEDIA.test(key)) out[key] = v;
    else if (o.upload && UPLOAD.test(key)) out[key] = v;
  });
  const rid = upstreamRequestId(src);
  if (rid) out["x-upstream-request-id"] = rid;
  return out;
}

/** Copy the allow-listed upstream headers into `dst` (never overwrites a header that is already set). */
export function forwardUpstreamHeaders(src: HeaderSource, dst: Headers, o: ForwardOptions): void {
  for (const [k, v] of Object.entries(pickForwardHeaders(src, o))) if (!dst.has(k)) dst.set(k, v);
}
