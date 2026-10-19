import { formatUSD, Decimal, ZERO } from "@/lib/money";
import { getBalance, refreshBalanceNow } from "./balance";
import type { Ctx } from "./context";
import { GatewayError } from "./errors";
import { forceSharedBalance, releaseHold, reserveHold, settleHold, isHoldOpen, type HoldBackend, type HoldRef } from "./holds";
import { userMonthlySpend } from "./limits";
import { fileBytes, getField } from "./multipart";
import type { StreamProcessor } from "./processor";
import { computeAmount } from "./pricing";
import { eligibleRoutes } from "./select";
import { collectText, countTokens, roughTokens, warmTokenizer } from "./tokenizer";
import { emptyUsage, type JsonObject, type Operation, type Usage } from "./types";
import { isObject } from "./util";
import { requestedSeconds } from "./video";
import { redisReady } from "@/lib/redis";

/**
 * Funds protection (PLAN 9c). Before any upstream call we reserve the WORST-CASE price of the request:
 *
 *     hold = price( estimated input tokens , effective max output tokens , flat / per-image / per-second parts )
 *
 * against `balance + creditLimit - minBalanceToCall - other holds` (and the key's spend limit / the monthly spend
 * limit). Not enough -> 402 in the native error shape, the upstream is never contacted.
 *
 *  - The client set max_tokens (any spelling): the hold covers exactly that (capped by the model / route maximum).
 *  - The client omitted it: the output is clamped to what is affordable (never above the model / route maximum, never
 *    below MIN_OUTPUT_TOKENS - below that it is a 402). The clamp is written into the upstream request.
 *  - Streams: when the accrued cost reaches the hold the upstream is aborted and the stream ends with a native
 *    `insufficient_balance` error event; what was produced is metered.
 *  - The hold is settled (replaced by the actual debit) / released when the request is logged, see `settleFunds`.
 */
export const MIN_OUTPUT_TOKENS = 256;
/** Output tokens assumed when the client gave no limit and the model has no declared maxOutput. */
export const UNKNOWN_MAX_OUTPUT = 16_384;
const IMAGE_OUTPUT_TOKENS = 4_200; // per image, for token-billed image models
const AUDIO_BYTES_PER_SEC = 4_000; // pessimistic (compressed) audio, so the hold over-reserves rather than under
const AUDIO_TOKENS_PER_SEC = 25;
const INPUT_SAFETY = 1.1;
const BIG_TEXT_CHARS = 150_000;

warmTokenizer();

export interface FundsState {
  hold: HoldRef | null;
  /** price of the hold */
  amount: Decimal;
  inputTokens: number;
  /** reserved output tokens per choice (0 for non-generating ops) */
  outputTokens: number;
  choices: number;
  /** value forced into the upstream request as the output cap (null = nothing injected) */
  injectOutput: number | null;
  /** value to use when the upstream REQUIRES a cap and the client sent none (Anthropic) */
  fillOutput: number | null;
  /** the upstream enforces the cap itself (client / route / injected limit) */
  enforced: boolean;
  clamped: boolean;
  /** admin-only note for the request log */
  note: string | null;
  /** stream cutoff */
  cutAtTokens: number;
  cut: boolean;
}

interface HoldPlan {
  base: Usage;
  textOut: boolean;
  choices: number;
  explicit: number | null;
  cap: number | null;
  enforcedByRoute: boolean;
}

// ---------------------------------------------------------------- request inspection
const posInt = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null);

/** The output limit the client asked for (any spelling), or null. */
export function explicitMaxOutput(op: Operation, body: JsonObject | null): number | null {
  if (!body) return null;
  switch (op) {
    case "chat":
      return posInt(body.max_completion_tokens) ?? posInt(body.max_tokens);
    case "completions":
    case "messages":
      return posInt(body.max_tokens);
    case "responses":
      return posInt(body.max_output_tokens);
    case "gemini_generate":
    case "gemini_stream": {
      const gc = isObject(body.generationConfig) ? body.generationConfig : isObject(body.generation_config) ? body.generation_config : null;
      return gc ? (posInt(gc.maxOutputTokens) ?? posInt(gc.max_output_tokens)) : null;
    }
    default:
      return null;
  }
}

