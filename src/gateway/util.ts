import { createId } from "@paralleldrive/cuid2";
import type { Json, JsonObject } from "./types";

export const newId = (): string => createId();

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function safeJsonParse<T = Json>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Short, log-safe description of a fetch/network error (includes the undici cause code). */
export function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return `${err.message}${cause?.code ? ` (${cause.code})` : ""}`.slice(0, 300);
  }
  return String(err).slice(0, 300);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "...[truncated]" : s;
}

export function clampInt(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

export function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Number coercion for upstream-reported counters (never NaN/negative). */
export function nn(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Deep-merge `overrides` into `target` (mutates + returns target). Plain objects merge recursively,
 * arrays/primitives replace, and a `null` override value DELETES the field (PLAN 9b paramOverrides).
 */
export function deepMerge(target: JsonObject, overrides: unknown): JsonObject {
  if (!isObject(overrides)) return target;
  for (const [k, v] of Object.entries(overrides)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    if (v === null) {
      delete target[k];
    } else if (isObject(v)) {
      const cur = target[k];
      if (isObject(cur)) deepMerge(cur, v);
      else target[k] = deepMerge({}, v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/**
 * Weighted random permutation (Efraimidis-Spirakis): items with higher weight tend to come first,
 * but every item appears exactly once. `rand` is injectable for deterministic tests.
 */
export function weightedShuffle<T>(items: readonly T[], weightOf: (t: T) => number, rand: () => number = Math.random): T[] {
  if (items.length <= 1) return items.slice();
  return items
    .map((item) => {
      const w = Math.max(0.0001, weightOf(item));
      return { item, key: Math.pow(Math.max(rand(), 1e-12), 1 / w) };
    })
    .sort((a, b) => b.key - a.key)
    .map((x) => x.item);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Visit every string in a JSON value (depth-limited). */
export function walkStrings(v: unknown, fn: (s: string, key: string | null) => void, depth = 0, key: string | null = null): void {
  if (depth > 40) return;
  if (typeof v === "string") fn(v, key);
  else if (Array.isArray(v)) for (const x of v) walkStrings(x, fn, depth + 1, key);
  else if (isObject(v)) for (const [k, x] of Object.entries(v)) walkStrings(x, fn, depth + 1, k);
}
