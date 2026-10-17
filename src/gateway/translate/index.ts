import type { InboundFormat } from "../types";

export { chatRequestToMessages, messagesResponseToChat, AnthropicToChatStream } from "./chat-to-anthropic";
export { messagesRequestToChat, chatResponseToMessages, ChatToAnthropicStream } from "./anthropic-to-chat";

/**
 * Translation matrix (PLAN 5):
 *
 * | inbound \ provider native | openai_chat          | anthropic_messages | gemini                 |
 * | openai_chat               | passthrough          | chat -> messages   | via Google OpenAI-compat (provider lists openai_chat) |
 * | anthropic_messages        | messages -> chat     | passthrough        | messages -> chat -> Google OpenAI-compat |
 * | gemini                    | unsupported unless the provider speaks gemini natively |
 * | openai_responses & the rest | passthrough only |
 */
export type TranslationMode = "native" | "chat_to_messages" | "messages_to_chat";

export interface FormatPlan {
  mode: TranslationMode;
  /** The wire format actually spoken to the upstream. */
  upstream: InboundFormat;
}

/** How (if at all) a request in `inbound` format can be served by a provider that natively accepts `providerFormats`. */
export function planTranslation(inbound: InboundFormat, providerFormats: ReadonlySet<string> | readonly string[]): FormatPlan | null {
  const has = (f: string) => (providerFormats instanceof Set ? providerFormats.has(f) : (providerFormats as readonly string[]).includes(f));
  if (has(inbound)) return { mode: "native", upstream: inbound };
  if (inbound === "openai_chat" && has("anthropic_messages")) return { mode: "chat_to_messages", upstream: "anthropic_messages" };
  if (inbound === "anthropic_messages" && has("openai_chat")) return { mode: "messages_to_chat", upstream: "openai_chat" };
  return null;
}