function choiceCount(op: Operation, body: JsonObject | null): number {
  if (!body) return 1;
  if (op === "chat" || op === "completions") return Math.min(posInt(body.n) ?? 1, 128);
  if (op === "gemini_generate" || op === "gemini_stream") {
    const gc = isObject(body.generationConfig) ? body.generationConfig : null;
    return Math.min(posInt(gc?.candidateCount) ?? 1, 8);
  }
  return 1;
}

/** Estimated prompt tokens: tiktoken on normal bodies, the char heuristic on huge ones, +10% for other tokenizers. */
export async function estimateInput(body: JsonObject | null): Promise<number> {
  if (!body) return 0;
  const { text, images, messages, extraTokens } = collectText(body);
  const t = text.length > BIG_TEXT_CHARS ? Math.ceil(roughTokens(text) * 1.15) : Math.ceil((await countTokens(text)) * INPUT_SAFETY);
  return t + images * 1000 + messages * 4 + extraTokens;
}

function routeCap(ctx: Ctx): number | null {
  const snap = ctx.snap!;
  const routes = eligibleRoutes(snap, ctx.model!, ctx.group, ctx.path!.wireFormat!);
  if (!routes.length) return null;
  let max = 0;
  for (const r of routes) {
    const c = r.route.maxOutputTokens;
    if (!c || c <= 0) return null; // one unbounded route -> no guaranteed cap
    max = Math.max(max, c);
  }
  return max;
}

async function planHold(ctx: Ctx): Promise<HoldPlan> {
  const op = ctx.path!.op;
  const body = ctx.body;
  const base = emptyUsage();
  const plan: HoldPlan = { base, textOut: false, choices: 1, explicit: null, cap: null, enforcedByRoute: false };
  switch (op) {
    case "chat":
    case "completions":
    case "responses":
    case "messages":
    case "gemini_generate":
    case "gemini_stream": {
      base.inputTokens = await estimateInput(body);
      plan.textOut = true;
      plan.choices = choiceCount(op, body);
      plan.explicit = explicitMaxOutput(op, body);
      const rc = routeCap(ctx);
      const mo = ctx.model!.maxOutput && ctx.model!.maxOutput > 0 ? ctx.model!.maxOutput : null;
      plan.cap = rc && mo ? Math.min(rc, mo) : (rc ?? mo);
      plan.enforcedByRoute = !!rc;
      break;
    }
    case "embeddings":
    case "gemini_embed":
    case "gemini_batch_embed":
      base.inputTokens = await estimateInput(body);
      break;
    case "images_generations":
    case "images_edits":
    case "images_variations": {
      const nRaw = body && typeof body.n === "number" ? body.n : Number(ctx.form ? getField(ctx.form, "n") : 1);
      base.imageCount = Number.isFinite(nRaw) && nRaw > 0 ? Math.min(Math.trunc(nRaw), 10) : 1;
      base.inputTokens = await estimateInput(body);
      // token-billed image models (no flat per-image price): the generated image bills as output tokens
      if (!ctx.model!.sell.image) base.outputTokens = base.imageCount * IMAGE_OUTPUT_TOKENS;
      break;
    }
    case "audio_speech":
      base.characters = typeof body?.input === "string" ? body.input.length : 0;
      base.inputTokens = Math.ceil(base.characters / 3.5); // gpt-4o-mini-tts style token billing
      break;
    case "audio_transcriptions":
    case "audio_translations": {
      const secs = ctx.form ? Math.ceil(fileBytes(ctx.form) / AUDIO_BYTES_PER_SEC) : 0;
      base.audioSeconds = secs;
      if (!ctx.model!.sell.perMinute) {
        base.inputTokens = secs * AUDIO_TOKENS_PER_SEC;
        base.audioInputTokens = base.inputTokens;
      }
      break;
    }
    case "videos_create":
      base.videoSeconds = requestedSeconds(ctx);
      break;
    default:
      break;
  }
  return plan;
}

