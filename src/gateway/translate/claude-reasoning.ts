import type { Json, JsonObject } from "../types";
import { isObject } from "../util";

/**
 * Chat Completions -> Claude: how OpenAI's reasoning knobs (`reasoning_effort`, `max_completion_tokens`, tool_choice)
 * map onto the CURRENT Claude API, per model generation (Anthropic docs, 2026-10):
 *
 *   - Claude 4.7+ / 5.x take `thinking: {type: "adaptive"}` + `output_config.effort`; the old
 *     `thinking: {type: "enabled", budget_tokens}` is REJECTED (400) there. Older models (<= 4.5) still take a budget
 *     (>= 1024, < max_tokens); 4.6 takes either.
 *   - Several 5.x models think BY DEFAULT when `thinking` is omitted (Sonnet 5.5, Haiku 5.5, Opus 5 / 5.5, Fable), and
 *     thinking tokens count against `max_tokens`: a long generation can burn the whole budget on thinking. So when the
 *     client did NOT ask for reasoning thinking is turned OFF the way each model supports (`disabled`, Sonnet 5.5's
 *     `between_tools`, or - on models that cannot turn it off - the lowest effort).
 *   - Sampling parameters (`temperature` / `top_p`) are rejected (non-default values) on the newest models; forced
 *     `tool_choice` (any / tool) is rejected on Fable 5.1, Opus 5.5 and Sonnet 5.5.
 *
 * Pure: no I/O.
 */
export type EffortName = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeProfile {
  /** the id was recognised as a Claude model of a known generation */
  known: boolean;
  /** how thinking is switched ON: an explicit token budget, adaptive thinking, or not at all (no extended thinking) */
  mode: "none" | "budget" | "adaptive";
  /** the model thinks when `thinking` is omitted */
  defaultOn: boolean;
  /** how to turn thinking OFF: omit the field (it is off by default), `disabled`, Sonnet 5.5's `between_tools`, or impossible */
  off: "omit" | "disabled" | "between_tools" | "never";
  /** supported `output_config.effort` values (empty = the parameter does not exist for this model) */
  efforts: readonly EffortName[];
  /** temperature / top_p may be sent */
  sampling: boolean;
  /** forced tool_choice (any / tool) is accepted */
  forcedTool: boolean;
}

const ALL: readonly EffortName[] = ["low", "medium", "high", "xhigh", "max"];

const P = (p: Partial<ClaudeProfile> & Pick<ClaudeProfile, "mode">): ClaudeProfile => ({
  known: true,
  defaultOn: false,
  off: "omit",
  efforts: [],
  sampling: true,
  forcedTool: true,
  ...p,
});

/** Claude generation of an upstream model id (tolerates date suffixes, vendor prefixes and `@`/`:` version tails). */
export function claudeProfile(upstreamModel: string): ClaudeProfile {
  const id = upstreamModel.toLowerCase();
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(id);
  if (!m) {
    // pre-4 naming (claude-3-7-sonnet, claude-3-5-haiku ...)
    if (/claude-3-7-sonnet/.test(id)) return P({ mode: "budget" });
    if (/claude-3/.test(id)) return P({ mode: "none" });
    // not a recognisable Claude id (a relay's own name): keep the classic budget style, change nothing else
    return { ...P({ mode: "budget" }), known: false };
  }
  const family = m[1];
  const major = Number(m[2]);
  const minor = m[3] ? Number(m[3]) : 0;
  const at = (f: string, ma: number, mi: number) => family === f && major === ma && minor === mi;

  if (family === "fable" || family === "mythos") return P({ mode: "adaptive", defaultOn: true, off: "never", efforts: ALL, sampling: false, forcedTool: !(major === 5 && minor >= 1) });
  if (at("opus", 5, 5)) return P({ mode: "adaptive", defaultOn: true, off: "never", efforts: ALL, sampling: false, forcedTool: false });
  if (at("sonnet", 5, 5)) return P({ mode: "adaptive", defaultOn: true, off: "between_tools", efforts: ALL, sampling: false, forcedTool: false });
  if (at("haiku", 5, 5)) return P({ mode: "adaptive", defaultOn: true, off: "disabled", efforts: ALL, sampling: false });
  if (at("opus", 5, 0) || at("sonnet", 5, 0)) return P({ mode: "adaptive", defaultOn: true, off: "disabled", efforts: ALL, sampling: false });
  if (major >= 5) return P({ mode: "adaptive", defaultOn: true, off: "disabled", efforts: ALL, sampling: false }); // a future 5.x: assume the family's shape
  if (family === "opus" && major === 4 && minor >= 7) return P({ mode: "adaptive", off: "omit", efforts: ALL, sampling: false });
  if ((family === "opus" || family === "sonnet") && major === 4 && minor === 6) return P({ mode: "adaptive", off: "omit", efforts: ["low", "medium", "high", "max"] });
  if (at("opus", 4, 5)) return P({ mode: "budget", efforts: ["low", "medium", "high"] });
  return P({ mode: "budget" }); // 4.5 and older: sonnet-4-5, haiku-4-5, opus-4-1, opus-4, sonnet-4 ...
}

/** OpenAI reasoning_effort value -> Claude effort the model supports. */
export function mapEffort(openai: string, profile: ClaudeProfile): EffortName | null {
  if (!profile.efforts.length) return null;
  const want: EffortName = openai === "minimal" || openai === "low" ? "low" : openai === "medium" ? "medium" : openai === "high" ? "high" : openai === "xhigh" ? "xhigh" : "medium";
  if (profile.efforts.includes(want)) return want;
  if (want === "xhigh") return profile.efforts.includes("max") ? "max" : "high";
  return profile.efforts.includes("high") ? "high" : (profile.efforts[profile.efforts.length - 1] ?? null);
}

