import { emptyUsage, type Json, type Usage } from "./types";
import { isObject, nn } from "./util";

/** OpenAI chat/completions usage -> normalised (prompt_tokens is already the TOTAL incl. cached). */
export function usageFromOpenAI(u: Json): Usage {
  const out = emptyUsage();
  if (!isObject(u)) return out;
  out.inputTokens = nn(u.prompt_tokens ?? u.input_tokens);
  out.outputTokens = nn(u.completion_tokens ?? u.output_tokens);
  const pd = u.prompt_tokens_details ?? u.input_tokens_details;
  const cd = u.completion_tokens_details ?? u.output_tokens_details;
  if (isObject(pd)) {
    out.cachedTokens = nn(pd.cached_tokens);
    out.audioInputTokens = nn(pd.audio_tokens);
    out.cacheWriteTokens = nn(pd.cache_write_tokens ?? pd.cache_creation_tokens);
  }
  if (isObject(cd)) {
    out.reasoningTokens = nn(cd.reasoning_tokens);
    out.audioOutputTokens = nn(cd.audio_tokens);
  }
  // some compat providers expose Anthropic-style / DeepSeek-style counters at the top level
  if (!out.cachedTokens) out.cachedTokens = nn(u.prompt_cache_hit_tokens ?? u.cache_read_input_tokens);
  if (!out.cacheWriteTokens) out.cacheWriteTokens = nn(u.cache_creation_input_tokens);
  if (!out.inputTokens && u.total_tokens) out.inputTokens = Math.max(0, nn(u.total_tokens) - out.outputTokens);
  return out;
}

/** OpenAI Responses API usage (input_tokens includes cached). */
export function usageFromResponses(u: Json): Usage {
  return usageFromOpenAI(u);
}

/** Output item types of the Responses API that are billed per call, and the price key each one is metered under. */
const RESPONSES_TOOL_ITEMS: Record<string, string> = {
  web_search_call: "web_search_call",
  file_search_call: "file_search_call",
};

/**
 * Server tools a Responses API response used: one unit per `web_search_call` / `file_search_call` output item
 * (OpenAI bills these per call, on top of the tokens). Other tool items (code interpreter, MCP, ...) are not priced.
 */
export function toolUsageFromResponsesOutput(output: Json): Record<string, number> {
  const out: Record<string, number> = {};
  if (!Array.isArray(output)) return out;
  for (const item of output) {
    if (!isObject(item) || typeof item.type !== "string") continue;
    const key = RESPONSES_TOOL_ITEMS[item.type];
    if (!key || item.status === "failed") continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

/** Usage of a whole Responses API response object (tokens + the server tools it used). */
export function usageFromResponsesObject(resp: Json): Usage {
  const out = usageFromResponses(isObject(resp) ? resp.usage : undefined);
  if (isObject(resp)) {
    const tools = toolUsageFromResponsesOutput(resp.output);
    if (Object.keys(tools).length) out.toolUsage = tools;
  }
  return out;
}

/**
 * Anthropic `usage.server_tool_use` -> price keys. `web_search_requests` is billed per search; code execution is billed by
 * container time (not reported in the usage): a request that used the tool counts one container for the 5-minute
 * minimum (`code_execution_hour` = 1/12 h), which is what Anthropic bills at least. Code execution that runs together
 * with web search / web fetch (dynamic filtering) is free upstream and never counted here.
 */
export const CODE_EXECUTION_MIN_HOURS = 5 / 60;
export function toolUsageFromAnthropic(u: Json): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(u) || !isObject(u.server_tool_use)) return out;
  const t = u.server_tool_use;
  const search = nn(t.web_search_requests);
  const fetches = nn(t.web_fetch_requests);
  const code = nn(t.code_execution_requests);
  if (search) out.web_search_request = search;
  if (fetches) out.web_fetch_request = fetches;
  if (code) {
    out.code_execution_request = code;
    if (!search && !fetches) out.code_execution_hour = CODE_EXECUTION_MIN_HOURS;
  }
  return out;
}