const priceOf = (ctx: Ctx, u: Usage): Decimal => computeAmount(u, ctx.model!.sell, { multiplier: ctx.multiplier, longContext: ctx.model!.longContext });

// ---------------------------------------------------------------- reservation
function insufficient(ctx: Ctx, args: { reason: "balance" | "monthly" | "key"; amount: Decimal; available: Decimal; affordTokens: number | null; explicit: boolean; internal: string }): GatewayError {
  const { reason, amount, available, affordTokens, explicit } = args;
  if (reason === "monthly") {
    return new GatewayError("spend_limit_reached", "This request would exceed the monthly spend limit of this account.", { internal: args.internal });
  }
  if (reason === "key") {
    return new GatewayError("spend_limit_reached", "This request would exceed the spend limit of this API key.", { internal: args.internal });
  }
  if (available.lte(0)) return new GatewayError("insufficient_balance", undefined, { internal: args.internal });
  const hint = explicit && affordTokens !== null && affordTokens >= 1 ? ` Lower max_tokens to about ${affordTokens} or add credit.` : " Add credit to continue.";
  void ctx;
  return new GatewayError(
    "insufficient_balance",
    `Insufficient balance for this request: it can cost up to ${formatUSD(amount)} but only ${formatUSD(available)} is available.${hint}`,
    { internal: args.internal },
  );
}

/**
 * Reserve the funds for this request (throws 402 `insufficient_balance` / `spend_limit_reached`). Sets `ctx.funds`.
 * Must run after the model is resolved and `ctx.multiplier` is set.
 */