/** Token budgets for models that still take one. */
const BUDGETS: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768 };
const MIN_BUDGET = 1024;
/** Visible output must keep at least this share of max_tokens (and 1024 tokens) when a budget is used. */
const HEADROOM_SHARE = 0.25;

export type ReasoningAsk = { kind: "off" } | { kind: "on"; effort: string; budget?: number } | { kind: "unspecified" };

/** What the client asked for: `reasoning_effort` (also `reasoning.effort` and Claude-style `thinking`), else nothing. */
export function readReasoningAsk(body: JsonObject): ReasoningAsk {
  const eff = typeof body.reasoning_effort === "string" ? body.reasoning_effort : isObject(body.reasoning) && typeof body.reasoning.effort === "string" ? body.reasoning.effort : undefined;
  if (eff !== undefined) {
    if (eff === "none") return { kind: "off" };
    if (eff in BUDGETS || eff === "xhigh") return { kind: "on", effort: eff };
    return { kind: "unspecified" };
  }
  // OpenAI-compatible Claude clients also send Anthropic's own field in the chat body
  const th = isObject(body.thinking) ? body.thinking : null;
  if (th) {
    if (th.type === "disabled") return { kind: "off" };
    if (th.type === "enabled" || th.type === "adaptive") {
      const b = typeof th.budget_tokens === "number" ? th.budget_tokens : undefined;
      const effort = b === undefined ? "medium" : b <= 2048 ? "low" : b <= 12288 ? "medium" : "high";
      return { kind: "on", effort, ...(b !== undefined ? { budget: b } : {}) };
    }
  }
  return { kind: "unspecified" };
}

export interface ReasoningPlan {
  /** value of the Messages `thinking` field (undefined = leave it out) */
  thinking?: JsonObject;
  /** value of `output_config.effort` */
  effort?: EffortName;
  /** thinking is on for this request */
  on: boolean;
  /** temperature / top_p must be left out */
  dropSampling: boolean;
  /** why thinking was not enabled although it was asked for (admin-only note) */
  note?: string;
}

/**
 * Decide the thinking / effort fields of the Messages request.
 * `canThink` is false when replaying the conversation would be rejected with thinking on (an earlier assistant tool call
 * carries no thinking block that could be passed back).
 */
export function planReasoning(profile: ClaudeProfile, ask: ReasoningAsk, maxTokens: number, canThink = true): ReasoningPlan {
  const base = { dropSampling: !profile.sampling };
  if (profile.mode === "none") return { ...base, on: false };

  // ---- the client wants reasoning
  if (ask.kind === "on" && canThink) {
    if (profile.mode === "adaptive") {
      const effort = mapEffort(ask.effort, profile) ?? undefined;
      // `summarized`: thinking text is omitted by default on these models - the client expects `reasoning_content`
      return { ...base, thinking: { type: "adaptive", display: "summarized" }, ...(effort ? { effort } : {}), on: true, dropSampling: true };
    }
    // budget style: budget < max_tokens with headroom for the visible answer
    const wanted = ask.budget ?? BUDGETS[ask.effort] ?? BUDGETS.medium;
    const headroom = Math.max(1024, Math.ceil(maxTokens * HEADROOM_SHARE));
    const budget = Math.min(wanted, maxTokens - headroom);
    if (budget >= MIN_BUDGET) {
      const effort = mapEffort(ask.effort, profile) ?? undefined;
      return { ...base, thinking: { type: "enabled", budget_tokens: Math.floor(budget) }, ...(effort ? { effort } : {}), on: true, dropSampling: true };
    }
    return { ...base, on: false, note: `reasoning_effort '${ask.effort}' ignored: max tokens ${maxTokens} leaves no room for a thinking budget plus a visible answer` };
  }
  const blocked = ask.kind === "on" && !canThink ? { note: "reasoning ignored for this request: an earlier assistant tool call has no thinking block to pass back (resend `thinking_blocks`)" } : {};

  // ---- reasoning not requested (or impossible): do NOT think
  if (!profile.defaultOn) return { ...base, on: false, ...blocked }; // omitting `thinking` already means "off"
  switch (profile.off) {
    case "disabled":
      return { ...base, thinking: { type: "disabled" }, on: false, ...blocked };
    case "between_tools":
      return { ...base, thinking: { type: "between_tools" }, on: false, ...blocked };
    case "never": {
      // cannot be switched off: the lowest effort keeps thinking short and the visible answer inside max_tokens
      const low = profile.efforts.includes("low") ? ("low" as const) : undefined;
      return { ...base, ...(low ? { effort: low } : {}), on: false, ...blocked };
    }
    default:
      return { ...base, on: false, ...blocked };
  }
}

/** Does this chat history contain an assistant tool call turn without thinking blocks? (it cannot be replayed with thinking on) */
export function hasToolTurnWithoutThinking(messages: Json[]): boolean {
  let last: JsonObject | null = null;
  for (const m of messages) if (isObject(m) && m.role === "assistant") last = m;
  if (!last) return false;
  const calls = (Array.isArray(last.tool_calls) && last.tool_calls.length > 0) || isObject(last.function_call);
  if (!calls) return false;
  return !(Array.isArray(last.thinking_blocks) && last.thinking_blocks.length > 0);
}
