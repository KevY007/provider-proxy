/** Pure time-bucket helpers for analytics series (UTC). */
export type Granularity = "hour" | "day";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export function bucketMs(g: Granularity): number {
  return g === "hour" ? HOUR : DAY;
}

/** Floor a date to the start of its UTC hour/day. */
export function floorBucket(d: Date, g: Granularity): Date {
  const ms = bucketMs(g);
  return new Date(Math.floor(d.getTime() / ms) * ms);
}

/** Every bucket start between from..to inclusive. Capped to avoid pathological ranges. */
export function bucketStarts(from: Date, to: Date, g: Granularity, cap = 800): Date[] {
  const out: Date[] = [];
  const ms = bucketMs(g);
  let t = floorBucket(from, g).getTime();
  const end = to.getTime();
  while (t <= end && out.length < cap) {
    out.push(new Date(t));
    t += ms;
  }
  return out;
}

/** Hour granularity is only allowed for ranges up to 14 days (<= 336 buckets); otherwise falls back to day. */
export function clampGranularity(requested: Granularity | undefined, from: Date, to: Date): Granularity {
  const span = to.getTime() - from.getTime();
  const auto: Granularity = span <= 3 * DAY ? "hour" : "day";
  const g = requested ?? auto;
  return g === "hour" && span > 14 * DAY ? "day" : g;
}

/** Merge sparse rows (keyed by bucket start) into a dense series with zeros for empty buckets. */
export function fillSeries<T extends { bucket: Date }>(rows: T[], from: Date, to: Date, g: Granularity, zero: (bucket: Date) => T): T[] {
  const map = new Map(rows.map((r) => [floorBucket(r.bucket, g).getTime(), r]));
  return bucketStarts(from, to, g).map((b) => map.get(b.getTime()) ?? zero(b));
}