export async function reserveFunds(ctx: Ctx): Promise<void> {
  const snap = ctx.snap!;
  const { user, key } = ctx.auth!;
  const plan = await planHold(ctx);
  ctx.inputEstimate = plan.base.inputTokens;

  const n = plan.choices;
  const explicit = plan.explicit;
  // output tokens PER CHOICE the hold should cover
  let outTokens = 0;
  let clampable = false;
  if (plan.textOut) {
    if (explicit !== null) outTokens = plan.cap ? Math.min(explicit, plan.cap) : explicit;
    else {
      outTokens = plan.cap ?? UNKNOWN_MAX_OUTPUT;
      clampable = true;
    }
  }
  const natural = outTokens;
  const usageAt = (e: number): Usage => ({ ...plan.base, outputTokens: plan.base.outputTokens + e * n });
  const flat = priceOf(ctx, usageAt(0));
  const slope = plan.textOut ? priceOf(ctx, usageAt(1_000_000)).minus(flat).div(1_000_000).div(n) : ZERO; // per output token of ONE choice

  const minBalance = new Decimal(snap.settings.minBalanceToCall);
  const headroomExtra = user.creditLimit.minus(minBalance);
  const monthlyLimit = user.monthlySpendLimit;
  const monthlyRemaining = monthlyLimit ? monthlyLimit.minus(await userMonthlySpend(user.id)) : null;
  const keyRemaining = key.spendLimit ? key.spendLimit.minus(key.spent).minus(ctx.auth!.spentDelta) : null;

  let base = await getBalance(user.id, { balance: user.balance, at: ctx.auth!.loadedAt });
  let confirmedWithDb = false;
  let clamped = false;
  let last: { reason: "balance" | "monthly" | "key"; amount: Decimal; available: Decimal; affordTokens: number | null; internal: string } | null = null;

  for (let attempt = 0; attempt < 8; attempt++) {
    const amount = priceOf(ctx, usageAt(outTokens));
    const r = await reserveHold({
      id: ctx.requestId,
      userId: user.id,
      keyId: key.id,
      amount,
      base,
      headroomExtra,
      monthlyRemaining,
      keyRemaining,
    });
    if (r.ok) {
      // 1:1 with the upstream: a client limit above the catalog maximum is passed through unchanged (the provider accepts it
      // or answers with its own error); only a funds clamp is ever written into the request
      const overCap = plan.textOut && explicit !== null && plan.cap !== null && explicit > plan.cap;
      const injectOutput = plan.textOut && clamped ? outTokens : null;
      const enforced = plan.textOut && (explicit !== null || clamped || plan.enforcedByRoute);
      const notes: string[] = [];
      if (clamped) notes.push(`funds: output clamped from ${natural} to ${outTokens} tokens (hold ${amount.toFixed(6)} of ${formatUSD(r.available)} available)`);
      if (overCap) notes.push(`funds: requested output limit ${explicit} is above the catalog maximum ${outTokens}; passed through unchanged`);
      ctx.funds = {
        hold: amount.gt(0) ? { id: ctx.requestId, userId: user.id, keyId: key.id, backend: r.backend, createdAt: Date.now() } : null,
        amount,
        inputTokens: plan.base.inputTokens,
        outputTokens: outTokens,
        choices: n,
        injectOutput,
        fillOutput: plan.textOut ? outTokens : null,
        enforced,
        clamped,
        note: notes.length ? notes.join("; ") : null,
        // only a runaway upstream is cut: an enforced cap may legitimately be reached exactly, and without one the
        // chars/4 estimate can run ~30% above the real token count on prose, so leave room for a full-length answer
        cutAtTokens: plan.textOut ? Math.ceil(outTokens * n * (enforced ? 1.25 : 1.5)) : 0,
        cut: false,
      };
      return;
    }

    const limit = Decimal.min(r.available, r.monthlyAvailable ?? r.available, r.keyAvailable ?? r.available);
    const afford = plan.textOut && slope.gt(0) ? Math.max(0, limit.minus(flat).div(slope).floor().toNumber()) : null;
    const reasonAvail = r.reason === "monthly" ? (r.monthlyAvailable ?? ZERO) : r.reason === "key" ? (r.keyAvailable ?? ZERO) : r.available;
    last = {
      reason: r.reason ?? "balance",
      amount,
      available: reasonAvail,
      affordTokens: afford,
      internal: `balance=${base.toFixed(6)} creditLimit=${user.creditLimit.toFixed(6)} available=${r.available.toFixed(6)} hold=${amount.toFixed(6)} reason=${r.reason} minBalanceToCall=${minBalance.toString()} outTokens=${outTokens}`,
    };

    // the cached balance may predate a top-up made on another instance: confirm against the DB before rejecting
    if (r.reason === "balance" && !confirmedWithDb) {
      confirmedWithDb = true;
      const fresh = await refreshBalanceNow(user.id);
      const known = r.sharedBalance ?? base; // Redis: the shared balance may be stale-low (e.g. a manual database change)
      if (!fresh.equals(base) || fresh.gt(known)) {
        if (fresh.gt(known)) await forceSharedBalance(user.id, fresh);
        base = fresh;
        continue;
      }
    }
    // omitted limit: shrink the output to what can be paid for
    if (clampable && afford !== null) {
      const minOut = Math.min(MIN_OUTPUT_TOKENS, natural);
      if (afford >= minOut) {
        const next = Math.min(natural, afford);
        if (next < outTokens) {
          outTokens = next;
          clamped = true;
          continue;
        }
      }
    }
    break;
  }
  const l = last!;
  throw insufficient(ctx, { ...l, explicit: explicit !== null, affordTokens: l.affordTokens });
}

// ---------------------------------------------------------------- Batch API
/** Batches end within 24 hours upstream; the hold outlives that (the sweep re-places it while the batch is open). */
export const BATCH_HOLD_TTL_MS = 30 * 60 * 60_000;

/**
 * Reserve the worst-case price of a whole batch (all its requests at the batch price) as ONE long-lived hold
 * `batch:<requestId>` (throws 402 `insufficient_balance` / `spend_limit_reached` like `reserveFunds`). The hold is
 * released once every result of the batch was metered (or the batch is gone), so the customer cannot start more
 * work than they can pay for while the batch runs.
 */
