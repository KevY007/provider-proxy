import type { ConfigSnapshot, GroupRec, ModelRec } from "./cache";
import type { InboundFormat, JsonObject } from "./types";

/**
 * Effort routing. A pool can send requests that ask for a high reasoning effort elsewhere, e.g. "GPT up to `high` on
 * the reseller, `xhigh` / `max` on the official provider": a reseller that caps generations at ~15 minutes cannot
 * finish the longest thinking runs.
 *
 * A matching rule swaps the request's pool for the target pool, so routing (its provider tags) AND billing (its
 * multiplier) are exactly the target pool's, and the request log records the pool and provider that really served it.
 * With a provider set the request only goes to that provider's routes (the pool's provider tags are not applied).
 * `capEffort` lowers a higher requested effort to that level (e.g. `max` -> `xhigh` for an upstream without `max`).
 */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
/** what a rule can tick: an effort, or "default" for requests that set none (the model's default effort) */
export const EFFORT_MATCHES = ["default", ...EFFORTS] as const;
export type EffortMatch = (typeof EFFORT_MATCHES)[number];

export interface EffortRoute {
  /** model slugs, `prefix*` globs allowed; empty = every model */
  models: string[];
  /** the efforts this rule applies to (ticked individually) */
  efforts: EffortMatch[];
  /** pool to route and bill as (null = keep the request's pool) */
  groupId: string | null;
  /** only this provider's routes (null = the pool's provider tags decide) */
  providerId: string | null;
  /** send at most this effort upstream (null = as requested) */
  capEffort: Effort | null;
}

// no runtime imports: the admin pool editor (a client component) uses EFFORTS too
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const rank = (e: string): number => EFFORTS.indexOf(e as Effort);

/** Validated rules out of the stored JSON (bad entries are dropped, never thrown on the hot path). */
export function parseEffortRoutes(raw: unknown): EffortRoute[] {
  if (!Array.isArray(raw)) return [];
  const out: EffortRoute[] = [];
  for (const r of raw) {
    if (!isObject(r)) continue;
    // `efforts` (ticked set); rules saved before it had `minEffort` = that effort and above
    const efforts = Array.isArray(r.efforts)
      ? EFFORT_MATCHES.filter((e) => (r.efforts as unknown[]).includes(e))
      : typeof r.minEffort === "string" && rank(r.minEffort) >= 0
        ? EFFORTS.filter((e) => rank(e) >= rank(r.minEffort as string))
        : [];
    if (!efforts.length) continue;
    const groupId = typeof r.groupId === "string" && r.groupId ? r.groupId : null;
    const providerId = typeof r.providerId === "string" && r.providerId ? r.providerId : null;
    if (!groupId && !providerId) continue;
    const models = Array.isArray(r.models) ? r.models.filter((m): m is string => typeof m === "string" && !!m.trim()).map((m) => m.trim()) : [];
    const capEffort = typeof r.capEffort === "string" && rank(r.capEffort) >= 0 ? (r.capEffort as Effort) : null;
    out.push({ models, efforts, groupId, providerId, capEffort });
  }
  return out;
}

/** The reasoning effort a request asks for, lower-cased; null when it does not set one (the model's default). */
export function requestEffort(format: InboundFormat, body: JsonObject | null | undefined): string | null {
  if (!body) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);
  switch (format) {
    case "openai_chat":
      return str(body.reasoning_effort) ?? (isObject(body.reasoning) ? str(body.reasoning.effort) : null);
    case "openai_responses":
      return isObject(body.reasoning) ? str(body.reasoning.effort) : null;
    case "anthropic_messages":
      return isObject(body.output_config) ? str(body.output_config.effort) : null;
    case "gemini": {
      const gc = isObject(body.generationConfig) ? body.generationConfig : null;
      const tc = gc && isObject(gc.thinkingConfig) ? gc.thinkingConfig : null;
      return tc ? str(tc.thinkingLevel) : null;
    }
    default:
      return null;
  }
}

/** A copy of `body` asking for `effort` instead (nested objects copied, the customer's body is not touched). */
export function withRequestEffort(format: InboundFormat, body: JsonObject, effort: Effort): JsonObject {
  const out: JsonObject = { ...body };
  switch (format) {
    case "openai_chat":
      if (typeof body.reasoning_effort === "string") out.reasoning_effort = effort;
      if (isObject(body.reasoning) && typeof body.reasoning.effort === "string") out.reasoning = { ...body.reasoning, effort };
      break;
    case "openai_responses":
      out.reasoning = { ...(isObject(body.reasoning) ? body.reasoning : {}), effort };
      break;
    case "anthropic_messages":
      out.output_config = { ...(isObject(body.output_config) ? body.output_config : {}), effort };
      break;
    case "gemini": {
      const gc = isObject(body.generationConfig) ? body.generationConfig : {};
      out.generationConfig = { ...gc, thinkingConfig: { ...(isObject(gc.thinkingConfig) ? gc.thinkingConfig : {}), thinkingLevel: effort } };
      break;
    }
  }
  return out;
}

function modelMatches(patterns: readonly string[], model: ModelRec): boolean {
  if (!patterns.length) return true;
  return patterns.some((p) => (p.endsWith("*") ? model.slug.startsWith(p.slice(0, -1)) : p === model.slug));
}

export interface EffortRouting {
  group: GroupRec;
  rule: EffortRoute;
  /** the requested effort ("default" when the request sets none) */
  effort: EffortMatch;
  /** the effort to send instead (the rule's cap is below the requested one), else null */
  sendEffort: Effort | null;
}

/**
 * The pool a request is served as after the pool's effort rules (first matching rule wins), or null for no change.
 * A rule whose target pool or provider no longer exists, or whose pool does not offer the model, is skipped.
 */
export function routeByEffort(snap: ConfigSnapshot, group: GroupRec | null, model: ModelRec, format: InboundFormat, body: JsonObject | null | undefined): EffortRouting | null {
  if (!group?.effortRoutes.length) return null;
  const asked = requestEffort(format, body);
  if (asked && rank(asked) < 0) return null; // a value we do not know: leave the request alone
  const effort: EffortMatch = (asked as Effort | null) ?? "default";
  for (const rule of group.effortRoutes) {
    if (!rule.efforts.includes(effort) || !modelMatches(rule.models, model)) continue;
    const target = rule.groupId ? snap.groupsById.get(rule.groupId) : group;
    if (!target) continue;
    if (target.allowedModels && !target.allowedModels.has(model.slug)) continue;
    if (rule.providerId && !snap.providers.has(rule.providerId)) continue;
    // the cap only lowers an effort the request actually set
    const sendEffort = asked && rule.capEffort && rank(asked) > rank(rule.capEffort) ? rule.capEffort : null;
    return { group: rule.providerId ? { ...target, routeProviderId: rule.providerId } : target, rule, effort, sendEffort };
  }
  return null;
}