/**
 * Anthropic usage: input_tokens EXCLUDES cache reads/writes; normalise so inputTokens = total prompt tokens.
 * Accepts partial objects (message_delta carries only output_tokens in older API versions).
 */
export function usageFromAnthropic(u: Json): Usage {
  const out = emptyUsage();
  if (!isObject(u)) return out;
  const base = nn(u.input_tokens);
  const read = nn(u.cache_read_input_tokens);
  let write = nn(u.cache_creation_input_tokens);
  let write1h = 0;
  if (isObject(u.cache_creation)) {
    const w5 = nn(u.cache_creation.ephemeral_5m_input_tokens);
    write1h = nn(u.cache_creation.ephemeral_1h_input_tokens);
    if (!write) write = w5 + write1h;
  }
  out.cachedTokens = read;
  out.cacheWriteTokens = write;
  out.cacheWrite1hTokens = Math.min(write1h, write);
  out.inputTokens = base + read + write;
  out.outputTokens = nn(u.output_tokens);
  // thinking tokens are part of output_tokens (billed as output); the API itemizes them when the model thought
  if (isObject(u.output_tokens_details)) out.reasoningTokens = Math.min(nn(u.output_tokens_details.thinking_tokens), out.outputTokens);
  const tools = toolUsageFromAnthropic(u);
  if (Object.keys(tools).length) out.toolUsage = tools;
  return out;
}

/** Gemini usageMetadata (promptTokenCount includes cached; thoughts are billed as output). */
export function usageFromGemini(u: Json): Usage {
  const out = emptyUsage();
  if (!isObject(u)) return out;
  out.inputTokens = nn(u.promptTokenCount);
  out.cachedTokens = nn(u.cachedContentTokenCount);
  out.reasoningTokens = nn(u.thoughtsTokenCount);
  out.outputTokens = nn(u.candidatesTokenCount) + out.reasoningTokens + nn(u.toolUsePromptTokenCount);
  if (!out.inputTokens && !out.outputTokens && u.totalTokenCount) out.inputTokens = nn(u.totalTokenCount);
  return out;
}

/** True when a Usage carries any billable signal (used to decide whether to fall back to estimation). */
export function hasUsage(u: Usage | null | undefined): u is Usage {
  return !!u && (u.inputTokens > 0 || u.outputTokens > 0 || u.imageCount > 0 || u.audioSeconds > 0 || u.characters > 0 || u.videoSeconds > 0);
}

/** Overlay non-zero fields of `next` on `base` (stream usage arrives in pieces). */
export function mergeUsage(base: Usage, next: Usage): Usage {
  const out = { ...base };
  const keys: Array<keyof Usage> = [
    "inputTokens",
    "outputTokens",
    "cachedTokens",
    "cacheWriteTokens",
    "cacheWrite1hTokens",
    "reasoningTokens",
    "audioInputTokens",
    "audioOutputTokens",
    "imageCount",
    "audioSeconds",
    "characters",
    "videoSeconds",
  ];
  for (const k of keys) {
    const v = next[k] as number;
    if (v > 0) (out[k] as number) = v;
  }
  // server tools: counters are cumulative per key (a later event carries the final value), so overlay per key
  if (base.toolUsage || next.toolUsage) {
    const merged: Record<string, number> = { ...(base.toolUsage ?? {}) };
    for (const [k, v] of Object.entries(next.toolUsage ?? {})) if (v > 0) merged[k] = v;
    out.toolUsage = merged;
  }
  out.estimated = base.estimated && next.estimated;
  return out;
}

/** Add the counters of a server-tool usage map to another one (batch results are summed per customer request, not merged). */
export function addToolUsage(into: Record<string, number>, add: Record<string, number> | undefined): Record<string, number> {
  for (const [k, v] of Object.entries(add ?? {})) into[k] = (into[k] ?? 0) + v;
  return into;
}