export async function reserveBatchHold(ctx: Ctx, amount: Decimal): Promise<HoldRef | null> {
  const snap = ctx.snap!;
  const { user, key } = ctx.auth!;
  const id = `batch:${ctx.requestId}`;
  const minBalance = new Decimal(snap.settings.minBalanceToCall);
  const monthlyRemaining = user.monthlySpendLimit ? user.monthlySpendLimit.minus(await userMonthlySpend(user.id)) : null;
  const keyRemaining = key.spendLimit ? key.spendLimit.minus(key.spent).minus(ctx.auth!.spentDelta) : null;
  let base = await getBalance(user.id, { balance: user.balance, at: ctx.auth!.loadedAt });
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await reserveHold({ id, userId: user.id, keyId: key.id, amount, base, headroomExtra: user.creditLimit.minus(minBalance), monthlyRemaining, keyRemaining, ttlMs: BATCH_HOLD_TTL_MS });
    if (r.ok) return amount.gt(0) ? { id, userId: user.id, keyId: key.id, backend: r.backend, createdAt: Date.now() } : null;
    const internal = `batch hold=${amount.toFixed(6)} available=${r.available.toFixed(6)} reason=${r.reason}`;
    if (r.reason === "balance" && attempt === 0) {
      const fresh = await refreshBalanceNow(user.id);
      const known = r.sharedBalance ?? base;
      if (!fresh.equals(base) || fresh.gt(known)) {
        if (fresh.gt(known)) await forceSharedBalance(user.id, fresh);
        base = fresh;
        continue;
      }
    }
    const available = r.reason === "monthly" ? (r.monthlyAvailable ?? ZERO) : r.reason === "key" ? (r.keyAvailable ?? ZERO) : r.available;
    throw insufficient(ctx, { reason: r.reason ?? "balance", amount, available, affordTokens: null, explicit: false, internal });
  }
  throw new GatewayError("insufficient_balance");
}

// ---------------------------------------------------------------- settle / release
/** Settle the hold with the actual price (called once per request from `logOutcome`). */
export function settleFunds(ctx: Ctx, price: Decimal): void {
  const auth = ctx.auth;
  const f = ctx.funds;
  if (f?.hold) {
    const ref = f.hold;
    f.hold = null;
    settleHold(ref, price);
    return;
  }
  if (!f && auth && price.gt(0)) {
    // billable request that never went through the reservation (defensive): still make the debit visible
    const backend: HoldBackend = redisReady() ? "redis" : "memory";
    settleHold({ id: ctx.requestId, userId: auth.user.id, keyId: auth.key.id, backend, createdAt: Date.now() }, price);
  } else if (f && !f.hold && price.gt(0) && auth) {
    // zero-amount reservation (free model) but a charge came out: make it visible too
    const backend: HoldBackend = redisReady() ? "redis" : "memory";
    settleHold({ id: ctx.requestId, userId: auth.user.id, keyId: auth.key.id, backend, createdAt: Date.now() }, price);
  }
}

/** Safety net: drop a hold that is still open after the request ended (no charge). */
export function closeFunds(ctx: Ctx): void {
  const f = ctx.funds;
  if (f?.hold && isHoldOpen(f.hold.id)) {
    const ref = f.hold;
    f.hold = null;
    releaseHold(ref);
  }
}

// ---------------------------------------------------------------- streaming cutoff
/**
 * Output tokens produced so far by a stream. Reported usage wins; otherwise an estimate from the text length.
 * When the upstream enforces the cap itself the estimate is deliberately generous (5 chars per token) so a normal
 * response that ends exactly at the cap is never cut early; without an enforced cap 4 chars per token are assumed.
 */
export function streamOutputTokens(f: FundsState, p: StreamProcessor): number {
  const chars = p.outputChars?.() ?? 0;
  return Math.floor(chars / (f.enforced ? 5 : 4));
}

/**
 * True when the stream has accrued the reserved amount (estimated output tokens reached the reserved output).
 * Usage reported by the upstream is deliberately NOT used here: it arrives with the final events, when there is
 * nothing left to stop (and the settlement uses it anyway). A stream that already signalled its end is never cut.
 */
export function streamExceedsHold(ctx: Ctx, p: StreamProcessor): boolean {
  const f = ctx.funds;
  if (!f || !f.outputTokens || f.cut) return false;
  if (p.completed()) return false;
  return streamOutputTokens(f, p) >= f.cutAtTokens;
}
