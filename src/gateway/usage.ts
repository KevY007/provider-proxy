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
  out.estimated = base.estimated && next.estimated;
  return out;
}
